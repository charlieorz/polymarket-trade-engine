// BTC 5m gap arbitrage strategy.

import type { Strategy, StrategyContext, StrategyMetrics } from "./types.ts";
import { Env } from "../../utils/config.ts";

type Side = "UP" | "DOWN";
type EntryKind = "advantage" | "reversal";
type OrderType = "GTC" | "FOK" | "FAK";

type Config = {
  tickIntervalMs: number;
  statsIntervalMs: number;
  velocityEmaPeriod: number;
  trendLookback: number;
  shares: number;
  entryStartElapsedSeconds: number;
  entryEndElapsedSeconds: number;
  managedExitStartElapsedSeconds: number;
  holdOnlyStartElapsedSeconds: number;
  entryOrderType: OrderType;
  entryOrderTtlMs: number;
  takeProfitOrderType: OrderType;
  takeProfitOrderTtlMs: number;
  stopLossOrderType: OrderType;
  stopLossOrderTtlMs: number;
  maxSpread: number;
  minEntryLiquidityUsd: number;
  minExitLiquidityUsd: number;
  maxAdvantagePrice: number;
  maxReversalPrice: number;
  advantageMinAbsGap: number;
  advantageMinMomentum: number;
  advantageMinCumulativeGap: number;
  reversalMaxAbsGap: number;
  reversalMinMomentum: number;
  minTakeProfitRatio: number;
  maxTakeProfitRatio: number;
  takeProfitPriceImmediate: number;
  fullTakeProfitRatio: number;
  halfStopLossRatio: number;
  fullStopLossRatio: number;
  entryTakeProfitEnabled: boolean;
  managedTakeProfitEnabled: boolean;
  stopLossEnabled: boolean;
  smallProfitExitMode: "cost_cover_hold" | "cost_cover_continue" | "full_exit" | "none";
  dynamicTpPriceWeight: number;
  dynamicTpGapWeight: number;
  dynamicTpMomentumWeight: number;
};

type EdgeStats = {
  sideVelocityEma: Record<Side, number | null>;
  gapHistory: number[];
  lastPrice: number | null;
  lastGap: number | null;
  lastUpdateMs: number;
  cumulativeGap: number;
};

type BookQuality = {
  ask: number;
  bid: number | null;
  askLiquidity: number;
  bidLiquidity: number;
  spread: number | null;
};

type EntryDecision = {
  kind: EntryKind;
  side: Side;
  tokenId: string;
  ask: number;
  bid: number | null;
  price: number;
  shares: number;
  absGap: number;
  sideGap: number;
  sideMomentum: number;
  cumulativeSideGap: number;
  takeProfitRatio: number;
  takeProfitPrice: number;
  score: number;
};

type Position = {
  kind: EntryKind;
  side: Side;
  tokenId: string;
  entryPrice: number;
  entryMs: number;
  entryGap: number;
  initialShares: number;
  shares: number;
  takeProfitRatio: number;
  takeProfitPrice: number;
  costCovered: boolean;
  halfStopped: boolean;
  holdRestToSettlement: boolean;
};

type State = {
  entryOrderSubmitted: boolean;
  pendingEntry: boolean;
  position: Position | null;
  closing: boolean;
  released: boolean;
  settlementHoldLogged: boolean;
};

type ExitDecision = {
  price: number;
  shares: number;
  orderType: OrderType;
  ttlMs: number;
  reason: string;
  holdRestAfterFill: boolean;
};

const EPSILON = 1e-9;

function parseNumberEnv(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
): number {
  const value = env[key];
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseOrderTypeEnv(
  env: Record<string, string | undefined>,
  key: string,
  fallback: OrderType,
): OrderType {
  const value = env[key]?.trim().toUpperCase();
  return value === "GTC" || value === "FOK" || value === "FAK" ? value : fallback;
}

function parseBooleanEnv(
  env: Record<string, string | undefined>,
  key: string,
  fallback: boolean,
): boolean {
  const value = env[key];
  if (value === undefined || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseSmallProfitExitModeEnv(
  env: Record<string, string | undefined>,
): Config["smallProfitExitMode"] {
  const value = env.B5A_SMALL_PROFIT_EXIT_MODE?.trim().toLowerCase();
  if (
    value === "cost_cover_hold" ||
    value === "cost_cover_continue" ||
    value === "full_exit" ||
    value === "none"
  ) {
    return value;
  }
  return "full_exit";
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function roundPrice(value: number): number {
  return clamp(Math.floor(value * 100 + EPSILON) / 100, 0.01, 0.99);
}

function roundShares(value: number): number {
  return Math.max(0, Math.floor(value * 10_000 + EPSILON) / 10_000);
}

export function readBtc5mArbConfig(
  env: Record<string, string | undefined> = process.env,
): Config {
  return {
    tickIntervalMs: Math.max(50, parseNumberEnv(env, "B5A_TICK_INTERVAL_MS", 200)),
    statsIntervalMs: Math.max(250, parseNumberEnv(env, "B5A_STATS_INTERVAL_MS", 1000)),
    velocityEmaPeriod: Math.max(2, parseNumberEnv(env, "B5A_VELOCITY_EMA_PERIOD", 5)),
    trendLookback: Math.max(3, Math.floor(parseNumberEnv(env, "B5A_TREND_LOOKBACK", 8))),
    shares: Math.max(0.01, parseNumberEnv(env, "B5A_SHARES", 6)),
    entryStartElapsedSeconds: Math.max(0, parseNumberEnv(env, "B5A_ENTRY_START_SECONDS", 67)),
    entryEndElapsedSeconds: Math.max(0, parseNumberEnv(env, "B5A_ENTRY_END_SECONDS", 217)),
    managedExitStartElapsedSeconds: Math.max(
      0,
      parseNumberEnv(env, "B5A_MANAGED_EXIT_START_SECONDS", 222),
    ),
    holdOnlyStartElapsedSeconds: Math.max(
      0,
      parseNumberEnv(env, "B5A_HOLD_ONLY_START_SECONDS", 297),
    ),
    entryOrderType: parseOrderTypeEnv(env, "B5A_ENTRY_ORDER_TYPE", "GTC"),
    entryOrderTtlMs: Math.max(250, parseNumberEnv(env, "B5A_ENTRY_ORDER_TTL_MS", 2500)),
    takeProfitOrderType: parseOrderTypeEnv(env, "B5A_TAKE_PROFIT_ORDER_TYPE", "GTC"),
    takeProfitOrderTtlMs: Math.max(
      250,
      parseNumberEnv(env, "B5A_TAKE_PROFIT_ORDER_TTL_MS", 3000),
    ),
    stopLossOrderType: parseOrderTypeEnv(env, "B5A_STOP_LOSS_ORDER_TYPE", "FAK"),
    stopLossOrderTtlMs: Math.max(
      250,
      parseNumberEnv(env, "B5A_STOP_LOSS_ORDER_TTL_MS", 1200),
    ),
    maxSpread: Math.max(0, parseNumberEnv(env, "B5A_MAX_SPREAD", 0.05)),
    minEntryLiquidityUsd: Math.max(0, parseNumberEnv(env, "B5A_MIN_ENTRY_LIQUIDITY_USD", 5)),
    minExitLiquidityUsd: Math.max(0, parseNumberEnv(env, "B5A_MIN_EXIT_LIQUIDITY_USD", 5)),
    maxAdvantagePrice: clamp(parseNumberEnv(env, "B5A_MAX_ADVANTAGE_PRICE", 0.58), 0.01, 0.99),
    maxReversalPrice: clamp(parseNumberEnv(env, "B5A_MAX_REVERSAL_PRICE", 0.51), 0.01, 0.99),
    advantageMinAbsGap: Math.max(0, parseNumberEnv(env, "B5A_ADV_MIN_ABS_GAP", 4)),
    advantageMinMomentum: Math.max(0, parseNumberEnv(env, "B5A_ADV_MIN_MOMENTUM", 0.18)),
    advantageMinCumulativeGap: Math.max(
      0,
      parseNumberEnv(env, "B5A_ADV_MIN_CUMULATIVE_GAP", 30),
    ),
    reversalMaxAbsGap: Math.max(0, parseNumberEnv(env, "B5A_REV_MAX_ABS_GAP", 6)),
    reversalMinMomentum: Math.max(0, parseNumberEnv(env, "B5A_REV_MIN_MOMENTUM", 0.18)),
    minTakeProfitRatio: Math.max(0.18, parseNumberEnv(env, "B5A_MIN_TAKE_PROFIT_RATIO", 0.2)),
    maxTakeProfitRatio: Math.max(0.12, parseNumberEnv(env, "B5A_MAX_TAKE_PROFIT_RATIO", 0.48)),
    takeProfitPriceImmediate: clamp(
      parseNumberEnv(env, "B5A_TAKE_PROFIT_PRICE_IMMEDIATE", 0.87),
      0.01,
      0.99,
    ),
    fullTakeProfitRatio: Math.max(0, parseNumberEnv(env, "B5A_FULL_TAKE_PROFIT_RATIO", 0.4)),
    halfStopLossRatio: clamp(parseNumberEnv(env, "B5A_HALF_STOP_LOSS_RATIO", 0.52), 0, 0.99),
    fullStopLossRatio: clamp(parseNumberEnv(env, "B5A_FULL_STOP_LOSS_RATIO", 0.67), 0, 0.99),
    entryTakeProfitEnabled: parseBooleanEnv(env, "B5A_ENTRY_TAKE_PROFIT_ENABLED", false),
    managedTakeProfitEnabled: parseBooleanEnv(env, "B5A_MANAGED_TAKE_PROFIT_ENABLED", true),
    stopLossEnabled: parseBooleanEnv(env, "B5A_STOP_LOSS_ENABLED", false),
    smallProfitExitMode: parseSmallProfitExitModeEnv(env),
    dynamicTpPriceWeight: Math.max(0, parseNumberEnv(env, "B5A_DYNAMIC_TP_PRICE_WEIGHT", 0.1)),
    dynamicTpGapWeight: Math.max(0, parseNumberEnv(env, "B5A_DYNAMIC_TP_GAP_WEIGHT", 0.08)),
    dynamicTpMomentumWeight: Math.max(
      0,
      parseNumberEnv(env, "B5A_DYNAMIC_TP_MOMENTUM_WEIGHT", 0.06),
    ),
  };
}

const CONFIG = readBtc5mArbConfig();

function createEdgeStats(): EdgeStats {
  return {
    sideVelocityEma: { UP: null, DOWN: null },
    gapHistory: [],
    lastPrice: null,
    lastGap: null,
    lastUpdateMs: 0,
    cumulativeGap: 0,
  };
}

function ema(previous: number | null, value: number, period: number): number {
  return previous === null ? value : (previous * (period - 1) + value) / period;
}

function sideGap(side: Side, gap: number): number {
  return side === "UP" ? gap : -gap;
}

function opposite(side: Side): Side {
  return side === "UP" ? "DOWN" : "UP";
}

function updateStats(
  stats: EdgeStats,
  price: number,
  gap: number,
  now = Date.now(),
  config = CONFIG,
): void {
  if (now - stats.lastUpdateMs < config.statsIntervalMs) return;

  if (stats.lastGap !== null) {
    const dtSeconds = Math.max((now - stats.lastUpdateMs) / 1000, EPSILON);
    const velocity = (gap - stats.lastGap) / dtSeconds;
    stats.sideVelocityEma.UP = ema(
      stats.sideVelocityEma.UP,
      velocity,
      config.velocityEmaPeriod,
    );
    stats.sideVelocityEma.DOWN = ema(
      stats.sideVelocityEma.DOWN,
      -velocity,
      config.velocityEmaPeriod,
    );
  }

  stats.cumulativeGap += gap;
  stats.gapHistory.push(gap);
  if (stats.gapHistory.length > config.trendLookback + 1) stats.gapHistory.shift();
  stats.lastPrice = price;
  stats.lastGap = gap;
  stats.lastUpdateMs = now;
}

function recentSideDelta(side: Side, history: number[]): number | null {
  if (history.length < 2) return null;
  return sideGap(side, history.at(-1)! - history.at(-2)!);
}

function bookQuality(ctx: StrategyContext, side: Side): BookQuality | null {
  const ask = ctx.orderBook.bestAskInfo(side);
  if (!ask) return null;
  const bid = ctx.orderBook.bestBidInfo(side);
  return {
    ask: ask.price,
    bid: bid?.price ?? null,
    askLiquidity: ask.liquidity,
    bidLiquidity: bid?.liquidity ?? 0,
    spread: bid ? ask.price - bid.price : null,
  };
}

function tickSize(ctx: StrategyContext, tokenId: string): number {
  const parsed = Number(ctx.orderBook.getTickSize(tokenId));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0.01;
}

function passiveBuyPrice(params: {
  ask: number;
  bid: number | null;
  tick: number;
  maxPrice: number;
  orderType: OrderType;
}): number | null {
  if (params.orderType !== "GTC") return roundPrice(Math.min(params.ask, params.maxPrice));
  const belowAsk = params.ask - params.tick;
  const improveBid = params.bid === null ? belowAsk : params.bid + params.tick;
  const price = roundPrice(Math.min(belowAsk, improveBid, params.maxPrice));
  if (price <= 0 || price >= params.ask) return null;
  return price;
}

function passiveSellPrice(params: {
  ask: number | null;
  bid: number;
  tick: number;
  minPrice: number;
  orderType: OrderType;
}): number | null {
  if (params.orderType !== "GTC") return roundPrice(params.bid);
  const improveAsk = params.ask === null ? params.bid + params.tick : params.ask - params.tick;
  const price = roundPrice(Math.max(params.bid, improveAsk, params.minPrice));
  if (price <= 0) return null;
  return price;
}

function dynamicTakeProfitRatio(params: {
  kind: EntryKind;
  price: number;
  absGap: number;
  momentum: number;
  maxPrice: number;
  config: Config;
}): number {
  const threshold =
    params.kind === "advantage"
      ? Math.max(params.config.advantageMinAbsGap, EPSILON)
      : Math.max(params.config.reversalMaxAbsGap, EPSILON);
  const gapScore =
    params.kind === "advantage"
      ? clamp(params.absGap / threshold - 1, 0, 2) / 2
      : clamp((params.config.reversalMaxAbsGap - params.absGap) / threshold, 0, 1);
  const momentumThreshold =
    params.kind === "advantage"
      ? Math.max(params.config.advantageMinMomentum, EPSILON)
      : Math.max(params.config.reversalMinMomentum, EPSILON);
  const momentumScore = clamp(params.momentum / momentumThreshold - 1, 0, 2) / 2;
  const priceScore = clamp((params.maxPrice - params.price) / params.maxPrice, 0, 1);
  return clamp(
    params.config.minTakeProfitRatio +
      params.config.dynamicTpPriceWeight * priceScore +
      params.config.dynamicTpGapWeight * gapScore +
      params.config.dynamicTpMomentumWeight * momentumScore,
    params.config.minTakeProfitRatio,
    params.config.maxTakeProfitRatio,
  );
}

function buildEntry(params: {
  ctx: StrategyContext;
  kind: EntryKind;
  side: Side;
  gap: number;
  stats: EdgeStats;
  config: Config;
}): EntryDecision | null {
  const maxPrice =
    params.kind === "advantage"
      ? params.config.maxAdvantagePrice
      : params.config.maxReversalPrice;
  const quality = bookQuality(params.ctx, params.side);
  if (!quality) return null;
  if (quality.ask > maxPrice) return null;
  if (quality.askLiquidity < params.config.minEntryLiquidityUsd) return null;
  if (quality.spread === null || quality.spread > params.config.maxSpread) return null;

  const tokenId =
    params.side === "UP" ? params.ctx.clobTokenIds[0] : params.ctx.clobTokenIds[1];
  const price = passiveBuyPrice({
    ask: quality.ask,
    bid: quality.bid,
    tick: tickSize(params.ctx, tokenId),
    maxPrice,
    orderType: params.config.entryOrderType,
  });
  if (price === null) return null;

  const absGap = Math.abs(params.gap);
  const currentSideGap = sideGap(params.side, params.gap);
  const momentum = params.stats.sideVelocityEma[params.side];
  const recentDelta = recentSideDelta(params.side, params.stats.gapHistory);
  const cumulativeSideGap = sideGap(params.side, params.stats.cumulativeGap);
  if (momentum === null || recentDelta === null || recentDelta <= 0) return null;

  if (params.kind === "advantage") {
    if (absGap < params.config.advantageMinAbsGap) return null;
    if (momentum < params.config.advantageMinMomentum) return null;
    if (cumulativeSideGap < params.config.advantageMinCumulativeGap) return null;
  } else {
    if (absGap > params.config.reversalMaxAbsGap) return null;
    if (momentum < params.config.reversalMinMomentum) return null;
  }

  const takeProfitRatio = dynamicTakeProfitRatio({
    kind: params.kind,
    price,
    absGap,
    momentum,
    maxPrice,
    config: params.config,
  });
  const takeProfitPrice = roundPrice(Math.min(0.99, price * (1 + takeProfitRatio)));
  const score =
    takeProfitRatio +
    Math.max(0, maxPrice - price) +
    Math.max(0, momentum) * 0.05 +
    (params.kind === "advantage" ? Math.max(0, cumulativeSideGap) * 0.0005 : 0);

  return {
    kind: params.kind,
    side: params.side,
    tokenId,
    ask: quality.ask,
    bid: quality.bid,
    price,
    shares: params.config.shares,
    absGap,
    sideGap: currentSideGap,
    sideMomentum: momentum,
    cumulativeSideGap,
    takeProfitRatio,
    takeProfitPrice,
    score,
  };
}

function chooseEntry(params: {
  ctx: StrategyContext;
  gap: number;
  elapsed: number;
  stats: EdgeStats;
  state: State;
  config?: Config;
}): EntryDecision | null {
  const config = params.config ?? CONFIG;
  if (params.state.entryOrderSubmitted || params.state.pendingEntry) return null;
  if (params.state.position || params.state.closing) return null;
  if (params.elapsed < config.entryStartElapsedSeconds) return null;
  if (params.elapsed > config.entryEndElapsedSeconds) return null;
  if (params.elapsed >= config.holdOnlyStartElapsedSeconds) return null;
  if (params.gap === 0) return null;

  const gapSide: Side = params.gap > 0 ? "UP" : "DOWN";
  const candidates = [
    buildEntry({
      ctx: params.ctx,
      kind: "advantage",
      side: gapSide,
      gap: params.gap,
      stats: params.stats,
      config,
    }),
    buildEntry({
      ctx: params.ctx,
      kind: "reversal",
      side: opposite(gapSide),
      gap: params.gap,
      stats: params.stats,
      config,
    }),
  ].filter((entry): entry is EntryDecision => entry !== null);

  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => b.score - a.score)[0]!;
}

function chooseExit(params: {
  ctx: StrategyContext;
  pos: Position;
  gap: number;
  ask: number | null;
  bid: number | null;
  bidLiquidity: number;
  elapsed: number;
  config?: Config;
}): ExitDecision | null {
  const config = params.config ?? CONFIG;
  if (params.elapsed >= config.holdOnlyStartElapsedSeconds) return null;
  if (params.pos.holdRestToSettlement) return null;
  if (params.bid === null) return null;
  if (params.bidLiquidity < config.minExitLiquidityUsd) return null;

  const profitRatio = (params.bid - params.pos.entryPrice) / params.pos.entryPrice;
  const sideCurrentGap = sideGap(params.pos.side, params.gap);
  const tick = tickSize(params.ctx, params.pos.tokenId);
  const tpPrice = (minPrice: number) =>
    passiveSellPrice({
      ask: params.ask,
      bid: params.bid!,
      tick,
      minPrice,
      orderType: config.takeProfitOrderType,
    });

  if (
    params.elapsed >= config.entryStartElapsedSeconds &&
    params.elapsed <= config.entryEndElapsedSeconds
  ) {
    if (!config.entryTakeProfitEnabled) return null;
    if (params.bid >= params.pos.takeProfitPrice) {
      const price = tpPrice(params.pos.takeProfitPrice);
      if (price === null) return null;
      return {
        price,
        shares: params.pos.shares,
        orderType: config.takeProfitOrderType,
        ttlMs: config.takeProfitOrderTtlMs,
        reason: "dynamic take-profit",
        holdRestAfterFill: false,
      };
    }
    return null;
  }

  if (
    params.elapsed < config.managedExitStartElapsedSeconds ||
    params.elapsed >= config.holdOnlyStartElapsedSeconds
  ) {
    return null;
  }

  if (config.managedTakeProfitEnabled) {
    if (params.bid >= config.takeProfitPriceImmediate) {
      const price = tpPrice(config.takeProfitPriceImmediate);
      if (price === null) return null;
      return {
        price,
        shares: params.pos.shares,
        orderType: config.takeProfitOrderType,
        ttlMs: config.takeProfitOrderTtlMs,
        reason: "managed price take-profit",
        holdRestAfterFill: false,
      };
    }

    if (profitRatio >= config.fullTakeProfitRatio) {
      const minPrice = params.pos.entryPrice * (1 + config.fullTakeProfitRatio);
      const price = tpPrice(minPrice);
      if (price === null) return null;
      return {
        price,
        shares: params.pos.shares,
        orderType: config.takeProfitOrderType,
        ttlMs: config.takeProfitOrderTtlMs,
        reason: "managed full take-profit",
        holdRestAfterFill: false,
      };
    }

    if (
      profitRatio > 0 &&
      !params.pos.costCovered &&
      config.smallProfitExitMode !== "none"
    ) {
      const costCoverShares = roundShares(
        Math.min(
          params.pos.shares,
          (params.pos.entryPrice * params.pos.initialShares) / Math.max(params.bid, EPSILON),
        ),
      );
      const price = tpPrice(params.pos.entryPrice);
      if (price === null) return null;
      if (config.smallProfitExitMode === "full_exit") {
        return {
          price,
          shares: params.pos.shares,
          orderType: config.takeProfitOrderType,
          ttlMs: config.takeProfitOrderTtlMs,
          reason: "managed small-profit full-exit",
          holdRestAfterFill: false,
        };
      }
      if (costCoverShares > EPSILON && costCoverShares < params.pos.shares - EPSILON) {
        return {
          price,
          shares: costCoverShares,
          orderType: config.takeProfitOrderType,
          ttlMs: config.takeProfitOrderTtlMs,
          reason: "managed cost-cover take-profit",
          holdRestAfterFill: config.smallProfitExitMode === "cost_cover_hold",
        };
      }
    }
  }

  if (profitRatio >= 0) return null;
  if (!config.stopLossEnabled) return null;
  if (sideCurrentGap > 0) return null;

  const lossRatio = -profitRatio;
  if (lossRatio >= config.fullStopLossRatio) {
    return {
      price: roundPrice(params.bid),
      shares: params.pos.shares,
      orderType: config.stopLossOrderType,
      ttlMs: config.stopLossOrderTtlMs,
      reason: "managed full stop-loss",
      holdRestAfterFill: false,
    };
  }

  if (lossRatio >= config.halfStopLossRatio && !params.pos.halfStopped) {
    return {
      price: roundPrice(params.bid),
      shares: roundShares(params.pos.shares / 2),
      orderType: config.stopLossOrderType,
      ttlMs: config.stopLossOrderTtlMs,
      reason: "managed half stop-loss",
      holdRestAfterFill: true,
    };
  }

  return null;
}

function releaseOnce(state: State, release: () => void): void {
  if (state.released) return;
  state.released = true;
  release();
}

function actionDeadlineMs(ctx: StrategyContext, config: Config): number {
  return ctx.slotStartMs + config.holdOnlyStartElapsedSeconds * 1000;
}

function metrics(params: {
  elapsed: number;
  remaining: number;
  btcPrice: number;
  priceToBeat: number;
  gap: number;
  stats: EdgeStats;
  entry?: EntryDecision;
  pos?: Position;
  exitReason?: string;
}): StrategyMetrics {
  const side = params.entry?.side ?? params.pos?.side ?? (params.gap >= 0 ? "UP" : "DOWN");
  return {
    strategy: "btc-5m-arb",
    elapsed: Math.round(params.elapsed),
    remaining: Math.round(params.remaining),
    btcPrice: Number(params.btcPrice.toFixed(2)),
    priceToBeat: Number(params.priceToBeat.toFixed(2)),
    gap: Number(params.gap.toFixed(2)),
    side,
    kind: params.entry?.kind ?? params.pos?.kind ?? null,
    sideMomentum:
      params.stats.sideVelocityEma[side] === null
        ? null
        : Number(params.stats.sideVelocityEma[side]!.toFixed(4)),
    cumulativeGap: Number(params.stats.cumulativeGap.toFixed(2)),
    cumulativeSideGap: Number(sideGap(side, params.stats.cumulativeGap).toFixed(2)),
    entryPrice: params.entry?.price ?? params.pos?.entryPrice ?? null,
    entryAsk: params.entry?.ask ?? null,
    takeProfitRatio:
      params.entry?.takeProfitRatio ?? params.pos?.takeProfitRatio ?? null,
    takeProfitPrice: params.entry?.takeProfitPrice ?? params.pos?.takeProfitPrice ?? null,
    exitReason: params.exitReason ?? null,
  };
}

function placeSell(params: {
  ctx: StrategyContext;
  state: State;
  pos: Position;
  decision: ExitDecision;
  gap: number;
  remaining: number;
  elapsed: number;
  btcPrice: number;
  priceToBeat: number;
  stats: EdgeStats;
  release: () => void;
}): void {
  params.state.closing = true;
  const sellMetrics = metrics({
    elapsed: params.elapsed,
    remaining: params.remaining,
    btcPrice: params.btcPrice,
    priceToBeat: params.priceToBeat,
    gap: params.gap,
    stats: params.stats,
    pos: params.pos,
    exitReason: params.decision.reason,
  });
  const signalId = params.ctx.recordSignal({
    action: "sell",
    side: params.pos.side,
    label: `btc-5m-arb ${params.decision.reason}`,
    metrics: sellMetrics,
  });

  params.ctx.postOrders([
    {
      req: {
        tokenId: params.pos.tokenId,
        action: "sell",
        price: params.decision.price,
        shares: params.decision.shares,
        orderType: params.decision.orderType,
      },
      expireAtMs: Math.min(
        actionDeadlineMs(params.ctx, CONFIG),
        Date.now() + params.decision.ttlMs,
      ),
      analysis: {
        signalId,
        label: `btc-5m-arb ${params.decision.reason}`,
        metrics: sellMetrics,
      },
      onFilled(filledShares) {
        const remainingShares = roundShares(params.pos.shares - filledShares);
        params.ctx.log(
          `[${params.ctx.slug}] btc-5m-arb: SELL ${params.pos.side} filled @ ${params.decision.price} (${filledShares} shares, ${params.decision.reason})`,
          "green",
        );
        if (params.decision.reason === "managed cost-cover take-profit") {
          params.pos.costCovered = true;
        }
        if (params.decision.reason === "managed half stop-loss") {
          params.pos.halfStopped = true;
        }
        if (params.decision.holdRestAfterFill) {
          params.pos.holdRestToSettlement = true;
        }
        if (remainingShares > EPSILON) {
          params.pos.shares = remainingShares;
          params.state.closing = false;
          return;
        }
        params.state.position = null;
        releaseOnce(params.state, params.release);
      },
      onExpired() {
        params.state.closing = false;
        params.ctx.log(
          `[${params.ctx.slug}] btc-5m-arb: SELL ${params.pos.side} expired (${params.decision.reason})`,
          "yellow",
        );
      },
      onFailed(reason) {
        params.state.closing = false;
        params.ctx.log(
          `[${params.ctx.slug}] btc-5m-arb: SELL ${params.pos.side} failed (${reason})`,
          "red",
        );
      },
    },
  ]);
}

export const btc5mArb: Strategy = async (ctx) => {
  if (Env.get("PROD")) {
    ctx.log(
      "[btc-5m-arb] Strategy is simulation-first. Remove this guard only after fresh replay and small-size paper runs are stable.",
      "red",
    );
    process.exit(1);
  }

  if (Env.get("MARKET_ASSET") !== "btc" || Env.get("MARKET_WINDOW") !== "5m") {
    ctx.log("[btc-5m-arb] Strategy only supports BTC 5m markets.", "yellow");
    return;
  }

  const release = ctx.hold();
  const stats = createEdgeStats();
  const state: State = {
    entryOrderSubmitted: false,
    pendingEntry: false,
    position: null,
    closing: false,
    released: false,
    settlementHoldLogged: false,
  };

  const interval = setInterval(() => {
    const now = Date.now();
    const remaining = Math.floor((ctx.slotEndMs - now) / 1000);
    const elapsed = Math.max(0, (now - ctx.slotStartMs) / 1000);
    if (remaining <= 0) {
      clearInterval(interval);
      releaseOnce(state, release);
      return;
    }

    const priceToBeat = ctx.getMarketResult()?.openPrice ?? null;
    const btcPrice = ctx.ticker.price ?? null;
    if (priceToBeat === null || btcPrice === null) return;

    const gap = btcPrice - priceToBeat;
    updateStats(stats, btcPrice, gap, now);

    const entry = chooseEntry({ ctx, gap, elapsed, stats, state });
    if (entry) {
      const entryMetrics = metrics({
        elapsed,
        remaining,
        btcPrice,
        priceToBeat,
        gap,
        stats,
        entry,
      });
      const signalId = ctx.recordSignal({
        action: "buy",
        side: entry.side,
        label: `btc-5m-arb ${entry.kind} entry`,
        metrics: entryMetrics,
      });
      state.entryOrderSubmitted = true;
      state.pendingEntry = true;
      ctx.log(
        `[${ctx.slug}] btc-5m-arb: signal BUY ${entry.kind} ${entry.side} @ ${entry.price} tp ${entry.takeProfitPrice}`,
        "cyan",
      );
      ctx.postOrders([
        {
          req: {
            tokenId: entry.tokenId,
            action: "buy",
            price: entry.price,
            shares: entry.shares,
            orderType: CONFIG.entryOrderType,
          },
          expireAtMs: Math.min(
            ctx.slotStartMs + CONFIG.entryEndElapsedSeconds * 1000,
            now + CONFIG.entryOrderTtlMs,
          ),
          analysis: {
            signalId,
            label: `btc-5m-arb ${entry.kind} entry`,
            metrics: entryMetrics,
          },
          onFilled(filledShares) {
            state.pendingEntry = false;
            state.position = {
              kind: entry.kind,
              side: entry.side,
              tokenId: entry.tokenId,
              entryPrice: entry.price,
              entryMs: Date.now(),
              entryGap: gap,
              initialShares: filledShares,
              shares: filledShares,
              takeProfitRatio: entry.takeProfitRatio,
              takeProfitPrice: entry.takeProfitPrice,
              costCovered: false,
              halfStopped: false,
              holdRestToSettlement: false,
            };
            state.settlementHoldLogged = false;
            ctx.log(
              `[${ctx.slug}] btc-5m-arb: BUY ${entry.kind} ${entry.side} filled @ ${entry.price} (${filledShares} shares)`,
              "green",
            );
          },
          onExpired() {
            state.pendingEntry = false;
            ctx.log(
              `[${ctx.slug}] btc-5m-arb: BUY ${entry.kind} ${entry.side} expired @ ${entry.price}`,
              "yellow",
            );
            if (!state.position) releaseOnce(state, release);
          },
          onFailed(reason) {
            state.pendingEntry = false;
            ctx.log(
              `[${ctx.slug}] btc-5m-arb: BUY ${entry.kind} ${entry.side} failed (${reason})`,
              "red",
            );
            if (!state.position) releaseOnce(state, release);
          },
        },
      ]);
    }

    const pos = state.position;
    if (!pos || state.closing) return;

    if (elapsed >= CONFIG.holdOnlyStartElapsedSeconds) {
      if (!state.settlementHoldLogged) {
        state.settlementHoldLogged = true;
        ctx.log(
          `[${ctx.slug}] btc-5m-arb: holding ${pos.side} to settlement inside final hold-only window`,
          "cyan",
        );
      }
      return;
    }

    const bidInfo = ctx.orderBook.bestBidInfo(pos.side);
    const askInfo = ctx.orderBook.bestAskInfo(pos.side);
    const exit = chooseExit({
      ctx,
      pos,
      gap,
      ask: askInfo?.price ?? null,
      bid: bidInfo?.price ?? null,
      bidLiquidity: bidInfo?.liquidity ?? 0,
      elapsed,
    });
    if (!exit) return;
    placeSell({
      ctx,
      state,
      pos,
      decision: exit,
      gap,
      remaining,
      elapsed,
      btcPrice,
      priceToBeat,
      stats,
      release,
    });
  }, CONFIG.tickIntervalMs);

  return () => {
    clearInterval(interval);
  };
};

export const __btc5mArbTestHooks = {
  readBtc5mArbConfig,
  createEdgeStats,
  updateStats,
  chooseEntry,
  chooseExit,
  dynamicTakeProfitRatio,
  passiveBuyPrice,
  passiveSellPrice,
  sideGap,
};

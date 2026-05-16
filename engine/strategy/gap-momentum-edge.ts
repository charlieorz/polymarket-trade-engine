// Gap Momentum Edge Strategy

import type { Strategy, StrategyContext, StrategyMetrics } from "./types.ts";
import { Env } from "../../utils/config.ts";

type Side = "UP" | "DOWN";
type OrderType = "GTC" | "FOK";

type Config = {
  tickIntervalMs: number;
  statsIntervalMs: number;
  atrPeriod: number;
  velocityEmaPeriod: number;
  trendLookback: number;
  noEntryFirstSeconds: number;
  maxEntryElapsedSeconds: number;
  finalWindowSeconds: number;
  holdOnlySeconds: number;
  orderUsd: number;
  maxEntriesPerMarket: number;
  entryOrderType: OrderType;
  entryOrderTtlMs: number;
  takeProfitOrderType: OrderType;
  takeProfitOrderTtlMs: number;
  finalDirectTakeProfitOrderType: OrderType;
  finalExitOrderType: OrderType;
  finalExitOrderTtlMs: number;
  maxEntryPrice: number;
  maxSpread: number;
  minEntryLiquidityUsd: number;
  minExitLiquidityUsd: number;
  minAbsGap: number;
  minGapAtr: number;
  earlyMinGapAtr: number;
  earlyRemainingSeconds: number;
  lateMinGapAtr: number;
  lateRemainingSeconds: number;
  minPeakRetainRatio: number;
  minTrendConsistency: number;
  minSideVelocityEma: number;
  minNetEdge: number;
  costBuffer: number;
  sigmaMultiplier: number;
  takeProfitMultiplier: number;
  takeProfitMaxPrice: number;
  finalDirectTakeProfitBid: number;
  finalMinFairProbability: number;
  finalMinGapAtr: number;
  finalMinPeakRetainRatio: number;
  finalSellEdgeBuffer: number;
  finalHoldEdgeBuffer: number;
};

type EdgeStats = {
  atr: number | null;
  sideVelocityEma: Record<Side, number | null>;
  gapHistory: number[];
  lastPrice: number | null;
  lastGap: number | null;
  lastUpdateMs: number;
  peakSideGap: Record<Side, number>;
};

type BookQuality = {
  ask: number;
  bid: number | null;
  askLiquidity: number;
  bidLiquidity: number;
  spread: number | null;
};

type EntryDecision = {
  side: Side;
  tokenId: string;
  ask: number;
  bid: number | null;
  price: number;
  shares: number;
  fairProbability: number;
  netEdge: number;
  sideGap: number;
  absGap: number;
  gapAtr: number;
  peakRetainRatio: number;
  trendConsistency: number;
  sideVelocityEma: number | null;
  takeProfitPrice: number;
};

type Position = {
  side: Side;
  tokenId: string;
  entryPrice: number;
  entryMs: number;
  entryGap: number;
  shares: number;
  takeProfitPrice: number;
  peakSideGap: number;
  takeProfitOrderPlaced: boolean;
  finalDirectTakeProfitPlaced: boolean;
};

type State = {
  entries: number;
  pendingEntry: boolean;
  position: Position | null;
  closing: boolean;
  released: boolean;
  settlementHoldLogged: boolean;
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
  return value === "GTC" || value === "FOK" ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function roundPrice(value: number): number {
  return clamp(Math.floor(value * 100 + EPSILON) / 100, 0.01, 0.99);
}

export function readGapMomentumEdgeConfig(
  env: Record<string, string | undefined> = process.env,
): Config {
  return {
    tickIntervalMs: Math.max(50, parseNumberEnv(env, "GME_TICK_INTERVAL_MS", 200)),
    statsIntervalMs: Math.max(250, parseNumberEnv(env, "GME_STATS_INTERVAL_MS", 1000)),
    atrPeriod: Math.max(2, parseNumberEnv(env, "GME_ATR_PERIOD", 14)),
    velocityEmaPeriod: Math.max(2, parseNumberEnv(env, "GME_VELOCITY_EMA_PERIOD", 6)),
    trendLookback: Math.max(3, Math.floor(parseNumberEnv(env, "GME_TREND_LOOKBACK", 10))),
    noEntryFirstSeconds: Math.max(0, parseNumberEnv(env, "GME_NO_ENTRY_FIRST_SECONDS", 20)),
    maxEntryElapsedSeconds: Math.max(
      0,
      parseNumberEnv(env, "GME_MAX_ENTRY_ELAPSED_SECONDS", 250),
    ),
    finalWindowSeconds: Math.max(1, parseNumberEnv(env, "GME_FINAL_WINDOW_SECONDS", 40)),
    holdOnlySeconds: Math.max(0, parseNumberEnv(env, "GME_HOLD_ONLY_SECONDS", 5)),
    orderUsd: Math.max(1, parseNumberEnv(env, "GME_ORDER_USD", 5)),
    maxEntriesPerMarket: Math.max(
      1,
      Math.floor(parseNumberEnv(env, "GME_MAX_ENTRIES_PER_MARKET", 1)),
    ),
    entryOrderType: parseOrderTypeEnv(env, "GME_ENTRY_ORDER_TYPE", "GTC"),
    entryOrderTtlMs: Math.max(250, parseNumberEnv(env, "GME_ENTRY_ORDER_TTL_MS", 2500)),
    takeProfitOrderType: parseOrderTypeEnv(env, "GME_TAKE_PROFIT_ORDER_TYPE", "GTC"),
    takeProfitOrderTtlMs: Math.max(
      250,
      parseNumberEnv(env, "GME_TAKE_PROFIT_ORDER_TTL_MS", 5000),
    ),
    finalDirectTakeProfitOrderType: parseOrderTypeEnv(
      env,
      "GME_FINAL_DIRECT_TP_ORDER_TYPE",
      "GTC",
    ),
    finalExitOrderType: parseOrderTypeEnv(env, "GME_FINAL_EXIT_ORDER_TYPE", "FOK"),
    finalExitOrderTtlMs: Math.max(
      250,
      parseNumberEnv(env, "GME_FINAL_EXIT_ORDER_TTL_MS", 1500),
    ),
    maxEntryPrice: clamp(parseNumberEnv(env, "GME_MAX_ENTRY_PRICE", 0.6), 0.01, 0.99),
    maxSpread: Math.max(0, parseNumberEnv(env, "GME_MAX_SPREAD", 0.04)),
    minEntryLiquidityUsd: Math.max(0, parseNumberEnv(env, "GME_MIN_ENTRY_LIQUIDITY_USD", 8)),
    minExitLiquidityUsd: Math.max(0, parseNumberEnv(env, "GME_MIN_EXIT_LIQUIDITY_USD", 5)),
    minAbsGap: Math.max(0, parseNumberEnv(env, "GME_MIN_ABS_GAP", 8)),
    minGapAtr: Math.max(0, parseNumberEnv(env, "GME_MIN_GAP_ATR", 2)),
    earlyMinGapAtr: Math.max(0, parseNumberEnv(env, "GME_EARLY_MIN_GAP_ATR", 3)),
    earlyRemainingSeconds: Math.max(
      0,
      parseNumberEnv(env, "GME_EARLY_REMAINING_SECONDS", 120),
    ),
    lateMinGapAtr: Math.max(0, parseNumberEnv(env, "GME_LATE_MIN_GAP_ATR", 1.5)),
    lateRemainingSeconds: Math.max(
      0,
      parseNumberEnv(env, "GME_LATE_REMAINING_SECONDS", 60),
    ),
    minPeakRetainRatio: clamp(parseNumberEnv(env, "GME_MIN_PEAK_RETAIN_RATIO", 0.75), 0, 1),
    minTrendConsistency: clamp(parseNumberEnv(env, "GME_MIN_TREND_CONSISTENCY", 0.6), 0, 1),
    minSideVelocityEma: parseNumberEnv(env, "GME_MIN_SIDE_VELOCITY_EMA", 0.05),
    minNetEdge: Math.max(0, parseNumberEnv(env, "GME_MIN_NET_EDGE", 0.03)),
    costBuffer: Math.max(0, parseNumberEnv(env, "GME_COST_BUFFER", 0.005)),
    sigmaMultiplier: Math.max(0.1, parseNumberEnv(env, "GME_SIGMA_MULTIPLIER", 1.25)),
    takeProfitMultiplier: Math.max(
      1,
      parseNumberEnv(env, "GME_TAKE_PROFIT_MULTIPLIER", 1.3),
    ),
    takeProfitMaxPrice: clamp(parseNumberEnv(env, "GME_TAKE_PROFIT_MAX_PRICE", 0.9), 0.01, 0.99),
    finalDirectTakeProfitBid: clamp(
      parseNumberEnv(env, "GME_FINAL_DIRECT_TP_BID", 0.9),
      0.01,
      0.99,
    ),
    finalMinFairProbability: clamp(
      parseNumberEnv(env, "GME_FINAL_MIN_FAIR_PROBABILITY", 0.88),
      0,
      1,
    ),
    finalMinGapAtr: Math.max(0, parseNumberEnv(env, "GME_FINAL_MIN_GAP_ATR", 1.5)),
    finalMinPeakRetainRatio: clamp(
      parseNumberEnv(env, "GME_FINAL_MIN_PEAK_RETAIN_RATIO", 0.7),
      0,
      1,
    ),
    finalSellEdgeBuffer: Math.max(0, parseNumberEnv(env, "GME_FINAL_SELL_EDGE_BUFFER", 0.02)),
    finalHoldEdgeBuffer: Math.max(0, parseNumberEnv(env, "GME_FINAL_HOLD_EDGE_BUFFER", 0.03)),
  };
}

const CONFIG = readGapMomentumEdgeConfig();

function normalCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const abs = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * abs);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const erf =
    sign *
    (1 -
      (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) *
        t *
        Math.exp(-abs * abs)));
  return 0.5 * (1 + erf);
}

function computeFairProbability(params: {
  sideGap: number;
  remaining: number;
  atr: number | null;
  config?: Config;
}): { pFair: number; sigmaPerSecond: number | null; zToBoundary: number | null } {
  const config = params.config ?? CONFIG;
  if (params.atr === null || params.atr <= 0 || params.remaining <= 0) {
    return { pFair: 0.5, sigmaPerSecond: null, zToBoundary: null };
  }
  const sigmaPerSecond = params.atr * Math.sqrt(Math.PI / 2) * config.sigmaMultiplier;
  const sigmaToClose = sigmaPerSecond * Math.sqrt(params.remaining);
  const zToBoundary = params.sideGap / Math.max(sigmaToClose, EPSILON);
  return {
    pFair: clamp(normalCdf(zToBoundary), 0, 1),
    sigmaPerSecond,
    zToBoundary,
  };
}

function createEdgeStats(): EdgeStats {
  return {
    atr: null,
    sideVelocityEma: { UP: null, DOWN: null },
    gapHistory: [],
    lastPrice: null,
    lastGap: null,
    lastUpdateMs: 0,
    peakSideGap: { UP: 0, DOWN: 0 },
  };
}

function ema(previous: number | null, value: number, period: number): number {
  return previous === null ? value : (previous * (period - 1) + value) / period;
}

function sideGap(side: Side, gap: number): number {
  return side === "UP" ? gap : -gap;
}

function updateStats(
  stats: EdgeStats,
  price: number,
  gap: number,
  now = Date.now(),
  config = CONFIG,
): void {
  if (now - stats.lastUpdateMs < config.statsIntervalMs) return;

  if (stats.lastPrice !== null) {
    stats.atr = ema(stats.atr, Math.abs(price - stats.lastPrice), config.atrPeriod);
  }

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

  const upSideGap = sideGap("UP", gap);
  const downSideGap = sideGap("DOWN", gap);
  stats.peakSideGap.UP = Math.max(stats.peakSideGap.UP, upSideGap);
  stats.peakSideGap.DOWN = Math.max(stats.peakSideGap.DOWN, downSideGap);

  stats.gapHistory.push(gap);
  if (stats.gapHistory.length > config.trendLookback + 1) stats.gapHistory.shift();
  stats.lastPrice = price;
  stats.lastGap = gap;
  stats.lastUpdateMs = now;
}

function trendConsistency(side: Side, history: number[]): number {
  if (history.length < 2) return 0;
  let confirms = 0;
  let total = 0;
  for (let i = 1; i < history.length; i++) {
    const delta = history[i]! - history[i - 1]!;
    if (Math.abs(delta) < EPSILON) continue;
    total++;
    if ((side === "UP" && delta > 0) || (side === "DOWN" && delta < 0)) {
      confirms++;
    }
  }
  return total === 0 ? 0 : confirms / total;
}

function requiredGapAtr(remaining: number, config = CONFIG): number {
  if (remaining > config.earlyRemainingSeconds) return config.earlyMinGapAtr;
  if (remaining < config.lateRemainingSeconds) return config.lateMinGapAtr;
  return config.minGapAtr;
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
}): number | null {
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
}): number | null {
  const improveAsk = params.ask === null ? params.bid + params.tick : params.ask - params.tick;
  const price = roundPrice(Math.max(params.bid + params.tick, improveAsk, params.minPrice));
  if (price <= params.bid) return null;
  return price;
}

function sharesForBudget(orderUsd: number, price: number): number {
  return Math.floor((orderUsd / price) * 100) / 100;
}

function chooseEntry(params: {
  ctx: StrategyContext;
  gap: number;
  remaining: number;
  elapsed: number;
  stats: EdgeStats;
  state: State;
  config?: Config;
}): EntryDecision | null {
  const config = params.config ?? CONFIG;
  if (params.state.pendingEntry || params.state.position || params.state.closing) return null;
  if (params.state.entries >= config.maxEntriesPerMarket) return null;
  if (params.elapsed < config.noEntryFirstSeconds) return null;
  if (params.elapsed > config.maxEntryElapsedSeconds) return null;
  if (params.remaining <= config.finalWindowSeconds) return null;
  if (params.gap === 0 || params.stats.atr === null) return null;

  const side: Side = params.gap > 0 ? "UP" : "DOWN";
  const sideCurrentGap = sideGap(side, params.gap);
  const absGap = Math.abs(params.gap);
  const gapAtr = absGap / Math.max(params.stats.atr, EPSILON);
  const neededGapAtr = requiredGapAtr(params.remaining, config);
  const peak = Math.max(params.stats.peakSideGap[side], sideCurrentGap);
  const peakRetainRatio = peak > 0 ? sideCurrentGap / peak : 0;
  const consistency = trendConsistency(side, params.stats.gapHistory);
  const velocityEma = params.stats.sideVelocityEma[side];
  const quality = bookQuality(params.ctx, side);
  if (!quality) return null;

  if (quality.ask > config.maxEntryPrice) return null;
  if (quality.askLiquidity < config.minEntryLiquidityUsd) return null;
  if (quality.spread === null || quality.spread > config.maxSpread) return null;
  if (absGap < config.minAbsGap) return null;
  if (gapAtr < neededGapAtr) return null;
  if (peakRetainRatio < config.minPeakRetainRatio) return null;
  if (consistency < config.minTrendConsistency) return null;
  if (velocityEma === null || velocityEma < config.minSideVelocityEma) return null;

  const tokenId = side === "UP" ? params.ctx.clobTokenIds[0] : params.ctx.clobTokenIds[1];
  const price =
    config.entryOrderType === "GTC"
      ? passiveBuyPrice({
          ask: quality.ask,
          bid: quality.bid,
          tick: tickSize(params.ctx, tokenId),
          maxPrice: config.maxEntryPrice,
        })
      : roundPrice(Math.min(quality.ask, config.maxEntryPrice));
  if (price === null) return null;

  const shares = sharesForBudget(config.orderUsd, price);
  if (shares <= 0) return null;

  const fair = computeFairProbability({
    sideGap: sideCurrentGap,
    remaining: params.remaining,
    atr: params.stats.atr,
    config,
  });
  const netEdge = fair.pFair - price - config.costBuffer;
  if (netEdge < config.minNetEdge) return null;

  return {
    side,
    tokenId,
    ask: quality.ask,
    bid: quality.bid,
    price,
    shares,
    fairProbability: fair.pFair,
    netEdge,
    sideGap: sideCurrentGap,
    absGap,
    gapAtr,
    peakRetainRatio,
    trendConsistency: consistency,
    sideVelocityEma: velocityEma,
    takeProfitPrice: roundPrice(
      Math.min(price * config.takeProfitMultiplier, config.takeProfitMaxPrice),
    ),
  };
}

function updatePositionPeak(pos: Position, gap: number): void {
  pos.peakSideGap = Math.max(pos.peakSideGap, sideGap(pos.side, gap));
}

type ExitDecision = {
  price: number;
  orderType: OrderType;
  ttlMs: number;
  reason: string;
};

function chooseExit(params: {
  ctx: StrategyContext;
  pos: Position;
  gap: number;
  ask: number | null;
  bid: number | null;
  bidLiquidity: number;
  remaining: number;
  stats: EdgeStats;
  config?: Config;
}): ExitDecision | null {
  const config = params.config ?? CONFIG;
  if (params.bid === null) return null;
  if (params.bidLiquidity < config.minExitLiquidityUsd) return null;
  if (params.remaining <= config.holdOnlySeconds) return null;

  const sideCurrentGap = sideGap(params.pos.side, params.gap);
  const gapAtr =
    params.stats.atr === null ? 0 : Math.abs(params.gap) / Math.max(params.stats.atr, EPSILON);
  const peakRetainRatio =
    params.pos.peakSideGap > 0 ? sideCurrentGap / params.pos.peakSideGap : 0;
  const fair = computeFairProbability({
    sideGap: sideCurrentGap,
    remaining: params.remaining,
    atr: params.stats.atr,
    config,
  });
  const sellEV = params.bid - params.pos.entryPrice;
  const holdEV = fair.pFair - params.pos.entryPrice;

  if (params.remaining <= config.finalWindowSeconds) {
    if (params.bid >= config.finalDirectTakeProfitBid) {
      const price =
        config.finalDirectTakeProfitOrderType === "GTC"
          ? passiveSellPrice({
              ask: params.ask,
              bid: params.bid,
              tick: tickSize(params.ctx, params.pos.tokenId),
              minPrice: params.bid,
            })
          : roundPrice(params.bid);
      if (price === null) return null;
      return {
        price,
        orderType: config.finalDirectTakeProfitOrderType,
        ttlMs: Math.min(config.finalExitOrderTtlMs, Math.max(250, (params.remaining - 5) * 1000)),
        reason: "final direct take-profit",
      };
    }

    const strongHold =
      fair.pFair >= config.finalMinFairProbability &&
      gapAtr >= config.finalMinGapAtr &&
      peakRetainRatio >= config.finalMinPeakRetainRatio;
    if (strongHold) return null;

    if (sellEV > 0 && sellEV > holdEV + config.finalSellEdgeBuffer) {
      return {
        price: roundPrice(params.bid),
        orderType: config.finalExitOrderType,
        ttlMs: config.finalExitOrderTtlMs,
        reason: "final profitable ev exit",
      };
    }

    if (holdEV > sellEV + config.finalHoldEdgeBuffer) return null;

    if (sellEV > 0) {
      return {
        price: roundPrice(params.bid),
        orderType: config.finalExitOrderType,
        ttlMs: config.finalExitOrderTtlMs,
        reason: "final profitable fallback exit",
      };
    }
    return null;
  }

  if (!params.pos.takeProfitOrderPlaced && params.bid >= params.pos.takeProfitPrice) {
    const price =
      config.takeProfitOrderType === "GTC"
        ? passiveSellPrice({
            ask: params.ask,
            bid: params.bid,
            tick: tickSize(params.ctx, params.pos.tokenId),
            minPrice: params.pos.takeProfitPrice,
          })
        : roundPrice(params.bid);
    if (price === null) return null;
    return {
      price,
      orderType: config.takeProfitOrderType,
      ttlMs: config.takeProfitOrderTtlMs,
      reason: "planned take-profit",
    };
  }

  return null;
}

function releaseOnce(state: State, release: () => void): void {
  if (state.released) return;
  state.released = true;
  release();
}

function metrics(params: {
  remaining: number;
  elapsed: number;
  btcPrice: number;
  priceToBeat: number;
  gap: number;
  stats: EdgeStats;
  entry?: EntryDecision;
  pos?: Position;
  exitReason?: string;
}): StrategyMetrics {
  const side = params.entry?.side ?? params.pos?.side ?? (params.gap >= 0 ? "UP" : "DOWN");
  const activeSideGap = sideGap(side, params.gap);
  const fair = computeFairProbability({
    sideGap: activeSideGap,
    remaining: params.remaining,
    atr: params.stats.atr,
  });
  return {
    strategy: "gap-momentum-edge",
    remaining: Math.round(params.remaining),
    elapsed: Math.round(params.elapsed),
    btcPrice: Number(params.btcPrice.toFixed(2)),
    priceToBeat: Number(params.priceToBeat.toFixed(2)),
    gap: Number(params.gap.toFixed(2)),
    side,
    atr: params.stats.atr === null ? null : Number(params.stats.atr.toFixed(4)),
    gapAtr:
      params.stats.atr === null
        ? null
        : Number((Math.abs(params.gap) / Math.max(params.stats.atr, EPSILON)).toFixed(4)),
    sideVelocityEma:
      params.stats.sideVelocityEma[side] === null
        ? null
        : Number(params.stats.sideVelocityEma[side]!.toFixed(4)),
    peakRetainRatio:
      params.stats.peakSideGap[side] > 0
        ? Number((activeSideGap / params.stats.peakSideGap[side]).toFixed(4))
        : null,
    fairProbability: Number(fair.pFair.toFixed(4)),
    zToBoundary: fair.zToBoundary === null ? null : Number(fair.zToBoundary.toFixed(4)),
    entryPrice: params.entry?.price ?? params.pos?.entryPrice ?? null,
    entryAsk: params.entry?.ask ?? null,
    netEdge: params.entry?.netEdge === undefined ? null : Number(params.entry.netEdge.toFixed(4)),
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
  const orderMetrics = metrics({
    remaining: params.remaining,
    elapsed: params.elapsed,
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
    label: `gap-momentum-edge ${params.decision.reason}`,
    metrics: orderMetrics,
  });
  params.ctx.postOrders([
    {
      req: {
        tokenId: params.pos.tokenId,
        action: "sell",
        price: params.decision.price,
        shares: params.pos.shares,
        orderType: params.decision.orderType,
      },
      expireAtMs: Math.min(
        params.ctx.slotEndMs - CONFIG.holdOnlySeconds * 1000,
        Date.now() + params.decision.ttlMs,
      ),
      analysis: {
        signalId,
        label: `gap-momentum-edge ${params.decision.reason}`,
        metrics: orderMetrics,
      },
      onFilled(filledShares) {
        const remainingShares = params.pos.shares - filledShares;
        params.ctx.log(
          `[${params.ctx.slug}] gap-momentum-edge: SELL ${params.pos.side} filled @ ${params.decision.price} (${filledShares} shares, ${params.decision.reason})`,
          "green",
        );
        if (remainingShares > 0.001) {
          params.pos.shares = remainingShares;
          params.pos.takeProfitOrderPlaced = false;
          params.pos.finalDirectTakeProfitPlaced = false;
          params.state.closing = false;
          return;
        }
        params.state.position = null;
        releaseOnce(params.state, params.release);
      },
      onExpired() {
        params.state.closing = false;
        params.ctx.log(
          `[${params.ctx.slug}] gap-momentum-edge: SELL ${params.pos.side} expired (${params.decision.reason})`,
          "yellow",
        );
      },
      onFailed(reason) {
        params.state.closing = false;
        params.ctx.log(
          `[${params.ctx.slug}] gap-momentum-edge: SELL ${params.pos.side} failed (${reason})`,
          "red",
        );
      },
    },
  ]);
}

export const gapMomentumEdge: Strategy = async (ctx) => {
  if (Env.get("PROD")) {
    ctx.log(
      "[gap-momentum-edge] Strategy is simulation-first. Remove this guard only after fresh replay and small-size paper runs are stable.",
      "red",
    );
    process.exit(1);
  }

  if (Env.get("MARKET_ASSET") !== "btc" || Env.get("MARKET_WINDOW") !== "5m") {
    ctx.log("[gap-momentum-edge] Strategy only supports BTC 5m markets.", "yellow");
    return;
  }

  const release = ctx.hold();
  const stats = createEdgeStats();
  const state: State = {
    entries: 0,
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

    const entry = chooseEntry({ ctx, gap, remaining, elapsed, stats, state });
    if (entry) {
      const entryMetrics = metrics({
        remaining,
        elapsed,
        btcPrice,
        priceToBeat,
        gap,
        stats,
        entry,
      });
      const signalId = ctx.recordSignal({
        action: "buy",
        side: entry.side,
        label: "gap-momentum-edge entry",
        metrics: entryMetrics,
      });
      state.pendingEntry = true;
      ctx.log(
        `[${ctx.slug}] gap-momentum-edge: signal BUY ${entry.side} @ ${entry.price} edge ${entry.netEdge.toFixed(3)}`,
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
            ctx.slotEndMs - CONFIG.finalWindowSeconds * 1000,
            now + CONFIG.entryOrderTtlMs,
          ),
          analysis: {
            signalId,
            label: "gap-momentum-edge entry",
            metrics: entryMetrics,
          },
          onFilled(filledShares) {
            state.pendingEntry = false;
            state.entries++;
            state.position = {
              side: entry.side,
              tokenId: entry.tokenId,
              entryPrice: entry.price,
              entryMs: Date.now(),
              entryGap: gap,
              shares: filledShares,
              takeProfitPrice: entry.takeProfitPrice,
              peakSideGap: entry.sideGap,
              takeProfitOrderPlaced: false,
              finalDirectTakeProfitPlaced: false,
            };
            state.settlementHoldLogged = false;
            ctx.log(
              `[${ctx.slug}] gap-momentum-edge: BUY ${entry.side} filled @ ${entry.price} (${filledShares} shares)`,
              "green",
            );
          },
          onExpired() {
            state.pendingEntry = false;
            ctx.log(
              `[${ctx.slug}] gap-momentum-edge: BUY ${entry.side} expired @ ${entry.price}`,
              "yellow",
            );
            if (!state.position) releaseOnce(state, release);
          },
          onFailed(reason) {
            state.pendingEntry = false;
            ctx.log(
              `[${ctx.slug}] gap-momentum-edge: BUY ${entry.side} failed (${reason})`,
              "red",
            );
            if (!state.position) releaseOnce(state, release);
          },
        },
      ]);
    }

    const pos = state.position;
    if (!pos || state.closing) return;
    updatePositionPeak(pos, gap);

    if (remaining <= CONFIG.holdOnlySeconds) {
      if (!state.settlementHoldLogged) {
        state.settlementHoldLogged = true;
        ctx.log(
          `[${ctx.slug}] gap-momentum-edge: holding ${pos.side} to settlement inside final ${CONFIG.holdOnlySeconds}s`,
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
      remaining,
      stats,
    });
    if (!exit) return;
    if (exit.reason === "planned take-profit") pos.takeProfitOrderPlaced = true;
    if (exit.reason === "final direct take-profit") pos.finalDirectTakeProfitPlaced = true;
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

export const __gapMomentumEdgeTestHooks = {
  readGapMomentumEdgeConfig,
  createEdgeStats,
  updateStats,
  computeFairProbability,
  chooseEntry,
  chooseExit,
  trendConsistency,
  passiveBuyPrice,
  requiredGapAtr,
};

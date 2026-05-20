// BTC 5m high-frequency gap arbitrage strategy.

import type { Strategy, StrategyContext, StrategyMetrics } from "./types.ts";
import { Env } from "../../utils/config.ts";

type Side = "UP" | "DOWN";
type EntryKind = "advantage";
type OrderType = "GTC" | "FOK" | "FAK";

type Config = {
  allowProd: boolean;
  tickIntervalMs: number;
  statsIntervalMs: number;
  velocityEmaPeriod: number;
  trendLookback: number;
  shares: number;
  maxMarketLoss: number;
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
  minEntryPrice: number;
  maxEntryPrice: number;
  maxAdvantagePrice: number;
  enableAdvantage: boolean;
  advantageMinAbsGap: number;
  advantageMinMomentum: number;
  advantageMinCumulativeGap: number;
  minTakeProfitRatio: number;
  maxTakeProfitRatio: number;
  earlyEntryCutoffSeconds: number;
  lateEntryCutoffSeconds: number;
  earlyTakeProfitBonus: number;
  lateTakeProfitDiscount: number;
  earlyStopLossBonus: number;
  lateStopLossDiscount: number;
  takeProfitPriceImmediate: number;
  fullTakeProfitRatio: number;
  halfStopLossRatio: number;
  fullStopLossRatio: number;
  stopLossStartElapsedSeconds: number;
  stopLossMinHoldSeconds: number;
  entryTakeProfitEnabled: boolean;
  managedTakeProfitEnabled: boolean;
  stopLossEnabled: boolean;
  smallProfitExitMode:
    | "cost_cover_hold"
    | "cost_cover_continue"
    | "full_exit"
    | "none";
  halfStopHoldRestToSettlement: boolean;
  dynamicTpPriceWeight: number;
  dynamicTpGapWeight: number;
  dynamicTpMomentumWeight: number;
  recentResultWindow: number;
  recentResultWeight: number;
  recentResultMinBias: number;
  recentCandleWindow: number;
  recentTrendWeight: number;
  recentTrendMinBias: number;
  settlementTrendHoldMinBias: number;
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
  halfStopLossRatio: number;
  fullStopLossRatio: number;
  recentBias: number;
  recentTrendFactor: number;
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
  halfStopLossRatio: number;
  fullStopLossRatio: number;
  costCovered: boolean;
  halfStopped: boolean;
  holdRestToSettlement: boolean;
  recentTrendFactor: number;
};

type MarketCandle = {
  open: number;
  high: number;
  low: number;
  close: number;
  direction: Side;
};

type State = {
  pendingEntry: boolean;
  position: Position | null;
  closing: boolean;
  realizedPnl: number;
  marketLossBlocked: boolean;
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
const RECENT_MARKET_RESULTS: Side[] = [];
const RECENT_MARKET_CANDLES: MarketCandle[] = [];

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
  return value === "GTC" || value === "FOK" || value === "FAK"
    ? value
    : fallback;
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
  const value = env.B5H_SMALL_PROFIT_EXIT_MODE?.trim().toLowerCase();
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

export function readBtc5mHfArbConfig(
  env: Record<string, string | undefined> = process.env,
): Config {
  return {
    allowProd: parseBooleanEnv(env, "B5H_ALLOW_PROD", false),
    tickIntervalMs: Math.max(
      50,
      parseNumberEnv(env, "B5H_TICK_INTERVAL_MS", 200),
    ),
    statsIntervalMs: Math.max(
      250,
      parseNumberEnv(env, "B5H_STATS_INTERVAL_MS", 1000),
    ),
    velocityEmaPeriod: Math.max(
      2,
      parseNumberEnv(env, "B5H_VELOCITY_EMA_PERIOD", 5),
    ),
    trendLookback: Math.max(
      3,
      Math.floor(parseNumberEnv(env, "B5H_TREND_LOOKBACK", 8)),
    ),
    shares: Math.max(0.01, parseNumberEnv(env, "B5H_SHARES", 6)),
    maxMarketLoss: Math.max(0, parseNumberEnv(env, "B5H_MAX_MARKET_LOSS", 2)),
    entryStartElapsedSeconds: Math.max(
      0,
      parseNumberEnv(env, "B5H_ENTRY_START_SECONDS", 30),
    ),
    entryEndElapsedSeconds: Math.max(
      0,
      parseNumberEnv(env, "B5H_ENTRY_END_SECONDS", 280),
    ),
    managedExitStartElapsedSeconds: Math.max(
      0,
      parseNumberEnv(env, "B5H_MANAGED_EXIT_START_SECONDS", 80),
    ),
    holdOnlyStartElapsedSeconds: Math.max(
      0,
      parseNumberEnv(env, "B5H_HOLD_ONLY_START_SECONDS", 300),
    ),
    entryOrderType: parseOrderTypeEnv(env, "B5H_ENTRY_ORDER_TYPE", "FAK"),
    entryOrderTtlMs: Math.max(
      250,
      parseNumberEnv(env, "B5H_ENTRY_ORDER_TTL_MS", 750),
    ),
    takeProfitOrderType: parseOrderTypeEnv(
      env,
      "B5H_TAKE_PROFIT_ORDER_TYPE",
      "FAK",
    ),
    takeProfitOrderTtlMs: Math.max(
      250,
      parseNumberEnv(env, "B5H_TAKE_PROFIT_ORDER_TTL_MS", 3000),
    ),
    stopLossOrderType: parseOrderTypeEnv(
      env,
      "B5H_STOP_LOSS_ORDER_TYPE",
      "FAK",
    ),
    stopLossOrderTtlMs: Math.max(
      250,
      parseNumberEnv(env, "B5H_STOP_LOSS_ORDER_TTL_MS", 1200),
    ),
    maxSpread: Math.max(0, parseNumberEnv(env, "B5H_MAX_SPREAD", 0.05)),
    minEntryLiquidityUsd: Math.max(
      0,
      parseNumberEnv(env, "B5H_MIN_ENTRY_LIQUIDITY_USD", 5),
    ),
    minExitLiquidityUsd: Math.max(
      0,
      parseNumberEnv(env, "B5H_MIN_EXIT_LIQUIDITY_USD", 5),
    ),
    minEntryPrice: clamp(
      parseNumberEnv(env, "B5H_MIN_ENTRY_PRICE", 0.48),
      0.01,
      0.99,
    ),
    maxEntryPrice: clamp(
      parseNumberEnv(env, "B5H_MAX_ENTRY_PRICE", 0.52),
      0.01,
      0.99,
    ),
    maxAdvantagePrice: clamp(
      parseNumberEnv(env, "B5H_MAX_ADVANTAGE_PRICE", 0.52),
      0.01,
      0.99,
    ),
    enableAdvantage: parseBooleanEnv(env, "B5H_ENABLE_ADVANTAGE", true),
    advantageMinAbsGap: Math.max(
      0,
      parseNumberEnv(env, "B5H_ADV_MIN_ABS_GAP", 2.5),
    ),
    advantageMinMomentum: Math.max(
      0,
      parseNumberEnv(env, "B5H_ADV_MIN_MOMENTUM", 0.12),
    ),
    advantageMinCumulativeGap: Math.max(
      0,
      parseNumberEnv(env, "B5H_ADV_MIN_CUMULATIVE_GAP", 10),
    ),
    minTakeProfitRatio: Math.max(
      0.02,
      parseNumberEnv(env, "B5H_MIN_TAKE_PROFIT_RATIO", 0.06),
    ),
    maxTakeProfitRatio: Math.max(
      0.12,
      parseNumberEnv(env, "B5H_MAX_TAKE_PROFIT_RATIO", 0.22),
    ),
    earlyEntryCutoffSeconds: Math.max(
      0,
      parseNumberEnv(env, "B5H_EARLY_ENTRY_CUTOFF_SECONDS", 150),
    ),
    lateEntryCutoffSeconds: Math.max(
      0,
      parseNumberEnv(env, "B5H_LATE_ENTRY_CUTOFF_SECONDS", 230),
    ),
    earlyTakeProfitBonus: Math.max(
      0,
      parseNumberEnv(env, "B5H_EARLY_TAKE_PROFIT_BONUS", 0.06),
    ),
    lateTakeProfitDiscount: Math.max(
      0,
      parseNumberEnv(env, "B5H_LATE_TAKE_PROFIT_DISCOUNT", 0.06),
    ),
    earlyStopLossBonus: Math.max(
      0,
      parseNumberEnv(env, "B5H_EARLY_STOP_LOSS_BONUS", 0.08),
    ),
    lateStopLossDiscount: Math.max(
      0,
      parseNumberEnv(env, "B5H_LATE_STOP_LOSS_DISCOUNT", 0.1),
    ),
    takeProfitPriceImmediate: clamp(
      parseNumberEnv(env, "B5H_TAKE_PROFIT_PRICE_IMMEDIATE", 0.66),
      0.01,
      0.99,
    ),
    fullTakeProfitRatio: Math.max(
      0,
      parseNumberEnv(env, "B5H_FULL_TAKE_PROFIT_RATIO", 0.14),
    ),
    halfStopLossRatio: clamp(
      parseNumberEnv(env, "B5H_HALF_STOP_LOSS_RATIO", 0.24),
      0,
      0.99,
    ),
    fullStopLossRatio: clamp(
      parseNumberEnv(env, "B5H_FULL_STOP_LOSS_RATIO", 0.24),
      0,
      0.99,
    ),
    stopLossStartElapsedSeconds: Math.max(
      0,
      parseNumberEnv(env, "B5H_STOP_LOSS_START_SECONDS", 60),
    ),
    stopLossMinHoldSeconds: Math.max(
      0,
      parseNumberEnv(env, "B5H_STOP_LOSS_MIN_HOLD_SECONDS", 8),
    ),
    entryTakeProfitEnabled: parseBooleanEnv(
      env,
      "B5H_ENTRY_TAKE_PROFIT_ENABLED",
      true,
    ),
    managedTakeProfitEnabled: parseBooleanEnv(
      env,
      "B5H_MANAGED_TAKE_PROFIT_ENABLED",
      true,
    ),
    stopLossEnabled: parseBooleanEnv(env, "B5H_STOP_LOSS_ENABLED", true),
    smallProfitExitMode: parseSmallProfitExitModeEnv(env),
    halfStopHoldRestToSettlement: parseBooleanEnv(
      env,
      "B5H_HALF_STOP_HOLD_REST_TO_SETTLEMENT",
      false,
    ),
    dynamicTpPriceWeight: Math.max(
      0,
      parseNumberEnv(env, "B5H_DYNAMIC_TP_PRICE_WEIGHT", 0.1),
    ),
    dynamicTpGapWeight: Math.max(
      0,
      parseNumberEnv(env, "B5H_DYNAMIC_TP_GAP_WEIGHT", 0.08),
    ),
    dynamicTpMomentumWeight: Math.max(
      0,
      parseNumberEnv(env, "B5H_DYNAMIC_TP_MOMENTUM_WEIGHT", 0.06),
    ),
    recentResultWindow: Math.max(
      0,
      Math.floor(parseNumberEnv(env, "B5H_RECENT_RESULT_WINDOW", 10)),
    ),
    recentResultWeight: Math.max(
      0,
      parseNumberEnv(env, "B5H_RECENT_RESULT_WEIGHT", 0.08),
    ),
    recentResultMinBias: parseNumberEnv(env, "B5H_RECENT_RESULT_MIN_BIAS", -0.1),
    recentCandleWindow: Math.max(
      0,
      Math.floor(parseNumberEnv(env, "B5H_RECENT_CANDLE_WINDOW", 50)),
    ),
    recentTrendWeight: Math.max(
      0,
      parseNumberEnv(env, "B5H_RECENT_TREND_WEIGHT", 0.08),
    ),
    recentTrendMinBias: parseNumberEnv(env, "B5H_RECENT_TREND_MIN_BIAS", -0.5),
    settlementTrendHoldMinBias: parseNumberEnv(
      env,
      "B5H_SETTLEMENT_TREND_HOLD_MIN_BIAS",
      0.45,
    ),
  };
}

const CONFIG = readBtc5mHfArbConfig();

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

function recordRecentMarketResult(direction: Side, config = CONFIG): void {
  if (config.recentResultWindow <= 0) return;
  RECENT_MARKET_RESULTS.push(direction);
  while (RECENT_MARKET_RESULTS.length > config.recentResultWindow) {
    RECENT_MARKET_RESULTS.shift();
  }
}

function recordRecentMarketCandle(
  candle: Omit<MarketCandle, "direction">,
  config = CONFIG,
): void {
  if (config.recentCandleWindow <= 0) return;
  const direction: Side = candle.close >= candle.open ? "UP" : "DOWN";
  RECENT_MARKET_CANDLES.push({ ...candle, direction });
  while (RECENT_MARKET_CANDLES.length > config.recentCandleWindow) {
    RECENT_MARKET_CANDLES.shift();
  }
}

function recentResultBias(
  side: Side,
  recentResults: readonly Side[] = RECENT_MARKET_RESULTS,
  config = CONFIG,
): number {
  if (config.recentResultWindow <= 0 || recentResults.length === 0) return 0;
  const window = recentResults.slice(-config.recentResultWindow);
  let weighted = 0;
  let totalWeight = 0;
  for (let i = 0; i < window.length; i++) {
    const weight = i + 1;
    weighted += window[i] === side ? weight : -weight;
    totalWeight += weight;
  }
  return totalWeight > 0 ? weighted / totalWeight : 0;
}

function recentTrendFactor(
  side: Side,
  recentCandles: readonly MarketCandle[] = RECENT_MARKET_CANDLES,
  config = CONFIG,
): number {
  if (config.recentCandleWindow <= 0 || recentCandles.length === 0) return 0;
  const window = recentCandles.slice(-config.recentCandleWindow);
  let weightedReturn = 0;
  let totalWeight = 0;
  let avgRange = 0;
  for (let i = 0; i < window.length; i++) {
    const candle = window[i]!;
    const range = Math.max(candle.high - candle.low, 1);
    const weight = i + 1;
    weightedReturn += ((candle.close - candle.open) / range) * weight;
    totalWeight += weight;
    avgRange += range;
  }
  avgRange = Math.max(avgRange / window.length, 1);
  const first = window[0]!;
  const last = window.at(-1)!;
  const slope = clamp((last.close - first.open) / avgRange, -1, 1);
  const lastRange = Math.max(last.high - last.low, 1);
  const closeLocation = clamp(
    ((last.close - last.low) / lastRange - 0.5) * 2,
    -1,
    1,
  );
  const raw =
    clamp(weightedReturn / Math.max(totalWeight, EPSILON), -1, 1) * 0.45 +
    slope * 0.35 +
    closeLocation * 0.2;
  return side === "UP" ? raw : -raw;
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
  if (stats.gapHistory.length > config.trendLookback + 1)
    stats.gapHistory.shift();
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
  if (params.orderType !== "GTC")
    return roundPrice(Math.min(params.ask, params.maxPrice));
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
  const improveAsk =
    params.ask === null ? params.bid + params.tick : params.ask - params.tick;
  const price = roundPrice(Math.max(params.bid, improveAsk, params.minPrice));
  if (price <= 0) return null;
  return price;
}

function timingAdjustment(
  elapsed: number,
  config: Config,
): "early" | "mid" | "late" {
  if (elapsed <= config.earlyEntryCutoffSeconds) return "early";
  if (elapsed >= config.lateEntryCutoffSeconds) return "late";
  return "mid";
}

function dynamicExitPlan(params: {
  kind: EntryKind;
  price: number;
  absGap: number;
  momentum: number;
  maxPrice: number;
  elapsed: number;
  config: Config;
}): {
  takeProfitRatio: number;
  halfStopLossRatio: number;
  fullStopLossRatio: number;
} {
  const threshold = Math.max(params.config.advantageMinAbsGap, EPSILON);
  const gapScore = clamp(params.absGap / threshold - 1, 0, 2) / 2;
  const momentumThreshold = Math.max(
    params.config.advantageMinMomentum,
    EPSILON,
  );
  const momentumScore =
    clamp(params.momentum / momentumThreshold - 1, 0, 2) / 2;
  const priceScore = clamp(
    (params.maxPrice - params.price) / params.maxPrice,
    0,
    1,
  );
  let takeProfitRatio = clamp(
    params.config.minTakeProfitRatio +
      params.config.dynamicTpPriceWeight * priceScore +
      params.config.dynamicTpGapWeight * gapScore +
      params.config.dynamicTpMomentumWeight * momentumScore,
    params.config.minTakeProfitRatio,
    params.config.maxTakeProfitRatio,
  );
  let halfStopLossRatio = params.config.halfStopLossRatio;
  let fullStopLossRatio = params.config.fullStopLossRatio;
  const timing = timingAdjustment(params.elapsed, params.config);
  if (timing === "early") {
    takeProfitRatio += params.config.earlyTakeProfitBonus;
    halfStopLossRatio += params.config.earlyStopLossBonus;
    fullStopLossRatio += params.config.earlyStopLossBonus;
  } else if (timing === "late") {
    takeProfitRatio -= params.config.lateTakeProfitDiscount;
    halfStopLossRatio -= params.config.lateStopLossDiscount;
    fullStopLossRatio -= params.config.lateStopLossDiscount;
  }
  return {
    takeProfitRatio: clamp(
      takeProfitRatio,
      params.config.minTakeProfitRatio,
      params.config.maxTakeProfitRatio,
    ),
    halfStopLossRatio: clamp(halfStopLossRatio, 0.05, 0.99),
    fullStopLossRatio: clamp(fullStopLossRatio, 0.05, 0.99),
  };
}

function dynamicTakeProfitRatio(params: {
  kind?: EntryKind;
  price: number;
  absGap: number;
  momentum: number;
  maxPrice: number;
  elapsed?: number;
  config: Config;
}): number {
  return dynamicExitPlan({
    kind: params.kind ?? "advantage",
    price: params.price,
    absGap: params.absGap,
    momentum: params.momentum,
    maxPrice: params.maxPrice,
    elapsed: params.elapsed ?? params.config.entryStartElapsedSeconds,
    config: params.config,
  }).takeProfitRatio;
}

function buildEntry(params: {
  ctx: StrategyContext;
  kind: EntryKind;
  side: Side;
  gap: number;
  elapsed: number;
  stats: EdgeStats;
  recentResults?: readonly Side[];
  recentCandles?: readonly MarketCandle[];
  config: Config;
}): EntryDecision | null {
  const maxPrice = params.config.maxAdvantagePrice;
  const quality = bookQuality(params.ctx, params.side);
  if (!quality) return null;
  if (quality.ask > maxPrice) return null;
  if (
    quality.ask < params.config.minEntryPrice ||
    quality.ask > params.config.maxEntryPrice
  ) {
    return null;
  }
  if (quality.askLiquidity < params.config.minEntryLiquidityUsd) return null;
  if (quality.spread === null || quality.spread > params.config.maxSpread)
    return null;

  const tokenId =
    params.side === "UP"
      ? params.ctx.clobTokenIds[0]
      : params.ctx.clobTokenIds[1];
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
  if (momentum === null || recentDelta === null || recentDelta <= 0)
    return null;

  if (absGap < params.config.advantageMinAbsGap) return null;
  if (momentum < params.config.advantageMinMomentum) return null;
  if (cumulativeSideGap < params.config.advantageMinCumulativeGap) return null;

  const resultBias = recentResultBias(
    params.side,
    params.recentResults,
    params.config,
  );
  if (resultBias < params.config.recentResultMinBias) return null;
  const trendFactor = recentTrendFactor(
    params.side,
    params.recentCandles,
    params.config,
  );
  if (trendFactor < params.config.recentTrendMinBias) return null;

  const exitPlan = dynamicExitPlan({
    kind: params.kind,
    price,
    absGap,
    momentum,
    maxPrice,
    elapsed: params.elapsed,
    config: params.config,
  });
  const takeProfitPrice = roundPrice(
    Math.min(0.99, price * (1 + exitPlan.takeProfitRatio)),
  );
  const score =
    exitPlan.takeProfitRatio +
    Math.max(0, maxPrice - price) +
    Math.max(0, momentum) * 0.05 +
    Math.max(0, cumulativeSideGap) * 0.0005 +
    resultBias * params.config.recentResultWeight +
    trendFactor * params.config.recentTrendWeight;

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
    takeProfitRatio: exitPlan.takeProfitRatio,
    takeProfitPrice,
    halfStopLossRatio: exitPlan.halfStopLossRatio,
    fullStopLossRatio: exitPlan.fullStopLossRatio,
    recentBias: resultBias,
    recentTrendFactor: trendFactor,
    score,
  };
}

function chooseEntry(params: {
  ctx: StrategyContext;
  gap: number;
  elapsed: number;
  stats: EdgeStats;
  state: State;
  recentResults?: readonly Side[];
  recentCandles?: readonly MarketCandle[];
  config?: Config;
}): EntryDecision | null {
  const config = params.config ?? CONFIG;
  if (params.state.pendingEntry) return null;
  if (params.state.position || params.state.closing) return null;
  if (params.state.marketLossBlocked) return null;
  if (params.elapsed < config.entryStartElapsedSeconds) return null;
  if (params.elapsed > config.entryEndElapsedSeconds) return null;
  if (params.elapsed >= config.holdOnlyStartElapsedSeconds) return null;
  if (params.gap === 0) return null;

  const gapSide: Side = params.gap > 0 ? "UP" : "DOWN";
  if (!config.enableAdvantage) return null;
  return buildEntry({
    ctx: params.ctx,
    kind: "advantage",
    side: gapSide,
    gap: params.gap,
    elapsed: params.elapsed,
    stats: params.stats,
    recentResults: params.recentResults,
    recentCandles: params.recentCandles,
    config,
  });
}

function chooseExit(params: {
  ctx: StrategyContext;
  pos: Position;
  gap: number;
  ask: number | null;
  bid: number | null;
  bidLiquidity: number;
  elapsed: number;
  nowMs?: number;
  config?: Config;
}): ExitDecision | null {
  const config = params.config ?? CONFIG;
  if (params.elapsed >= config.holdOnlyStartElapsedSeconds) return null;
  if (params.pos.holdRestToSettlement) return null;
  if (params.bid === null) return null;
  if (params.bidLiquidity < config.minExitLiquidityUsd) return null;

  const profitRatio =
    (params.bid - params.pos.entryPrice) / params.pos.entryPrice;
  const sideCurrentGap = sideGap(params.pos.side, params.gap);
  const holdSeconds =
    ((params.nowMs ?? Date.now()) - params.pos.entryMs) / 1000;
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
    if (
      config.entryTakeProfitEnabled &&
      params.bid >= params.pos.takeProfitPrice
    ) {
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
  }

  if (
    profitRatio < 0 &&
    config.stopLossEnabled &&
    params.elapsed >= config.stopLossStartElapsedSeconds &&
    holdSeconds >= config.stopLossMinHoldSeconds &&
    sideCurrentGap <= 0
  ) {
    const lossRatio = -profitRatio;
    if (lossRatio >= params.pos.fullStopLossRatio) {
      return {
        price: roundPrice(params.bid),
        shares: params.pos.shares,
        orderType: config.stopLossOrderType,
        ttlMs: config.stopLossOrderTtlMs,
        reason: "managed full stop-loss",
        holdRestAfterFill: false,
      };
    }

    if (lossRatio >= params.pos.halfStopLossRatio && !params.pos.halfStopped) {
      return {
        price: roundPrice(params.bid),
        shares: roundShares(params.pos.shares / 2),
        orderType: config.stopLossOrderType,
        ttlMs: config.stopLossOrderTtlMs,
        reason: "managed half stop-loss",
        holdRestAfterFill: config.halfStopHoldRestToSettlement,
      };
    }
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
      if (
        params.pos.recentTrendFactor >= config.settlementTrendHoldMinBias &&
        sideCurrentGap > 0
      ) {
        return null;
      }
      const costCoverShares = roundShares(
        Math.min(
          params.pos.shares,
          (params.pos.entryPrice * params.pos.initialShares) /
            Math.max(params.bid, EPSILON),
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
      if (
        costCoverShares > EPSILON &&
        costCoverShares < params.pos.shares - EPSILON
      ) {
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
  const side =
    params.entry?.side ?? params.pos?.side ?? (params.gap >= 0 ? "UP" : "DOWN");
  return {
    strategy: "btc-5m-hf-arb",
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
    cumulativeSideGap: Number(
      sideGap(side, params.stats.cumulativeGap).toFixed(2),
    ),
    entryPrice: params.entry?.price ?? params.pos?.entryPrice ?? null,
    entryAsk: params.entry?.ask ?? null,
    takeProfitRatio:
      params.entry?.takeProfitRatio ?? params.pos?.takeProfitRatio ?? null,
    takeProfitPrice:
      params.entry?.takeProfitPrice ?? params.pos?.takeProfitPrice ?? null,
    halfStopLossRatio:
      params.entry?.halfStopLossRatio ?? params.pos?.halfStopLossRatio ?? null,
    fullStopLossRatio:
      params.entry?.fullStopLossRatio ?? params.pos?.fullStopLossRatio ?? null,
    recentBias: params.entry?.recentBias ?? null,
    recentTrendFactor:
      params.entry?.recentTrendFactor ?? params.pos?.recentTrendFactor ?? null,
    exitReason: params.exitReason ?? null,
  };
}

function updateMarketLossBlock(state: State, config = CONFIG): void {
  if (config.maxMarketLoss <= 0) return;
  if (state.realizedPnl <= -config.maxMarketLoss + EPSILON) {
    state.marketLossBlocked = true;
  }
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
    label: `btc-5m-hf-arb ${params.decision.reason}`,
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
        label: `btc-5m-hf-arb ${params.decision.reason}`,
        metrics: sellMetrics,
      },
      onFilled(filledShares) {
        params.state.realizedPnl +=
          (params.decision.price - params.pos.entryPrice) * filledShares;
        updateMarketLossBlock(params.state);
        const remainingShares = roundShares(params.pos.shares - filledShares);
        params.ctx.log(
          `[${params.ctx.slug}] btc-5m-hf-arb: SELL ${params.pos.side} filled @ ${params.decision.price} (${filledShares} shares, ${params.decision.reason})`,
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
      },
      onExpired() {
        params.state.closing = false;
        params.ctx.log(
          `[${params.ctx.slug}] btc-5m-hf-arb: SELL ${params.pos.side} expired (${params.decision.reason})`,
          "yellow",
        );
      },
      onFailed(reason) {
        params.state.closing = false;
        params.ctx.log(
          `[${params.ctx.slug}] btc-5m-hf-arb: SELL ${params.pos.side} failed (${reason})`,
          "red",
        );
      },
    },
  ]);
}

export const btc5mHfArb: Strategy = async (ctx) => {
  if (Env.get("PROD") && !CONFIG.allowProd) {
    ctx.log(
      "[btc-5m-hf-arb] Strategy is simulation-first. Set B5H_ALLOW_PROD=true only after fresh replay and small-size paper runs are stable.",
      "red",
    );
    process.exit(1);
  }

  if (Env.get("MARKET_ASSET") !== "btc" || Env.get("MARKET_WINDOW") !== "5m") {
    ctx.log("[btc-5m-hf-arb] Strategy only supports BTC 5m markets.", "yellow");
    return;
  }

  const release = ctx.hold();
  const stats = createEdgeStats();
  const state: State = {
    pendingEntry: false,
    position: null,
    closing: false,
    realizedPnl: 0,
    marketLossBlocked: false,
    released: false,
    settlementHoldLogged: false,
  };
  let finalResultRecorded = false;
  let lastGap: number | null = null;
  let candle: Omit<MarketCandle, "direction"> | null = null;

  const interval = setInterval(() => {
    const now = Date.now();
    const remaining = Math.floor((ctx.slotEndMs - now) / 1000);
    const elapsed = Math.max(0, (now - ctx.slotStartMs) / 1000);
    if (remaining <= 0) {
      if (!finalResultRecorded) {
        const result = ctx.getMarketResult();
        if (result?.closePrice != null && result?.openPrice != null) {
          recordRecentMarketResult(
            result.closePrice > result.openPrice ? "UP" : "DOWN",
          );
          recordRecentMarketCandle(
            candle
              ? {
                  ...candle,
                  close: result.closePrice,
                  high: Math.max(candle.high, result.closePrice),
                  low: Math.min(candle.low, result.closePrice),
                }
              : {
                  open: result.openPrice,
                  high: Math.max(result.openPrice, result.closePrice),
                  low: Math.min(result.openPrice, result.closePrice),
                  close: result.closePrice,
                },
          );
        } else if (lastGap !== null) {
          recordRecentMarketResult(lastGap >= 0 ? "UP" : "DOWN");
          if (candle) recordRecentMarketCandle(candle);
        }
        finalResultRecorded = true;
      }
      clearInterval(interval);
      releaseOnce(state, release);
      return;
    }

    const priceToBeat = ctx.getMarketResult()?.openPrice ?? null;
    const btcPrice = ctx.ticker.price ?? null;
    if (priceToBeat === null || btcPrice === null) return;

    const gap = btcPrice - priceToBeat;
    lastGap = gap;
    candle =
      candle === null
        ? { open: priceToBeat, high: btcPrice, low: btcPrice, close: btcPrice }
        : {
            open: candle.open,
            high: Math.max(candle.high, btcPrice),
            low: Math.min(candle.low, btcPrice),
            close: btcPrice,
          };
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
        label: `btc-5m-hf-arb ${entry.kind} entry`,
        metrics: entryMetrics,
      });
      state.pendingEntry = true;
      ctx.log(
        `[${ctx.slug}] btc-5m-hf-arb: signal BUY ${entry.kind} ${entry.side} @ ${entry.price} tp ${entry.takeProfitPrice}`,
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
            label: `btc-5m-hf-arb ${entry.kind} entry`,
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
              halfStopLossRatio: entry.halfStopLossRatio,
              fullStopLossRatio: entry.fullStopLossRatio,
              costCovered: false,
              halfStopped: false,
              holdRestToSettlement: false,
              recentTrendFactor: entry.recentTrendFactor,
            };
            state.settlementHoldLogged = false;
            ctx.log(
              `[${ctx.slug}] btc-5m-hf-arb: BUY ${entry.kind} ${entry.side} filled @ ${entry.price} (${filledShares} shares)`,
              "green",
            );
          },
          onExpired() {
            state.pendingEntry = false;
            ctx.log(
              `[${ctx.slug}] btc-5m-hf-arb: BUY ${entry.kind} ${entry.side} expired @ ${entry.price}`,
              "yellow",
            );
          },
          onFailed(reason) {
            state.pendingEntry = false;
            ctx.log(
              `[${ctx.slug}] btc-5m-hf-arb: BUY ${entry.kind} ${entry.side} failed (${reason})`,
              "red",
            );
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
          `[${ctx.slug}] btc-5m-hf-arb: holding ${pos.side} to settlement inside final hold-only window`,
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
      nowMs: now,
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

export const __btc5mHfArbTestHooks = {
  readBtc5mHfArbConfig,
  createEdgeStats,
  updateStats,
  chooseEntry,
  chooseExit,
  dynamicTakeProfitRatio,
  passiveBuyPrice,
  passiveSellPrice,
  recentTrendFactor,
  recordRecentMarketCandle,
  sideGap,
};

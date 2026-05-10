// Dual edge arbitrage strategy:
// - continuation: buy the current advantage side only while gap momentum still supports it
// - reversal: buy the weak side only after an extended gap starts reverting toward zero

import type { Strategy, StrategyContext, StrategyMetrics } from "./types.ts";
import { Env } from "../../utils/config.ts";

type Side = "UP" | "DOWN";
type EntryModel = "continuation" | "reversal";

type DualEdgeConfig = {
  tickIntervalMs: number;
  statsIntervalMs: number;
  shares: number;
  minEntryRemaining: number;
  maxEntryRemaining: number;
  minEntryAsk: number;
  maxContinuationAsk: number;
  maxReversalAsk: number;
  maxSpread: number;
  minEntryLiquidity: number;
  minExitLiquidity: number;
  minContinuationAbsGap: number;
  minContinuationNormGap: number;
  minContinuationPeakGapRatio: number;
  minContinuationNetEdge: number;
  minContinuationScore: number;
  minReversalAbsGap: number;
  minReversalNormGap: number;
  minReversalGapZ: number;
  minReversalPeakRetrace: number;
  maxReversalPeakRetrace: number;
  minReversalNetEdge: number;
  minReversalScore: number;
  reversalScoreMargin: number;
  projectionSeconds: number;
  minHoldMs: number;
  reversalFailureMinHoldMs: number;
  takeProfitCents: number;
  profitLockMin: number;
  highProfitLock: number;
  trailingDrawdownCents: number;
  maxLossCents: number;
  catastrophicLossCents: number;
  trendInvalidConfirmMs: number;
  finalExitSeconds: number;
  settlementMinProbability: number;
  settlementMinSideGap: number;
  settlementAtrMultiplier: number;
  riskExitOrderTtlMs: number;
  riskExitMaxRetries: number;
};

type Quote = {
  ts: number;
  ask: number | null;
  bid: number | null;
  spread: number | null;
};

type SignalStats = {
  lastUpdateMs: number;
  lastPrice: number | null;
  lastGap: number | null;
  atr: number | null;
  gapAtr: number | null;
  gapVelocityEma: number | null;
  fastGapEma: number | null;
  slowGapEma: number | null;
  rsi: Rsi;
  gapDeltas: number[];
  priceDeltas: number[];
  absGapWindow: number[];
  peakAbsGap: number;
  quotes: Record<Side, Quote[]>;
};

type BookQuality = {
  ask: number;
  bid: number;
  askLiquidity: number;
  bidLiquidity: number;
  spread: number;
  depthImbalance: number | null;
};

type EntryDecision = {
  model: EntryModel;
  side: Side;
  ask: number;
  bid: number;
  askLiquidity: number;
  bidLiquidity: number;
  spread: number;
  depthImbalance: number | null;
  score: number;
  absGap: number;
  sideGap: number;
  normGap: number | null;
  gapZ: number | null;
  peakGapRatio: number | null;
  peakRetrace: number | null;
  velocityShort: number | null;
  velocityMid: number | null;
  acceleration: number | null;
  emaTrend: number | null;
  rsi: number | null;
  bidSlope3s: number | null;
  askSlope3s: number | null;
  pFair: number;
  netEdge: number;
  projectedGap: number;
  takeProfitPrice: number;
  stopLossPrice: number;
};

type Position = {
  model: EntryModel;
  side: Side;
  tokenId: string;
  entryPrice: number;
  entryGap: number;
  entryAbsGap: number;
  entrySideGap: number;
  entryMs: number;
  shares: number;
  pFairEntry: number;
  netEdgeEntry: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  peakSideGap: number;
  peakBid: number | null;
  trendInvalidSinceMs: number | null;
  riskExitAttempts: number;
};

type State = {
  traded: boolean;
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

function readConfig(env: Record<string, string | undefined> = process.env): DualEdgeConfig {
  return {
    tickIntervalMs: Math.max(50, parseNumberEnv(env, "DUAL_EDGE_TICK_INTERVAL_MS", 200)),
    statsIntervalMs: Math.max(250, parseNumberEnv(env, "DUAL_EDGE_STATS_INTERVAL_MS", 1000)),
    shares: Math.max(1, parseNumberEnv(env, "DUAL_EDGE_SHARES", 6)),
    minEntryRemaining: Math.max(1, parseNumberEnv(env, "DUAL_EDGE_MIN_ENTRY_REMAINING", 45)),
    maxEntryRemaining: Math.max(1, parseNumberEnv(env, "DUAL_EDGE_MAX_ENTRY_REMAINING", 240)),
    minEntryAsk: Math.max(0.01, parseNumberEnv(env, "DUAL_EDGE_MIN_ENTRY_ASK", 0.28)),
    maxContinuationAsk: Math.min(0.99, parseNumberEnv(env, "DUAL_EDGE_MAX_CONTINUATION_ASK", 0.6)),
    maxReversalAsk: Math.min(0.99, parseNumberEnv(env, "DUAL_EDGE_MAX_REVERSAL_ASK", 0.64)),
    maxSpread: Math.max(0, parseNumberEnv(env, "DUAL_EDGE_MAX_SPREAD", 0.03)),
    minEntryLiquidity: Math.max(0, parseNumberEnv(env, "DUAL_EDGE_MIN_ENTRY_LIQUIDITY", 18)),
    minExitLiquidity: Math.max(0, parseNumberEnv(env, "DUAL_EDGE_MIN_EXIT_LIQUIDITY", 6)),
    minContinuationAbsGap: Math.max(0, parseNumberEnv(env, "DUAL_EDGE_MIN_CONTINUATION_ABS_GAP", 9)),
    minContinuationNormGap: Math.max(0, parseNumberEnv(env, "DUAL_EDGE_MIN_CONTINUATION_NORM_GAP", 3)),
    minContinuationPeakGapRatio: Math.max(
      0,
      Math.min(1, parseNumberEnv(env, "DUAL_EDGE_MIN_CONTINUATION_PGR", 0.82)),
    ),
    minContinuationNetEdge: Math.max(0, parseNumberEnv(env, "DUAL_EDGE_MIN_CONTINUATION_NET_EDGE", 0.035)),
    minContinuationScore: Math.max(0, parseNumberEnv(env, "DUAL_EDGE_MIN_CONTINUATION_SCORE", 0.96)),
    minReversalAbsGap: Math.max(0, parseNumberEnv(env, "DUAL_EDGE_MIN_REVERSAL_ABS_GAP", 12)),
    minReversalNormGap: Math.max(0, parseNumberEnv(env, "DUAL_EDGE_MIN_REVERSAL_NORM_GAP", 4)),
    minReversalGapZ: Math.max(0, parseNumberEnv(env, "DUAL_EDGE_MIN_REVERSAL_GAP_Z", 1.2)),
    minReversalPeakRetrace: Math.max(
      0,
      Math.min(1, parseNumberEnv(env, "DUAL_EDGE_MIN_REVERSAL_PEAK_RETRACE", 0.16)),
    ),
    maxReversalPeakRetrace: Math.max(
      0,
      Math.min(1, parseNumberEnv(env, "DUAL_EDGE_MAX_REVERSAL_PEAK_RETRACE", 0.55)),
    ),
    minReversalNetEdge: Math.max(0, parseNumberEnv(env, "DUAL_EDGE_MIN_REVERSAL_NET_EDGE", 0.045)),
    minReversalScore: Math.max(0, parseNumberEnv(env, "DUAL_EDGE_MIN_REVERSAL_SCORE", 0.8)),
    reversalScoreMargin: Math.max(0, parseNumberEnv(env, "DUAL_EDGE_REVERSAL_SCORE_MARGIN", 0.05)),
    projectionSeconds: Math.max(0, parseNumberEnv(env, "DUAL_EDGE_PROJECTION_SECONDS", 24)),
    minHoldMs: Math.max(0, parseNumberEnv(env, "DUAL_EDGE_MIN_HOLD_MS", 12_000)),
    reversalFailureMinHoldMs: Math.max(0, parseNumberEnv(env, "DUAL_EDGE_REVERSAL_FAILURE_MIN_HOLD_MS", 4_000)),
    takeProfitCents: Math.max(0, parseNumberEnv(env, "DUAL_EDGE_TAKE_PROFIT_CENTS", 0.08)),
    profitLockMin: Math.max(0, parseNumberEnv(env, "DUAL_EDGE_PROFIT_LOCK_MIN", 0.045)),
    highProfitLock: Math.max(0, parseNumberEnv(env, "DUAL_EDGE_HIGH_PROFIT_LOCK", 0.16)),
    trailingDrawdownCents: Math.max(0, parseNumberEnv(env, "DUAL_EDGE_TRAILING_DRAWDOWN_CENTS", 0.04)),
    maxLossCents: Math.max(0.01, parseNumberEnv(env, "DUAL_EDGE_MAX_LOSS_CENTS", 0.08)),
    catastrophicLossCents: Math.max(0.01, parseNumberEnv(env, "DUAL_EDGE_CATASTROPHIC_LOSS_CENTS", 0.14)),
    trendInvalidConfirmMs: Math.max(0, parseNumberEnv(env, "DUAL_EDGE_TREND_INVALID_CONFIRM_MS", 3_000)),
    finalExitSeconds: Math.max(1, parseNumberEnv(env, "DUAL_EDGE_FINAL_EXIT_SECONDS", 30)),
    settlementMinProbability: Math.max(
      0,
      Math.min(1, parseNumberEnv(env, "DUAL_EDGE_SETTLEMENT_MIN_PROBABILITY", 0.93)),
    ),
    settlementMinSideGap: Math.max(0, parseNumberEnv(env, "DUAL_EDGE_SETTLEMENT_MIN_SIDE_GAP", 6)),
    settlementAtrMultiplier: Math.max(0, parseNumberEnv(env, "DUAL_EDGE_SETTLEMENT_ATR_MULTIPLIER", 8)),
    riskExitOrderTtlMs: Math.max(250, parseNumberEnv(env, "DUAL_EDGE_RISK_EXIT_ORDER_TTL_MS", 5000)),
    riskExitMaxRetries: Math.max(0, Math.floor(parseNumberEnv(env, "DUAL_EDGE_RISK_EXIT_MAX_RETRIES", 3))),
  };
}

const CONFIG = readConfig();

class Rsi {
  private previous: number | null = null;
  private avgGain: number | null = null;
  private avgLoss: number | null = null;
  private seedGains: number[] = [];
  private seedLosses: number[] = [];
  private current: number | null = null;

  constructor(private readonly period = 14) {}

  update(value: number): number | null {
    if (this.previous === null) {
      this.previous = value;
      return null;
    }

    const delta = value - this.previous;
    this.previous = value;
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;

    if (this.avgGain === null || this.avgLoss === null) {
      this.seedGains.push(gain);
      this.seedLosses.push(loss);
      if (this.seedGains.length >= this.period) {
        this.avgGain = this.seedGains.reduce((sum, v) => sum + v, 0) / this.period;
        this.avgLoss = this.seedLosses.reduce((sum, v) => sum + v, 0) / this.period;
        this.current = this.compute(this.avgGain, this.avgLoss);
      }
      return this.current;
    }

    this.avgGain = (this.avgGain * (this.period - 1) + gain) / this.period;
    this.avgLoss = (this.avgLoss * (this.period - 1) + loss) / this.period;
    this.current = this.compute(this.avgGain, this.avgLoss);
    return this.current;
  }

  get value(): number | null {
    return this.current;
  }

  private compute(avgGain: number, avgLoss: number): number {
    if (avgLoss <= EPSILON) return 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  }
}

function ema(previous: number | null, value: number, period: number): number {
  return previous === null ? value : (previous * (period - 1) + value) / period;
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

function round(value: number | null, digits = 4): number | null {
  return value === null ? null : parseFloat(value.toFixed(digits));
}

function createSignalStats(): SignalStats {
  return {
    lastUpdateMs: 0,
    lastPrice: null,
    lastGap: null,
    atr: null,
    gapAtr: null,
    gapVelocityEma: null,
    fastGapEma: null,
    slowGapEma: null,
    rsi: new Rsi(14),
    gapDeltas: [],
    priceDeltas: [],
    absGapWindow: [],
    peakAbsGap: 0,
    quotes: { UP: [], DOWN: [] },
  };
}

function bestAsk(ctx: StrategyContext, side: Side) {
  return ctx.orderBook.bestAskInfo(side);
}

function bestBidInfo(ctx: StrategyContext, side: Side) {
  return ctx.orderBook.bestBidInfo(side);
}

function bestBid(ctx: StrategyContext, side: Side): number | null {
  return bestBidInfo(ctx, side)?.price ?? null;
}

function sideToken(ctx: StrategyContext, side: Side): string {
  return side === "UP" ? ctx.clobTokenIds[0] : ctx.clobTokenIds[1];
}

function advantageSide(gap: number): Side {
  return gap >= 0 ? "UP" : "DOWN";
}

function oppositeSide(side: Side): Side {
  return side === "UP" ? "DOWN" : "UP";
}

function sideSign(side: Side): 1 | -1 {
  return side === "UP" ? 1 : -1;
}

function gapSign(gap: number): 1 | -1 {
  return gap >= 0 ? 1 : -1;
}

function sideGap(side: Side, gap: number): number {
  return side === "UP" ? gap : -gap;
}

function sumRecent(values: number[], count: number, offset = 0): number | null {
  const end = values.length - offset;
  const start = Math.max(0, end - count);
  if (end <= 0 || start >= end) return null;
  let sum = 0;
  for (let i = start; i < end; i++) sum += values[i] ?? 0;
  return sum;
}

function standardDeviation(values: number[]): number | null {
  if (values.length < 4) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    (values.length - 1);
  return Math.sqrt(Math.max(0, variance));
}

function gapZScore(stats: SignalStats, absGap: number): number | null {
  if (stats.absGapWindow.length < 12) return null;
  const mean =
    stats.absGapWindow.reduce((sum, value) => sum + value, 0) /
    stats.absGapWindow.length;
  const sd = standardDeviation(stats.absGapWindow);
  if (sd === null || sd <= EPSILON) return null;
  return (absGap - mean) / sd;
}

function computeOrderbookQuality(params: {
  ask: { price: number; liquidity: number } | null;
  bid: { price: number; liquidity: number } | null;
}): BookQuality | null {
  if (!params.ask || !params.bid) return null;
  const spread = parseFloat((params.ask.price - params.bid.price).toFixed(4));
  const depth = params.ask.liquidity + params.bid.liquidity;
  return {
    ask: params.ask.price,
    bid: params.bid.price,
    askLiquidity: params.ask.liquidity,
    bidLiquidity: params.bid.liquidity,
    spread,
    depthImbalance:
      depth > 0
        ? parseFloat(((params.bid.liquidity - params.ask.liquidity) / depth).toFixed(4))
        : null,
  };
}

function quoteSlope(stats: SignalStats, side: Side, field: "bid" | "ask", seconds: number): number | null {
  const history = stats.quotes[side];
  const latest = history[history.length - 1];
  if (!latest) return null;
  const current = latest[field];
  if (current === null) return null;
  const targetTs = latest.ts - seconds * 1000;
  let previous: Quote | null = null;
  for (let i = history.length - 1; i >= 0; i--) {
    const quote = history[i]!;
    if (quote.ts <= targetTs) {
      previous = quote;
      break;
    }
  }
  previous ??= history[0] ?? null;
  const oldValue = previous?.[field] ?? null;
  return oldValue === null ? null : parseFloat((current - oldValue).toFixed(4));
}

function updateQuote(stats: SignalStats, side: Side, quality: BookQuality | null, now: number): void {
  const quote: Quote = {
    ts: now,
    ask: quality?.ask ?? null,
    bid: quality?.bid ?? null,
    spread: quality?.spread ?? null,
  };
  stats.quotes[side].push(quote);
  while (stats.quotes[side].length > 45) stats.quotes[side].shift();
}

function updateStats(
  stats: SignalStats,
  ctx: StrategyContext,
  price: number,
  gap: number,
  now = Date.now(),
  config: DualEdgeConfig = CONFIG,
): void {
  if (now - stats.lastUpdateMs < config.statsIntervalMs) return;

  const upQuality = computeOrderbookQuality({
    ask: bestAsk(ctx, "UP"),
    bid: bestBidInfo(ctx, "UP"),
  });
  const downQuality = computeOrderbookQuality({
    ask: bestAsk(ctx, "DOWN"),
    bid: bestBidInfo(ctx, "DOWN"),
  });
  updateQuote(stats, "UP", upQuality, now);
  updateQuote(stats, "DOWN", downQuality, now);

  if (stats.lastPrice !== null) {
    const priceDelta = price - stats.lastPrice;
    stats.priceDeltas.push(priceDelta);
    while (stats.priceDeltas.length > 60) stats.priceDeltas.shift();
    stats.atr = ema(stats.atr, Math.abs(priceDelta), 14);
  }

  if (stats.lastGap !== null) {
    const gapDelta = gap - stats.lastGap;
    stats.gapDeltas.push(gapDelta);
    while (stats.gapDeltas.length > 60) stats.gapDeltas.shift();
    stats.gapAtr = ema(stats.gapAtr, Math.abs(gapDelta), 14);
    stats.gapVelocityEma = ema(stats.gapVelocityEma, gapDelta, 5);
  }

  stats.fastGapEma = ema(stats.fastGapEma, gap, 3);
  stats.slowGapEma = ema(stats.slowGapEma, gap, 10);
  stats.rsi.update(gap);
  stats.absGapWindow.push(Math.abs(gap));
  while (stats.absGapWindow.length > 60) stats.absGapWindow.shift();
  stats.peakAbsGap = Math.max(stats.peakAbsGap, Math.abs(gap));
  stats.lastPrice = price;
  stats.lastGap = gap;
  stats.lastUpdateMs = now;
}

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * absX);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t -
      0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-absX * absX));
  return sign * y;
}

function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

function rollingSigma(stats: SignalStats): number | null {
  return standardDeviation(stats.priceDeltas) ?? stats.atr;
}

function fairProbability(params: {
  side: Side;
  gap: number;
  remaining: number;
  sigmaPerSecond: number | null;
  projectedGap?: number;
}): number {
  const sigma = params.sigmaPerSecond;
  const gap = params.projectedGap ?? params.gap;
  if (sigma === null || sigma <= EPSILON) return 0.5;
  const z = sideGap(params.side, gap) / Math.max(sigma * Math.sqrt(Math.max(1, params.remaining)), EPSILON);
  return clamp(normalCdf(z), 0.01, 0.99);
}

function netEdge(pFair: number, quality: BookQuality, minBuffer = 0.005): number {
  const slippageBuffer = Math.max(minBuffer, quality.spread + 0.005);
  return parseFloat((pFair - quality.ask - slippageBuffer).toFixed(4));
}

function marketPassesCommonFilters(
  quality: BookQuality,
  config: DualEdgeConfig,
  maxAsk: number,
): boolean {
  return (
    quality.spread >= 0 &&
    quality.spread <= config.maxSpread &&
    quality.ask >= config.minEntryAsk &&
    quality.ask <= maxAsk &&
    quality.askLiquidity >= config.minEntryLiquidity &&
    quality.bidLiquidity >= config.minExitLiquidity
  );
}

function momentumSnapshot(stats: SignalStats) {
  const velocityShort = sumRecent(stats.gapDeltas, 3);
  const velocityMid = sumRecent(stats.gapDeltas, 10);
  const previousShort = sumRecent(stats.gapDeltas, 3, 1);
  const acceleration =
    velocityShort === null || previousShort === null ? null : velocityShort - previousShort;
  const emaTrend =
    stats.fastGapEma === null || stats.slowGapEma === null
      ? null
      : stats.fastGapEma - stats.slowGapEma;
  return { velocityShort, velocityMid, acceleration, emaTrend };
}

function evaluateContinuationCandidate(params: {
  side: Side;
  gap: number;
  remaining: number;
  quality: BookQuality;
  stats: SignalStats;
  config?: DualEdgeConfig;
}): EntryDecision | null {
  const config = params.config ?? CONFIG;
  const { side, gap, remaining, quality, stats } = params;
  if (!marketPassesCommonFilters(quality, config, config.maxContinuationAsk)) return null;

  const absGap = Math.abs(gap);
  const sigma = rollingSigma(stats);
  const normGap = stats.atr !== null && stats.atr > EPSILON ? absGap / stats.atr : null;
  const peakGapRatio = stats.peakAbsGap > 0 ? absGap / stats.peakAbsGap : null;
  const peakRetrace = peakGapRatio === null ? null : 1 - peakGapRatio;
  const { velocityShort, velocityMid, acceleration, emaTrend } = momentumSnapshot(stats);
  const sign = sideSign(side);
  const sideVelocityShort = velocityShort === null ? null : velocityShort * sign;
  const sideVelocityMid = velocityMid === null ? null : velocityMid * sign;
  const sideAcceleration = acceleration === null ? null : acceleration * sign;
  const sideEmaTrend = emaTrend === null ? null : emaTrend * sign;
  const rsi = stats.rsi.value;
  const rsiConfirms = rsi === null || (side === "UP" ? rsi >= 52 : rsi <= 48);
  const pFair = fairProbability({ side, gap, remaining, sigmaPerSecond: sigma });
  const edge = netEdge(pFair, quality);

  if (absGap < config.minContinuationAbsGap) return null;
  if (normGap !== null && normGap < config.minContinuationNormGap) return null;
  if (peakGapRatio !== null && peakGapRatio < config.minContinuationPeakGapRatio) return null;
  if (sideVelocityShort !== null && sideVelocityShort <= 0) return null;
  if (sideVelocityMid !== null && sideVelocityMid < 0) return null;
  if (sideAcceleration !== null && sideAcceleration < -1.5) return null;
  if (sideEmaTrend !== null && sideEmaTrend <= 0) return null;
  if (!rsiConfirms) return null;
  if (edge < config.minContinuationNetEdge) return null;

  const trendScore =
    ((sideVelocityShort !== null && sideVelocityShort > 0 ? 1 : 0.5) +
      (sideVelocityMid !== null && sideVelocityMid > 0 ? 1 : 0.5) +
      (sideEmaTrend !== null && sideEmaTrend > 0 ? 1 : 0.5) +
      (rsiConfirms ? 1 : 0)) /
    4;
  const edgeScore = clamp(edge / 0.16);
  const normGapScore = normGap === null ? 0.5 : clamp((normGap - config.minContinuationNormGap) / 8);
  const pgrScore = peakGapRatio === null ? 0.5 : clamp((peakGapRatio - 0.72) / 0.28);
  const bookScore = clamp((quality.bidLiquidity - quality.askLiquidity) / Math.max(quality.bidLiquidity + quality.askLiquidity, EPSILON) / 2 + 0.5);
  const score = parseFloat(
    (0.34 * edgeScore + 0.28 * trendScore + 0.16 * normGapScore + 0.12 * pgrScore + 0.1 * bookScore).toFixed(4),
  );
  if (score < config.minContinuationScore) return null;

  return {
    model: "continuation",
    side,
    ask: quality.ask,
    bid: quality.bid,
    askLiquidity: quality.askLiquidity,
    bidLiquidity: quality.bidLiquidity,
    spread: quality.spread,
    depthImbalance: quality.depthImbalance,
    score,
    absGap,
    sideGap: sideGap(side, gap),
    normGap,
    gapZ: gapZScore(stats, absGap),
    peakGapRatio,
    peakRetrace,
    velocityShort,
    velocityMid,
    acceleration,
    emaTrend,
    rsi,
    bidSlope3s: quoteSlope(stats, side, "bid", 3),
    askSlope3s: quoteSlope(stats, side, "ask", 3),
    pFair,
    netEdge: edge,
    projectedGap: gap,
    takeProfitPrice: Math.min(0.97, parseFloat((quality.ask + config.takeProfitCents).toFixed(2))),
    stopLossPrice: Math.max(0.01, parseFloat((quality.ask - config.maxLossCents).toFixed(2))),
  };
}

function evaluateReversalCandidate(params: {
  side: Side;
  gap: number;
  remaining: number;
  quality: BookQuality;
  stats: SignalStats;
  config?: DualEdgeConfig;
}): EntryDecision | null {
  const config = params.config ?? CONFIG;
  const { side, gap, remaining, quality, stats } = params;
  if (!marketPassesCommonFilters(quality, config, config.maxReversalAsk)) return null;

  const absGap = Math.abs(gap);
  const sigma = rollingSigma(stats);
  const normGap = stats.atr !== null && stats.atr > EPSILON ? absGap / stats.atr : null;
  const gapZ = gapZScore(stats, absGap);
  const peakGapRatio = stats.peakAbsGap > 0 ? absGap / stats.peakAbsGap : null;
  const peakRetrace = peakGapRatio === null ? null : 1 - peakGapRatio;
  const { velocityShort, velocityMid, acceleration, emaTrend } = momentumSnapshot(stats);
  const advSign = gapSign(gap);
  const movingTowardZero = velocityShort !== null && velocityShort * advSign < 0;
  const accelerationAgainstAdv = acceleration !== null && acceleration * advSign < 0;
  const emaFlipped = emaTrend !== null && emaTrend * advSign < 0;
  const bidSlope3s = quoteSlope(stats, side, "bid", 3);
  const askSlope3s = quoteSlope(stats, side, "ask", 3);
  const rsi = stats.rsi.value;
  const rsiFlipped = rsi === null || (gap > 0 ? rsi <= 46 : rsi >= 54);
  const projectedGap =
    gap +
    (stats.gapVelocityEma ?? velocityShort ?? 0) *
      Math.min(config.projectionSeconds, Math.max(1, remaining * 0.3));
  const pFair = fairProbability({
    side,
    gap,
    remaining,
    sigmaPerSecond: sigma,
    projectedGap,
  });
  const edge = netEdge(pFair, quality, 0.01);

  if (absGap < config.minReversalAbsGap) return null;
  if (normGap !== null && normGap < config.minReversalNormGap) return null;
  if (gapZ !== null && gapZ < config.minReversalGapZ) return null;
  if (peakRetrace === null || peakRetrace < config.minReversalPeakRetrace) return null;
  if (peakRetrace > config.maxReversalPeakRetrace) return null;
  if (!movingTowardZero || !accelerationAgainstAdv) return null;
  if (!emaFlipped && !rsiFlipped) return null;
  if (bidSlope3s !== null && bidSlope3s <= 0) return null;
  if (askSlope3s !== null && askSlope3s > 0.05) return null;
  if (edge < config.minReversalNetEdge) return null;

  const edgeScore = clamp(edge / 0.18);
  const extensionScore =
    0.5 * (normGap === null ? 0.5 : clamp((normGap - config.minReversalNormGap) / 10)) +
    0.5 * (gapZ === null ? 0.5 : clamp((gapZ - config.minReversalGapZ) / 2));
  const decayScore =
    ((movingTowardZero ? 1 : 0) +
      (accelerationAgainstAdv ? 1 : 0) +
      (emaFlipped ? 1 : 0) +
      (rsiFlipped ? 1 : 0)) /
    4;
  const retraceScore = clamp(
    (peakRetrace - config.minReversalPeakRetrace) /
      Math.max(config.maxReversalPeakRetrace - config.minReversalPeakRetrace, EPSILON),
  );
  const bookScore =
    0.5 * (bidSlope3s === null ? 0.5 : clamp(bidSlope3s / 0.08)) +
    0.5 * clamp((quality.bidLiquidity - quality.askLiquidity) / Math.max(quality.bidLiquidity + quality.askLiquidity, EPSILON) / 2 + 0.5);
  const score = parseFloat(
    (0.32 * edgeScore + 0.22 * extensionScore + 0.22 * decayScore + 0.12 * retraceScore + 0.12 * bookScore).toFixed(4),
  );
  if (score < config.minReversalScore) return null;

  return {
    model: "reversal",
    side,
    ask: quality.ask,
    bid: quality.bid,
    askLiquidity: quality.askLiquidity,
    bidLiquidity: quality.bidLiquidity,
    spread: quality.spread,
    depthImbalance: quality.depthImbalance,
    score,
    absGap,
    sideGap: sideGap(side, gap),
    normGap,
    gapZ,
    peakGapRatio,
    peakRetrace,
    velocityShort,
    velocityMid,
    acceleration,
    emaTrend,
    rsi,
    bidSlope3s,
    askSlope3s,
    pFair,
    netEdge: edge,
    projectedGap,
    takeProfitPrice: Math.min(0.94, parseFloat((quality.ask + config.takeProfitCents).toFixed(2))),
    stopLossPrice: Math.max(0.01, parseFloat((quality.ask - Math.min(config.maxLossCents, 0.06)).toFixed(2))),
  };
}

function chooseEntry(params: {
  ctx: StrategyContext;
  remaining: number;
  gap: number;
  stats: SignalStats;
  config?: DualEdgeConfig;
}): EntryDecision | null {
  const config = params.config ?? CONFIG;
  if (params.remaining < config.minEntryRemaining || params.remaining > config.maxEntryRemaining) {
    return null;
  }

  const adv = advantageSide(params.gap);
  const weak = oppositeSide(adv);
  const advQuality = computeOrderbookQuality({
    ask: bestAsk(params.ctx, adv),
    bid: bestBidInfo(params.ctx, adv),
  });
  const weakQuality = computeOrderbookQuality({
    ask: bestAsk(params.ctx, weak),
    bid: bestBidInfo(params.ctx, weak),
  });
  const continuation = advQuality
    ? evaluateContinuationCandidate({
        side: adv,
        gap: params.gap,
        remaining: params.remaining,
        quality: advQuality,
        stats: params.stats,
        config,
      })
    : null;
  const reversal = weakQuality
    ? evaluateReversalCandidate({
        side: weak,
        gap: params.gap,
        remaining: params.remaining,
        quality: weakQuality,
        stats: params.stats,
        config,
      })
    : null;

  if (reversal && (!continuation || reversal.score >= continuation.score + config.reversalScoreMargin)) {
    return reversal;
  }
  return continuation;
}

function trendSupportsPosition(pos: Position, gap: number, stats: SignalStats): boolean {
  const { velocityShort, velocityMid, emaTrend } = momentumSnapshot(stats);
  const sign = sideSign(pos.side);
  const sideVelocityShort = velocityShort === null ? null : velocityShort * sign;
  const sideVelocityMid = velocityMid === null ? null : velocityMid * sign;
  const sideEmaTrend = emaTrend === null ? null : emaTrend * sign;
  const currentSideGap = sideGap(pos.side, gap);
  const peakRetain =
    pos.peakSideGap > 0 && currentSideGap > 0 ? currentSideGap / pos.peakSideGap : 0;
  return (
    currentSideGap > 0 &&
    peakRetain >= 0.78 &&
    (sideVelocityShort === null || sideVelocityShort >= 0) &&
    (sideVelocityMid === null || sideVelocityMid >= 0) &&
    (sideEmaTrend === null || sideEmaTrend >= 0)
  );
}

function settlementHoldAllowed(params: {
  pos: Position;
  gap: number;
  bid: number | null;
  remaining: number;
  stats: SignalStats;
  config?: DualEdgeConfig;
}): boolean {
  const config = params.config ?? CONFIG;
  const sigma = rollingSigma(params.stats);
  const pFair = fairProbability({
    side: params.pos.side,
    gap: params.gap,
    remaining: params.remaining,
    sigmaPerSecond: sigma,
  });
  const currentSideGap = sideGap(params.pos.side, params.gap);
  const requiredGap = Math.max(
    config.settlementMinSideGap,
    params.stats.atr !== null ? params.stats.atr * config.settlementAtrMultiplier : 0,
  );
  const exitUpside = params.bid === null ? 1 : 1 - params.bid;
  return (
    params.remaining <= 60 &&
    pFair >= config.settlementMinProbability &&
    currentSideGap >= requiredGap &&
    exitUpside >= 0.04
  );
}

function updatePosition(pos: Position, gap: number, bid: number | null): void {
  pos.peakSideGap = Math.max(pos.peakSideGap, sideGap(pos.side, gap));
  if (bid !== null) pos.peakBid = Math.max(pos.peakBid ?? bid, bid);
}

function shouldExit(params: {
  pos: Position;
  gap: number;
  bid: number | null;
  remaining: number;
  now: number;
  stats: SignalStats;
  config?: DualEdgeConfig;
}): { price: number; reason: string; mode: string; holdMs: number } | null {
  const config = params.config ?? CONFIG;
  const { pos, gap, bid, remaining, now, stats } = params;
  const holdMs = now - pos.entryMs;
  const price = bid ?? pos.stopLossPrice;
  const profit = bid === null ? null : bid - pos.entryPrice;
  const trendSupports = trendSupportsPosition(pos, gap, stats);
  const currentSideGap = sideGap(pos.side, gap);
  const peakRetain =
    pos.peakSideGap > 0 && currentSideGap > 0 ? currentSideGap / pos.peakSideGap : 0;
  const { velocityShort, emaTrend } = momentumSnapshot(stats);
  const posVelocity = velocityShort === null ? null : velocityShort * sideSign(pos.side);
  const posEmaTrend = emaTrend === null ? null : emaTrend * sideSign(pos.side);
  const trendInvalid =
    currentSideGap <= 0 ||
    (peakRetain < 0.62 && (posVelocity === null || posVelocity < 0) && (posEmaTrend === null || posEmaTrend < 0));

  if (!trendInvalid) {
    pos.trendInvalidSinceMs = null;
  } else if (pos.trendInvalidSinceMs === null) {
    pos.trendInvalidSinceMs = now;
  }

  const trendInvalidConfirmed =
    pos.trendInvalidSinceMs !== null &&
    now - pos.trendInvalidSinceMs >= config.trendInvalidConfirmMs;

  if (
    pos.model === "reversal" &&
    holdMs >= config.reversalFailureMinHoldMs &&
    currentSideGap < -pos.entryAbsGap * 1.1 &&
    (posVelocity === null || posVelocity < 0)
  ) {
    return { price, reason: "reversal failed", mode: "reversal-failure", holdMs };
  }

  if (profit !== null && bid !== null) {
    if (profit <= -config.catastrophicLossCents) {
      return { price: bid, reason: "catastrophic price stop", mode: "catastrophic", holdMs };
    }
    if (holdMs >= config.minHoldMs && profit <= -config.maxLossCents && !trendSupports) {
      return { price: bid, reason: "confirmed price stop", mode: "price-stop", holdMs };
    }
    if (profit >= config.highProfitLock && remaining <= 120) {
      return { price: bid, reason: "high profit lock", mode: "high-profit", holdMs };
    }
    const peakBid = pos.peakBid ?? bid;
    if (
      profit > 0 &&
      peakBid - pos.entryPrice >= config.profitLockMin &&
      peakBid - bid >= config.trailingDrawdownCents
    ) {
      return { price: bid, reason: "bid trailing take-profit", mode: "bid-trailing", holdMs };
    }
    if (
      profit >= config.takeProfitCents &&
      holdMs >= config.minHoldMs &&
      (!trendSupports || remaining <= 90)
    ) {
      return { price: bid, reason: "dynamic take-profit", mode: "take-profit", holdMs };
    }
    if (remaining <= 75 && profit >= config.profitLockMin) {
      return { price: bid, reason: "late profit lock", mode: "late-profit", holdMs };
    }
    if (remaining <= 45 && profit > 0) {
      return { price: bid, reason: "final profit lock", mode: "final-profit", holdMs };
    }
  }

  if (holdMs >= config.minHoldMs && trendInvalidConfirmed) {
    return { price, reason: "trend invalidated", mode: "trend-invalid", holdMs };
  }

  if (remaining <= config.finalExitSeconds && !settlementHoldAllowed(params)) {
    return { price, reason: "final timed exit", mode: "final-exit", holdMs };
  }

  return null;
}

function buildMetrics(params: {
  ctx: StrategyContext;
  remaining: number;
  btcPrice: number | null;
  priceToBeat: number | null;
  gap: number | null;
  side: Side | null;
  stats: SignalStats;
  position?: Position | null;
  entry?: EntryDecision | null;
  extra?: StrategyMetrics;
}): StrategyMetrics {
  const { side, gap, stats, position, entry } = params;
  const activeSide = side ?? position?.side ?? null;
  const ask = activeSide ? bestAsk(params.ctx, activeSide) : null;
  const bid = activeSide ? bestBidInfo(params.ctx, activeSide) : null;
  const absGap = gap === null ? null : Math.abs(gap);
  const momentum = momentumSnapshot(stats);
  const sigma = rollingSigma(stats);
  const pFair =
    activeSide && gap !== null
      ? fairProbability({
          side: activeSide,
          gap,
          remaining: params.remaining,
          sigmaPerSecond: sigma,
        })
      : null;
  return {
    strategy: "dual-edge-arb",
    remaining: params.remaining,
    btcPrice: params.btcPrice,
    priceToBeat: params.priceToBeat,
    gap,
    absGap,
    side: activeSide,
    model: entry?.model ?? position?.model ?? null,
    atr: round(stats.atr, 6),
    gapAtr: round(stats.gapAtr, 6),
    rollingSigma: round(sigma, 6),
    normGap:
      absGap !== null && stats.atr !== null && stats.atr > EPSILON
        ? round(absGap / stats.atr)
        : null,
    gapZ: absGap === null ? null : round(gapZScore(stats, absGap)),
    peakAbsGap: round(stats.peakAbsGap),
    peakGapRatio:
      absGap !== null && stats.peakAbsGap > 0 ? round(absGap / stats.peakAbsGap) : null,
    peakRetrace:
      absGap !== null && stats.peakAbsGap > 0 ? round(1 - absGap / stats.peakAbsGap) : null,
    velocityShort: round(momentum.velocityShort),
    velocityMid: round(momentum.velocityMid),
    acceleration: round(momentum.acceleration),
    gapVelocityEma: round(stats.gapVelocityEma),
    emaTrend: round(momentum.emaTrend),
    gapRsi: round(stats.rsi.value),
    pFair: round(entry?.pFair ?? pFair),
    netEdge: round(entry?.netEdge ?? null),
    score: round(entry?.score ?? null),
    entryModel: entry?.model ?? null,
    entryAsk: entry?.ask ?? null,
    entryBid: entry?.bid ?? null,
    bestAsk: ask?.price ?? null,
    bestAskLiquidity: ask?.liquidity ?? null,
    bestBid: bid?.price ?? null,
    bestBidLiquidity: bid?.liquidity ?? null,
    spread: entry?.spread ?? (ask && bid ? round(ask.price - bid.price) : null),
    depthImbalance: entry?.depthImbalance ?? null,
    bidSlope3s: entry?.bidSlope3s ?? (activeSide ? quoteSlope(stats, activeSide, "bid", 3) : null),
    askSlope3s: entry?.askSlope3s ?? (activeSide ? quoteSlope(stats, activeSide, "ask", 3) : null),
    projectedGap: round(entry?.projectedGap ?? null),
    entryPrice: position?.entryPrice ?? null,
    entryGap: position?.entryGap ?? null,
    entryAbsGap: position?.entryAbsGap ?? null,
    entrySideGap: position?.entrySideGap ?? null,
    peakSideGap: position?.peakSideGap ?? null,
    peakBid: position?.peakBid ?? null,
    takeProfitPrice: entry?.takeProfitPrice ?? position?.takeProfitPrice ?? null,
    stopLossPrice: entry?.stopLossPrice ?? position?.stopLossPrice ?? null,
    unrealizedEdge:
      position && bid?.price !== undefined ? round(bid.price - position.entryPrice) : null,
    trendSupports:
      position && gap !== null ? trendSupportsPosition(position, gap, stats) : null,
    settlementHold:
      position && gap !== null
        ? settlementHoldAllowed({
            pos: position,
            gap,
            bid: bid?.price ?? null,
            remaining: params.remaining,
            stats,
          })
        : null,
    ...params.extra,
  };
}

function releaseOnce(state: State, release: () => void): void {
  if (state.released) return;
  state.released = true;
  release();
}

function placeSell(params: {
  ctx: StrategyContext;
  state: State;
  pos: Position;
  price: number;
  label: string;
  reason: string;
  metrics: StrategyMetrics;
  getMetrics: () => StrategyMetrics;
  release: () => void;
  riskExit?: boolean;
}): void {
  if (params.state.closing) return;
  params.state.closing = true;
  const expireAtMs = params.riskExit ? Date.now() + CONFIG.riskExitOrderTtlMs : params.ctx.slotEndMs;
  const signalId = params.ctx.recordSignal({
    action: "sell",
    side: params.pos.side,
    label: params.label,
    metrics: params.metrics,
  });
  params.ctx.postOrders([
    {
      req: {
        tokenId: params.pos.tokenId,
        action: "sell",
        price: params.price,
        shares: params.pos.shares,
      },
      expireAtMs,
      analysis: {
        signalId,
        label: params.label,
        getMetrics: params.getMetrics,
      },
      onFilled() {
        params.state.position = null;
        params.ctx.log(
          `[${params.ctx.slug}] dual-edge-arb: SELL ${params.pos.side} filled @ ${params.price} (${params.reason})`,
          "green",
        );
        releaseOnce(params.state, params.release);
      },
      onExpired() {
        params.ctx.log(
          `[${params.ctx.slug}] dual-edge-arb: SELL ${params.pos.side} @ ${params.price} expired`,
          "red",
        );
        if (
          params.riskExit &&
          params.state.position === params.pos &&
          Date.now() < params.ctx.slotEndMs - 1_000 &&
          params.pos.riskExitAttempts < CONFIG.riskExitMaxRetries
        ) {
          params.pos.riskExitAttempts++;
          params.state.closing = false;
          placeSell({
            ...params,
            price: bestBid(params.ctx, params.pos.side) ?? Math.max(0.01, params.price - 0.01),
            reason: `${params.reason} retry ${params.pos.riskExitAttempts}`,
          });
          return;
        }
        params.state.closing = false;
        const sellIds = params.ctx.pendingOrders
          .filter((o) => o.action === "sell" && o.tokenId === params.pos.tokenId)
          .map((o) => o.orderId);
        if (sellIds.length > 0) {
          params.ctx.emergencySells(sellIds).finally(() => releaseOnce(params.state, params.release));
        }
      },
      onFailed(reason) {
        params.ctx.log(
          `[${params.ctx.slug}] dual-edge-arb: SELL ${params.pos.side} failed (${reason})`,
          "red",
        );
        if (!reason.includes("order expired before placement")) params.state.closing = false;
      },
    },
  ]);
}

export const dualEdgeArb: Strategy = async (ctx) => {
  if (Env.get("PROD")) {
    ctx.log(
      "[dual-edge-arb] Strategy is designed for simulation/tuning first. " +
        "Remove this guard only after train/validation/test replay is stable.",
      "red",
    );
    process.exit(1);
  }

  const release = ctx.hold();
  const state: State = {
    traded: false,
    position: null,
    closing: false,
    released: false,
    settlementHoldLogged: false,
  };
  const stats = createSignalStats();

  const tickInterval = setInterval(() => {
    const now = Date.now();
    const remaining = Math.floor((ctx.slotEndMs - now) / 1000);
    if (remaining <= 0) {
      clearInterval(tickInterval);
      releaseOnce(state, release);
      return;
    }

    const priceToBeat = ctx.getMarketResult()?.openPrice ?? null;
    const btcPrice = ctx.ticker.price ?? null;
    if (priceToBeat === null || btcPrice === null) return;

    const gap = btcPrice - priceToBeat;
    updateStats(stats, ctx, btcPrice, gap, now);

    if (!state.traded) {
      const entry = chooseEntry({ ctx, remaining, gap, stats });
      if (entry) {
        state.traded = true;
        const tokenId = sideToken(ctx, entry.side);
        const metrics = buildMetrics({
          ctx,
          remaining,
          btcPrice,
          priceToBeat,
          gap,
          side: entry.side,
          stats,
          entry,
        });
        const signalId = ctx.recordSignal({
          action: "buy",
          side: entry.side,
          label: `dual-edge-arb ${entry.model} entry`,
          metrics,
        });
        ctx.log(
          `[${ctx.slug}] dual-edge-arb: signal BUY ${entry.side} ${entry.model} @ ${entry.ask} score ${entry.score}`,
          "cyan",
        );
        ctx.postOrders([
          {
            req: {
              tokenId,
              action: "buy",
              price: entry.ask,
              shares: CONFIG.shares,
            },
            expireAtMs: ctx.slotEndMs - 45_000,
            analysis: {
              signalId,
              label: `dual-edge-arb ${entry.model} entry`,
              getMetrics: () =>
                buildMetrics({
                  ctx,
                  remaining: Math.floor((ctx.slotEndMs - Date.now()) / 1000),
                  btcPrice: ctx.ticker.price ?? null,
                  priceToBeat,
                  gap: ctx.ticker.price !== undefined ? ctx.ticker.price - priceToBeat : null,
                  side: entry.side,
                  stats,
                  entry,
                }),
            },
            onFilled(filledShares) {
              const fillGap =
                ctx.ticker.price !== undefined ? ctx.ticker.price - priceToBeat : gap;
              state.position = {
                model: entry.model,
                side: entry.side,
                tokenId,
                entryPrice: entry.ask,
                entryGap: fillGap,
                entryAbsGap: Math.abs(fillGap),
                entrySideGap: sideGap(entry.side, fillGap),
                entryMs: Date.now(),
                shares: filledShares,
                pFairEntry: entry.pFair,
                netEdgeEntry: entry.netEdge,
                takeProfitPrice: entry.takeProfitPrice,
                stopLossPrice: entry.stopLossPrice,
                peakSideGap: Math.max(0, sideGap(entry.side, fillGap)),
                peakBid: bestBid(ctx, entry.side),
                trendInvalidSinceMs: null,
                riskExitAttempts: 0,
              };
              state.settlementHoldLogged = false;
              ctx.log(
                `[${ctx.slug}] dual-edge-arb: BUY ${entry.side} ${entry.model} filled @ ${entry.ask} (${filledShares} shares)`,
                "green",
              );
            },
            onExpired() {
              ctx.log(
                `[${ctx.slug}] dual-edge-arb: BUY ${entry.side} @ ${entry.ask} expired`,
                "yellow",
              );
              releaseOnce(state, release);
            },
            onFailed(reason) {
              ctx.log(
                `[${ctx.slug}] dual-edge-arb: BUY ${entry.side} failed (${reason})`,
                "red",
              );
              releaseOnce(state, release);
            },
          },
        ]);
      }
    }

    const pos = state.position;
    if (!pos || state.closing) return;

    const bid = bestBid(ctx, pos.side);
    updatePosition(pos, gap, bid);

    if (
      settlementHoldAllowed({
        pos,
        gap,
        bid,
        remaining,
        stats,
      })
    ) {
      if (!state.settlementHoldLogged) {
        state.settlementHoldLogged = true;
        ctx.log(
          `[${ctx.slug}] dual-edge-arb: holding ${pos.side} to settlement`,
          "cyan",
        );
      }
      return;
    }

    const exit = shouldExit({
      pos,
      gap,
      bid,
      remaining,
      now,
      stats,
    });
    if (!exit) return;

    const metrics = () =>
      buildMetrics({
        ctx,
        remaining: Math.floor((ctx.slotEndMs - Date.now()) / 1000),
        btcPrice: ctx.ticker.price ?? null,
        priceToBeat,
        gap: ctx.ticker.price !== undefined ? ctx.ticker.price - priceToBeat : null,
        side: pos.side,
        stats,
        position: pos,
        extra: {
          exitReason: exit.reason,
          exitMode: exit.mode,
          holdSeconds: round(exit.holdMs / 1000, 3),
        },
      });
    placeSell({
      ctx,
      state,
      pos,
      price: exit.price,
      label: "dual-edge-arb exit",
      reason: exit.reason,
      metrics: metrics(),
      getMetrics: metrics,
      release,
      riskExit: true,
    });
  }, CONFIG.tickIntervalMs);

  return () => {
    clearInterval(tickInterval);
  };
};

export const __dualEdgeArbTestHooks = {
  readConfig,
  createSignalStats,
  updateStats,
  computeOrderbookQuality,
  evaluateContinuationCandidate,
  evaluateReversalCandidate,
  chooseEntry,
  fairProbability,
  netEdge,
  momentumSnapshot,
  trendSupportsPosition,
  shouldExit,
  settlementHoldAllowed,
};

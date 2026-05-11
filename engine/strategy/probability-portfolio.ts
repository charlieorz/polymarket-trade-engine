// Probability Portfolio Strategy
//
// 这个策略把 UP/DOWN 当成一个组合来管理：先用 gap、剩余时间和近期波动估计
// 两侧结算概率，再只在「估计概率 - 可成交价格 - 成本缓冲」足够高时入场。
// 如果双边持仓已经形成正的最差结算 payoff，临近结算时优先保护组合收益。

import type { Strategy, StrategyContext, StrategyMetrics } from "./types.ts";
import { Env } from "../../utils/config.ts";

export type PortfolioSide = "UP" | "DOWN";
export type PortfolioEntryModel = "continuation" | "reversal";

export type PortfolioConfig = {
  tickIntervalMs: number;
  statsIntervalMs: number;
  shares: number;
  minEntryRemaining: number;
  maxEntryRemaining: number;
  maxOpenLegs: number;
  maxSameSideLegs: number;
  maxEntriesPerMarket: number;
  minEntryAsk: number;
  maxContinuationAsk: number;
  maxReversalAsk: number;
  maxSpread: number;
  minEntryLiquidityUsd: number;
  minExitLiquidityUsd: number;
  costBuffer: number;
  sigmaMultiplier: number;
  projectionSeconds: number;
  minContinuationAbsGap: number;
  minContinuationRelativeGap: number;
  minContinuationPeakRetain: number;
  minContinuationNetEdge: number;
  minContinuationScore: number;
  minReversalAbsGap: number;
  minReversalRelativeGap: number;
  minReversalPeakRetrace: number;
  maxReversalPeakRetrace: number;
  minReversalNetEdge: number;
  minReversalScore: number;
  reversalScoreMargin: number;
  maxSignFlipCount: number;
  takeProfitCents: number;
  profitLockMin: number;
  trailingDrawdownCents: number;
  maxLossCents: number;
  catastrophicLossCents: number;
  minHoldMs: number;
  reversalFailureMinHoldMs: number;
  trendInvalidConfirmMs: number;
  settlementHoldMaxSeconds: number;
  settlementMinProbability: number;
  settlementMinSideGap: number;
  settlementMinGuaranteedPnl: number;
  finalExitSeconds: number;
  riskExitOrderTtlMs: number;
  riskExitMaxRetries: number;
};

export type BookQuality = {
  ask: number;
  bid: number;
  askLiquidity: number;
  bidLiquidity: number;
  spread: number;
  depthImbalance: number | null;
};

type Quote = {
  ts: number;
  ask: number | null;
  bid: number | null;
};

export type PortfolioStats = {
  lastUpdateMs: number;
  lastPrice: number | null;
  lastGap: number | null;
  atr: number | null;
  gapAtr: number | null;
  gapVelocityEma: number | null;
  fastGapEma: number | null;
  slowGapEma: number | null;
  gapDeltas: number[];
  priceDeltas: number[];
  absGapWindow: number[];
  peakAbsGap: number;
  quotes: Record<PortfolioSide, Quote[]>;
};

export type PortfolioLeg = {
  id: string;
  model: PortfolioEntryModel;
  side: PortfolioSide;
  tokenId: string;
  entryPrice: number;
  entryGap: number;
  entrySideGap: number;
  entryMs: number;
  shares: number;
  pFairEntry: number;
  netEdgeEntry: number;
  scoreEntry: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  peakSideGap: number;
  peakBid: number | null;
  trendInvalidSinceMs: number | null;
  riskExitAttempts: number;
};

export type PortfolioRuntimeState = {
  legs: PortfolioLeg[];
  closingLegIds: Set<string>;
  pendingEntryCount: number;
  pendingEntrySideCounts: Record<PortfolioSide, number>;
  realizedCash: number;
  released: boolean;
  settlementHoldLogged: boolean;
  openedLegCount: number;
};

export type PortfolioView = {
  upShares: number;
  downShares: number;
  realizedCash: number;
  upPnl: number;
  downPnl: number;
  guaranteedPnl: number;
  bestCasePnl: number;
  balancedShares: number;
  imbalanceShares: number;
};

export type PortfolioEntryDecision = {
  model: PortfolioEntryModel;
  side: PortfolioSide;
  ask: number;
  bid: number;
  askLiquidity: number;
  bidLiquidity: number;
  spread: number;
  depthImbalance: number | null;
  score: number;
  absGap: number;
  sideGap: number;
  relativeGap: number | null;
  peakRetain: number | null;
  peakRetrace: number | null;
  velocityShort: number | null;
  velocityMid: number | null;
  acceleration: number | null;
  emaTrend: number | null;
  pFair: number;
  netEdge: number;
  projectedGap: number;
  guaranteedPnlAfter: number;
  takeProfitPrice: number;
  stopLossPrice: number;
};

const EPSILON = 1e-9;

type EntryLimitState = Pick<PortfolioRuntimeState, "legs"> & {
  openedLegCount?: number;
  pendingEntryCount?: number;
  pendingEntrySideCounts?: Partial<Record<PortfolioSide, number>>;
};

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

export function readProbabilityPortfolioConfig(
  env: Record<string, string | undefined> = process.env,
): PortfolioConfig {
  return {
    tickIntervalMs: Math.max(50, parseNumberEnv(env, "PP_TICK_INTERVAL_MS", 200)),
    statsIntervalMs: Math.max(250, parseNumberEnv(env, "PP_STATS_INTERVAL_MS", 1000)),
    shares: Math.max(1, parseNumberEnv(env, "PP_SHARES", 6)),
    minEntryRemaining: Math.max(1, parseNumberEnv(env, "PP_MIN_ENTRY_REMAINING", 35)),
    maxEntryRemaining: Math.max(1, parseNumberEnv(env, "PP_MAX_ENTRY_REMAINING", 245)),
    maxOpenLegs: Math.max(1, Math.floor(parseNumberEnv(env, "PP_MAX_OPEN_LEGS", 2))),
    maxSameSideLegs: Math.max(1, Math.floor(parseNumberEnv(env, "PP_MAX_SAME_SIDE_LEGS", 1))),
    maxEntriesPerMarket: Math.max(
      1,
      Math.floor(parseNumberEnv(env, "PP_MAX_ENTRIES_PER_MARKET", 1)),
    ),
    minEntryAsk: Math.max(0.01, parseNumberEnv(env, "PP_MIN_ENTRY_ASK", 0.24)),
    maxContinuationAsk: Math.min(0.99, parseNumberEnv(env, "PP_MAX_CONTINUATION_ASK", 0.68)),
    maxReversalAsk: Math.min(0.99, parseNumberEnv(env, "PP_MAX_REVERSAL_ASK", 0.58)),
    maxSpread: Math.max(0, parseNumberEnv(env, "PP_MAX_SPREAD", 0.04)),
    minEntryLiquidityUsd: Math.max(0, parseNumberEnv(env, "PP_MIN_ENTRY_LIQUIDITY_USD", 8)),
    minExitLiquidityUsd: Math.max(0, parseNumberEnv(env, "PP_MIN_EXIT_LIQUIDITY_USD", 8)),
    costBuffer: Math.max(0, parseNumberEnv(env, "PP_COST_BUFFER", 0.008)),
    sigmaMultiplier: Math.max(1, parseNumberEnv(env, "PP_SIGMA_MULTIPLIER", 1.4)),
    projectionSeconds: Math.max(0, parseNumberEnv(env, "PP_PROJECTION_SECONDS", 20)),
    minContinuationAbsGap: Math.max(0, parseNumberEnv(env, "PP_MIN_CONTINUATION_ABS_GAP", 7)),
    minContinuationRelativeGap: Math.max(
      0,
      parseNumberEnv(env, "PP_MIN_CONTINUATION_RELATIVE_GAP", 0.62),
    ),
    minContinuationPeakRetain: Math.max(
      0,
      Math.min(1, parseNumberEnv(env, "PP_MIN_CONTINUATION_PEAK_RETAIN", 0.74)),
    ),
    minContinuationNetEdge: Math.max(0, parseNumberEnv(env, "PP_MIN_CONTINUATION_NET_EDGE", 0.015)),
    minContinuationScore: Math.max(0, parseNumberEnv(env, "PP_MIN_CONTINUATION_SCORE", 0.56)),
    minReversalAbsGap: Math.max(0, parseNumberEnv(env, "PP_MIN_REVERSAL_ABS_GAP", 10)),
    minReversalRelativeGap: Math.max(0, parseNumberEnv(env, "PP_MIN_REVERSAL_RELATIVE_GAP", 0.85)),
    minReversalPeakRetrace: Math.max(
      0,
      Math.min(1, parseNumberEnv(env, "PP_MIN_REVERSAL_PEAK_RETRACE", 0.14)),
    ),
    maxReversalPeakRetrace: Math.max(
      0,
      Math.min(1, parseNumberEnv(env, "PP_MAX_REVERSAL_PEAK_RETRACE", 0.58)),
    ),
    minReversalNetEdge: Math.max(0, parseNumberEnv(env, "PP_MIN_REVERSAL_NET_EDGE", 0.02)),
    minReversalScore: Math.max(0, parseNumberEnv(env, "PP_MIN_REVERSAL_SCORE", 0.52)),
    reversalScoreMargin: Math.max(0, parseNumberEnv(env, "PP_REVERSAL_SCORE_MARGIN", 0.03)),
    maxSignFlipCount: Math.max(0, Math.floor(parseNumberEnv(env, "PP_MAX_SIGN_FLIP_COUNT", 4))),
    takeProfitCents: Math.max(0, parseNumberEnv(env, "PP_TAKE_PROFIT_CENTS", 0.09)),
    profitLockMin: Math.max(0, parseNumberEnv(env, "PP_PROFIT_LOCK_MIN", 0.045)),
    trailingDrawdownCents: Math.max(0, parseNumberEnv(env, "PP_TRAILING_DRAWDOWN_CENTS", 0.045)),
    maxLossCents: Math.max(0.01, parseNumberEnv(env, "PP_MAX_LOSS_CENTS", 0.05)),
    catastrophicLossCents: Math.max(0.01, parseNumberEnv(env, "PP_CATASTROPHIC_LOSS_CENTS", 0.17)),
    minHoldMs: Math.max(0, parseNumberEnv(env, "PP_MIN_HOLD_MS", 8_000)),
    reversalFailureMinHoldMs: Math.max(0, parseNumberEnv(env, "PP_REVERSAL_FAILURE_MIN_HOLD_MS", 4_000)),
    trendInvalidConfirmMs: Math.max(0, parseNumberEnv(env, "PP_TREND_INVALID_CONFIRM_MS", 2_500)),
    settlementHoldMaxSeconds: Math.max(1, parseNumberEnv(env, "PP_SETTLEMENT_HOLD_MAX_SECONDS", 70)),
    settlementMinProbability: Math.max(
      0,
      Math.min(1, parseNumberEnv(env, "PP_SETTLEMENT_MIN_PROBABILITY", 0.9)),
    ),
    settlementMinSideGap: Math.max(0, parseNumberEnv(env, "PP_SETTLEMENT_MIN_SIDE_GAP", 5)),
    settlementMinGuaranteedPnl: parseNumberEnv(env, "PP_SETTLEMENT_MIN_GUARANTEED_PNL", 0.06),
    finalExitSeconds: Math.max(1, parseNumberEnv(env, "PP_FINAL_EXIT_SECONDS", 24)),
    riskExitOrderTtlMs: Math.max(250, parseNumberEnv(env, "PP_RISK_EXIT_ORDER_TTL_MS", 4_000)),
    riskExitMaxRetries: Math.max(0, Math.floor(parseNumberEnv(env, "PP_RISK_EXIT_MAX_RETRIES", 3))),
  };
}

const CONFIG = readProbabilityPortfolioConfig();

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

function round(value: number | null, digits = 4): number | null {
  return value === null ? null : parseFloat(value.toFixed(digits));
}

function priceRound(value: number): number {
  return parseFloat(clamp(value, 0.01, 0.99).toFixed(2));
}

function ema(previous: number | null, value: number, period: number): number {
  return previous === null ? value : (previous * (period - 1) + value) / period;
}

function standardDeviation(values: number[]): number | null {
  if (values.length < 4) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    (values.length - 1);
  return Math.sqrt(Math.max(0, variance));
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

function sideSign(side: PortfolioSide): 1 | -1 {
  return side === "UP" ? 1 : -1;
}

function sideGap(side: PortfolioSide, gap: number): number {
  return side === "UP" ? gap : -gap;
}

function advantageSide(gap: number): PortfolioSide {
  return gap >= 0 ? "UP" : "DOWN";
}

function oppositeSide(side: PortfolioSide): PortfolioSide {
  return side === "UP" ? "DOWN" : "UP";
}

function sumRecent(values: number[], count: number, offset = 0): number | null {
  const end = values.length - offset;
  const start = Math.max(0, end - count);
  if (end <= 0 || start >= end) return null;
  let sum = 0;
  for (let i = start; i < end; i++) sum += values[i] ?? 0;
  return sum;
}

function signFlipCount(values: number[]): number {
  let previous = 0;
  let flips = 0;
  for (const value of values) {
    const sign = Math.abs(value) <= EPSILON ? 0 : value > 0 ? 1 : -1;
    if (sign === 0) continue;
    if (previous !== 0 && sign !== previous) flips++;
    previous = sign;
  }
  return flips;
}

function quoteSlope(
  stats: PortfolioStats,
  side: PortfolioSide,
  field: "bid" | "ask",
  seconds: number,
): number | null {
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

export function createPortfolioStats(): PortfolioStats {
  return {
    lastUpdateMs: 0,
    lastPrice: null,
    lastGap: null,
    atr: null,
    gapAtr: null,
    gapVelocityEma: null,
    fastGapEma: null,
    slowGapEma: null,
    gapDeltas: [],
    priceDeltas: [],
    absGapWindow: [],
    peakAbsGap: 0,
    quotes: { UP: [], DOWN: [] },
  };
}

function updateQuote(
  stats: PortfolioStats,
  side: PortfolioSide,
  quality: BookQuality | null,
  now: number,
): void {
  stats.quotes[side].push({
    ts: now,
    ask: quality?.ask ?? null,
    bid: quality?.bid ?? null,
  });
  while (stats.quotes[side].length > 60) stats.quotes[side].shift();
}

export function updatePortfolioStats(params: {
  stats: PortfolioStats;
  now: number;
  price: number;
  gap: number;
  upQuality: BookQuality | null;
  downQuality: BookQuality | null;
  config?: PortfolioConfig;
}): void {
  const config = params.config ?? CONFIG;
  const { stats, now, price, gap } = params;
  if (now - stats.lastUpdateMs < config.statsIntervalMs) return;

  updateQuote(stats, "UP", params.upQuality, now);
  updateQuote(stats, "DOWN", params.downQuality, now);

  if (stats.lastPrice !== null) {
    const delta = price - stats.lastPrice;
    stats.priceDeltas.push(delta);
    while (stats.priceDeltas.length > 90) stats.priceDeltas.shift();
    stats.atr = ema(stats.atr, Math.abs(delta), 14);
  }
  if (stats.lastGap !== null) {
    const delta = gap - stats.lastGap;
    stats.gapDeltas.push(delta);
    while (stats.gapDeltas.length > 90) stats.gapDeltas.shift();
    stats.gapAtr = ema(stats.gapAtr, Math.abs(delta), 14);
    stats.gapVelocityEma = ema(stats.gapVelocityEma, delta, 5);
  }
  stats.fastGapEma = ema(stats.fastGapEma, gap, 3);
  stats.slowGapEma = ema(stats.slowGapEma, gap, 10);
  stats.absGapWindow.push(Math.abs(gap));
  while (stats.absGapWindow.length > 90) stats.absGapWindow.shift();
  stats.peakAbsGap = Math.max(stats.peakAbsGap, Math.abs(gap));
  stats.lastPrice = price;
  stats.lastGap = gap;
  stats.lastUpdateMs = now;
}

function rollingSigma(stats: PortfolioStats): number | null {
  return standardDeviation(stats.priceDeltas) ?? stats.atr;
}

function remainingSigma(
  stats: PortfolioStats,
  remaining: number,
  config: Pick<PortfolioConfig, "sigmaMultiplier"> = CONFIG,
): number | null {
  const sigma = rollingSigma(stats);
  if (sigma === null || sigma <= EPSILON) return null;
  return sigma * config.sigmaMultiplier * Math.sqrt(Math.max(1, remaining));
}

function fairProbability(params: {
  side: PortfolioSide;
  gap: number;
  remaining: number;
  stats: PortfolioStats;
  projectedGap?: number;
  config?: PortfolioConfig;
}): number {
  const sigma = remainingSigma(params.stats, params.remaining, params.config ?? CONFIG);
  if (sigma === null || sigma <= EPSILON) return 0.5;
  const z = sideGap(params.side, params.projectedGap ?? params.gap) / sigma;
  return clamp(normalCdf(z), 0.01, 0.99);
}

function momentumSnapshot(stats: PortfolioStats) {
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

export function computeBookQuality(params: {
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

export function portfolioView(
  state: Pick<PortfolioRuntimeState, "legs" | "realizedCash">,
): PortfolioView {
  const upShares = state.legs
    .filter((leg) => leg.side === "UP")
    .reduce((sum, leg) => sum + leg.shares, 0);
  const downShares = state.legs
    .filter((leg) => leg.side === "DOWN")
    .reduce((sum, leg) => sum + leg.shares, 0);
  const upPnl = state.realizedCash + upShares;
  const downPnl = state.realizedCash + downShares;
  return {
    upShares,
    downShares,
    realizedCash: state.realizedCash,
    upPnl,
    downPnl,
    guaranteedPnl: Math.min(upPnl, downPnl),
    bestCasePnl: Math.max(upPnl, downPnl),
    balancedShares: Math.min(upShares, downShares),
    imbalanceShares: Math.abs(upShares - downShares),
  };
}

function marketPassesCommonFilters(
  quality: BookQuality,
  config: PortfolioConfig,
  maxAsk: number,
): boolean {
  return (
    quality.spread >= 0 &&
    quality.spread <= config.maxSpread &&
    quality.ask >= config.minEntryAsk &&
    quality.ask <= maxAsk &&
    quality.askLiquidity >= config.minEntryLiquidityUsd &&
    quality.bidLiquidity >= config.minExitLiquidityUsd
  );
}

function canAddLeg(params: {
  side: PortfolioSide;
  state: EntryLimitState;
  config: PortfolioConfig;
}): boolean {
  const pendingEntryCount = params.state.pendingEntryCount ?? 0;
  if (
    (params.state.openedLegCount ?? params.state.legs.length) + pendingEntryCount >=
    params.config.maxEntriesPerMarket
  ) {
    return false;
  }
  if (params.state.legs.length + pendingEntryCount >= params.config.maxOpenLegs) return false;
  const sameSide =
    params.state.legs.filter((leg) => leg.side === params.side).length +
    (params.state.pendingEntrySideCounts?.[params.side] ?? 0);
  return sameSide < params.config.maxSameSideLegs;
}

function netEdge(pFair: number, quality: BookQuality, config: PortfolioConfig): number {
  const executionBuffer = Math.max(config.costBuffer, quality.spread + config.costBuffer * 0.5);
  return parseFloat((pFair - quality.ask - executionBuffer).toFixed(4));
}

function portfolioAfterBuy(params: {
  state: Pick<PortfolioRuntimeState, "legs" | "realizedCash">;
  side: PortfolioSide;
  ask: number;
  shares: number;
}): PortfolioView {
  return portfolioView({
    realizedCash: params.state.realizedCash - params.ask * params.shares,
    legs: [
      ...params.state.legs,
      {
        id: "preview",
        model: "continuation",
        side: params.side,
        tokenId: "",
        entryPrice: params.ask,
        entryGap: 0,
        entrySideGap: 0,
        entryMs: 0,
        shares: params.shares,
        pFairEntry: 0,
        netEdgeEntry: 0,
        scoreEntry: 0,
        takeProfitPrice: 0,
        stopLossPrice: 0,
        peakSideGap: 0,
        peakBid: null,
        trendInvalidSinceMs: null,
        riskExitAttempts: 0,
      },
    ],
  });
}

function evaluateContinuation(params: {
  side: PortfolioSide;
  gap: number;
  remaining: number;
  quality: BookQuality;
  stats: PortfolioStats;
  state: EntryLimitState & Pick<PortfolioRuntimeState, "realizedCash">;
  config: PortfolioConfig;
}): PortfolioEntryDecision | null {
  const { side, gap, remaining, quality, stats, state, config } = params;
  if (!canAddLeg({ side, state, config })) return null;
  if (!marketPassesCommonFilters(quality, config, config.maxContinuationAsk)) return null;
  if (signFlipCount(stats.gapDeltas.slice(-10)) > config.maxSignFlipCount) return null;

  const absGap = Math.abs(gap);
  const sigma = remainingSigma(stats, remaining, config);
  const relativeGap = sigma === null ? null : absGap / Math.max(sigma, EPSILON);
  const peakRetain = stats.peakAbsGap > 0 ? absGap / stats.peakAbsGap : null;
  const peakRetrace = peakRetain === null ? null : 1 - peakRetain;
  const { velocityShort, velocityMid, acceleration, emaTrend } = momentumSnapshot(stats);
  const sign = sideSign(side);
  const sideVelocityShort = velocityShort === null ? null : velocityShort * sign;
  const sideVelocityMid = velocityMid === null ? null : velocityMid * sign;
  const sideAcceleration = acceleration === null ? null : acceleration * sign;
  const sideEmaTrend = emaTrend === null ? null : emaTrend * sign;
  const projectedGap =
    gap + (stats.gapVelocityEma ?? velocityShort ?? 0) * Math.min(config.projectionSeconds, remaining * 0.25);
  const pFair = fairProbability({ side, gap, remaining, stats, projectedGap, config });
  const edge = netEdge(pFair, quality, config);

  if (absGap < config.minContinuationAbsGap) return null;
  if (relativeGap !== null && relativeGap < config.minContinuationRelativeGap) return null;
  if (peakRetain !== null && peakRetain < config.minContinuationPeakRetain) return null;
  if (sideVelocityShort !== null && sideVelocityShort <= 0) return null;
  if (sideVelocityMid !== null && sideVelocityMid < -0.5) return null;
  if (sideAcceleration !== null && sideAcceleration < -2) return null;
  if (sideEmaTrend !== null && sideEmaTrend <= 0) return null;
  if (edge < config.minContinuationNetEdge) return null;

  const after = portfolioAfterBuy({ state, side, ask: quality.ask, shares: config.shares });
  const hedgeBonus = state.legs.some((leg) => leg.side === oppositeSide(side))
    ? clamp((after.guaranteedPnl - portfolioView(state).guaranteedPnl) / 0.5)
    : 0;
  const edgeScore = clamp(edge / 0.16);
  const momentumScore =
    ((sideVelocityShort !== null && sideVelocityShort > 0 ? 1 : 0.5) +
      (sideVelocityMid !== null && sideVelocityMid > 0 ? 1 : 0.5) +
      (sideEmaTrend !== null && sideEmaTrend > 0 ? 1 : 0.5)) /
    3;
  const relativeGapScore =
    relativeGap === null
      ? 0.5
      : clamp((relativeGap - config.minContinuationRelativeGap) / 1.2);
  const retainScore =
    peakRetain === null ? 0.5 : clamp((peakRetain - config.minContinuationPeakRetain) / 0.26);
  const bookScore = clamp((quality.bidLiquidity - quality.askLiquidity) / Math.max(quality.bidLiquidity + quality.askLiquidity, EPSILON) / 2 + 0.5);
  const score = parseFloat(
    (
      0.3 * edgeScore +
      0.24 * momentumScore +
      0.16 * relativeGapScore +
      0.12 * retainScore +
      0.1 * bookScore +
      0.08 * hedgeBonus
    ).toFixed(4),
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
    relativeGap,
    peakRetain,
    peakRetrace,
    velocityShort,
    velocityMid,
    acceleration,
    emaTrend,
    pFair,
    netEdge: edge,
    projectedGap,
    guaranteedPnlAfter: after.guaranteedPnl,
    takeProfitPrice: priceRound(quality.ask + config.takeProfitCents),
    stopLossPrice: priceRound(quality.ask - config.maxLossCents),
  };
}

function evaluateReversal(params: {
  side: PortfolioSide;
  gap: number;
  remaining: number;
  quality: BookQuality;
  stats: PortfolioStats;
  state: EntryLimitState & Pick<PortfolioRuntimeState, "realizedCash">;
  config: PortfolioConfig;
}): PortfolioEntryDecision | null {
  const { side, gap, remaining, quality, stats, state, config } = params;
  if (!canAddLeg({ side, state, config })) return null;
  if (!marketPassesCommonFilters(quality, config, config.maxReversalAsk)) return null;
  if (signFlipCount(stats.gapDeltas.slice(-10)) > config.maxSignFlipCount + 1) return null;

  const absGap = Math.abs(gap);
  const sigma = remainingSigma(stats, remaining, config);
  const relativeGap = sigma === null ? null : absGap / Math.max(sigma, EPSILON);
  const peakRetain = stats.peakAbsGap > 0 ? absGap / stats.peakAbsGap : null;
  const peakRetrace = peakRetain === null ? null : 1 - peakRetain;
  const { velocityShort, velocityMid, acceleration, emaTrend } = momentumSnapshot(stats);
  const advSign = sideSign(advantageSide(gap));
  const movingTowardZero = velocityShort !== null && velocityShort * advSign < 0;
  const accelerationAgainstAdv = acceleration !== null && acceleration * advSign < 0;
  const emaAgainstAdv = emaTrend !== null && emaTrend * advSign < 0;
  const bidSlope3s = quoteSlope(stats, side, "bid", 3);
  const askSlope3s = quoteSlope(stats, side, "ask", 3);
  const projectedGap =
    gap + (stats.gapVelocityEma ?? velocityShort ?? 0) * Math.min(config.projectionSeconds, remaining * 0.3);
  const pFair = fairProbability({ side, gap, remaining, stats, projectedGap, config });
  const edge = netEdge(pFair, quality, config);

  if (absGap < config.minReversalAbsGap) return null;
  if (relativeGap !== null && relativeGap < config.minReversalRelativeGap) return null;
  if (peakRetrace === null || peakRetrace < config.minReversalPeakRetrace) return null;
  if (peakRetrace > config.maxReversalPeakRetrace) return null;
  if (!movingTowardZero || !accelerationAgainstAdv) return null;
  if (!emaAgainstAdv && (bidSlope3s === null || bidSlope3s <= 0)) return null;
  if (askSlope3s !== null && askSlope3s > 0.06) return null;
  if (edge < config.minReversalNetEdge) return null;

  const after = portfolioAfterBuy({ state, side, ask: quality.ask, shares: config.shares });
  const hedgeBonus = state.legs.some((leg) => leg.side === oppositeSide(side))
    ? clamp((after.guaranteedPnl - portfolioView(state).guaranteedPnl) / 0.5)
    : 0;
  const edgeScore = clamp(edge / 0.18);
  const extensionScore =
    relativeGap === null ? 0.5 : clamp((relativeGap - config.minReversalRelativeGap) / 1.6);
  const decayScore =
    ((movingTowardZero ? 1 : 0) +
      (accelerationAgainstAdv ? 1 : 0) +
      (emaAgainstAdv ? 1 : 0) +
      (bidSlope3s === null || bidSlope3s > 0 ? 1 : 0)) /
    4;
  const retraceScore = clamp(
    (peakRetrace - config.minReversalPeakRetrace) /
      Math.max(config.maxReversalPeakRetrace - config.minReversalPeakRetrace, EPSILON),
  );
  const bookScore = clamp((quality.bidLiquidity - quality.askLiquidity) / Math.max(quality.bidLiquidity + quality.askLiquidity, EPSILON) / 2 + 0.5);
  const score = parseFloat(
    (
      0.3 * edgeScore +
      0.22 * extensionScore +
      0.2 * decayScore +
      0.12 * retraceScore +
      0.08 * bookScore +
      0.08 * hedgeBonus
    ).toFixed(4),
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
    relativeGap,
    peakRetain,
    peakRetrace,
    velocityShort,
    velocityMid,
    acceleration,
    emaTrend,
    pFair,
    netEdge: edge,
    projectedGap,
    guaranteedPnlAfter: after.guaranteedPnl,
    takeProfitPrice: priceRound(Math.min(0.94, quality.ask + config.takeProfitCents)),
    stopLossPrice: priceRound(quality.ask - Math.min(config.maxLossCents, 0.07)),
  };
}

export function choosePortfolioEntry(params: {
  remaining: number;
  gap: number;
  upQuality: BookQuality | null;
  downQuality: BookQuality | null;
  stats: PortfolioStats;
  state: EntryLimitState & Pick<PortfolioRuntimeState, "realizedCash">;
  config?: PortfolioConfig;
}): PortfolioEntryDecision | null {
  const config = params.config ?? CONFIG;
  if (params.remaining < config.minEntryRemaining || params.remaining > config.maxEntryRemaining) {
    return null;
  }
  if (params.remaining <= config.finalExitSeconds) return null;

  const adv = advantageSide(params.gap);
  const weak = oppositeSide(adv);
  const advQuality = adv === "UP" ? params.upQuality : params.downQuality;
  const weakQuality = weak === "UP" ? params.upQuality : params.downQuality;
  const continuation = advQuality
    ? evaluateContinuation({
        side: adv,
        gap: params.gap,
        remaining: params.remaining,
        quality: advQuality,
        stats: params.stats,
        state: params.state,
        config,
      })
    : null;
  const reversal = weakQuality
    ? evaluateReversal({
        side: weak,
        gap: params.gap,
        remaining: params.remaining,
        quality: weakQuality,
        stats: params.stats,
        state: params.state,
        config,
      })
    : null;

  if (
    reversal &&
    (!continuation || reversal.score >= continuation.score + config.reversalScoreMargin)
  ) {
    return reversal;
  }
  return continuation;
}

function trendSupportsLeg(leg: PortfolioLeg, gap: number, stats: PortfolioStats): boolean {
  const { velocityShort, velocityMid, emaTrend } = momentumSnapshot(stats);
  const sign = sideSign(leg.side);
  const sideVelocityShort = velocityShort === null ? null : velocityShort * sign;
  const sideVelocityMid = velocityMid === null ? null : velocityMid * sign;
  const sideEmaTrend = emaTrend === null ? null : emaTrend * sign;
  const currentSideGap = sideGap(leg.side, gap);
  const peakRetain =
    leg.peakSideGap > 0 && currentSideGap > 0 ? currentSideGap / leg.peakSideGap : 0;
  return (
    currentSideGap > 0 &&
    peakRetain >= 0.7 &&
    (sideVelocityShort === null || sideVelocityShort >= 0) &&
    (sideVelocityMid === null || sideVelocityMid >= -0.25) &&
    (sideEmaTrend === null || sideEmaTrend >= 0)
  );
}

export function updatePortfolioLeg(leg: PortfolioLeg, gap: number, bid: number | null): void {
  leg.peakSideGap = Math.max(leg.peakSideGap, sideGap(leg.side, gap));
  if (bid !== null) leg.peakBid = Math.max(leg.peakBid ?? bid, bid);
}

export function portfolioSettlementHoldAllowed(params: {
  leg: PortfolioLeg;
  state: Pick<PortfolioRuntimeState, "legs" | "realizedCash">;
  gap: number;
  remaining: number;
  stats: PortfolioStats;
  config?: PortfolioConfig;
}): boolean {
  const config = params.config ?? CONFIG;
  const view = portfolioView(params.state);
  const pFair = fairProbability({
    side: params.leg.side,
    gap: params.gap,
    remaining: params.remaining,
    stats: params.stats,
    config,
  });
  const currentSideGap = sideGap(params.leg.side, params.gap);
  const protectedPortfolio =
    view.balancedShares > 0 && view.guaranteedPnl >= config.settlementMinGuaranteedPnl;
  const strongSingleSide =
    pFair >= config.settlementMinProbability &&
    currentSideGap >= config.settlementMinSideGap;
  return (
    params.remaining <= config.settlementHoldMaxSeconds &&
    (protectedPortfolio || strongSingleSide)
  );
}

export function shouldExitPortfolioLeg(params: {
  leg: PortfolioLeg;
  state: Pick<PortfolioRuntimeState, "legs" | "realizedCash">;
  gap: number;
  bid: number | null;
  remaining: number;
  now: number;
  stats: PortfolioStats;
  config?: PortfolioConfig;
}): { price: number; reason: string; mode: string; holdMs: number } | null {
  const config = params.config ?? CONFIG;
  const { leg, gap, bid, remaining, now, stats } = params;
  const holdMs = now - leg.entryMs;
  const price = bid ?? leg.stopLossPrice;
  const profit = bid === null ? null : bid - leg.entryPrice;
  const trendSupports = trendSupportsLeg(leg, gap, stats);
  const currentSideGap = sideGap(leg.side, gap);
  const { velocityShort, emaTrend } = momentumSnapshot(stats);
  const legVelocity = velocityShort === null ? null : velocityShort * sideSign(leg.side);
  const legEmaTrend = emaTrend === null ? null : emaTrend * sideSign(leg.side);
  const peakRetain =
    leg.peakSideGap > 0 && currentSideGap > 0 ? currentSideGap / leg.peakSideGap : 0;
  const trendInvalid =
    currentSideGap <= 0 ||
    (peakRetain < 0.58 &&
      (legVelocity === null || legVelocity < 0) &&
      (legEmaTrend === null || legEmaTrend < 0));

  if (!trendInvalid) {
    leg.trendInvalidSinceMs = null;
  } else if (leg.trendInvalidSinceMs === null) {
    leg.trendInvalidSinceMs = now;
  }

  if (portfolioSettlementHoldAllowed(params)) return null;

  if (
    leg.model === "reversal" &&
    holdMs >= config.reversalFailureMinHoldMs &&
    currentSideGap < -Math.abs(leg.entryGap) * 0.9 &&
    (legVelocity === null || legVelocity < 0)
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
    const peakBid = leg.peakBid ?? bid;
    if (
      profit > 0 &&
      peakBid - leg.entryPrice >= config.profitLockMin &&
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
    if (remaining <= 45 && profit > 0) {
      return { price: bid, reason: "final profit lock", mode: "final-profit", holdMs };
    }
  }

  const trendInvalidConfirmed =
    leg.trendInvalidSinceMs !== null &&
    now - leg.trendInvalidSinceMs >= config.trendInvalidConfirmMs;
  if (holdMs >= config.minHoldMs && trendInvalidConfirmed) {
    return { price, reason: "trend invalidated", mode: "trend-invalid", holdMs };
  }
  if (remaining <= config.finalExitSeconds) {
    return { price, reason: "final timed exit", mode: "final-exit", holdMs };
  }
  return null;
}

function bestAsk(ctx: StrategyContext, side: PortfolioSide) {
  return ctx.orderBook.bestAskInfo(side);
}

function bestBidInfo(ctx: StrategyContext, side: PortfolioSide) {
  return ctx.orderBook.bestBidInfo(side);
}

function bestBid(ctx: StrategyContext, side: PortfolioSide): number | null {
  return bestBidInfo(ctx, side)?.price ?? null;
}

function sideToken(ctx: StrategyContext, side: PortfolioSide): string {
  return side === "UP" ? ctx.clobTokenIds[0] : ctx.clobTokenIds[1];
}

function removeLeg(state: PortfolioRuntimeState, leg: PortfolioLeg): void {
  state.legs = state.legs.filter((candidate) => candidate.id !== leg.id);
  state.closingLegIds.delete(leg.id);
}

function buildMetrics(params: {
  ctx: StrategyContext;
  remaining: number;
  btcPrice: number | null;
  priceToBeat: number | null;
  gap: number | null;
  stats: PortfolioStats;
  state: PortfolioRuntimeState;
  entry?: PortfolioEntryDecision | null;
  leg?: PortfolioLeg | null;
  extra?: StrategyMetrics;
}): StrategyMetrics {
  const activeSide = params.entry?.side ?? params.leg?.side ?? null;
  const ask = activeSide ? bestAsk(params.ctx, activeSide) : null;
  const bid = activeSide ? bestBidInfo(params.ctx, activeSide) : null;
  const view = portfolioView(params.state);
  const sigma =
    params.gap === null ? null : remainingSigma(params.stats, params.remaining);
  const pFair =
    activeSide && params.gap !== null
      ? fairProbability({
          side: activeSide,
          gap: params.gap,
          remaining: params.remaining,
          stats: params.stats,
        })
      : null;
  const momentum = momentumSnapshot(params.stats);
  return {
    strategy: "probability-portfolio",
    remaining: params.remaining,
    btcPrice: params.btcPrice,
    priceToBeat: params.priceToBeat,
    gap: params.gap,
    absGap: params.gap === null ? null : Math.abs(params.gap),
    side: activeSide,
    model: params.entry?.model ?? params.leg?.model ?? null,
    atr: round(params.stats.atr, 6),
    gapAtr: round(params.stats.gapAtr, 6),
    remainingSigma: round(sigma, 6),
    relativeGap:
      params.gap !== null && sigma !== null ? round(Math.abs(params.gap) / sigma) : null,
    peakAbsGap: round(params.stats.peakAbsGap),
    peakRetain:
      params.gap !== null && params.stats.peakAbsGap > 0
        ? round(Math.abs(params.gap) / params.stats.peakAbsGap)
        : null,
    peakRetrace:
      params.gap !== null && params.stats.peakAbsGap > 0
        ? round(1 - Math.abs(params.gap) / params.stats.peakAbsGap)
        : null,
    velocityShort: round(momentum.velocityShort),
    velocityMid: round(momentum.velocityMid),
    acceleration: round(momentum.acceleration),
    gapVelocityEma: round(params.stats.gapVelocityEma),
    emaTrend: round(momentum.emaTrend),
    pFair: round(params.entry?.pFair ?? pFair),
    netEdge: round(params.entry?.netEdge ?? null),
    score: round(params.entry?.score ?? null),
    entryAsk: params.entry?.ask ?? null,
    entryBid: params.entry?.bid ?? null,
    bestAsk: ask?.price ?? null,
    bestAskLiquidity: ask?.liquidity ?? null,
    bestBid: bid?.price ?? null,
    bestBidLiquidity: bid?.liquidity ?? null,
    spread: params.entry?.spread ?? (ask && bid ? round(ask.price - bid.price) : null),
    entryPrice: params.leg?.entryPrice ?? null,
    entryGap: params.leg?.entryGap ?? null,
    entrySideGap: params.leg?.entrySideGap ?? null,
    peakSideGap: params.leg?.peakSideGap ?? null,
    peakBid: params.leg?.peakBid ?? null,
    unrealizedEdge:
      params.leg && bid?.price !== undefined ? round(bid.price - params.leg.entryPrice) : null,
    openLegs: params.state.legs.length,
    pendingEntryCount: params.state.pendingEntryCount,
    pendingUpEntries: params.state.pendingEntrySideCounts.UP,
    pendingDownEntries: params.state.pendingEntrySideCounts.DOWN,
    upShares: round(view.upShares),
    downShares: round(view.downShares),
    realizedCash: round(view.realizedCash),
    guaranteedPnl: round(view.guaranteedPnl),
    upPnl: round(view.upPnl),
    downPnl: round(view.downPnl),
    guaranteedPnlAfter: round(params.entry?.guaranteedPnlAfter ?? null),
    settlementHold:
      params.leg && params.gap !== null
        ? portfolioSettlementHoldAllowed({
            leg: params.leg,
            state: params.state,
            gap: params.gap,
            remaining: params.remaining,
            stats: params.stats,
          })
        : null,
    ...params.extra,
  };
}

function releaseOnce(state: PortfolioRuntimeState, release: () => void): void {
  if (state.released) return;
  state.released = true;
  release();
}

function reservePendingEntry(state: PortfolioRuntimeState, side: PortfolioSide): void {
  state.pendingEntryCount++;
  state.pendingEntrySideCounts[side]++;
}

function releasePendingEntry(state: PortfolioRuntimeState, side: PortfolioSide): void {
  state.pendingEntryCount = Math.max(0, state.pendingEntryCount - 1);
  state.pendingEntrySideCounts[side] = Math.max(0, state.pendingEntrySideCounts[side] - 1);
}

function placeSell(params: {
  ctx: StrategyContext;
  state: PortfolioRuntimeState;
  leg: PortfolioLeg;
  price: number;
  label: string;
  reason: string;
  metrics: StrategyMetrics;
  getMetrics: () => StrategyMetrics;
  release: () => void;
}): void {
  if (params.state.closingLegIds.has(params.leg.id)) return;
  params.state.closingLegIds.add(params.leg.id);
  const expireAtMs = Date.now() + CONFIG.riskExitOrderTtlMs;
  const signalId = params.ctx.recordSignal({
    action: "sell",
    side: params.leg.side,
    label: params.label,
    metrics: params.metrics,
  });
  params.ctx.postOrders([
    {
      req: {
        tokenId: params.leg.tokenId,
        action: "sell",
        price: params.price,
        shares: params.leg.shares,
      },
      expireAtMs,
      analysis: {
        signalId,
        label: params.label,
        getMetrics: params.getMetrics,
      },
      onFilled(filledShares) {
        params.state.realizedCash += params.price * filledShares;
        removeLeg(params.state, params.leg);
        params.ctx.log(
          `[${params.ctx.slug}] probability-portfolio: SELL ${params.leg.side} ${params.leg.model} filled @ ${params.price} (${params.reason})`,
          "green",
        );
        if (params.state.legs.length === 0) releaseOnce(params.state, params.release);
      },
      onExpired() {
        params.ctx.log(
          `[${params.ctx.slug}] probability-portfolio: SELL ${params.leg.side} @ ${params.price} expired`,
          "red",
        );
        params.state.closingLegIds.delete(params.leg.id);
        if (
          Date.now() < params.ctx.slotEndMs - 1_000 &&
          params.leg.riskExitAttempts < CONFIG.riskExitMaxRetries
        ) {
          params.leg.riskExitAttempts++;
          placeSell({
            ...params,
            price: bestBid(params.ctx, params.leg.side) ?? Math.max(0.01, params.price - 0.01),
            reason: `${params.reason} retry ${params.leg.riskExitAttempts}`,
          });
          return;
        }
        const sellIds = params.ctx.pendingOrders
          .filter((order) => order.action === "sell" && order.tokenId === params.leg.tokenId)
          .map((order) => order.orderId);
        if (sellIds.length > 0) params.ctx.emergencySells(sellIds).catch(() => {});
      },
      onFailed(reason) {
        params.ctx.log(
          `[${params.ctx.slug}] probability-portfolio: SELL ${params.leg.side} failed (${reason})`,
          "red",
        );
        if (!reason.includes("order expired before placement")) {
          params.state.closingLegIds.delete(params.leg.id);
        }
      },
    },
  ]);
}

export const probabilityPortfolio: Strategy = async (ctx) => {
  if (Env.get("PROD")) {
    ctx.log(
      "[probability-portfolio] Strategy is simulation-first. Remove this guard only after fresh out-of-sample replay and small-size paper runs are stable.",
      "red",
    );
    process.exit(1);
  }

  const release = ctx.hold();
  const stats = createPortfolioStats();
  const state: PortfolioRuntimeState = {
    legs: [],
    closingLegIds: new Set<string>(),
    pendingEntryCount: 0,
    pendingEntrySideCounts: { UP: 0, DOWN: 0 },
    realizedCash: 0,
    released: false,
    settlementHoldLogged: false,
    openedLegCount: 0,
  };

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
    const upQuality = computeBookQuality({
      ask: bestAsk(ctx, "UP"),
      bid: bestBidInfo(ctx, "UP"),
    });
    const downQuality = computeBookQuality({
      ask: bestAsk(ctx, "DOWN"),
      bid: bestBidInfo(ctx, "DOWN"),
    });
    updatePortfolioStats({
      stats,
      now,
      price: btcPrice,
      gap,
      upQuality,
      downQuality,
    });

    const entry = choosePortfolioEntry({
      remaining,
      gap,
      upQuality,
      downQuality,
      stats,
      state,
    });
    if (entry) {
      const tokenId = sideToken(ctx, entry.side);
      const metrics = buildMetrics({
        ctx,
        remaining,
        btcPrice,
        priceToBeat,
        gap,
        stats,
        state,
        entry,
      });
      const signalId = ctx.recordSignal({
        action: "buy",
        side: entry.side,
        label: `probability-portfolio ${entry.model} entry`,
        metrics,
      });
      ctx.log(
        `[${ctx.slug}] probability-portfolio: signal BUY ${entry.side} ${entry.model} @ ${entry.ask} score ${entry.score}`,
        "cyan",
      );
      reservePendingEntry(state, entry.side);
      ctx.postOrders([
        {
          req: {
            tokenId,
            action: "buy",
            price: entry.ask,
            shares: CONFIG.shares,
          },
          expireAtMs: Math.min(ctx.slotEndMs - CONFIG.finalExitSeconds * 1000, now + 8_000),
          analysis: {
            signalId,
            label: `probability-portfolio ${entry.model} entry`,
            getMetrics: () =>
              buildMetrics({
                ctx,
                remaining: Math.floor((ctx.slotEndMs - Date.now()) / 1000),
                btcPrice: ctx.ticker.price ?? null,
                priceToBeat,
                gap: ctx.ticker.price !== undefined ? ctx.ticker.price - priceToBeat : null,
                stats,
                state,
                entry,
              }),
          },
          onFilled(filledShares) {
            releasePendingEntry(state, entry.side);
            const fillGap =
              ctx.ticker.price !== undefined ? ctx.ticker.price - priceToBeat : gap;
            const leg: PortfolioLeg = {
              id: `${entry.side}-${entry.model}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
              model: entry.model,
              side: entry.side,
              tokenId,
              entryPrice: entry.ask,
              entryGap: fillGap,
              entrySideGap: sideGap(entry.side, fillGap),
              entryMs: Date.now(),
              shares: filledShares,
              pFairEntry: entry.pFair,
              netEdgeEntry: entry.netEdge,
              scoreEntry: entry.score,
              takeProfitPrice: entry.takeProfitPrice,
              stopLossPrice: entry.stopLossPrice,
              peakSideGap: Math.max(0, sideGap(entry.side, fillGap)),
              peakBid: bestBid(ctx, entry.side),
              trendInvalidSinceMs: null,
              riskExitAttempts: 0,
            };
            state.realizedCash -= entry.ask * filledShares;
            state.openedLegCount++;
            state.legs.push(leg);
            state.settlementHoldLogged = false;
            ctx.log(
              `[${ctx.slug}] probability-portfolio: BUY ${entry.side} ${entry.model} filled @ ${entry.ask} (${filledShares} shares)`,
              "green",
            );
          },
          onExpired() {
            releasePendingEntry(state, entry.side);
            ctx.log(
              `[${ctx.slug}] probability-portfolio: BUY ${entry.side} @ ${entry.ask} expired`,
              "yellow",
            );
            if (state.legs.length === 0) releaseOnce(state, release);
          },
          onFailed(reason) {
            releasePendingEntry(state, entry.side);
            ctx.log(
              `[${ctx.slug}] probability-portfolio: BUY ${entry.side} failed (${reason})`,
              "red",
            );
            if (state.legs.length === 0) releaseOnce(state, release);
          },
        },
      ]);
    }

    for (const leg of [...state.legs]) {
      if (state.closingLegIds.has(leg.id)) continue;
      const bid = bestBid(ctx, leg.side);
      updatePortfolioLeg(leg, gap, bid);

      if (
        portfolioSettlementHoldAllowed({
          leg,
          state,
          gap,
          remaining,
          stats,
        })
      ) {
        if (!state.settlementHoldLogged) {
          state.settlementHoldLogged = true;
          const view = portfolioView(state);
          ctx.log(
            `[${ctx.slug}] probability-portfolio: holding portfolio to settlement (guaranteed ${view.guaranteedPnl.toFixed(2)})`,
            "cyan",
          );
        }
        continue;
      }

      const exit = shouldExitPortfolioLeg({
        leg,
        state,
        gap,
        bid,
        remaining,
        now,
        stats,
      });
      if (!exit) continue;

      const metrics = () =>
        buildMetrics({
          ctx,
          remaining: Math.floor((ctx.slotEndMs - Date.now()) / 1000),
          btcPrice: ctx.ticker.price ?? null,
          priceToBeat,
          gap: ctx.ticker.price !== undefined ? ctx.ticker.price - priceToBeat : null,
          stats,
          state,
          leg,
          extra: {
            exitReason: exit.reason,
            exitMode: exit.mode,
            holdSeconds: round(exit.holdMs / 1000, 3),
          },
        });
      placeSell({
        ctx,
        state,
        leg,
        price: exit.price,
        label: "probability-portfolio exit",
        reason: exit.reason,
        metrics: metrics(),
        getMetrics: metrics,
        release,
      });
    }
  }, CONFIG.tickIntervalMs);

  return () => {
    clearInterval(tickInterval);
  };
};

export const __probabilityPortfolioTestHooks = {
  readProbabilityPortfolioConfig,
  createPortfolioStats,
  updatePortfolioStats,
  computeBookQuality,
  choosePortfolioEntry,
  portfolioView,
  updatePortfolioLeg,
  shouldExitPortfolioLeg,
  portfolioSettlementHoldAllowed,
  fairProbability,
  momentumSnapshot,
};

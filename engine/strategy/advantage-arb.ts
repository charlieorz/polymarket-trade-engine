// Advantage-side arbitrage strategy

import type { Strategy, StrategyContext, StrategyMetrics } from "./types.ts";
import { Env } from "../../utils/config.ts";

type Side = "UP" | "DOWN";

type Position = {
  side: Side;
  tokenId: string;
  entryPrice: number;
  entryGap: number;
  entryAbsGap: number;
  entryMs: number;
  shares: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  peakSideGap: number;
  peakBid: number | null;
  adverseSinceMs: number | null;
  velocityAdverseSinceMs: number | null;
  settlementInvalidSinceMs: number | null;
  riskExitAttempts: number;
};

type State = {
  entered: boolean;
  position: Position | null;
  closing: boolean;
  released: boolean;
  settlementHoldLogged: boolean;
};

type EdgeStats = {
  atr: number | null;
  gapAtr: number | null;
  gapVelocity: number | null;
  gapVelocityEma: number | null;
  lastPrice: number | null;
  lastGap: number | null;
  lastUpdateMs: number;
  gapVelocityHistory: number[];
  peakSideGapBySide: Record<Side, number>;
  peakSignalStrengthBySide: Record<Side, number>;
  weakTrendSinceMsBySide: Record<Side, number | null>;
};

type SettlementView = {
  currentSideGap: number;
  requiredSideGap: number;
  holdToSettlement: boolean;
  holdInvalidated: boolean;
  settlementProfit: number;
  exitProfit: number | null;
  settlementUpside: number | null;
};

const SHARES = 6;
const MIN_ENTRY_REMAINING = 75;
const MAX_ENTRY_REMAINING = 240;
const EPSILON = 1e-9;

type AdvantageArbConfig = {
  tickIntervalMs: number;
  statsIntervalMs: number;
  atrPeriod: number;
  gapAtrPeriod: number;
  velocityEmaPeriod: number;
  trendLookback: number;
  noEntryFirstSeconds: number;
  noEntryLastSeconds: number;
  minEntrySignalStrength: number;
  minEntryPeakRetainRatio: number;
  entryWeakTrendConfirmMs: number;
  gapAwareTakeProfitEnabled: boolean;
  takeProfitDelayMinTrendConsistency: number;
  takeProfitDelayMinPeakRetainRatio: number;
  takeProfitDelayMinSideVelocityEma: number;
  settlementInvalidateRetainRatio: number;
  settlementInvalidateVelocityEma: number;
  settlementInvalidateConfirmMs: number;
  riskExitOrderTtlMs: number;
  riskExitMaxRetries: number;
  stopNegativeVelocityEma: number;
  stopVelocityConfirmMs: number;
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

function parseBooleanEnv(
  env: Record<string, string | undefined>,
  key: string,
  fallback: boolean,
): boolean {
  const value = env[key];
  if (value === undefined || value.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function readConfig(env: Record<string, string | undefined> = process.env): AdvantageArbConfig {
  return {
    tickIntervalMs: Math.max(50, parseNumberEnv(env, "ADV_ARB_TICK_INTERVAL_MS", 200)),
    statsIntervalMs: Math.max(100, parseNumberEnv(env, "ADV_ARB_STATS_INTERVAL_MS", 1000)),
    atrPeriod: Math.max(2, parseNumberEnv(env, "ADV_ARB_ATR_PERIOD", 14)),
    gapAtrPeriod: Math.max(2, parseNumberEnv(env, "ADV_ARB_GAP_ATR_PERIOD", 14)),
    velocityEmaPeriod: Math.max(2, parseNumberEnv(env, "ADV_ARB_VELOCITY_EMA_PERIOD", 5)),
    trendLookback: Math.max(2, Math.floor(parseNumberEnv(env, "ADV_ARB_TREND_LOOKBACK", 6))),
    noEntryFirstSeconds: Math.max(0, parseNumberEnv(env, "ADV_ARB_NO_ENTRY_FIRST_SECONDS", 5)),
    noEntryLastSeconds: Math.max(0, parseNumberEnv(env, "ADV_ARB_NO_ENTRY_LAST_SECONDS", 45)),
    minEntrySignalStrength: Math.max(0, parseNumberEnv(env, "ADV_ARB_MIN_ENTRY_SIGNAL_STRENGTH", 0)),
    minEntryPeakRetainRatio: Math.max(
      0,
      Math.min(1, parseNumberEnv(env, "ADV_ARB_MIN_ENTRY_PEAK_RETAIN_RATIO", 0.78)),
    ),
    entryWeakTrendConfirmMs: Math.max(
      0,
      parseNumberEnv(env, "ADV_ARB_ENTRY_WEAK_TREND_CONFIRM_MS", 2000),
    ),
    gapAwareTakeProfitEnabled: parseBooleanEnv(env, "ADV_ARB_GAP_AWARE_TP_ENABLED", true),
    takeProfitDelayMinTrendConsistency: Math.max(
      0,
      Math.min(1, parseNumberEnv(env, "ADV_ARB_TP_DELAY_MIN_TREND_CONSISTENCY", 0.67)),
    ),
    takeProfitDelayMinPeakRetainRatio: Math.max(
      0,
      Math.min(1, parseNumberEnv(env, "ADV_ARB_TP_DELAY_MIN_PEAK_RETAIN_RATIO", 0.85)),
    ),
    takeProfitDelayMinSideVelocityEma: parseNumberEnv(
      env,
      "ADV_ARB_TP_DELAY_MIN_SIDE_VELOCITY_EMA",
      0,
    ),
    settlementInvalidateRetainRatio: Math.max(
      0,
      Math.min(1, parseNumberEnv(env, "ADV_ARB_SETTLEMENT_INVALIDATE_RETAIN_RATIO", 0.55)),
    ),
    settlementInvalidateVelocityEma: parseNumberEnv(
      env,
      "ADV_ARB_SETTLEMENT_INVALIDATE_VELOCITY_EMA",
      -0.5,
    ),
    settlementInvalidateConfirmMs: Math.max(
      0,
      parseNumberEnv(env, "ADV_ARB_SETTLEMENT_INVALIDATE_CONFIRM_MS", 1500),
    ),
    riskExitOrderTtlMs: Math.max(250, parseNumberEnv(env, "ADV_ARB_RISK_EXIT_ORDER_TTL_MS", 5000)),
    riskExitMaxRetries: Math.max(
      0,
      Math.floor(parseNumberEnv(env, "ADV_ARB_RISK_EXIT_MAX_RETRIES", 3)),
    ),
    stopNegativeVelocityEma: parseNumberEnv(env, "ADV_ARB_STOP_NEGATIVE_VELOCITY_EMA", -0.5),
    stopVelocityConfirmMs: Math.max(
      0,
      parseNumberEnv(env, "ADV_ARB_STOP_VELOCITY_CONFIRM_MS", 2000),
    ),
  };
}

const CONFIG = readConfig();
const MIN_ABS_GAP = parseFloat(process.env.ADV_ARB_MIN_ABS_GAP ?? "8");
const ENTRY_ATR_MULTIPLIER = parseFloat(
  process.env.ADV_ARB_ENTRY_ATR_MULTIPLIER ?? "6",
);
const MIN_LIQUIDITY = parseFloat(process.env.ADV_ARB_MIN_LIQUIDITY ?? "20");
const MAX_ENTRY_ASK = parseFloat(process.env.ADV_ARB_MAX_ENTRY_ASK ?? "0.76");
const MIN_ENTRY_ASK = parseFloat(process.env.ADV_ARB_MIN_ENTRY_ASK ?? "0.52");
const MIN_PROFIT = parseFloat(process.env.ADV_ARB_MIN_PROFIT ?? "0.08");
const TAKE_PROFIT_BUFFER = parseFloat(
  process.env.ADV_ARB_TAKE_PROFIT_BUFFER ?? "0.02",
);
const MAX_PRICE_LOSS = parseFloat(process.env.ADV_ARB_MAX_PRICE_LOSS ?? "0.12");
const MAX_TAKE_PROFIT_PRICE = parseFloat(
  process.env.ADV_ARB_MAX_TAKE_PROFIT_PRICE ?? "0.96",
);
const TAKE_PROFIT_MIN_BID_LIQUIDITY = parseFloat(
  process.env.ADV_ARB_TAKE_PROFIT_MIN_BID_LIQUIDITY ?? String(SHARES),
);
const TAKE_PROFIT_PEAK_EXPANSION_RATIO = parseFloat(
  process.env.ADV_ARB_TAKE_PROFIT_PEAK_EXPANSION_RATIO ?? "1.2",
);
const TAKE_PROFIT_TRAIL_RATIO = parseFloat(
  process.env.ADV_ARB_TAKE_PROFIT_TRAIL_RATIO ?? "0.78",
);
const TAKE_PROFIT_LOCK_REMAINING = parseFloat(
  process.env.ADV_ARB_TAKE_PROFIT_LOCK_REMAINING ?? "45",
);
const TAKE_PROFIT_LOCK_BID = parseFloat(
  process.env.ADV_ARB_TAKE_PROFIT_LOCK_BID ?? "0.9",
);
const SETTLEMENT_HOLD_MAX_REMAINING = parseFloat(
  process.env.ADV_ARB_SETTLEMENT_HOLD_MAX_REMAINING ?? "75",
);
const SETTLEMENT_MIN_SIDE_GAP = parseFloat(
  process.env.ADV_ARB_SETTLEMENT_MIN_SIDE_GAP ?? "6",
);
const SETTLEMENT_FINAL_MIN_SIDE_GAP = parseFloat(
  process.env.ADV_ARB_SETTLEMENT_FINAL_MIN_SIDE_GAP ?? "2",
);
const SETTLEMENT_ATR_MULTIPLIER = parseFloat(
  process.env.ADV_ARB_SETTLEMENT_ATR_MULTIPLIER ?? "8",
);
const SETTLEMENT_EXIT_MIN_BID = parseFloat(
  process.env.ADV_ARB_SETTLEMENT_EXIT_MIN_BID ?? "0.97",
);
const STOP_LOSS_PRICE = parseFloat(process.env.ADV_ARB_STOP_LOSS_PRICE ?? "0.48");
const LAST_MINUTE_STOP_LOSS_ASK = parseFloat(
  process.env.ADV_ARB_LAST_MINUTE_STOP_LOSS_ASK ?? "0.55",
);
const GAP_RETRACE_RATIO = parseFloat(
  process.env.ADV_ARB_GAP_RETRACE_RATIO ?? "0.65",
);
const EARLY_STOP_ENTRY_RETRACE_RATIO = parseFloat(
  process.env.ADV_ARB_EARLY_STOP_ENTRY_RETRACE_RATIO ?? "0.55",
);
const EARLY_STOP_PEAK_RETRACE_RATIO = parseFloat(
  process.env.ADV_ARB_EARLY_STOP_PEAK_RETRACE_RATIO ?? "0.52",
);
const EARLY_STOP_CONFIRM_MS = parseFloat(
  process.env.ADV_ARB_EARLY_STOP_CONFIRM_MS ?? "2000",
);
const REVERSAL_GAP_BUFFER = parseFloat(
  process.env.ADV_ARB_REVERSAL_GAP_BUFFER ?? "1.5",
);
const EARLY_STOP_MAX_POSITIVE_SIDE_GAP = parseFloat(
  process.env.ADV_ARB_EARLY_STOP_MAX_POSITIVE_SIDE_GAP ?? "1.5",
);
const MIN_HOLD_MS = parseFloat(process.env.ADV_ARB_MIN_HOLD_MS ?? "3000");

function ema(previous: number | null, value: number, period: number): number {
  return previous === null ? value : (previous * (period - 1) + value) / period;
}

function createEdgeStats(): EdgeStats {
  return {
    atr: null,
    gapAtr: null,
    gapVelocity: null,
    gapVelocityEma: null,
    lastPrice: null,
    lastGap: null,
    lastUpdateMs: 0,
    gapVelocityHistory: [],
    peakSideGapBySide: { UP: 0, DOWN: 0 },
    peakSignalStrengthBySide: { UP: 0, DOWN: 0 },
    weakTrendSinceMsBySide: { UP: null, DOWN: null },
  };
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
    const tr = Math.abs(price - stats.lastPrice);
    stats.atr = ema(stats.atr, tr, config.atrPeriod);
  }
  if (stats.lastGap !== null) {
    const gapVelocity = gap - stats.lastGap;
    stats.gapVelocity = gapVelocity;
    stats.gapVelocityEma = ema(
      stats.gapVelocityEma,
      gapVelocity,
      config.velocityEmaPeriod,
    );
    stats.gapAtr = ema(stats.gapAtr, Math.abs(gapVelocity), config.gapAtrPeriod);
    stats.gapVelocityHistory.push(gapVelocity);
    if (stats.gapVelocityHistory.length > config.trendLookback) {
      stats.gapVelocityHistory.shift();
    }
  }
  stats.lastPrice = price;
  stats.lastGap = gap;
  stats.lastUpdateMs = now;
}

function advantageSide(gap: number): Side {
  return gap >= 0 ? "UP" : "DOWN";
}

function sideGap(side: Side, gap: number): number {
  return side === "UP" ? gap : -gap;
}

function sideGapVelocity(side: Side, gapVelocity: number | null): number | null {
  if (gapVelocity === null) return null;
  return side === "UP" ? gapVelocity : -gapVelocity;
}

function sideGapVelocityEma(stats: EdgeStats, side: Side): number | null {
  return sideGapVelocity(side, stats.gapVelocityEma);
}

function trendConsistency(stats: EdgeStats, side: Side): number | null {
  if (stats.gapVelocityHistory.length === 0) return null;
  let useful = 0;
  let nonZero = 0;
  for (const v of stats.gapVelocityHistory) {
    if (Math.abs(v) <= EPSILON) continue;
    nonZero++;
    const sideVelocity = side === "UP" ? v : -v;
    if (sideVelocity > 0) useful++;
  }
  return nonZero === 0 ? null : useful / nonZero;
}

function signFlipCount(stats: EdgeStats): number {
  let previous = 0;
  let flips = 0;
  for (const v of stats.gapVelocityHistory) {
    const sign = Math.abs(v) <= EPSILON ? 0 : v > 0 ? 1 : -1;
    if (sign === 0) continue;
    if (previous !== 0 && sign !== previous) flips++;
    previous = sign;
  }
  return flips;
}

function computeEntrySignalStrength(absGap: number, atr: number | null): number | null {
  if (atr === null) return null;
  const denominator = Math.max(Math.abs(atr), EPSILON);
  return parseFloat((absGap / denominator).toFixed(4));
}

function canEnterByTime(params: {
  now: number;
  slotStartMs: number;
  slotEndMs: number;
  remaining: number;
  config?: AdvantageArbConfig;
}): {
  allowed: boolean;
  reason: string | null;
  elapsedSeconds: number;
  remainingSeconds: number;
} {
  const config = params.config ?? CONFIG;
  const elapsedSeconds = Math.max(0, (params.now - params.slotStartMs) / 1000);
  const remainingSeconds = Math.max(0, (params.slotEndMs - params.now) / 1000);
  if (elapsedSeconds < config.noEntryFirstSeconds) {
    return {
      allowed: false,
      reason: "first-window-block",
      elapsedSeconds,
      remainingSeconds,
    };
  }
  if (remainingSeconds < config.noEntryLastSeconds) {
    return {
      allowed: false,
      reason: "last-window-block",
      elapsedSeconds,
      remainingSeconds,
    };
  }
  if (params.remaining < MIN_ENTRY_REMAINING) {
    return {
      allowed: false,
      reason: "min-entry-remaining-block",
      elapsedSeconds,
      remainingSeconds,
    };
  }
  if (params.remaining > MAX_ENTRY_REMAINING) {
    return {
      allowed: false,
      reason: "max-entry-remaining-block",
      elapsedSeconds,
      remainingSeconds,
    };
  }
  return { allowed: true, reason: null, elapsedSeconds, remainingSeconds };
}

function updateEntryPeaks(
  stats: EdgeStats,
  side: Side,
  currentSideGap: number,
  entrySignalStrength: number | null,
): { peakSideGap: number; peakSignalStrength: number } {
  const peakSideGap = Math.max(stats.peakSideGapBySide[side] ?? 0, currentSideGap);
  stats.peakSideGapBySide[side] = peakSideGap;
  if (entrySignalStrength !== null) {
    stats.peakSignalStrengthBySide[side] = Math.max(
      stats.peakSignalStrengthBySide[side] ?? 0,
      entrySignalStrength,
    );
  }
  return {
    peakSideGap,
    peakSignalStrength: stats.peakSignalStrengthBySide[side] ?? 0,
  };
}

function detectAntiRetraceEntry(params: {
  stats: EdgeStats;
  side: Side;
  currentSideGap: number;
  entrySignalStrength: number | null;
  now: number;
  config?: AdvantageArbConfig;
}): {
  allowed: boolean;
  reason: string | null;
  peakSideGap: number;
  peakRetainRatio: number | null;
  entryRetainRatio: number | null;
} {
  const config = params.config ?? CONFIG;
  const { peakSideGap, peakSignalStrength } = updateEntryPeaks(
    params.stats,
    params.side,
    params.currentSideGap,
    params.entrySignalStrength,
  );
  const peakRetainRatio =
    peakSideGap > 0 ? params.currentSideGap / peakSideGap : null;
  const entryRetainRatio =
    params.entrySignalStrength !== null && peakSignalStrength > 0
      ? params.entrySignalStrength / peakSignalStrength
      : null;
  const velocityEma = sideGapVelocityEma(params.stats, params.side);
  const consistency = trendConsistency(params.stats, params.side);
  const weak = velocityEma !== null && velocityEma < 0;
  if (weak) {
    params.stats.weakTrendSinceMsBySide[params.side] ??= params.now;
  } else {
    params.stats.weakTrendSinceMsBySide[params.side] = null;
  }
  const weakSince = params.stats.weakTrendSinceMsBySide[params.side];
  const weakConfirmed =
    weakSince !== null && params.now - weakSince >= config.entryWeakTrendConfirmMs;
  const trendRecovered =
    velocityEma !== null &&
    velocityEma >= 0 &&
    (consistency === null || consistency >= 0.5);

  if (weakConfirmed) {
    return {
      allowed: false,
      reason: "weak-side-gap-velocity",
      peakSideGap,
      peakRetainRatio,
      entryRetainRatio,
    };
  }
  if (
    peakRetainRatio !== null &&
    peakRetainRatio < config.minEntryPeakRetainRatio &&
    !trendRecovered
  ) {
    return {
      allowed: false,
      reason: "entry-peak-retrace",
      peakSideGap,
      peakRetainRatio,
      entryRetainRatio,
    };
  }
  return {
    allowed: true,
    reason: null,
    peakSideGap,
    peakRetainRatio,
    entryRetainRatio,
  };
}

function sideToken(ctx: StrategyContext, side: Side): string {
  return side === "UP" ? ctx.clobTokenIds[0] : ctx.clobTokenIds[1];
}

function bestAsk(ctx: StrategyContext, side: Side) {
  return ctx.orderBook.bestAskInfo(side);
}

function bestBid(ctx: StrategyContext, side: Side): number | null {
  return bestBidInfo(ctx, side)?.price ?? null;
}

function bestBidInfo(ctx: StrategyContext, side: Side) {
  return ctx.orderBook.bestBidInfo(side);
}

function plannedStopLossPrice(entryAsk: number): number {
  return Math.max(
    STOP_LOSS_PRICE,
    parseFloat((entryAsk - MAX_PRICE_LOSS).toFixed(2)),
  );
}

function settlementView(params: {
  pos: Position;
  gap: number;
  bid: number | null;
  remaining: number;
  atr: number | null;
  stats?: EdgeStats;
  now?: number;
  config?: AdvantageArbConfig;
}): SettlementView {
  const { pos, gap, bid, remaining, atr } = params;
  const config = params.config ?? CONFIG;
  const currentSideGap = sideGap(pos.side, gap);
  const baseRequired = Math.max(
    SETTLEMENT_MIN_SIDE_GAP,
    atr !== null ? atr * SETTLEMENT_ATR_MULTIPLIER : SETTLEMENT_MIN_SIDE_GAP,
  );
  const timeDiscount =
    remaining <= 30 ? 0.45 : remaining <= 60 ? 0.7 : 1;
  const requiredSideGap = Math.max(
    SETTLEMENT_FINAL_MIN_SIDE_GAP,
    baseRequired * timeDiscount,
  );
  const settlementProfit = parseFloat((1 - pos.entryPrice).toFixed(4));
  const exitProfit = bid === null ? null : parseFloat((bid - pos.entryPrice).toFixed(4));
  const settlementUpside = bid === null ? null : parseFloat((1 - bid).toFixed(4));

  // 结算收益是二元市场的核心：当临近结束且自己仍有足够 gap 领先时，
  // 低价卖出相当于主动放弃 1.00 结算空间。只有盘口 bid 已接近满额，
  // 或优势不足以覆盖尾盘反转风险时，才继续走止盈/止损卖出分支。
  const holdToSettlement =
    remaining <= SETTLEMENT_HOLD_MAX_REMAINING &&
    currentSideGap >= requiredSideGap &&
    (bid === null || bid < SETTLEMENT_EXIT_MIN_BID);
  const peakRetainRatio =
    pos.peakSideGap > 0 ? currentSideGap / pos.peakSideGap : null;
  const sideVelocityEma = params.stats
    ? sideGapVelocityEma(params.stats, pos.side)
    : null;
  const invalidating =
    holdToSettlement &&
    ((peakRetainRatio !== null &&
      peakRetainRatio < config.settlementInvalidateRetainRatio) ||
      (sideVelocityEma !== null &&
        sideVelocityEma <= config.settlementInvalidateVelocityEma));
  if (!holdToSettlement || !invalidating) {
    pos.settlementInvalidSinceMs = null;
  } else if (params.now !== undefined && pos.settlementInvalidSinceMs === null) {
    pos.settlementInvalidSinceMs = params.now;
  }
  const holdInvalidated =
    holdToSettlement &&
    invalidating &&
    params.now !== undefined &&
    pos.settlementInvalidSinceMs !== null &&
    params.now - pos.settlementInvalidSinceMs >= config.settlementInvalidateConfirmMs;

  return {
    currentSideGap,
    requiredSideGap,
    holdToSettlement: holdToSettlement && !holdInvalidated,
    holdInvalidated,
    settlementProfit,
    exitProfit,
    settlementUpside,
  };
}

function buildMetrics(params: {
  ctx: StrategyContext;
  remaining: number;
  btcPrice: number | null;
  priceToBeat: number | null;
  gap: number | null;
  side: Side | null;
  stats: EdgeStats;
  position?: Position | null;
  extra?: StrategyMetrics;
}): StrategyMetrics {
  const { ctx, remaining, btcPrice, priceToBeat, gap, side, stats, position } =
    params;
  const activeSide = side ?? position?.side ?? null;
  const ask = activeSide ? bestAsk(ctx, activeSide) : null;
  const bidInfo = activeSide ? bestBidInfo(ctx, activeSide) : null;
  const bid = bidInfo?.price ?? null;
  const absGap = gap === null ? null : Math.abs(gap);
  const settlement =
    position && gap !== null
      ? settlementView({
          pos: position,
          gap,
          bid,
          remaining,
          atr: stats.atr,
          stats,
          now: Date.now(),
        })
      : null;
  const activeSideVelocity = activeSide
    ? sideGapVelocity(activeSide, stats.gapVelocity)
    : null;
  const activeSideVelocityEma = activeSide
    ? sideGapVelocityEma(stats, activeSide)
    : null;
  const activeTrendConsistency = activeSide
    ? trendConsistency(stats, activeSide)
    : null;
  const activeCurrentSideGap =
    activeSide && gap !== null ? sideGap(activeSide, gap) : null;
  const activePeakSideGap =
    activeSide !== null ? stats.peakSideGapBySide[activeSide] : 0;
  const activePeakSignalStrength =
    activeSide !== null ? stats.peakSignalStrengthBySide[activeSide] : 0;
  const entrySignalStrength =
    absGap === null ? null : computeEntrySignalStrength(absGap, stats.atr);
  return {
    remaining,
    btcPrice,
    priceToBeat,
    gap,
    absGap,
    side: activeSide,
    atr: stats.atr,
    atrPeriod: CONFIG.atrPeriod,
    gapAtr: stats.gapAtr,
    gapVelocity: stats.gapVelocity,
    sideGapVelocity: activeSideVelocity,
    sideGapVelocityEma: activeSideVelocityEma,
    trendConsistency:
      activeTrendConsistency === null
        ? null
        : parseFloat(activeTrendConsistency.toFixed(4)),
    signFlipCount: signFlipCount(stats),
    entrySignalStrength,
    peakSideGapSeen: activePeakSideGap || null,
    peakSignalStrengthSeen: activePeakSignalStrength || null,
    currentSideGap:
      position && gap !== null
        ? sideGap(position.side, gap)
        : activeCurrentSideGap,
    bestAsk: ask?.price ?? null,
    bestAskLiquidity: ask?.liquidity ?? null,
    bestBid: bid,
    bestBidLiquidity: bidInfo?.liquidity ?? null,
    entryPrice: position?.entryPrice ?? null,
    entryGap: position?.entryGap ?? null,
    entryAbsGap: position?.entryAbsGap ?? null,
    peakSideGap: position?.peakSideGap ?? null,
    settlementHold: settlement?.holdToSettlement ?? null,
    settlementHoldInvalidated: settlement?.holdInvalidated ?? null,
    settlementRequiredGap: settlement?.requiredSideGap ?? null,
    settlementProfit: settlement?.settlementProfit ?? null,
    exitProfit: settlement?.exitProfit ?? null,
    settlementUpside: settlement?.settlementUpside ?? null,
    gapRetainRatio:
      position && gap !== null && position.peakSideGap > 0
        ? parseFloat((sideGap(position.side, gap) / position.peakSideGap).toFixed(4))
        : null,
    adverseMs:
      position?.adverseSinceMs !== null && position?.adverseSinceMs !== undefined
        ? Date.now() - position.adverseSinceMs
        : null,
    peakBid: position?.peakBid ?? null,
    takeProfitPrice: position?.takeProfitPrice ?? null,
    stopLossPrice: position?.stopLossPrice ?? null,
    unrealizedEdge:
      position && bid !== null ? parseFloat((bid - position.entryPrice).toFixed(4)) : null,
    tickIntervalMs: CONFIG.tickIntervalMs,
    statsIntervalMs: CONFIG.statsIntervalMs,
    ...params.extra,
  };
}

function checkEntry(params: {
  ctx: StrategyContext;
  remaining: number;
  btcPrice: number;
  priceToBeat: number;
  gap: number;
  stats: EdgeStats;
  now: number;
  config?: AdvantageArbConfig;
}):
  | {
      side: Side;
      ask: number;
      liquidity: number;
      entryAbsGap: number;
      requiredAbsGap: number;
      entrySignalStrength: number | null;
      requiredSignalStrength: number;
      peakSideGap: number;
      peakRetainRatio: number | null;
      entryRetainRatio: number | null;
      takeProfitPrice: number;
      stopLossPrice: number;
    }
  | null {
  const { ctx, remaining, gap, stats } = params;
  const config = params.config ?? CONFIG;
  const time = canEnterByTime({
    now: params.now,
    slotStartMs: ctx.slotStartMs,
    slotEndMs: ctx.slotEndMs,
    remaining,
    config,
  });
  if (!time.allowed) {
    return null;
  }

  const side = advantageSide(gap);
  const absGap = Math.abs(gap);
  const requiredAbsGap = Math.max(
    MIN_ABS_GAP,
    stats.atr !== null ? stats.atr * ENTRY_ATR_MULTIPLIER : MIN_ABS_GAP,
  );
  const entrySignalStrength = computeEntrySignalStrength(absGap, stats.atr);
  const currentSideGap = sideGap(side, gap);
  const retrace = detectAntiRetraceEntry({
    stats,
    side,
    currentSideGap,
    entrySignalStrength,
    now: params.now,
    config,
  });
  const ask = bestAsk(ctx, side);
  if (!ask) return null;

  const hasEnoughGap = absGap >= requiredAbsGap;
  const hasEnoughSignal =
    config.minEntrySignalStrength <= 0 ||
    (entrySignalStrength !== null &&
      entrySignalStrength >= config.minEntrySignalStrength);
  const hasUsablePrice = ask.price >= MIN_ENTRY_ASK && ask.price <= MAX_ENTRY_ASK;
  const hasRoomToProfit = ask.price + MIN_PROFIT <= MAX_TAKE_PROFIT_PRICE;
  const hasLiquidity = ask.liquidity >= MIN_LIQUIDITY;

  if (
    !hasEnoughGap ||
    !hasEnoughSignal ||
    !hasUsablePrice ||
    !hasRoomToProfit ||
    !hasLiquidity ||
    !retrace.allowed
  ) {
    return null;
  }

  return {
    side,
    ask: ask.price,
    liquidity: ask.liquidity,
    entryAbsGap: absGap,
    requiredAbsGap,
    entrySignalStrength,
    requiredSignalStrength: config.minEntrySignalStrength,
    peakSideGap: retrace.peakSideGap,
    peakRetainRatio: retrace.peakRetainRatio,
    entryRetainRatio: retrace.entryRetainRatio,
    takeProfitPrice: Math.min(
      MAX_TAKE_PROFIT_PRICE,
      parseFloat((ask.price + MIN_PROFIT + TAKE_PROFIT_BUFFER).toFixed(2)),
    ),
    stopLossPrice: plannedStopLossPrice(ask.price),
  };
}

function updatePositionEdge(pos: Position, gap: number, bid: number | null): void {
  const currentSideGap = sideGap(pos.side, gap);
  if (currentSideGap > pos.peakSideGap) {
    pos.peakSideGap = currentSideGap;
  }
  if (bid !== null && (pos.peakBid === null || bid > pos.peakBid)) {
    pos.peakBid = bid;
  }
}

function markAdverseState(
  pos: Position,
  gap: number,
  now: number,
): {
  currentSideGap: number;
  holdMs: number;
  peakRetainRatio: number;
  entryRetainRatio: number;
  isReversed: boolean;
  isDeepRetrace: boolean;
  confirmed: boolean;
} {
  const currentSideGap = sideGap(pos.side, gap);
  const holdMs = now - pos.entryMs;
  const peakRetainRatio =
    pos.peakSideGap > 0 ? currentSideGap / pos.peakSideGap : 0;
  const entryRetainRatio =
    pos.entryAbsGap > 0 ? currentSideGap / pos.entryAbsGap : 0;
  const isReversed = currentSideGap <= -REVERSAL_GAP_BUFFER;
  const isDeepRetrace =
    currentSideGap <= pos.entryAbsGap * EARLY_STOP_ENTRY_RETRACE_RATIO ||
    currentSideGap <= pos.peakSideGap * EARLY_STOP_PEAK_RETRACE_RATIO;
  const adverse = isReversed || isDeepRetrace;

  // gap 会有秒级噪声，提前止损必须要求“不利状态持续一小段时间”。
  // 这样既能在优势明显衰减时早走，也避免单个 ticker 抖动把仓位洗出去。
  if (!adverse || holdMs < MIN_HOLD_MS) {
    pos.adverseSinceMs = null;
  } else if (pos.adverseSinceMs === null) {
    pos.adverseSinceMs = now;
  }

  return {
    currentSideGap,
    holdMs,
    peakRetainRatio,
    entryRetainRatio,
    isReversed,
    isDeepRetrace,
    confirmed:
      pos.adverseSinceMs !== null && now - pos.adverseSinceMs >= EARLY_STOP_CONFIRM_MS,
  };
}

function shouldTakeProfit(params: {
  pos: Position;
  gap: number;
  bid: number | null;
  bidLiquidity: number | null;
  remaining: number;
  stats: EdgeStats;
  config?: AdvantageArbConfig;
}): { price: number; reason: string; mode: string } | null {
  const { pos, gap, bid, bidLiquidity, remaining, stats } = params;
  const config = params.config ?? CONFIG;
  if (bid === null) return null;

  const settlement = settlementView({
    pos,
    gap,
    bid,
    remaining,
    atr: stats.atr,
    stats,
    now: Date.now(),
    config,
  });
  if (settlement.holdToSettlement) {
    return null;
  }

  const currentSideGap = sideGap(pos.side, gap);
  const peakRetainRatio =
    pos.peakSideGap > 0 ? currentSideGap / pos.peakSideGap : 0;
  const currentTrendConsistency = trendConsistency(stats, pos.side);
  const currentSideVelocityEma = sideGapVelocityEma(stats, pos.side);
  const hasMinimumProfit = bid >= pos.entryPrice + MIN_PROFIT;
  const reachedPlannedProfit = bid >= pos.takeProfitPrice;
  const hasExecutableBid =
    bidLiquidity === null || bidLiquidity >= TAKE_PROFIT_MIN_BID_LIQUIDITY;
  const expandedEnough =
    pos.peakSideGap >= pos.entryAbsGap * TAKE_PROFIT_PEAK_EXPANSION_RATIO;
  const retracedFromPeak =
    expandedEnough && currentSideGap <= pos.peakSideGap * TAKE_PROFIT_TRAIL_RATIO;
  const trendStillSupports =
    config.gapAwareTakeProfitEnabled &&
    remaining > TAKE_PROFIT_LOCK_REMAINING &&
    bid < TAKE_PROFIT_LOCK_BID &&
    currentSideVelocityEma !== null &&
    currentSideVelocityEma >= config.takeProfitDelayMinSideVelocityEma &&
    (currentTrendConsistency === null ||
      currentTrendConsistency >= config.takeProfitDelayMinTrendConsistency) &&
    peakRetainRatio >= config.takeProfitDelayMinPeakRetainRatio;

  if (hasMinimumProfit && reachedPlannedProfit && hasExecutableBid) {
    if (trendStillSupports) return null;
    return { price: bid, reason: "planned take-profit", mode: "planned" };
  }

  // 计划止盈优先锁定已经出现的正收益；如果顶层 bid 流动性不足，
  // 再退回到优势回撤和尾盘锁利，避免为了几股薄流动性过早放弃大趋势。
  if (hasMinimumProfit && retracedFromPeak) {
    return { price: bid, reason: "trailing take-profit", mode: "trailing" };
  }

  if (remaining <= TAKE_PROFIT_LOCK_REMAINING && reachedPlannedProfit) {
    return { price: bid, reason: "late profit lock", mode: "late-lock" };
  }

  if (remaining <= 75 && bid >= TAKE_PROFIT_LOCK_BID) {
    return {
      price: bid,
      reason: "high-probability profit lock",
      mode: "high-probability-lock",
    };
  }

  return null;
}

function shouldLastMinuteStop(params: {
  pos: Position;
  gap: number;
  ask: number | null;
  bid: number | null;
  remaining: number;
  stats: EdgeStats;
}): boolean {
  const { pos, gap, ask, bid, remaining, stats } = params;
  const settlement = settlementView({
    pos,
    gap,
    bid,
    remaining,
    atr: stats.atr,
    stats,
    now: Date.now(),
  });
  if (settlement.holdToSettlement) return false;

  const absGap = Math.abs(gap);
  const stillAdvantaged =
    (pos.side === "UP" && gap > 0) || (pos.side === "DOWN" && gap < 0);
  const gapRetraced = absGap <= pos.entryAbsGap * GAP_RETRACE_RATIO;
  return (
    ask !== null &&
    ask <= LAST_MINUTE_STOP_LOSS_ASK &&
    (!stillAdvantaged ||
      (gapRetraced && sideGap(pos.side, gap) <= EARLY_STOP_MAX_POSITIVE_SIDE_GAP))
  );
}

function shouldEarlyStopLoss(params: {
  pos: Position;
  gap: number;
  bid: number | null;
  now: number;
  remaining: number;
  stats: EdgeStats;
  config?: AdvantageArbConfig;
}): {
  price: number;
  reason: string;
  mode: string;
  edge: ReturnType<typeof markAdverseState>;
} | null {
  const { pos, gap, bid, now, remaining, stats } = params;
  const config = params.config ?? CONFIG;
  const settlement = settlementView({
    pos,
    gap,
    bid,
    remaining,
    atr: stats.atr,
    stats,
    now,
    config,
  });
  if (settlement.holdToSettlement) return null;

  const edge = markAdverseState(pos, gap, now);
  const fallbackPrice = Math.max(0.01, Math.min(pos.stopLossPrice, pos.entryPrice - 0.01));
  const price = bid ?? fallbackPrice;
  if (settlement.holdInvalidated && edge.holdMs >= MIN_HOLD_MS) {
    return {
      price,
      reason: "settlement hold invalidated",
      mode: "settlement-invalidated",
      edge,
    };
  }
  const velocityEma = sideGapVelocityEma(stats, pos.side);
  const velocityAdverse =
    velocityEma !== null &&
    velocityEma <= config.stopNegativeVelocityEma &&
    edge.holdMs >= MIN_HOLD_MS;
  if (!velocityAdverse) {
    pos.velocityAdverseSinceMs = null;
  } else if (pos.velocityAdverseSinceMs === null) {
    pos.velocityAdverseSinceMs = now;
  }
  const velocityConfirmed =
    pos.velocityAdverseSinceMs !== null &&
    now - pos.velocityAdverseSinceMs >= config.stopVelocityConfirmMs;

  if (edge.confirmed) {
    if (edge.isReversed) {
      return { price, reason: "gap reversal stop-loss", mode: "gap-reversal", edge };
    }
    if (
      edge.isDeepRetrace &&
      edge.currentSideGap <= EARLY_STOP_MAX_POSITIVE_SIDE_GAP
    ) {
      return { price, reason: "gap retrace stop-loss", mode: "gap-retrace", edge };
    }
  }
  if (velocityConfirmed) {
    return { price, reason: "velocity stop-loss", mode: "velocity", edge };
  }
  if (bid !== null && bid <= pos.stopLossPrice && edge.holdMs >= MIN_HOLD_MS) {
    return { price: bid, reason: "price stop-loss", mode: "price", edge };
  }
  return null;
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
  expireAtMs?: number;
  riskExit?: boolean;
  release: () => void;
}): void {
  const {
    ctx,
    state,
    pos,
    price,
    label,
    reason,
    metrics,
    getMetrics,
    expireAtMs,
    riskExit = false,
    release,
  } = params;
  if (state.closing) return;
  state.closing = true;
  const resolvedExpireAtMs =
    expireAtMs ?? (riskExit ? Date.now() + CONFIG.riskExitOrderTtlMs : ctx.slotEndMs);

  // 每一次卖出都先记录一个策略信号，图片会把该信号点画成浅色标记；
  // 随后的 SELL order 会通过 signalId 关联到真实确认点，便于比较策略
  // 触发止盈/止损和 CLOB 返回 orderId 之间的时间差。
  const signalId = ctx.recordSignal({
    action: "sell",
    side: pos.side,
    label,
    metrics,
  });

  ctx.postOrders([
    {
      req: {
        tokenId: pos.tokenId,
        action: "sell",
        price,
        shares: pos.shares,
      },
      expireAtMs: resolvedExpireAtMs,
      analysis: {
        signalId,
        label,
        getMetrics,
      },
      onFilled() {
        state.position = null;
        ctx.log(
          `[${ctx.slug}] advantage-arb: SELL ${pos.side} filled @ ${price} (${reason})`,
          "green",
        );
        releaseOnce(state, release);
      },
      onExpired() {
        ctx.log(
          `[${ctx.slug}] advantage-arb: SELL ${pos.side} @ ${price} expired — emergency selling`,
          "red",
        );
        if (
          riskExit &&
          state.position === pos &&
          Date.now() < ctx.slotEndMs - 1_000 &&
          pos.riskExitAttempts < CONFIG.riskExitMaxRetries
        ) {
          pos.riskExitAttempts++;
          state.closing = false;
          const retryPrice = bestBid(ctx, pos.side) ?? Math.max(0.01, price - 0.01);
          placeSell({
            ctx,
            state,
            pos,
            price: retryPrice,
            label,
            reason: `${reason} retry ${pos.riskExitAttempts}`,
            metrics: {
              ...getMetrics(),
              exitReason: reason,
              riskExitRetries: pos.riskExitAttempts,
            },
            getMetrics: () => ({
              ...getMetrics(),
              exitReason: reason,
              riskExitRetries: pos.riskExitAttempts,
            }),
            riskExit: true,
            release,
          });
          return;
        }
        state.closing = false;
        const sellIds = ctx.pendingOrders
          .filter((o) => o.action === "sell" && o.tokenId === pos.tokenId)
          .map((o) => o.orderId);
        if (sellIds.length > 0) {
          ctx.emergencySells(sellIds).finally(() => releaseOnce(state, release));
        }
      },
      onFailed(reasonText) {
        ctx.log(
          `[${ctx.slug}] advantage-arb: SELL ${pos.side} failed (${reasonText})`,
          "red",
        );
        if (!reasonText.includes("order expired before placement")) {
          state.closing = false;
        }
      },
    },
  ]);
}

export const advantageArb: Strategy = async (ctx) => {
  if (Env.get("PROD")) {
    ctx.log(
      "[advantage-arb] Strategy is designed for simulation/tuning first. " +
        "Remove this guard only after validating parameters and image diagnostics.",
      "red",
    );
    process.exit(1);
  }

  const release = ctx.hold();
  const state: State = {
    entered: false,
    position: null,
    closing: false,
    released: false,
    settlementHoldLogged: false,
  };
  const stats = createEdgeStats();

  const tickInterval = setInterval(() => {
    const now = Date.now();
    const remaining = Math.floor((ctx.slotEndMs - Date.now()) / 1000);
    if (remaining <= 0) {
      clearInterval(tickInterval);
      releaseOnce(state, release);
      return;
    }

    const priceToBeat = ctx.getMarketResult()?.openPrice ?? null;
    const btcPrice = ctx.ticker.price ?? null;
    if (priceToBeat === null || btcPrice === null) return;

    const gap = btcPrice - priceToBeat;
    updateStats(stats, btcPrice, gap, now);

    if (!state.entered) {
      const entry = checkEntry({
        ctx,
        remaining,
        btcPrice,
        priceToBeat,
        gap,
        stats,
        now,
      });

      if (entry) {
        state.entered = true;
        const tokenId = sideToken(ctx, entry.side);
        const metrics = buildMetrics({
          ctx,
          remaining,
          btcPrice,
          priceToBeat,
          gap,
          side: entry.side,
          stats,
          extra: {
            requiredAbsGap: entry.requiredAbsGap,
            requiredSignalStrength: entry.requiredSignalStrength,
            entrySignalStrength: entry.entrySignalStrength,
            sideGapVelocity: sideGapVelocity(entry.side, stats.gapVelocity),
            sideGapVelocityEma: sideGapVelocityEma(stats, entry.side),
            trendConsistency:
              trendConsistency(stats, entry.side) === null
                ? null
                : parseFloat(trendConsistency(stats, entry.side)!.toFixed(4)),
            peakSideGap: entry.peakSideGap,
            peakRetainRatio:
              entry.peakRetainRatio === null
                ? null
                : parseFloat(entry.peakRetainRatio.toFixed(4)),
            entryRetainRatio:
              entry.entryRetainRatio === null
                ? null
                : parseFloat(entry.entryRetainRatio.toFixed(4)),
            entryAsk: entry.ask,
            entryLiquidity: entry.liquidity,
            plannedTakeProfit: entry.takeProfitPrice,
            plannedStopLoss: entry.stopLossPrice,
          },
        });

        // 入场信号只在优势侧产生：gap>0 买 UP，gap<0 买 DOWN。
        // requiredAbsGap 同时考虑绝对 gap 和近期 ATR，避免在价格噪声里
        // 误把很小的领先当成优势；MAX_ENTRY_ASK 则保护止盈空间。
        const signalId = ctx.recordSignal({
          action: "buy",
          side: entry.side,
          label: "advantage-arb entry",
          metrics,
        });

        ctx.log(
          `[${ctx.slug}] advantage-arb: signal BUY ${entry.side} @ ${entry.ask} (gap ${gap.toFixed(2)}, target ${entry.takeProfitPrice})`,
          "cyan",
        );

        ctx.postOrders([
          {
            req: {
              tokenId,
              action: "buy",
              price: entry.ask,
              shares: SHARES,
            },
            expireAtMs: ctx.slotEndMs - 60_000,
            analysis: {
              signalId,
              label: "advantage-arb entry",
              getMetrics: () =>
                buildMetrics({
                  ctx,
                  remaining: Math.floor((ctx.slotEndMs - Date.now()) / 1000),
                  btcPrice: ctx.ticker.price ?? null,
                  priceToBeat,
                  gap:
                    ctx.ticker.price !== undefined
                      ? ctx.ticker.price - priceToBeat
                      : null,
                  side: entry.side,
                  stats,
                  extra: {
                    requiredAbsGap: entry.requiredAbsGap,
                    requiredSignalStrength: entry.requiredSignalStrength,
                    entrySignalStrength: entry.entrySignalStrength,
                    entryAsk: entry.ask,
                    plannedTakeProfit: entry.takeProfitPrice,
                    plannedStopLoss: entry.stopLossPrice,
                  },
                }),
            },
            onFilled(filledShares) {
              // 仓位风控的基准必须使用“成交确认时”的 gap，而不是识别信号时的 gap。
              // 如果 CLOB 确认存在几百毫秒延迟，优势可能已经变化；用成交时快照
              // 初始化 entryAbsGap/peakSideGap，后续止盈止损才不会围绕过期信号计算。
              const fillGap =
                ctx.ticker.price !== undefined ? ctx.ticker.price - priceToBeat : gap;
              const entryAbsGap = Math.abs(fillGap);
              state.position = {
                side: entry.side,
                tokenId,
                entryPrice: entry.ask,
                entryGap: fillGap,
                entryAbsGap,
                entryMs: Date.now(),
                shares: filledShares,
                takeProfitPrice: entry.takeProfitPrice,
                stopLossPrice: entry.stopLossPrice,
                peakSideGap: entryAbsGap,
                peakBid: bestBid(ctx, entry.side),
                adverseSinceMs: null,
                velocityAdverseSinceMs: null,
                settlementInvalidSinceMs: null,
                riskExitAttempts: 0,
              };
              state.settlementHoldLogged = false;
              ctx.log(
                `[${ctx.slug}] advantage-arb: BUY ${entry.side} filled @ ${entry.ask} (${filledShares} shares)`,
                "green",
              );
            },
            onExpired() {
              ctx.log(
                `[${ctx.slug}] advantage-arb: BUY ${entry.side} @ ${entry.ask} expired — no position`,
                "yellow",
              );
              releaseOnce(state, release);
            },
            onFailed(reason) {
              ctx.log(
                `[${ctx.slug}] advantage-arb: BUY ${entry.side} failed (${reason})`,
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

    const bidInfo = bestBidInfo(ctx, pos.side);
    const bid = bidInfo?.price ?? null;
    const ask = bestAsk(ctx, pos.side)?.price ?? null;
    updatePositionEdge(pos, gap, bid);
    const metrics = () =>
      buildMetrics({
        ctx,
        remaining,
        btcPrice,
        priceToBeat,
        gap,
        side: pos.side,
        stats,
        position: pos,
      });

    const takeProfit = shouldTakeProfit({
      pos,
      gap,
      bid,
      bidLiquidity: bidInfo?.liquidity ?? null,
      remaining,
        stats,
      });
    if (takeProfit) {
      placeSell({
        ctx,
        state,
        pos,
        price: takeProfit.price,
        label: "advantage-arb take-profit",
        reason: takeProfit.reason,
        metrics: {
          ...metrics(),
          exitReason: takeProfit.reason,
          takeProfitMode: takeProfit.mode,
        },
        getMetrics: () => ({
          ...metrics(),
          exitReason: takeProfit.reason,
          takeProfitMode: takeProfit.mode,
        }),
        release,
      });
      return;
    }

    const earlyStop = shouldEarlyStopLoss({
      pos,
      gap,
      bid,
      now: Date.now(),
      remaining,
      stats,
    });
    if (earlyStop) {
      placeSell({
        ctx,
        state,
        pos,
        price: earlyStop.price,
        label: "advantage-arb early-stop",
        reason: earlyStop.reason,
        metrics: {
          ...metrics(),
          exitReason: earlyStop.reason,
          stopLossMode: earlyStop.mode,
          holdSeconds: parseFloat((earlyStop.edge.holdMs / 1000).toFixed(3)),
          peakRetainRatio: parseFloat(earlyStop.edge.peakRetainRatio.toFixed(4)),
          entryRetainRatio: parseFloat(earlyStop.edge.entryRetainRatio.toFixed(4)),
        },
        getMetrics: () => ({
          ...metrics(),
          exitReason: earlyStop.reason,
          stopLossMode: earlyStop.mode,
          holdSeconds: parseFloat((earlyStop.edge.holdMs / 1000).toFixed(3)),
          peakRetainRatio: parseFloat(earlyStop.edge.peakRetainRatio.toFixed(4)),
          entryRetainRatio: parseFloat(earlyStop.edge.entryRetainRatio.toFixed(4)),
        }),
        riskExit: true,
        release,
      });
      return;
    }

    if (
      remaining <= 60 &&
      shouldLastMinuteStop({
        pos,
        gap,
        ask,
        bid,
        remaining,
        stats,
      })
    ) {
      const stopBid = bid ?? Math.max(0.01, pos.stopLossPrice - 0.01);
      placeSell({
        ctx,
        state,
        pos,
        price: stopBid,
        label: "advantage-arb stop-loss",
        reason: "last-minute stop-loss",
        metrics: {
          ...metrics(),
          exitReason: "last-minute stop-loss",
          stopLossMode: "last-minute",
        },
        getMetrics: () => ({
          ...metrics(),
          exitReason: "last-minute stop-loss",
          stopLossMode: "last-minute",
        }),
        riskExit: true,
        release,
      });
      return;
    }

    if (remaining <= 30) {
      const settlement = settlementView({
        pos,
        gap,
        bid,
        remaining,
        atr: stats.atr,
        stats,
        now: Date.now(),
      });
      if (settlement.holdToSettlement) {
        if (!state.settlementHoldLogged) {
          state.settlementHoldLogged = true;
          ctx.log(
            `[${ctx.slug}] advantage-arb: holding ${pos.side} to settlement (sideGap ${settlement.currentSideGap.toFixed(2)}, required ${settlement.requiredSideGap.toFixed(2)}, bid ${bid ?? "-"})`,
            "cyan",
          );
        }
        return;
      }

      const sellIds = ctx.pendingOrders
        .filter((o) => o.action === "sell" && o.tokenId === pos.tokenId)
        .map((o) => o.orderId);
      if (sellIds.length > 0) {
        ctx.emergencySells(sellIds).finally(() => releaseOnce(state, release));
      } else {
        placeSell({
          ctx,
          state,
          pos,
          price: bid ?? Math.max(0.01, pos.stopLossPrice - 0.01),
          label: "advantage-arb final-exit",
          reason: "final 30s exit",
          metrics: {
            ...metrics(),
            exitReason: "final 30s exit",
            stopLossMode: "final-exit",
          },
          getMetrics: () => ({
            ...metrics(),
            exitReason: "final 30s exit",
            stopLossMode: "final-exit",
          }),
          expireAtMs: ctx.slotEndMs,
          riskExit: true,
          release,
        });
      }
    }
  }, CONFIG.tickIntervalMs);

  return () => {
    clearInterval(tickInterval);
  };
};

export const __advantageArbTestHooks = {
  readConfig,
  createEdgeStats,
  updateStats,
  computeEntrySignalStrength,
  canEnterByTime,
  detectAntiRetraceEntry,
  sideGapVelocity,
  sideGapVelocityEma,
  trendConsistency,
  settlementView,
  plannedStopLossPrice,
  shouldTakeProfit,
  shouldEarlyStopLoss,
};

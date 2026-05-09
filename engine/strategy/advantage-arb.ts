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
  gapVelocity: number | null;
  lastPrice: number | null;
  lastGap: number | null;
  lastUpdateMs: number;
};

type SettlementView = {
  currentSideGap: number;
  requiredSideGap: number;
  holdToSettlement: boolean;
  settlementProfit: number;
  exitProfit: number | null;
  settlementUpside: number | null;
};

const SHARES = 6;
const MIN_ENTRY_REMAINING = 75;
const MAX_ENTRY_REMAINING = 240;
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
const MAX_TAKE_PROFIT_PRICE = parseFloat(
  process.env.ADV_ARB_MAX_TAKE_PROFIT_PRICE ?? "0.96",
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

function updateStats(stats: EdgeStats, price: number, gap: number): void {
  const now = Date.now();
  if (now - stats.lastUpdateMs < 1000) return;
  if (stats.lastPrice !== null) {
    const tr = Math.abs(price - stats.lastPrice);
    stats.atr = stats.atr === null ? tr : (stats.atr * 13 + tr) / 14;
  }
  if (stats.lastGap !== null) {
    stats.gapVelocity = gap - stats.lastGap;
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

function sideToken(ctx: StrategyContext, side: Side): string {
  return side === "UP" ? ctx.clobTokenIds[0] : ctx.clobTokenIds[1];
}

function bestAsk(ctx: StrategyContext, side: Side) {
  return ctx.orderBook.bestAskInfo(side);
}

function bestBid(ctx: StrategyContext, side: Side): number | null {
  return ctx.orderBook.bestBidPrice(side);
}

function settlementView(params: {
  pos: Position;
  gap: number;
  bid: number | null;
  remaining: number;
  atr: number | null;
}): SettlementView {
  const { pos, gap, bid, remaining, atr } = params;
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

  return {
    currentSideGap,
    requiredSideGap,
    holdToSettlement,
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
  const bid = activeSide ? bestBid(ctx, activeSide) : null;
  const absGap = gap === null ? null : Math.abs(gap);
  const settlement =
    position && gap !== null
      ? settlementView({
          pos: position,
          gap,
          bid,
          remaining,
          atr: stats.atr,
        })
      : null;
  return {
    remaining,
    btcPrice,
    priceToBeat,
    gap,
    absGap,
    side: activeSide,
    atr: stats.atr,
    gapVelocity: stats.gapVelocity,
    bestAsk: ask?.price ?? null,
    bestAskLiquidity: ask?.liquidity ?? null,
    bestBid: bid,
    entryPrice: position?.entryPrice ?? null,
    entryGap: position?.entryGap ?? null,
    entryAbsGap: position?.entryAbsGap ?? null,
    currentSideGap: position && gap !== null ? sideGap(position.side, gap) : null,
    peakSideGap: position?.peakSideGap ?? null,
    settlementHold: settlement?.holdToSettlement ?? null,
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
}):
  | {
      side: Side;
      ask: number;
      liquidity: number;
      entryAbsGap: number;
      requiredAbsGap: number;
      takeProfitPrice: number;
      stopLossPrice: number;
    }
  | null {
  const { ctx, remaining, gap, stats } = params;
  if (remaining < MIN_ENTRY_REMAINING || remaining > MAX_ENTRY_REMAINING) {
    return null;
  }

  const side = advantageSide(gap);
  const ask = bestAsk(ctx, side);
  if (!ask) return null;

  const absGap = Math.abs(gap);
  const requiredAbsGap = Math.max(
    MIN_ABS_GAP,
    stats.atr !== null ? stats.atr * ENTRY_ATR_MULTIPLIER : MIN_ABS_GAP,
  );

  const hasEnoughGap = absGap >= requiredAbsGap;
  const hasUsablePrice = ask.price >= MIN_ENTRY_ASK && ask.price <= MAX_ENTRY_ASK;
  const hasRoomToProfit = ask.price + MIN_PROFIT <= MAX_TAKE_PROFIT_PRICE;
  const hasLiquidity = ask.liquidity >= MIN_LIQUIDITY;

  if (!hasEnoughGap || !hasUsablePrice || !hasRoomToProfit || !hasLiquidity) {
    return null;
  }

  return {
    side,
    ask: ask.price,
    liquidity: ask.liquidity,
    entryAbsGap: absGap,
    requiredAbsGap,
    takeProfitPrice: Math.min(
      MAX_TAKE_PROFIT_PRICE,
      parseFloat((ask.price + MIN_PROFIT + TAKE_PROFIT_BUFFER).toFixed(2)),
    ),
    stopLossPrice: STOP_LOSS_PRICE,
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
  remaining: number;
  stats: EdgeStats;
}): { price: number; reason: string } | null {
  const { pos, gap, bid, remaining, stats } = params;
  if (bid === null) return null;

  const settlement = settlementView({
    pos,
    gap,
    bid,
    remaining,
    atr: stats.atr,
  });
  if (settlement.holdToSettlement) {
    return null;
  }

  const currentSideGap = sideGap(pos.side, gap);
  const hasMinimumProfit = bid >= pos.entryPrice + MIN_PROFIT;
  const reachedPlannedProfit = bid >= pos.takeProfitPrice;
  const expandedEnough =
    pos.peakSideGap >= pos.entryAbsGap * TAKE_PROFIT_PEAK_EXPANSION_RATIO;
  const retracedFromPeak =
    expandedEnough && currentSideGap <= pos.peakSideGap * TAKE_PROFIT_TRAIL_RATIO;

  // 止盈不再是“到固定价就卖”。优势仍在扩大时，固定目标价只是一个
  // 最低收益门槛；真正卖出要等优势从峰值回落，或者临近尾盘需要锁定利润。
  if (hasMinimumProfit && retracedFromPeak) {
    return { price: bid, reason: "trailing take-profit" };
  }

  if (remaining <= TAKE_PROFIT_LOCK_REMAINING && reachedPlannedProfit) {
    return { price: bid, reason: "late profit lock" };
  }

  if (remaining <= 75 && bid >= TAKE_PROFIT_LOCK_BID) {
    return { price: bid, reason: "high-probability profit lock" };
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
}): { price: number; reason: string; edge: ReturnType<typeof markAdverseState> } | null {
  const { pos, gap, bid, now, remaining, stats } = params;
  const settlement = settlementView({
    pos,
    gap,
    bid,
    remaining,
    atr: stats.atr,
  });
  if (settlement.holdToSettlement) return null;

  const edge = markAdverseState(pos, gap, now);
  if (!edge.confirmed) return null;

  const fallbackPrice = Math.max(0.01, Math.min(pos.stopLossPrice, pos.entryPrice - 0.01));
  const price = bid ?? fallbackPrice;
  if (edge.isReversed) {
    return { price, reason: "gap reversal stop-loss", edge };
  }
  if (
    edge.isDeepRetrace &&
    edge.currentSideGap <= EARLY_STOP_MAX_POSITIVE_SIDE_GAP
  ) {
    return { price, reason: "gap retrace stop-loss", edge };
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
    release,
  } = params;
  if (state.closing) return;
  state.closing = true;

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
      expireAtMs: expireAtMs ?? ctx.slotEndMs - 30_000,
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
        const sellIds = ctx.pendingOrders
          .filter((o) => o.action === "sell" && o.tokenId === pos.tokenId)
          .map((o) => o.orderId);
        if (sellIds.length > 0) {
          ctx.emergencySells(sellIds).finally(() => releaseOnce(state, release));
        } else {
          releaseOnce(state, release);
        }
      },
      onFailed(reasonText) {
        ctx.log(
          `[${ctx.slug}] advantage-arb: SELL ${pos.side} failed (${reasonText})`,
          "red",
        );
        state.closing = false;
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
  const stats: EdgeStats = {
    atr: null,
    gapVelocity: null,
    lastPrice: null,
    lastGap: null,
    lastUpdateMs: 0,
  };

  const tickInterval = setInterval(() => {
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
    updateStats(stats, btcPrice, gap);

    if (!state.entered) {
      const entry = checkEntry({
        ctx,
        remaining,
        btcPrice,
        priceToBeat,
        gap,
        stats,
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

    const bid = bestBid(ctx, pos.side);
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
        },
        getMetrics: () => ({
          ...metrics(),
          exitReason: takeProfit.reason,
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
          holdSeconds: parseFloat((earlyStop.edge.holdMs / 1000).toFixed(3)),
          peakRetainRatio: parseFloat(earlyStop.edge.peakRetainRatio.toFixed(4)),
          entryRetainRatio: parseFloat(earlyStop.edge.entryRetainRatio.toFixed(4)),
        },
        getMetrics: () => ({
          ...metrics(),
          exitReason: earlyStop.reason,
          holdSeconds: parseFloat((earlyStop.edge.holdMs / 1000).toFixed(3)),
          peakRetainRatio: parseFloat(earlyStop.edge.peakRetainRatio.toFixed(4)),
          entryRetainRatio: parseFloat(earlyStop.edge.entryRetainRatio.toFixed(4)),
        }),
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
        },
        getMetrics: () => ({
          ...metrics(),
          exitReason: "last-minute stop-loss",
        }),
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
          },
          getMetrics: () => ({
            ...metrics(),
            exitReason: "final 30s exit",
          }),
          expireAtMs: ctx.slotEndMs,
          release,
        });
      }
    }
  }, 0);

  return () => {
    clearInterval(tickInterval);
  };
};

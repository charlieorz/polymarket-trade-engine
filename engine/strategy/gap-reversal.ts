import type { Strategy, StrategyContext } from "./types.ts";
import { Env } from "../../utils/config.ts";

export const GAP_REVERSAL_DEFAULTS = {
  // 单个 5m 市场最多尝试多少次入场。值越大越激进，但也更容易在震荡行情中反复亏损。
  // 调参建议：保守 1-2，默认 3，激进最多 4；不建议超过 4。
  MAX_ENTRIES_PER_MARKET: 3,
  // 每次买入的 shares 数量。模拟盘阶段建议保持 5-10；实盘前先用小仓位验证滑点和成交率。
  SHARES: 6,
  // 开盘后的禁入时间。前 30s PBT 刚形成，订单簿和价格噪声较大。
  // 调参建议：20_000-60_000；如果发现机会太少可降到 20s。
  NO_ENTRY_AFTER_OPEN_MS: 30_000,
  // 收盘前禁入时间。最后 30s 反转失败时几乎没有退出时间。
  // 调参建议：30_000-60_000；风控优先时提高到 45-60s。
  NO_ENTRY_BEFORE_CLOSE_MS: 30_000,
  // 根据线性动量估算 gap 穿越 0 的最长秒数。
  // 调参建议：2-5；越小越严格，交易次数更少但信号更强。
  SECOND_FLIP: 3,
  // 动量回看窗口。用最近 N ms 的价格样本做线性回归，估算每秒价格变化。
  // 调参建议：3_000-8_000；窗口越短越灵敏，越长越稳。
  MOMENTUM_LOOKBACK_MS: 4_000,
  // 策略 tick 间隔。只影响策略采样和判断频率，不改变 engine 主 tick。
  // 调参建议：500-1_000；更低会更敏感但更容易追噪声。
  SAMPLE_INTERVAL_MS: 500,
  // 入场时允许的最大 gap 百分比，计算方式 abs(price - PBT) / PBT。
  // 默认 0.0008 约等于 BTC 100k 时 $80 gap。值越大越容易追较远反转。
  // 调参建议：0.0004-0.0012。
  MAX_ENTRY_GAP_PCT: 0.0008,
  // 最小动量百分比，每秒价格变化 / 当前价格。
  // 默认 0.00003 约等于 BTC 100k 时 $3/s。值越高，信号越强但次数越少。
  // 调参建议：0.000015-0.00008。
  MIN_MOMENTUM_PCT_PER_SEC: 0.00003,
  // 目标侧最高买入价格。限制不要在反转还没确认时买太贵。
  // 调参建议：0.52-0.62；模拟盘若成交太少可提高到 0.60。
  MAX_ENTRY_PRICE: 0.57,
  // 目标侧 ask 顶层最小 USDC 流动性。低流动性会导致成交质量和退出都不稳定。
  // 调参建议：10-50；实盘建议 >= 20。
  MIN_ENTRY_LIQUIDITY_USD: 15,
  // GTC 买单挂单有效时间。该策略希望“被动成交”，过期说明信号没有按预期推进。
  // 调参建议：1_000-4_000。
  BUY_TTL_MS: 2_000,
  // GTC 卖单有效时间。止损/止盈挂单过期后，必要时改用 FAK 退出。
  // 调参建议：1_000-3_000。
  SELL_TTL_MS: 2_000,
  // 买入后允许 gap 完成反转的宽限时间。超过仍未站到持仓方向则止损。
  // 调参建议：2_000-5_000。
  STOP_LOSS_GRACE_MS: 3_000,
  // 若 gap 在宽限时间内向错误方向扩大到入场 gap 的该倍数，提前止损。
  // 调参建议：1.1-1.8；越低越保守。
  ADVERSE_EXPANSION_RATIO: 1.25,
  // 最小浮盈金额，达到后才允许止盈判断。
  // 调参建议：0.15-0.60，取决于 shares 和手续费/滑点。
  TAKE_PROFIT_MIN_USD: 0.25,
  // 最小 bid-entry 价格差。避免 tiny profit 因 taker fee/滑点变成亏损。
  // 调参建议：0.02-0.08。
  TAKE_PROFIT_MIN_PRICE_DELTA: 0.04,
  // 单市场已实现亏损上限。达到后本市场 blockBuys，不再新开仓。
  // 调参建议：1-5；实盘初期建议 1-2。
  MARKET_MAX_LOSS_USD: 2,
} as const;

type GapReversalConfig = {
  [K in keyof typeof GAP_REVERSAL_DEFAULTS]: number;
};

function envNumber<T extends keyof GapReversalConfig>(key: T): number {
  const raw = process.env[`GAP_REVERSAL_${key}`];
  const fallback = GAP_REVERSAL_DEFAULTS[key];
  if (raw === undefined || raw.trim() === "") return fallback;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function getGapReversalConfig(): GapReversalConfig {
  return {
    MAX_ENTRIES_PER_MARKET: envNumber("MAX_ENTRIES_PER_MARKET"),
    SHARES: envNumber("SHARES"),
    NO_ENTRY_AFTER_OPEN_MS: envNumber("NO_ENTRY_AFTER_OPEN_MS"),
    NO_ENTRY_BEFORE_CLOSE_MS: envNumber("NO_ENTRY_BEFORE_CLOSE_MS"),
    SECOND_FLIP: envNumber("SECOND_FLIP"),
    MOMENTUM_LOOKBACK_MS: envNumber("MOMENTUM_LOOKBACK_MS"),
    SAMPLE_INTERVAL_MS: envNumber("SAMPLE_INTERVAL_MS"),
    MAX_ENTRY_GAP_PCT: envNumber("MAX_ENTRY_GAP_PCT"),
    MIN_MOMENTUM_PCT_PER_SEC: envNumber("MIN_MOMENTUM_PCT_PER_SEC"),
    MAX_ENTRY_PRICE: envNumber("MAX_ENTRY_PRICE"),
    MIN_ENTRY_LIQUIDITY_USD: envNumber("MIN_ENTRY_LIQUIDITY_USD"),
    BUY_TTL_MS: envNumber("BUY_TTL_MS"),
    SELL_TTL_MS: envNumber("SELL_TTL_MS"),
    STOP_LOSS_GRACE_MS: envNumber("STOP_LOSS_GRACE_MS"),
    ADVERSE_EXPANSION_RATIO: envNumber("ADVERSE_EXPANSION_RATIO"),
    TAKE_PROFIT_MIN_USD: envNumber("TAKE_PROFIT_MIN_USD"),
    TAKE_PROFIT_MIN_PRICE_DELTA: envNumber("TAKE_PROFIT_MIN_PRICE_DELTA"),
    MARKET_MAX_LOSS_USD: envNumber("MARKET_MAX_LOSS_USD"),
  };
}

type Side = "UP" | "DOWN";
type Mode =
  | "IDLE"
  | "BUY_PENDING"
  | "HOLDING"
  | "SELL_PENDING"
  | "EXITING"
  | "DONE";
type ExitReason = "take-profit" | "stop-loss" | "late-risk";

type Sample = {
  ts: number;
  price: number;
  gap: number;
};

type MomentumStats = {
  latest: Sample;
  slopeUsdPerSec: number;
  slopePctPerSec: number;
};

type EntrySignal = {
  side: Side;
  tokenId: string;
  ask: number;
  bid: number | null;
  orderPrice: number;
  gap: number;
  projectedFlipSec: number;
};

type Position = {
  side: Side;
  tokenId: string;
  entryPrice: number;
  shares: number;
  entryGap: number;
  filledAtMs: number;
};

class MomentumWindow {
  private _samples: Sample[] = [];

  constructor(private readonly lookbackMs: number) {}

  add(sample: Sample): void {
    this._samples.push(sample);
    const cutoff = sample.ts - this.lookbackMs;
    while (this._samples.length > 0 && this._samples[0]!.ts < cutoff) {
      this._samples.shift();
    }
  }

  stats(): MomentumStats | null {
    if (this._samples.length < 3) return null;

    const latest = this._samples[this._samples.length - 1]!;
    const baseTs = this._samples[0]!.ts;
    const xs = this._samples.map((s) => (s.ts - baseTs) / 1000);
    const ys = this._samples.map((s) => s.price);
    const xMean = xs.reduce((sum, v) => sum + v, 0) / xs.length;
    const yMean = ys.reduce((sum, v) => sum + v, 0) / ys.length;

    let numerator = 0;
    let denominator = 0;
    for (let i = 0; i < xs.length; i++) {
      const dx = xs[i]! - xMean;
      numerator += dx * (ys[i]! - yMean);
      denominator += dx * dx;
    }
    if (denominator === 0) return null;

    const slopeUsdPerSec = numerator / denominator;
    return {
      latest,
      slopeUsdPerSec,
      slopePctPerSec: slopeUsdPerSec / latest.price,
    };
  }
}

function sideForToken(ctx: StrategyContext, side: Side): string {
  return side === "UP" ? ctx.clobTokenIds[0] : ctx.clobTokenIds[1];
}

function isSideAdvantaged(side: Side, gap: number): boolean {
  return side === "UP" ? gap > 0 : gap < 0;
}

function momentumSupportsSide(side: Side, slopeUsdPerSec: number): boolean {
  return side === "UP" ? slopeUsdPerSec > 0 : slopeUsdPerSec < 0;
}

function clampPrice(price: number, tick: number): number {
  const min = tick;
  const max = 1 - tick;
  return Math.min(max, Math.max(min, price));
}

function decimalsForTick(tick: number): number {
  const text = tick.toString();
  const dot = text.indexOf(".");
  return dot === -1 ? 0 : text.length - dot - 1;
}

function floorToTick(price: number, tick: number): number {
  const decimals = decimalsForTick(tick);
  return Number((Math.floor(price / tick) * tick).toFixed(decimals));
}

function roundToTick(price: number, tick: number): number {
  const decimals = decimalsForTick(tick);
  return Number((Math.round(price / tick) * tick).toFixed(decimals));
}

function passiveBuyPrice(ask: number, tick: number): number {
  return clampPrice(floorToTick(ask - tick, tick), tick);
}

function executableSellPrice(price: number, tick: number): number {
  return clampPrice(roundToTick(price, tick), tick);
}

function findEntrySignal(
  ctx: StrategyContext,
  stats: MomentumStats,
  priceToBeat: number,
  config: GapReversalConfig,
): EntrySignal | null {
  const { latest, slopeUsdPerSec, slopePctPerSec } = stats;
  const gap = latest.gap;
  if (gap === 0) return null;

  const absGapPct = Math.abs(gap) / priceToBeat;
  if (absGapPct > config.MAX_ENTRY_GAP_PCT) return null;
  if (Math.abs(slopePctPerSec) < config.MIN_MOMENTUM_PCT_PER_SEC) {
    return null;
  }

  let side: Side | null = null;
  let projectedFlipSec = Infinity;

  if (gap > 0 && slopeUsdPerSec < 0) {
    side = "DOWN";
    projectedFlipSec = gap / -slopeUsdPerSec;
  } else if (gap < 0 && slopeUsdPerSec > 0) {
    side = "UP";
    projectedFlipSec = Math.abs(gap / slopeUsdPerSec);
  }

  if (!side || projectedFlipSec <= 0) return null;
  if (projectedFlipSec > config.SECOND_FLIP) return null;

  const ask = ctx.orderBook.bestAskInfo(side);
  if (!ask) return null;
  if (ask.price > config.MAX_ENTRY_PRICE) return null;
  if (ask.liquidity < config.MIN_ENTRY_LIQUIDITY_USD) {
    return null;
  }

  const tokenId = sideForToken(ctx, side);
  const tick = parseFloat(ctx.orderBook.getTickSize(tokenId));
  const bid = ctx.orderBook.bestBidPrice(side);

  return {
    side,
    tokenId,
    ask: ask.price,
    bid,
    orderPrice: passiveBuyPrice(ask.price, tick),
    gap,
    projectedFlipSec,
  };
}

function shouldTakeProfit(
  position: Position,
  stats: MomentumStats,
  bestBid: number | null,
  config: GapReversalConfig,
): boolean {
  if (bestBid === null) return false;

  const unrealized = (bestBid - position.entryPrice) * position.shares;
  const priceDelta = bestBid - position.entryPrice;
  if (unrealized < config.TAKE_PROFIT_MIN_USD) return false;
  if (priceDelta < config.TAKE_PROFIT_MIN_PRICE_DELTA) {
    return false;
  }

  const gap = stats.latest.gap;
  const sideAdvantaged = isSideAdvantaged(position.side, gap);
  const trendStillSupports = momentumSupportsSide(
    position.side,
    stats.slopeUsdPerSec,
  );
  if (sideAdvantaged && trendStillSupports) return false;

  const momentumFlat =
    Math.abs(stats.slopePctPerSec) < config.MIN_MOMENTUM_PCT_PER_SEC;
  const gapShrinking =
    sideAdvantaged &&
    !momentumSupportsSide(position.side, stats.slopeUsdPerSec);

  return !sideAdvantaged || momentumFlat || gapShrinking;
}

function shouldStopLoss(
  position: Position,
  stats: MomentumStats,
  now: number,
  config: GapReversalConfig,
): boolean {
  const gap = stats.latest.gap;
  if (isSideAdvantaged(position.side, gap)) return false;

  const ageMs = now - position.filledAtMs;
  if (ageMs >= config.STOP_LOSS_GRACE_MS) return true;

  const entryAbsGap = Math.max(Math.abs(position.entryGap), 0.01);
  const adverseExpansion =
    Math.abs(gap) >= entryAbsGap * config.ADVERSE_EXPANSION_RATIO;
  const adverseMomentum = !momentumSupportsSide(
    position.side,
    stats.slopeUsdPerSec,
  );
  return adverseExpansion && adverseMomentum;
}

/**
 * gap-reversal 反转策略执行逻辑：
 *
 * 1. 每 SAMPLE_INTERVAL_MS 采样一次当前价格，并计算 gap = price - priceToBeat。
 * 2. 用最近 MOMENTUM_LOOKBACK_MS 的价格样本做线性回归，得到 slopeUsdPerSec：
 *    - slope > 0 表示价格正在上行；
 *    - slope < 0 表示价格正在下行。
 * 3. 只在入场窗口内寻找信号：
 *    - 开盘后 NO_ENTRY_AFTER_OPEN_MS 之前不入场；
 *    - 收盘前 NO_ENTRY_BEFORE_CLOSE_MS 之内不新开仓。
 * 4. 入场方向是“押反转”：
 *    - gap > 0 且 slope < 0：价格在 PBT 上方但正在回落，预计穿越 PBT，则买 DOWN；
 *    - gap < 0 且 slope > 0：价格在 PBT 下方但正在回升，预计穿越 PBT，则买 UP。
 * 5. 信号还必须满足：
 *    - projectedFlipSec <= SECOND_FLIP，即按当前动量估算能在 N 秒内穿越 PBT；
 *    - gap 不超过 MAX_ENTRY_GAP_PCT，避免追太远的反转；
 *    - 动量强度不低于 MIN_MOMENTUM_PCT_PER_SEC；
 *    - 目标侧 ask <= MAX_ENTRY_PRICE，且顶层流动性 >= MIN_ENTRY_LIQUIDITY_USD。
 * 6. 买入使用被动 GTC：价格挂在 ask 下一个 tick，不主动吃单。这样减少 taker fee 和滑点，
 *    但会降低成交率。买单过期后，如果还没到最大入场次数，会重新等待下一个信号。
 * 7. 任意时刻只允许一个状态存在：BUY_PENDING、HOLDING、SELL_PENDING/EXITING。
 *    这避免了同一市场内重叠仓位导致的 PnL 和退出逻辑混乱。
 * 8. 止损：买入后 STOP_LOSS_GRACE_MS 内如果 gap 没有站到持仓方向，或者更早出现
 *    ADVERSE_EXPANSION_RATIO 级别的反向扩大，则先挂 GTC 卖单，过期后用 FAK 退出。
 * 9. 止盈：当当前 bid 相对 entryPrice 的浮盈同时超过 TAKE_PROFIT_MIN_USD 和
 *    TAKE_PROFIT_MIN_PRICE_DELTA，并且动量转平、gap 缩小或持仓方向不再占优时，先挂 GTC 止盈；
 *    若 GTC 过期且止盈条件仍成立，则用 FAK 卖出。
 * 10. 最后 30 秒：不再开新仓。如果已有持仓且持仓方向仍有优势，则允许持有到结算；
 *     如果没有优势，使用 FAK 风险退出。
 *
 * 所有参数都可通过环境变量覆盖，变量名为 GAP_REVERSAL_<参数名>，
 * 例如 GAP_REVERSAL_MAX_ENTRY_PRICE=0.6。
 */
export const gapReversal: Strategy = async (ctx) => {
  if (Env.get("PROD") && process.env.ALLOW_GAP_REVERSAL_PROD !== "true") {
    ctx.log(
      "[gap-reversal] Production is blocked by default. Set ALLOW_GAP_REVERSAL_PROD=true only after simulation validation.",
      "red",
    );
    process.exit(1);
  }

  const config = getGapReversalConfig();
  const release = ctx.hold();
  const momentum = new MomentumWindow(config.MOMENTUM_LOOKBACK_MS);

  let mode: Mode = "IDLE";
  let released = false;
  let destroyed = false;
  let entries = 0;
  let buysBlocked = false;
  let realizedPnl = 0;
  let position: Position | null = null;
  let lastStats: MomentumStats | null = null;
  let interval: ReturnType<typeof setInterval> | null = null;

  const releaseOnce = () => {
    if (released) return;
    released = true;
    release();
  };

  const stopLoop = () => {
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
    releaseOnce();
  };

  const blockBuysForMarket = () => {
    if (buysBlocked) return;
    buysBlocked = true;
    ctx.blockBuys();
    ctx.log(
      `[${ctx.slug}] gap-reversal: market loss limit reached (${realizedPnl.toFixed(2)}), blocking buys`,
      "red",
    );
  };

  const finishPositionIfSold = (sellPrice: number, filledShares: number) => {
    if (!position) return;

    const closedShares = Math.min(position.shares, filledShares);
    realizedPnl += (sellPrice - position.entryPrice) * closedShares;
    position.shares = Number((position.shares - closedShares).toFixed(6));

    if (realizedPnl <= -config.MARKET_MAX_LOSS_USD) {
      blockBuysForMarket();
    }

    if (position.shares <= 0.000001) {
      ctx.log(
        `[${ctx.slug}] gap-reversal: position closed, realized PnL ${realizedPnl.toFixed(2)}`,
        realizedPnl >= 0 ? "green" : "red",
      );
      position = null;
      mode =
        buysBlocked || entries >= config.MAX_ENTRIES_PER_MARKET
          ? "DONE"
          : "IDLE";
      if (mode === "DONE") stopLoop();
    } else {
      ctx.log(
        `[${ctx.slug}] gap-reversal: partial exit filled (${closedShares}), ${position.shares} shares remain`,
        "yellow",
      );
      mode = "HOLDING";
    }
  };

  const placeExit = (reason: ExitReason, orderType: "GTC" | "FAK") => {
    if (destroyed || !position) return;
    if (mode === "SELL_PENDING" || mode === "EXITING" || mode === "DONE") {
      return;
    }

    const side = position.side;
    const bid = ctx.orderBook.bestBidPrice(side);
    const tokenId = position.tokenId;
    const tick = parseFloat(ctx.orderBook.getTickSize(tokenId));
    const fallback = Math.max(0.01, position.entryPrice - 0.02);
    const sellPrice = executableSellPrice(bid ?? fallback, tick);

    mode = orderType === "FAK" ? "EXITING" : "SELL_PENDING";

    ctx.log(
      `[${ctx.slug}] gap-reversal: ${reason} SELL ${side} ${orderType} @ ${sellPrice}`,
      orderType === "FAK" || reason === "stop-loss" ? "red" : "green",
    );

    ctx.postOrders([
      {
        req: {
          tokenId,
          action: "sell",
          price: sellPrice,
          shares: position.shares,
          orderType,
        },
        expireAtMs: Date.now() + config.SELL_TTL_MS,
        onFilled: (filledShares) => {
          if (destroyed) return;
          finishPositionIfSold(sellPrice, filledShares);
        },
        onExpired: () => {
          if (destroyed || !position) return;
          mode = "HOLDING";
          if (orderType === "FAK") return;
          if (reason === "take-profit") {
            const stats = lastStats;
            const currentBid = ctx.orderBook.bestBidPrice(position.side);
            if (
              stats &&
              shouldTakeProfit(position, stats, currentBid, config)
            ) {
              placeExit("take-profit", "FAK");
            }
          } else {
            placeExit(reason, "FAK");
          }
        },
        onFailed: () => {
          if (destroyed || !position) return;
          mode = "HOLDING";
        },
      },
    ]);
  };

  const placeEntry = (signal: EntrySignal) => {
    if (destroyed || mode !== "IDLE") return;
    mode = "BUY_PENDING";
    entries++;

    ctx.log(
      `[${ctx.slug}] gap-reversal: entry ${entries}/${config.MAX_ENTRIES_PER_MARKET} BUY ${signal.side} @ ${signal.orderPrice} (gap ${signal.gap.toFixed(2)}, flip ${signal.projectedFlipSec.toFixed(2)}s)`,
      "cyan",
    );

    ctx.postOrders([
      {
        req: {
          tokenId: signal.tokenId,
          action: "buy",
          price: signal.orderPrice,
          shares: config.SHARES,
        },
        expireAtMs: Date.now() + config.BUY_TTL_MS,
        onFilled: (filledShares) => {
          if (destroyed) return;
          const currentGap = lastStats?.latest.gap ?? signal.gap;
          position = {
            side: signal.side,
            tokenId: signal.tokenId,
            entryPrice: signal.orderPrice,
            shares: filledShares,
            entryGap: currentGap,
            filledAtMs: Date.now(),
          };
          mode = "HOLDING";
          ctx.log(
            `[${ctx.slug}] gap-reversal: BUY ${signal.side} filled (${filledShares} shares)`,
            "green",
          );
        },
        onExpired: () => {
          if (destroyed) return;
          mode =
            buysBlocked || entries >= config.MAX_ENTRIES_PER_MARKET
              ? "DONE"
              : "IDLE";
          if (mode === "DONE") stopLoop();
        },
        onFailed: (reason) => {
          if (destroyed) return;
          ctx.log(
            `[${ctx.slug}] gap-reversal: BUY ${signal.side} failed (${reason})`,
            "red",
          );
          mode =
            buysBlocked || entries >= config.MAX_ENTRIES_PER_MARKET
              ? "DONE"
              : "IDLE";
          if (mode === "DONE") stopLoop();
        },
      },
    ]);
  };

  const tick = () => {
    if (destroyed || mode === "DONE") return;

    const now = Date.now();
    const market = ctx.getMarketResult();
    const priceToBeat = market?.openPrice;
    const price = ctx.ticker.price;

    if (now >= ctx.slotEndMs) {
      mode = "DONE";
      stopLoop();
      return;
    }

    if (!priceToBeat || price === undefined) return;

    momentum.add({
      ts: now,
      price,
      gap: price - priceToBeat,
    });

    const stats = momentum.stats();
    if (!stats) return;
    lastStats = stats;

    const remainingMs = ctx.slotEndMs - now;

    if (position && remainingMs <= config.NO_ENTRY_BEFORE_CLOSE_MS) {
      if (isSideAdvantaged(position.side, stats.latest.gap)) {
        ctx.log(
          `[${ctx.slug}] gap-reversal: final window, ${position.side} has advantage; holding to resolution`,
          "yellow",
        );
        mode = "DONE";
        stopLoop();
      } else {
        placeExit("late-risk", "FAK");
      }
      return;
    }

    if (position && mode === "HOLDING") {
      const bestBid = ctx.orderBook.bestBidPrice(position.side);
      if (shouldStopLoss(position, stats, now, config)) {
        placeExit("stop-loss", "GTC");
      } else if (shouldTakeProfit(position, stats, bestBid, config)) {
        placeExit("take-profit", "GTC");
      }
      return;
    }

    if (mode !== "IDLE" || buysBlocked) return;
    if (entries >= config.MAX_ENTRIES_PER_MARKET) {
      mode = "DONE";
      stopLoop();
      return;
    }

    const inEntryWindow =
      now >= ctx.slotStartMs + config.NO_ENTRY_AFTER_OPEN_MS &&
      remainingMs > config.NO_ENTRY_BEFORE_CLOSE_MS;
    if (!inEntryWindow) {
      if (remainingMs <= config.NO_ENTRY_BEFORE_CLOSE_MS) {
        mode = "DONE";
        stopLoop();
      }
      return;
    }

    const signal = findEntrySignal(ctx, stats, priceToBeat, config);
    if (signal) placeEntry(signal);
  };

  interval = setInterval(tick, config.SAMPLE_INTERVAL_MS);
  tick();

  return () => {
    destroyed = true;
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
    releaseOnce();
  };
};

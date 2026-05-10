import { readdirSync, readFileSync } from "fs";
import { basename, join } from "path";

type LogEntry = Record<string, any>;
type Side = "UP" | "DOWN";

type BookSide = {
  bestBid: number | null;
  bestBidLiquidity: number | null;
  bestAsk: number | null;
  bestAskLiquidity: number | null;
};

type Tick = {
  ts: number;
  slug: string;
  remaining: number;
  assetPrice: number;
  openPrice: number;
  gap: number;
  up: BookSide;
  down: BookSide;
};

type EdgeStats = {
  atr: number | null;
  gapAtr: number | null;
  gapVelocity: number | null;
  gapVelocityEma: number | null;
  lastGap: number | null;
  lastPrice: number | null;
  lastTs: number | null;
  gapVelocityHistory: number[];
  gapChangePerSecondHistory: number[];
  peakSideGapBySide: Record<Side, number>;
};

type ActualTrade = {
  slug: string;
  startTime: number;
  entryTs: number | null;
  entryRemaining: number | null;
  side: Side | null;
  entryAsk: number | null;
  entryBid: number | null;
  entrySpread: number | null;
  entryAskLiquidity: number | null;
  entryBidLiquidity: number | null;
  entryGap: number | null;
  entryAbsGap: number | null;
  gapZ: number | null;
  gapAtr: number | null;
  atr: number | null;
  sideGapVelocity: number | null;
  sideGapVelocityEma: number | null;
  trendConsistency: number | null;
  signFlipCount: number | null;
  exitTs: number | null;
  exitRemaining: number | null;
  exitReason: string | null;
  exitPrice: number | null;
  holdSeconds: number | null;
  realizedPnl: number | null;
  roi: number | null;
  mfe: number | null;
  mae: number | null;
  maxFavorableBid: number | null;
  minAdverseBid: number | null;
  peakSideGap: number | null;
  finalSideGap: number | null;
  settlementResult: Side | null;
  sellAttempts: number;
  sellExpired: boolean;
  attribution: string | null;
};

type SimParams = {
  name: string;
  minNetEdge: number;
  minFairProbability: number;
  maxEntryAsk: number;
  maxSpread: number;
  profitLockMin: number;
  trailingDrawdownCents: number;
  hardStopLossCents: number;
  minTrendConsistency: number;
  maxSignFlipCount: number;
  settlementMinProbability: number;
  minRiskReward: number;
};

type SimTrade = {
  slug: string;
  startTime: number;
  side: Side;
  entryTs: number;
  entryRemaining: number;
  entryAsk: number;
  entryBid: number;
  entrySpread: number;
  entryAskLiquidity: number;
  entryBidLiquidity: number;
  entryGap: number;
  entryAbsGap: number;
  gapZ: number;
  pFair: number;
  netEv: number;
  rr: number;
  sideGapVelocityEma: number | null;
  trendConsistency: number | null;
  signFlipCount: number;
  exitTs: number;
  exitRemaining: number;
  exitReason: string;
  exitPrice: number;
  holdSeconds: number;
  pnl: number;
  roi: number;
  mfe: number;
  mae: number;
  maxFavorableBid: number;
  minAdverseBid: number;
  peakSideGap: number;
  finalSideGap: number;
  settlementResult: Side | null;
};

type OpenSimPosition = Omit<
  SimTrade,
  | "exitTs"
  | "exitRemaining"
  | "exitReason"
  | "exitPrice"
  | "holdSeconds"
  | "pnl"
  | "roi"
  | "mfe"
  | "mae"
  | "maxFavorableBid"
  | "minAdverseBid"
  | "peakSideGap"
  | "finalSideGap"
  | "settlementResult"
> & {
  peakBid: number;
  minBid: number;
  peakSideGap: number;
  entrySideGap: number;
  positiveSeen: boolean;
};

type Summary = {
  name: string;
  markets: number;
  trades: number;
  pnl: number;
  winRate: number | null;
  avgPnl: number | null;
  medianPnl: number | null;
  profitFactor: number | null;
  maxDrawdown: number;
  avgMfe: number | null;
  avgMae: number | null;
  missedTakeProfitRate: number | null;
  lateStopLossRate: number | null;
};

const SHARES = 6;
const EPSILON = 1e-9;

function argValue(name: string): string | null {
  const direct = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] ?? null : null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function parseAllJson(text: string): LogEntry[] {
  const results: LogEntry[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "{") {
      if (depth++ === 0) start = i;
    } else if (c === "}" && --depth === 0 && start !== -1) {
      try {
        results.push(JSON.parse(text.slice(start, i + 1)));
      } catch {}
      start = -1;
    }
  }
  return results;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function fmt(value: number | null, digits = 4): string {
  if (value === null || !Number.isFinite(value)) return "-";
  return value.toFixed(digits);
}

function pct(value: number | null): string {
  return value === null ? "-" : `${(value * 100).toFixed(1)}%`;
}

function slugStart(slug: string): number {
  const last = Number(slug.split("-").at(-1));
  return Number.isFinite(last) ? last * 1000 : 0;
}

function sideFromGap(gap: number): Side {
  return gap >= 0 ? "UP" : "DOWN";
}

function sideGap(side: Side, gap: number): number {
  return side === "UP" ? gap : -gap;
}

function sideVelocity(side: Side, velocity: number | null): number | null {
  if (velocity === null) return null;
  return side === "UP" ? velocity : -velocity;
}

function createStats(): EdgeStats {
  return {
    atr: null,
    gapAtr: null,
    gapVelocity: null,
    gapVelocityEma: null,
    lastGap: null,
    lastPrice: null,
    lastTs: null,
    gapVelocityHistory: [],
    gapChangePerSecondHistory: [],
    peakSideGapBySide: { UP: 0, DOWN: 0 },
  };
}

function ema(previous: number | null, value: number, period: number): number {
  return previous === null ? value : (previous * (period - 1) + value) / period;
}

function updateStats(stats: EdgeStats, tick: Tick): void {
  if (stats.lastTs !== null && tick.ts - stats.lastTs < 850) return;
  if (stats.lastPrice !== null) {
    stats.atr = ema(stats.atr, Math.abs(tick.assetPrice - stats.lastPrice), 14);
  }
  if (stats.lastGap !== null && stats.lastTs !== null) {
    const dtSeconds = Math.max((tick.ts - stats.lastTs) / 1000, EPSILON);
    const gapChange = tick.gap - stats.lastGap;
    const perSecond = gapChange / dtSeconds;
    stats.gapVelocity = gapChange;
    stats.gapVelocityEma = ema(stats.gapVelocityEma, gapChange, 5);
    stats.gapAtr = ema(stats.gapAtr, Math.abs(gapChange), 14);
    stats.gapVelocityHistory.push(gapChange);
    stats.gapChangePerSecondHistory.push(perSecond);
    if (stats.gapVelocityHistory.length > 12) stats.gapVelocityHistory.shift();
    if (stats.gapChangePerSecondHistory.length > 45) {
      stats.gapChangePerSecondHistory.shift();
    }
  }
  stats.lastGap = tick.gap;
  stats.lastPrice = tick.assetPrice;
  stats.lastTs = tick.ts;
  stats.peakSideGapBySide.UP = Math.max(stats.peakSideGapBySide.UP, tick.gap);
  stats.peakSideGapBySide.DOWN = Math.max(stats.peakSideGapBySide.DOWN, -tick.gap);
}

function trendConsistency(stats: EdgeStats, side: Side): number | null {
  const values = stats.gapVelocityHistory.filter((v) => Math.abs(v) > EPSILON);
  if (!values.length) return null;
  const useful = values.filter((v) => sideVelocity(side, v)! > 0).length;
  return useful / values.length;
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

function std(values: number[]): number | null {
  if (values.length < 4) return null;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance =
    values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(Math.max(0, variance));
}

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const absX = Math.abs(x);
  const t = 1 / (1 + p * absX);
  const y =
    1 -
    (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) *
      t *
      Math.exp(-absX * absX));
  return sign * y;
}

function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

function computeRollingVolatility(stats: EdgeStats): number | null {
  return std(stats.gapChangePerSecondHistory);
}

function computeFairProbability(params: {
  sideGap: number;
  remaining: number;
  sigmaPerSecond: number | null;
}): { pFair: number; zToBoundary: number | null; sigmaPerSecond: number | null } {
  const sigma = params.sigmaPerSecond;
  if (sigma === null || sigma <= EPSILON) {
    return {
      pFair: params.sideGap > 0 ? 0.99 : params.sideGap < 0 ? 0.01 : 0.5,
      zToBoundary: null,
      sigmaPerSecond: sigma,
    };
  }
  const horizon = Math.max(1, params.remaining);
  const z = params.sideGap / Math.max(sigma * Math.sqrt(horizon), EPSILON);
  return {
    pFair: Math.max(0.01, Math.min(0.99, normalCdf(z))),
    zToBoundary: z,
    sigmaPerSecond: sigma,
  };
}

function bookSideFromSnapshot(book: any): BookSide {
  const bid = Array.isArray(book?.bids?.[0]) ? book.bids[0] : null;
  const ask = Array.isArray(book?.asks?.[0]) ? book.asks[0] : null;
  const bidPrice = num(bid?.[0]);
  const askPrice = num(ask?.[0]);
  const bidSize = num(bid?.[1]);
  const askSize = num(ask?.[1]);
  return {
    bestBid: bidPrice,
    bestBidLiquidity:
      bidPrice !== null && bidSize !== null ? bidPrice * bidSize : null,
    bestAsk: askPrice,
    bestAskLiquidity:
      askPrice !== null && askSize !== null ? askPrice * askSize : null,
  };
}

function emptyBookSide(): BookSide {
  return {
    bestBid: null,
    bestBidLiquidity: null,
    bestAsk: null,
    bestAskLiquidity: null,
  };
}

function sideBook(tick: Tick, side: Side): BookSide {
  return side === "UP" ? tick.up : tick.down;
}

function collectTicks(entries: LogEntry[], slug: string): Tick[] {
  let remaining: number | null = null;
  let assetPrice: number | null = null;
  let openPrice: number | null = null;
  let gap: number | null = null;
  let up = emptyBookSide();
  let down = emptyBookSide();
  const ticks: Tick[] = [];

  for (const entry of entries.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))) {
    if (entry.type === "remaining") remaining = num(entry.seconds);
    if (entry.type === "ticker") assetPrice = num(entry.assetPrice);
    if (entry.type === "orderbook_snapshot") {
      up = bookSideFromSnapshot(entry.up);
      down = bookSideFromSnapshot(entry.down);
    }
    if (entry.type === "market_price") {
      openPrice = num(entry.openPrice) ?? num(entry.priceToBeat) ?? openPrice;
      gap = num(entry.gap) ?? gap;
      if (
        remaining !== null &&
        assetPrice !== null &&
        openPrice !== null &&
        gap !== null
      ) {
        ticks.push({
          ts: entry.ts,
          slug,
          remaining,
          assetPrice,
          openPrice,
          gap,
          up,
          down,
        });
      }
    }
  }
  return ticks.filter((tick) => tick.remaining <= 300 && tick.remaining >= -5);
}

function settlementResult(entries: LogEntry[], ticks: Tick[]): Side | null {
  const resolution = entries.find((e) => e.type === "resolution");
  if (resolution?.direction === "UP" || resolution?.direction === "DOWN") {
    return resolution.direction;
  }
  const closeGap =
    num(resolution?.closePrice) !== null && num(resolution?.openPrice) !== null
      ? num(resolution?.closePrice)! - num(resolution?.openPrice)!
      : ticks.at(-1)?.gap;
  return closeGap === undefined ? null : closeGap >= 0 ? "UP" : "DOWN";
}

function nearestTick(ticks: Tick[], ts: number | null): Tick | null {
  if (ts === null || !ticks.length) return null;
  let best = ticks[0]!;
  let bestDist = Math.abs(best.ts - ts);
  for (const tick of ticks) {
    const dist = Math.abs(tick.ts - ts);
    if (dist < bestDist) {
      best = tick;
      bestDist = dist;
    }
  }
  return best;
}

function findEntry(entries: LogEntry[]): LogEntry | null {
  return (
    entries.find(
      (e) => e.type === "order" && e.action === "buy" && e.status === "filled",
    ) ??
    entries.find(
      (e) => e.type === "order" && e.action === "buy" && e.status === "placed",
    ) ??
    null
  );
}

function findExit(entries: LogEntry[]): LogEntry | null {
  return (
    entries.find(
      (e) => e.type === "order" && e.action === "sell" && e.status === "filled",
    ) ??
    entries.find(
      (e) => e.type === "order" && e.action === "sell" && e.status === "placed",
    ) ??
    null
  );
}

function computeActualPnl(entries: LogEntry[]): number | null {
  const resolution = entries.find((e) => e.type === "resolution");
  if (typeof resolution?.pnl === "number") return resolution.pnl;
  let pnl = 0;
  let touched = false;
  for (const e of entries) {
    if (e.type !== "order" || e.status !== "filled") continue;
    const price = num(e.price);
    const shares = num(e.shares);
    if (price === null || shares === null) continue;
    touched = true;
    pnl += e.action === "sell" ? price * shares : -price * shares;
  }
  return touched ? round(pnl, 4) : null;
}

function attribution(trade: ActualTrade): string | null {
  if (trade.realizedPnl === null || trade.realizedPnl >= 0) return null;
  if (trade.sellExpired || trade.exitReason?.includes("final")) return "execution risk";
  if (trade.exitReason?.includes("settlement")) return "bad settlement hold";
  if (
    (trade.entrySpread !== null && trade.entrySpread > 0.05) ||
    (trade.entryBidLiquidity !== null && trade.entryBidLiquidity < SHARES)
  ) {
    return "liquidity/slippage risk";
  }
  if (trade.mfe !== null && trade.mfe <= 0) return "bad entry";
  if (trade.mfe !== null && trade.mfe >= 0.04) return "missed take-profit";
  if (trade.mae !== null && trade.mae <= -0.08) return "late stop-loss";
  return "bad entry";
}

function reportActualMarket(path: string): ActualTrade | null {
  const entries = parseAllJson(readFileSync(path, "utf8"));
  const slot = entries.find((e) => e.type === "slot" && e.action === "start");
  if (!slot) return null;
  const slug =
    slot.slug ?? basename(path).replace(/^early-bird-/, "").replace(/\.log$/, "");
  const ticks = collectTicks(entries, slug);
  const entry = findEntry(entries);
  const exit = findExit(entries);
  const side = (entry?.side ?? entry?.metrics?.side ?? null) as Side | null;
  const entryTs = num(entry?.ts);
  const exitTs = num(exit?.ts);
  const entryTick = nearestTick(ticks, entryTs);
  const exitTick = nearestTick(ticks, exitTs);
  const entryAsk = num(entry?.price) ?? num(entry?.metrics?.entryAsk);
  const entryBook = side && entryTick ? sideBook(entryTick, side) : null;
  const entryBid = num(entry?.metrics?.bestBid) ?? entryBook?.bestBid ?? null;
  const entryAskLiquidity =
    num(entry?.metrics?.entryLiquidity) ??
    num(entry?.metrics?.bestAskLiquidity) ??
    entryBook?.bestAskLiquidity ??
    null;
  const entryBidLiquidity =
    num(entry?.metrics?.bestBidLiquidity) ?? entryBook?.bestBidLiquidity ?? null;
  const entryGap = num(entry?.metrics?.gap) ?? entryTick?.gap ?? null;
  const entryAbsGap =
    num(entry?.metrics?.absGap) ?? (entryGap === null ? null : Math.abs(entryGap));
  const exitPrice = num(exit?.price);
  const afterEntry =
    entryTs === null || side === null ? [] : ticks.filter((tick) => tick.ts >= entryTs);
  const bidsAfterEntry = afterEntry
    .map((tick) => sideBook(tick, side!).bestBid)
    .filter((v): v is number => v !== null);
  const sideGapsAfterEntry = afterEntry.map((tick) => sideGap(side!, tick.gap));
  const maxBid = bidsAfterEntry.length ? Math.max(...bidsAfterEntry) : null;
  const minBid = bidsAfterEntry.length ? Math.min(...bidsAfterEntry) : null;
  const mfe = entryAsk !== null && maxBid !== null ? maxBid - entryAsk : null;
  const mae = entryAsk !== null && minBid !== null ? minBid - entryAsk : null;
  const realizedPnl = computeActualPnl(entries);
  const result = settlementResult(entries, ticks);
  const sellOrders = entries.filter(
    (e) => e.type === "order" && e.action === "sell",
  );
  const trade: ActualTrade = {
    slug,
    startTime: slugStart(slug),
    entryTs,
    entryRemaining:
      num(entry?.metrics?.remaining) ?? entryTick?.remaining ?? null,
    side,
    entryAsk,
    entryBid,
    entrySpread:
      entryAsk !== null && entryBid !== null ? round(entryAsk - entryBid, 4) : null,
    entryAskLiquidity,
    entryBidLiquidity,
    entryGap,
    entryAbsGap,
    gapZ:
      entryAbsGap !== null && num(entry?.metrics?.gapAtr) !== null
        ? round(entryAbsGap / Math.max(num(entry?.metrics?.gapAtr)!, EPSILON), 4)
        : null,
    gapAtr: num(entry?.metrics?.gapAtr),
    atr: num(entry?.metrics?.atr),
    sideGapVelocity: num(entry?.metrics?.sideGapVelocity),
    sideGapVelocityEma: num(entry?.metrics?.sideGapVelocityEma),
    trendConsistency: num(entry?.metrics?.trendConsistency),
    signFlipCount: num(entry?.metrics?.signFlipCount),
    exitTs,
    exitRemaining: num(exit?.metrics?.remaining) ?? exitTick?.remaining ?? null,
    exitReason:
      (exit?.metrics?.exitReason as string | undefined) ??
      (exit?.label as string | undefined) ??
      null,
    exitPrice,
    holdSeconds:
      entryTs !== null && exitTs !== null ? round((exitTs - entryTs) / 1000, 3) : null,
    realizedPnl,
    roi:
      realizedPnl !== null && entryAsk !== null
        ? round(realizedPnl / (entryAsk * SHARES), 4)
        : null,
    mfe: mfe === null ? null : round(mfe, 4),
    mae: mae === null ? null : round(mae, 4),
    maxFavorableBid: maxBid,
    minAdverseBid: minBid,
    peakSideGap: sideGapsAfterEntry.length ? Math.max(...sideGapsAfterEntry) : null,
    finalSideGap: sideGapsAfterEntry.at(-1) ?? null,
    settlementResult: result,
    sellAttempts: sellOrders.filter((e) => e.status === "placed").length,
    sellExpired: sellOrders.some((e) => e.status === "expired"),
    attribution: null,
  };
  trade.attribution = attribution(trade);
  return trade;
}

function round(value: number, digits = 4): number {
  return parseFloat(value.toFixed(digits));
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function summarizeTrades(name: string, markets: number, trades: Array<ActualTrade | SimTrade>): Summary {
  const pnls = trades
    .map((trade) => ("realizedPnl" in trade ? trade.realizedPnl : trade.pnl))
    .filter((v): v is number => v !== null);
  const wins = pnls.filter((pnl) => pnl > 0);
  const losses = pnls.filter((pnl) => pnl < 0);
  let running = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const pnl of pnls) {
    running += pnl;
    peak = Math.max(peak, running);
    maxDrawdown = Math.min(maxDrawdown, running - peak);
  }
  const mfes = trades
    .map((trade) => trade.mfe)
    .filter((v): v is number => v !== null);
  const maes = trades
    .map((trade) => trade.mae)
    .filter((v): v is number => v !== null);
  const lossTrades = trades.filter((trade) => {
    const pnl = "realizedPnl" in trade ? trade.realizedPnl : trade.pnl;
    return pnl !== null && pnl < 0;
  });
  const missed = lossTrades.filter((trade) => trade.mfe !== null && trade.mfe >= 0.04);
  const lateStops = lossTrades.filter((trade) => trade.mae !== null && trade.mae <= -0.08);
  return {
    name,
    markets,
    trades: pnls.length,
    pnl: round(pnls.reduce((sum, pnl) => sum + pnl, 0), 4),
    winRate: pnls.length ? wins.length / pnls.length : null,
    avgPnl: pnls.length
      ? round(pnls.reduce((sum, pnl) => sum + pnl, 0) / pnls.length, 4)
      : null,
    medianPnl: median(pnls),
    profitFactor:
      losses.length === 0
        ? wins.length
          ? Infinity
          : null
        : round(wins.reduce((sum, pnl) => sum + pnl, 0) / Math.abs(losses.reduce((sum, pnl) => sum + pnl, 0)), 4),
    maxDrawdown: round(maxDrawdown, 4),
    avgMfe: mfes.length ? round(mfes.reduce((sum, v) => sum + v, 0) / mfes.length, 4) : null,
    avgMae: maes.length ? round(maes.reduce((sum, v) => sum + v, 0) / maes.length, 4) : null,
    missedTakeProfitRate: lossTrades.length ? missed.length / lossTrades.length : null,
    lateStopLossRate: lossTrades.length ? lateStops.length / lossTrades.length : null,
  };
}

function splitChronological<T extends { startTime: number }>(rows: T[]): [T[], T[], T[]] {
  const sorted = [...rows].sort((a, b) => a.startTime - b.startTime);
  const trainEnd = Math.ceil(sorted.length * 0.6);
  const validationEnd = trainEnd + Math.floor(sorted.length * 0.2);
  return [
    sorted.slice(0, trainEnd),
    sorted.slice(trainEnd, validationEnd),
    sorted.slice(validationEnd),
  ];
}

function bucket(value: number | null, buckets: Array<[number, number]>, suffix = ""): string {
  if (value === null) return "missing";
  for (const [lo, hi] of buckets) {
    if (value >= lo && value < hi) return `${lo}-${hi}${suffix}`;
  }
  const last = buckets.at(-1);
  return last ? `>=${last[1]}${suffix}` : "all";
}

function bucketSigned(value: number | null, cuts: number[]): string {
  if (value === null) return "missing";
  let previous = -Infinity;
  for (const cut of cuts) {
    if (value < cut) return `${fmt(previous, 2)}..${fmt(cut, 2)}`;
    previous = cut;
  }
  return `>=${fmt(cuts.at(-1) ?? 0, 2)}`;
}

function printSummary(summary: Summary): void {
  console.log(
    [
      summary.name,
      `markets=${summary.markets}`,
      `trades=${summary.trades}`,
      `pnl=${fmt(summary.pnl, 4)}`,
      `winRate=${pct(summary.winRate)}`,
      `avg=${fmt(summary.avgPnl, 4)}`,
      `median=${fmt(summary.medianPnl, 4)}`,
      `pf=${summary.profitFactor === Infinity ? "inf" : fmt(summary.profitFactor, 4)}`,
      `maxDD=${fmt(summary.maxDrawdown, 4)}`,
      `avgMFE=${fmt(summary.avgMfe, 4)}`,
      `avgMAE=${fmt(summary.avgMae, 4)}`,
      `missedTP=${pct(summary.missedTakeProfitRate)}`,
      `lateSL=${pct(summary.lateStopLossRate)}`,
    ].join(" | "),
  );
}

function printBucketStats(rows: ActualTrade[]): void {
  const specs: Array<[string, (row: ActualTrade) => string]> = [
    [
      "entryAsk",
      (row) =>
        bucket(row.entryAsk, [
          [0.5, 0.55],
          [0.55, 0.6],
          [0.6, 0.65],
          [0.65, 0.7],
          [0.7, 0.76],
          [0.76, 9],
        ]),
    ],
    [
      "remaining",
      (row) =>
        bucket(row.entryRemaining, [
          [45, 75],
          [75, 120],
          [120, 180],
          [180, 240],
          [240, 300],
        ]),
    ],
    ["absGap", (row) => bucket(row.entryAbsGap, [[0, 8], [8, 12], [12, 18], [18, 30]])],
    ["gapZ", (row) => bucket(row.gapZ, [[0, 10], [10, 25], [25, 50], [50, 100]])],
    [
      "sideGapVelocityEma",
      (row) => bucketSigned(row.sideGapVelocityEma, [-1, -0.25, 0, 0.25, 1]),
    ],
    [
      "trendConsistency",
      (row) => bucket(row.trendConsistency, [[0, 0.5], [0.5, 0.65], [0.65, 0.75], [0.75, 1.01]]),
    ],
    ["signFlipCount", (row) => bucket(row.signFlipCount, [[0, 1], [1, 2], [2, 3], [3, 99]])],
    ["spread", (row) => bucket(row.entrySpread, [[0, 0.02], [0.02, 0.04], [0.04, 0.06], [0.06, 9]])],
    ["liquidity", (row) => bucket(row.entryAskLiquidity, [[0, 10], [10, 25], [25, 50], [50, 100], [100, 10000]])],
    ["exitReason", (row) => row.exitReason ?? "no-exit"],
  ];
  console.log("\n# factor buckets (actual trades)");
  for (const [name, keyFn] of specs) {
    const groups = new Map<string, ActualTrade[]>();
    for (const row of rows.filter((r) => r.entryAsk !== null)) {
      const key = keyFn(row);
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    console.log(`\n## ${name}`);
    for (const [key, group] of [...groups.entries()].sort()) {
      const summary = summarizeTrades(key, group.length, group);
      console.log(
        `${key}\tn=${group.length}\tpnl=${fmt(summary.pnl)}\twin=${pct(summary.winRate)}\tavg=${fmt(summary.avgPnl)}\tpf=${summary.profitFactor === Infinity ? "inf" : fmt(summary.profitFactor)}`,
      );
    }
  }
}

function hypotheticalCurves(rows: ActualTrade[]): void {
  const trades = rows.filter((r) => r.entryAsk !== null && r.realizedPnl !== null);
  console.log("\n# MFE take-profit curve (actual entries, per-share cents threshold)");
  for (const threshold of [0.02, 0.03, 0.04, 0.05, 0.06, 0.08, 0.1]) {
    const pnl = trades.reduce((sum, trade) => {
      if (trade.mfe !== null && trade.mfe >= threshold) return sum + threshold * SHARES;
      return sum + (trade.realizedPnl ?? 0);
    }, 0);
    console.log(`tp=${threshold.toFixed(2)}\tpnl=${fmt(pnl)}`);
  }
  console.log("\n# MAE stop-loss curve (actual entries, per-share cents threshold)");
  for (const threshold of [0.04, 0.06, 0.08, 0.1, 0.12, 0.16]) {
    const pnl = trades.reduce((sum, trade) => {
      if (trade.mae !== null && trade.mae <= -threshold) return sum - threshold * SHARES;
      return sum + (trade.realizedPnl ?? 0);
    }, 0);
    console.log(`sl=${threshold.toFixed(2)}\tpnl=${fmt(pnl)}`);
  }
}

function riskReward(entryAsk: number, targetBid: number, stopPrice: number): number {
  const upside = Math.max(0, Math.min(1 - entryAsk, targetBid - entryAsk));
  const downside = Math.max(0.01, entryAsk - stopPrice);
  return upside / downside;
}

function defaultParams(): SimParams {
  return {
    name: "recommended",
    minNetEdge: 0.05,
    minFairProbability: 0.62,
    maxEntryAsk: 0.72,
    maxSpread: 0.03,
    profitLockMin: 0.04,
    trailingDrawdownCents: 0.03,
    hardStopLossCents: 0.04,
    minTrendConsistency: 0.55,
    maxSignFlipCount: 2,
    settlementMinProbability: 0.92,
    minRiskReward: 0.8,
  };
}

function candidateParams(): SimParams[] {
  const out: SimParams[] = [];
  let id = 0;
  for (const minNetEdge of [0.03, 0.05, 0.07]) {
    for (const minFairProbability of [0.62, 0.66, 0.7]) {
      for (const maxEntryAsk of [0.68, 0.72, 0.76]) {
        for (const hardStopLossCents of [0.04, 0.06, 0.08]) {
          for (const profitLockMin of [0.03, 0.04, 0.05]) {
            out.push({
              ...defaultParams(),
              name: `p${++id}`,
              minNetEdge,
              minFairProbability,
              maxEntryAsk,
              hardStopLossCents,
              profitLockMin,
            });
          }
        }
      }
    }
  }
  return out;
}

function shouldEnter(params: {
  tick: Tick;
  stats: EdgeStats;
  config: SimParams;
}):
  | {
      side: Side;
      book: BookSide;
      pFair: number;
      netEv: number;
      rr: number;
      gapZ: number;
      trendConsistency: number | null;
      signFlipCount: number;
      sideGapVelocityEma: number | null;
    }
  | null {
  const { tick, stats, config } = params;
  if (tick.remaining > 240 || tick.remaining < 45) return null;
  const side = sideFromGap(tick.gap);
  const book = sideBook(tick, side);
  if (
    book.bestAsk === null ||
    book.bestBid === null ||
    book.bestAskLiquidity === null ||
    book.bestBidLiquidity === null
  ) {
    return null;
  }
  const spread = book.bestAsk - book.bestBid;
  if (spread < 0 || spread > config.maxSpread) return null;
  if (book.bestAskLiquidity < 20 || book.bestBidLiquidity < SHARES) return null;
  if (book.bestAsk < 0.52 || book.bestAsk > config.maxEntryAsk) return null;

  const currentSideGap = sideGap(side, tick.gap);
  const gapZ = currentSideGap / Math.max(stats.gapAtr ?? 1, EPSILON);
  if (currentSideGap < 8 || gapZ < 8) return null;
  const fair = computeFairProbability({
    sideGap: currentSideGap,
    remaining: tick.remaining,
    sigmaPerSecond: computeRollingVolatility(stats),
  });
  const slippageBuffer = Math.max(0.01, spread + 0.005);
  const netEv = fair.pFair - book.bestAsk - slippageBuffer;
  const stopPrice = Math.max(0.01, book.bestAsk - config.hardStopLossCents);
  const targetBid = Math.min(0.95, book.bestAsk + Math.max(config.profitLockMin, 0.04));
  const rr = riskReward(book.bestAsk, targetBid, stopPrice);
  const consistency = trendConsistency(stats, side);
  const flips = signFlipCount(stats);
  const velocityEma = sideVelocity(side, stats.gapVelocityEma);
  const peakSideGap = Math.max(stats.peakSideGapBySide[side], currentSideGap);
  const peakRetain = peakSideGap > 0 ? currentSideGap / peakSideGap : 1;

  if (fair.pFair < config.minFairProbability) return null;
  if (netEv < config.minNetEdge) return null;
  if (rr < config.minRiskReward) return null;
  if (consistency !== null && consistency < config.minTrendConsistency) return null;
  if (flips > config.maxSignFlipCount) return null;
  if (velocityEma !== null && velocityEma < -0.1) return null;
  if (peakRetain < 0.78) return null;
  return {
    side,
    book,
    pFair: fair.pFair,
    netEv,
    rr,
    gapZ,
    trendConsistency: consistency,
    signFlipCount: flips,
    sideGapVelocityEma: velocityEma,
  };
}

function replayMarket(
  slug: string,
  startTime: number,
  ticks: Tick[],
  result: Side | null,
  config: SimParams,
): SimTrade | null {
  const stats = createStats();
  let position: OpenSimPosition | null = null;

  for (const tick of ticks) {
    updateStats(stats, tick);
    if (!position) {
      const entry = shouldEnter({ tick, stats, config });
      if (!entry) continue;
      const currentSideGap = sideGap(entry.side, tick.gap);
      position = {
        slug,
        startTime,
        side: entry.side,
        entryTs: tick.ts,
        entryRemaining: tick.remaining,
        entryAsk: entry.book.bestAsk!,
        entryBid: entry.book.bestBid!,
        entrySpread: round(entry.book.bestAsk! - entry.book.bestBid!, 4),
        entryAskLiquidity: entry.book.bestAskLiquidity!,
        entryBidLiquidity: entry.book.bestBidLiquidity!,
        entryGap: tick.gap,
        entryAbsGap: Math.abs(tick.gap),
        gapZ: round(entry.gapZ, 4),
        pFair: round(entry.pFair, 4),
        netEv: round(entry.netEv, 4),
        rr: round(entry.rr, 4),
        sideGapVelocityEma: entry.sideGapVelocityEma,
        trendConsistency: entry.trendConsistency,
        signFlipCount: entry.signFlipCount,
        peakBid: entry.book.bestBid!,
        minBid: entry.book.bestBid!,
        peakSideGap: currentSideGap,
        entrySideGap: currentSideGap,
        positiveSeen: false,
      };
      continue;
    }

    const book = sideBook(tick, position.side);
    const bid = book.bestBid;
    if (bid === null) continue;
    const currentSideGap = sideGap(position.side, tick.gap);
    position.peakBid = Math.max(position.peakBid, bid);
    position.minBid = Math.min(position.minBid, bid);
    position.peakSideGap = Math.max(position.peakSideGap, currentSideGap);
    if (bid > position.entryAsk) position.positiveSeen = true;

    const fair = computeFairProbability({
      sideGap: currentSideGap,
      remaining: tick.remaining,
      sigmaPerSecond: computeRollingVolatility(stats),
    });
    const continueEdge = fair.pFair - bid;
    const profit = bid - position.entryAsk;
    const drawdownFromPeak = position.peakBid - bid;
    const velocityEma = sideVelocity(position.side, stats.gapVelocityEma);
    const consistency = trendConsistency(stats, position.side);
    const strongSettlement =
      tick.remaining <= 30 &&
      fair.pFair >= config.settlementMinProbability &&
      fair.pFair - bid >= 0.03 &&
      currentSideGap > 0 &&
      (velocityEma === null || velocityEma >= -0.1) &&
      signFlipCount(stats) <= config.maxSignFlipCount;

    let reason: string | null = null;
    if (profit <= -config.hardStopLossCents) {
      reason = "hard stop-loss";
    } else if (fair.pFair < position.entryAsk - 0.04 || continueEdge < -0.04) {
      reason = "EV stop";
    } else if (
      currentSideGap <= Math.max(0, position.entrySideGap * 0.45) ||
      (velocityEma !== null && velocityEma < -0.5 && consistency !== null && consistency < 0.5)
    ) {
      reason = "gap invalidation";
    } else if (
      profit >= config.profitLockMin &&
      (continueEdge < 0.015 || velocityEma === null || velocityEma < 0)
    ) {
      reason = "profit lock";
    } else if (
      position.peakBid - position.entryAsk >= 0.06 &&
      drawdownFromPeak >= config.trailingDrawdownCents
    ) {
      reason = "bid trailing take-profit";
    } else if (
      tick.ts - position.entryTs >= 45_000 &&
      !position.positiveSeen &&
      tick.remaining > 45
    ) {
      reason = "time stop";
    } else if (tick.remaining <= 45 && !strongSettlement) {
      reason = "final-window exit";
    }

    if (reason !== null) {
      return finishSimTrade(position, {
        tick,
        bid,
        reason,
        result,
      });
    }
  }

  if (!position) return null;
  const last = ticks.at(-1);
  if (!last) return null;
  const finalBid = sideBook(last, position.side).bestBid ?? position.minBid;
  const correct = result === position.side;
  return finishSimTrade(position, {
    tick: last,
    bid: correct ? 1 : 0,
    reason: "settlement",
    result,
    settlementPayout: true,
    fallbackBid: finalBid,
  });
}

function finishSimTrade(
  position: OpenSimPosition,
  params: {
    tick: Tick;
    bid: number;
    reason: string;
    result: Side | null;
    settlementPayout?: boolean;
    fallbackBid?: number;
  },
): SimTrade {
  const exitPrice = params.settlementPayout ? params.bid : params.bid;
  const pnl = round((exitPrice - position.entryAsk) * SHARES, 4);
  const observedBid = params.fallbackBid ?? params.bid;
  position.peakBid = Math.max(position.peakBid, observedBid);
  position.minBid = Math.min(position.minBid, observedBid);
  return {
    ...position,
    exitTs: params.tick.ts,
    exitRemaining: params.tick.remaining,
    exitReason: params.reason,
    exitPrice,
    holdSeconds: round((params.tick.ts - position.entryTs) / 1000, 3),
    pnl,
    roi: round(pnl / (position.entryAsk * SHARES), 4),
    mfe: round(position.peakBid - position.entryAsk, 4),
    mae: round(position.minBid - position.entryAsk, 4),
    maxFavorableBid: position.peakBid,
    minAdverseBid: position.minBid,
    peakSideGap: position.peakSideGap,
    finalSideGap: sideGap(position.side, params.tick.gap),
    settlementResult: params.result,
  };
}

function loadMarkets(logDir: string, strategyFilter: string | null): Array<{
  path: string;
  slug: string;
  startTime: number;
  entries: LogEntry[];
  ticks: Tick[];
  result: Side | null;
}> {
  return readdirSync(logDir)
    .filter((name) => /^early-bird-btc-updown-5m-\d+\.log$/.test(name))
    .sort()
    .map((name) => {
      const path = join(logDir, name);
      const entries = parseAllJson(readFileSync(path, "utf8"));
      const slot = entries.find((e) => e.type === "slot" && e.action === "start");
      const slug = slot?.slug ?? name.replace(/^early-bird-/, "").replace(/\.log$/, "");
      return {
        path,
        slug,
        startTime: slugStart(slug),
        entries,
        ticks: collectTicks(entries, slug),
        result: settlementResult(entries, collectTicks(entries, slug)),
        strategy: slot?.strategy ?? null,
      };
    })
    .filter((m) => !strategyFilter || m.strategy === strategyFilter)
    .sort((a, b) => a.startTime - b.startTime);
}

function printActualDetails(rows: ActualTrade[]): void {
  console.log("\n# trade details (actual)");
  console.log(
    [
      "slug",
      "side",
      "entryRemaining",
      "entryAsk",
      "entryBid",
      "spread",
      "askLiq",
      "bidLiq",
      "entryGap",
      "gapZ",
      "velEma",
      "trend",
      "flips",
      "exitReason",
      "exitPrice",
      "holdSec",
      "pnl",
      "roi",
      "mfe",
      "mae",
      "peakBid",
      "minBid",
      "peakSideGap",
      "finalSideGap",
      "settlement",
      "sellAttempts",
      "attribution",
    ].join("\t"),
  );
  for (const row of rows) {
    console.log(
      [
        row.slug,
        row.side ?? "-",
        fmt(row.entryRemaining, 1),
        fmt(row.entryAsk, 2),
        fmt(row.entryBid, 2),
        fmt(row.entrySpread, 2),
        fmt(row.entryAskLiquidity, 2),
        fmt(row.entryBidLiquidity, 2),
        fmt(row.entryGap, 2),
        fmt(row.gapZ, 2),
        fmt(row.sideGapVelocityEma, 2),
        fmt(row.trendConsistency, 2),
        fmt(row.signFlipCount, 0),
        row.exitReason ?? "-",
        fmt(row.exitPrice, 2),
        fmt(row.holdSeconds, 1),
        fmt(row.realizedPnl, 2),
        fmt(row.roi, 2),
        fmt(row.mfe, 2),
        fmt(row.mae, 2),
        fmt(row.maxFavorableBid, 2),
        fmt(row.minAdverseBid, 2),
        fmt(row.peakSideGap, 2),
        fmt(row.finalSideGap, 2),
        row.settlementResult ?? "-",
        String(row.sellAttempts),
        row.attribution ?? "-",
      ].join("\t"),
    );
  }
}

function printAttribution(rows: ActualTrade[]): void {
  console.log("\n# losing trade attribution");
  const groups = new Map<string, ActualTrade[]>();
  for (const row of rows.filter((r) => (r.realizedPnl ?? 0) < 0)) {
    const key = row.attribution ?? "unknown";
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  for (const [key, group] of [...groups.entries()].sort()) {
    const pnl = group.reduce((sum, row) => sum + (row.realizedPnl ?? 0), 0);
    console.log(`${key}\tn=${group.length}\tpnl=${fmt(pnl)}`);
  }
}

function printSweep(markets: ReturnType<typeof loadMarkets>): void {
  const candidates = candidateParams();
  const actualSplits = splitChronological(markets);
  const summaries = candidates.map((config) => {
    const bySplit = actualSplits.map((split, idx) => {
      const trades = split
        .map((m) => replayMarket(m.slug, m.startTime, m.ticks, m.result, config))
        .filter((v): v is SimTrade => v !== null);
      return summarizeTrades(["train", "validation", "test"][idx]!, split.length, trades);
    });
    return { config, bySplit };
  });
  summaries.sort((a, b) => {
    const at = a.bySplit[2]!;
    const bt = b.bySplit[2]!;
    const aScore =
      at.pnl + (at.profitFactor ?? 0) * 0.5 - Math.abs(at.maxDrawdown) * 0.2;
    const bScore =
      bt.pnl + (bt.profitFactor ?? 0) * 0.5 - Math.abs(bt.maxDrawdown) * 0.2;
    return bScore - aScore;
  });

  console.log("\n# parameter sweep top 20 (walk-forward split)");
  console.log(
    [
      "name",
      "minEdge",
      "minFair",
      "maxAsk",
      "hardSL",
      "profitLock",
      "trainPnl",
      "valPnl",
      "testPnl",
      "testTrades",
      "testPF",
      "testDD",
    ].join("\t"),
  );
  for (const row of summaries.slice(0, 20)) {
    const [train, validation, test] = row.bySplit;
    console.log(
      [
        row.config.name,
        row.config.minNetEdge,
        row.config.minFairProbability,
        row.config.maxEntryAsk,
        row.config.hardStopLossCents,
        row.config.profitLockMin,
        fmt(train!.pnl),
        fmt(validation!.pnl),
        fmt(test!.pnl),
        String(test!.trades),
        test!.profitFactor === Infinity ? "inf" : fmt(test!.profitFactor),
        fmt(test!.maxDrawdown),
      ].join("\t"),
    );
  }
}

const logDir = argValue("--log-dir") ?? "logs";
const strategyFilter = argValue("--strategy") ?? "advantage-arb";
const markets = loadMarkets(logDir, strategyFilter);
const actual = markets
  .map((m) => reportActualMarket(m.path))
  .filter((v): v is ActualTrade => v !== null);
const actualTrades = actual.filter((row) => row.entryAsk !== null);
const [actualTrain, actualValidation, actualTest] = splitChronological(actual);

console.log("# advantage-arb diagnostics");
console.log(`logs=${logDir} strategy=${strategyFilter} markets=${markets.length}`);
printSummary(summarizeTrades("old/full", actual.length, actualTrades));
printSummary(
  summarizeTrades(
    "old/train",
    actualTrain.length,
    actualTrain.filter((row) => row.entryAsk !== null),
  ),
);
printSummary(
  summarizeTrades(
    "old/validation",
    actualValidation.length,
    actualValidation.filter((row) => row.entryAsk !== null),
  ),
);
printSummary(
  summarizeTrades(
    "old/test",
    actualTest.length,
    actualTest.filter((row) => row.entryAsk !== null),
  ),
);

const recommended = defaultParams();
const simTrades = markets
  .map((m) => replayMarket(m.slug, m.startTime, m.ticks, m.result, recommended))
  .filter((v): v is SimTrade => v !== null);
const [simTrainMarkets, simValidationMarkets, simTestMarkets] = splitChronological(markets);
console.log("\n# replay baseline (new rules, default params)");
printSummary(summarizeTrades("new/full", markets.length, simTrades));
printSummary(
  summarizeTrades(
    "new/train",
    simTrainMarkets.length,
    simTrainMarkets
      .map((m) => replayMarket(m.slug, m.startTime, m.ticks, m.result, recommended))
      .filter((v): v is SimTrade => v !== null),
  ),
);
printSummary(
  summarizeTrades(
    "new/validation",
    simValidationMarkets.length,
    simValidationMarkets
      .map((m) => replayMarket(m.slug, m.startTime, m.ticks, m.result, recommended))
      .filter((v): v is SimTrade => v !== null),
  ),
);
printSummary(
  summarizeTrades(
    "new/test",
    simTestMarkets.length,
    simTestMarkets
      .map((m) => replayMarket(m.slug, m.startTime, m.ticks, m.result, recommended))
      .filter((v): v is SimTrade => v !== null),
  ),
);

printAttribution(actualTrades);
hypotheticalCurves(actualTrades);
printBucketStats(actualTrades);
if (!hasFlag("--no-details")) printActualDetails(actual);
if (!hasFlag("--no-sweep")) printSweep(markets);

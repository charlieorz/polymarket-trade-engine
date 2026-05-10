import { readdirSync, readFileSync } from "fs";
import { basename, join } from "path";
import { __dualEdgeArbTestHooks as dual } from "../engine/strategy/dual-edge-arb.ts";

type Side = "UP" | "DOWN";
type LogEntry = Record<string, any>;

type ReplayReport = {
  slug: string;
  startTime: number;
  direction: Side | null;
  entryModel: string | null;
  entrySide: Side | null;
  entryPrice: number | null;
  entryRemaining: number | null;
  entryGap: number | null;
  entryScore: number | null;
  exitPrice: number | null;
  exitReason: string | null;
  pnl: number | null;
};

function argValue(name: string): string | null {
  const direct = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] ?? null : null;
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

function slugStart(slug: string): number {
  const last = slug.split("-").at(-1);
  return Number(last ?? 0) * 1000;
}

function sideFromDirection(value: unknown): Side | null {
  return value === "UP" || value === "DOWN" ? value : null;
}

function bestLevel(
  book: { bids?: [number, number][]; asks?: [number, number][] } | null | undefined,
  side: "bids" | "asks",
): { price: number; liquidity: number } | null {
  const level = book?.[side]?.[0];
  if (!level) return null;
  const [price, size] = level;
  return { price, liquidity: price * size };
}

function qualityFromSnapshot(snapshot: LogEntry | null, side: Side) {
  const book = side === "UP" ? snapshot?.up : snapshot?.down;
  const ask = bestLevel(book, "asks");
  const bid = bestLevel(book, "bids");
  return dual.computeOrderbookQuality({ ask, bid });
}

function ema(previous: number | null, value: number, period: number): number {
  return previous === null ? value : (previous * (period - 1) + value) / period;
}

function updateReplayStats(params: {
  stats: any;
  snapshot: LogEntry | null;
  price: number;
  gap: number;
  ts: number;
  statsIntervalMs: number;
}) {
  const { stats, snapshot, price, gap, ts, statsIntervalMs } = params;
  if (ts - stats.lastUpdateMs < statsIntervalMs) return;

  for (const side of ["UP", "DOWN"] as const) {
    const q = qualityFromSnapshot(snapshot, side);
    stats.quotes[side].push({
      ts,
      ask: q?.ask ?? null,
      bid: q?.bid ?? null,
      spread: q?.spread ?? null,
    });
    while (stats.quotes[side].length > 45) stats.quotes[side].shift();
  }

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
  stats.lastUpdateMs = ts;
}

function chooseReplayEntry(params: {
  snapshot: LogEntry | null;
  gap: number;
  remaining: number;
  stats: any;
}) {
  const config = dual.readConfig();
  if (
    params.remaining < config.minEntryRemaining ||
    params.remaining > config.maxEntryRemaining
  ) {
    return null;
  }
  const advSide: Side = params.gap >= 0 ? "UP" : "DOWN";
  const weakSide: Side = advSide === "UP" ? "DOWN" : "UP";
  const advQuality = qualityFromSnapshot(params.snapshot, advSide);
  const weakQuality = qualityFromSnapshot(params.snapshot, weakSide);
  const continuation = advQuality
    ? dual.evaluateContinuationCandidate({
        side: advSide,
        gap: params.gap,
        remaining: params.remaining,
        quality: advQuality,
        stats: params.stats,
      })
    : null;
  const reversal = weakQuality
    ? dual.evaluateReversalCandidate({
        side: weakSide,
        gap: params.gap,
        remaining: params.remaining,
        quality: weakQuality,
        stats: params.stats,
      })
    : null;
  if (reversal && (!continuation || reversal.score >= continuation.score + 0.05)) {
    return reversal;
  }
  return continuation;
}

function replayMarket(path: string): ReplayReport | null {
  const entries = parseAllJson(readFileSync(path, "utf8"));
  const slot = entries.find((e) => e.type === "slot" && e.action === "start");
  if (!slot) return null;
  const resolution = entries.find((e) => e.type === "resolution");
  const direction = sideFromDirection(resolution?.direction);
  const priceToBeat =
    typeof resolution?.openPrice === "number" ? resolution.openPrice : null;
  if (priceToBeat === null) return null;

  const slug =
    slot.slug ?? basename(path).replace(/^early-bird-/, "").replace(/\.log$/, "");
  const startTime =
    typeof slot.startTime === "number" ? slot.startTime : slugStart(slug);
  const endTime =
    typeof slot.endTime === "number" ? slot.endTime : startTime + 300_000;
  const stats = dual.createSignalStats() as any;
  const config = dual.readConfig();

  let latestSnapshot: LogEntry | null = null;
  let position: any = null;
  let report: ReplayReport = {
    slug,
    startTime,
    direction,
    entryModel: null,
    entrySide: null,
    entryPrice: null,
    entryRemaining: null,
    entryGap: null,
    entryScore: null,
    exitPrice: null,
    exitReason: null,
    pnl: null,
  };

  for (const entry of entries) {
    if (entry.type === "orderbook_snapshot") {
      latestSnapshot = entry;
      continue;
    }
    if (entry.type !== "ticker" || typeof entry.assetPrice !== "number") continue;
    const ts = typeof entry.ts === "number" ? entry.ts : startTime;
    const remaining = Math.floor((endTime - ts) / 1000);
    if (remaining <= 0) continue;
    const gap = entry.assetPrice - priceToBeat;
    updateReplayStats({
      stats,
      snapshot: latestSnapshot,
      price: entry.assetPrice,
      gap,
      ts,
      statsIntervalMs: config.statsIntervalMs,
    });

    if (!position) {
      const decision = chooseReplayEntry({
        snapshot: latestSnapshot,
        gap,
        remaining,
        stats,
      });
      if (!decision) continue;
      position = {
        model: decision.model,
        side: decision.side,
        tokenId: `${decision.side.toLowerCase()}-token`,
        entryPrice: decision.ask,
        entryGap: gap,
        entryAbsGap: Math.abs(gap),
        entrySideGap: decision.side === "UP" ? gap : -gap,
        entryMs: ts,
        shares: config.shares,
        pFairEntry: decision.pFair,
        netEdgeEntry: decision.netEdge,
        takeProfitPrice: decision.takeProfitPrice,
        stopLossPrice: decision.stopLossPrice,
        peakSideGap: Math.max(0, decision.side === "UP" ? gap : -gap),
        peakBid: decision.bid,
        trendInvalidSinceMs: null,
        riskExitAttempts: 0,
      };
      report = {
        ...report,
        entryModel: decision.model,
        entrySide: decision.side,
        entryPrice: decision.ask,
        entryRemaining: remaining,
        entryGap: gap,
        entryScore: decision.score,
      };
      continue;
    }

    const q = qualityFromSnapshot(latestSnapshot, position.side);
    const bid = q?.bid ?? null;
    const currentSideGap = position.side === "UP" ? gap : -gap;
    position.peakSideGap = Math.max(position.peakSideGap, currentSideGap);
    if (bid !== null) position.peakBid = Math.max(position.peakBid ?? bid, bid);
    const exit = dual.shouldExit({
      pos: position,
      gap,
      bid,
      remaining,
      now: ts,
      stats,
    });
    if (exit) {
      report.exitPrice = exit.price;
      report.exitReason = exit.reason;
      report.pnl = parseFloat(((exit.price - position.entryPrice) * position.shares).toFixed(4));
      position = null;
      break;
    }
  }

  if (position && direction !== null) {
    const payout = direction === position.side ? 1 : 0;
    report.exitReason = "settlement";
    report.exitPrice = payout;
    report.pnl = parseFloat(((payout - position.entryPrice) * position.shares).toFixed(4));
  }

  return report;
}

function fmt(value: number | null, digits = 4): string {
  return value === null || !Number.isFinite(value) ? "-" : value.toFixed(digits);
}

function splitRows<T>(rows: T[]): [T[], T[], T[]] {
  const trainEnd = Math.ceil(rows.length * 0.6);
  const validationEnd = trainEnd + Math.floor(rows.length * 0.2);
  return [
    rows.slice(0, trainEnd),
    rows.slice(trainEnd, validationEnd),
    rows.slice(validationEnd),
  ];
}

function summarize(name: string, rows: ReplayReport[]) {
  const pnls = rows.map((r) => r.pnl).filter((v): v is number => v !== null);
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  let running = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const pnl of pnls) {
    running += pnl;
    peak = Math.max(peak, running);
    maxDrawdown = Math.min(maxDrawdown, running - peak);
  }
  console.log(
    [
      name,
      `markets=${rows.length}`,
      `traded=${rows.filter((r) => r.entryPrice !== null).length}`,
      `pnl=${fmt(pnls.reduce((sum, pnl) => sum + pnl, 0))}`,
      `maxLoss=${fmt(losses.length ? Math.min(...losses) : 0)}`,
      `maxDD=${fmt(maxDrawdown)}`,
      `winRate=${pnls.length ? `${(wins.length / pnls.length * 100).toFixed(1)}%` : "-"}`,
      `avgWin=${fmt(wins.length ? wins.reduce((sum, p) => sum + p, 0) / wins.length : null)}`,
      `avgLoss=${fmt(losses.length ? losses.reduce((sum, p) => sum + p, 0) / losses.length : null)}`,
      `continuation=${rows.filter((r) => r.entryModel === "continuation").length}`,
      `reversal=${rows.filter((r) => r.entryModel === "reversal").length}`,
    ].join(" | "),
  );
}

const logDir = argValue("--log-dir") ?? "logs";
const fromSlug = argValue("--from-slug");

const rows = readdirSync(logDir)
  .filter((name) => /^early-bird-btc-updown-5m-\d+\.log$/.test(name))
  .sort()
  .map((name) => join(logDir, name))
  .map(replayMarket)
  .filter((r): r is ReplayReport => r !== null)
  .filter((r) => !fromSlug || r.slug >= fromSlug)
  .sort((a, b) => a.startTime - b.startTime);

const [train, validation, test] = splitRows(rows);

console.log("# dual-edge-arb offline replay");
console.log(
  "Note: openPrice is read from each log's resolution record because this offline file format stores it there; in live/sim runtime it is the known priceToBeat.",
);
console.log(`logs=${logDir} from=${fromSlug ?? "all"} markets=${rows.length}`);
summarize("full", rows);
summarize("train", train);
summarize("validation", validation);
summarize("test", test);
console.log("");
console.log(["slug", "model", "side", "entry", "remaining", "gap", "score", "exit", "reason", "pnl"].join("\t"));
for (const row of rows) {
  console.log(
    [
      row.slug,
      row.entryModel ?? "-",
      row.entrySide ?? "-",
      fmt(row.entryPrice, 2),
      fmt(row.entryRemaining, 0),
      fmt(row.entryGap, 2),
      fmt(row.entryScore, 2),
      fmt(row.exitPrice, 2),
      row.exitReason ?? "-",
      fmt(row.pnl, 2),
    ].join("\t"),
  );
}

import { readdirSync, readFileSync } from "fs";
import { basename, join } from "path";

type LogEntry = Record<string, any>;
type Side = "UP" | "DOWN";

type MarketReport = {
  slug: string;
  startTime: number;
  strategy: string | null;
  entryTime: number | null;
  entrySide: Side | null;
  entryPrice: number | null;
  entryGap: number | null;
  entrySignalStrength: number | null;
  entryAskLiquidity: number | null;
  entryBid: number | null;
  exitTime: number | null;
  exitReason: string | null;
  exitPrice: number | null;
  pnl: number | null;
  maxFavorableExcursion: number | null;
  maxAdverseExcursion: number | null;
  missedUpsideAfterExit: number | null;
  gapRetraceEntry: boolean;
  earlyPlannedTakeProfit: boolean;
  settlementHoldDrawdown: boolean;
  sellUnfilled: boolean;
};

type SplitReport = {
  name: string;
  count: number;
  traded: number;
  pnl: number;
  maxSingleLoss: number;
  maxDrawdown: number;
  winRate: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  pnlRetraceEntries: number;
  pnlExcludingRetraceEntries: number;
  gapRetraceEntries: number;
  earlyPlannedTakeProfits: number;
  settlementHoldDrawdowns: number;
  sellUnfilled: number;
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
  const parts = slug.split("-");
  return Number(parts[parts.length - 1] ?? 0) * 1000;
}

function sideGap(side: Side, gap: number): number {
  return side === "UP" ? gap : -gap;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function fmt(value: number | null, digits = 4): string {
  if (value === null || !Number.isFinite(value)) return "-";
  return value.toFixed(digits);
}

function gapAt(entry: LogEntry): number | null {
  return (
    num(entry.metrics?.gap) ??
    num(entry.market?.gap) ??
    num(entry.gap) ??
    null
  );
}

function sideBid(entry: LogEntry): number | null {
  return num(entry.metrics?.bestBid) ?? num(entry.market?.bestBid) ?? null;
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

function computePnl(entries: LogEntry[]): number | null {
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
  return touched ? parseFloat(pnl.toFixed(4)) : null;
}

function reportMarket(path: string): MarketReport | null {
  const entries = parseAllJson(readFileSync(path, "utf8"));
  const slot = entries.find((e) => e.type === "slot" && e.action === "start");
  if (!slot) return null;
  const slug =
    slot.slug ?? basename(path).replace(/^early-bird-/, "").replace(/\.log$/, "");
  const strategy = slot.strategy ?? null;
  const startTime = slot.startTime ?? slugStart(slug);
  const entry = findEntry(entries);
  const exit = findExit(entries);
  const entrySide = (entry?.side ?? entry?.metrics?.side ?? null) as Side | null;
  const entryGap = entry ? gapAt(entry) : null;
  const entryPrice = num(entry?.price) ?? num(entry?.metrics?.entryAsk);
  const entrySignalStrength =
    num(entry?.metrics?.entrySignalStrength) ??
    (entry?.metrics?.absGap !== undefined && entry?.metrics?.atr
      ? num(entry.metrics.absGap)! / num(entry.metrics.atr)!
      : null);
  const entryAskLiquidity =
    num(entry?.metrics?.entryLiquidity) ??
    num(entry?.metrics?.bestAskLiquidity) ??
    null;
  const entryBid = sideBid(entry ?? {});
  const exitPrice = num(exit?.price);
  const exitReason =
    (exit?.metrics?.exitReason as string | undefined) ??
    (exit?.label as string | undefined) ??
    null;
  const pnl = computePnl(entries);

  const beforeEntryGaps = entries
    .filter((e) => entry && e.ts <= entry.ts)
    .map((e) => gapAt(e))
    .filter((v): v is number => v !== null);
  const preEntryPeak =
    entrySide && beforeEntryGaps.length
      ? Math.max(...beforeEntryGaps.map((g) => sideGap(entrySide, g)))
      : null;
  const entrySideGap =
    entrySide && entryGap !== null ? sideGap(entrySide, entryGap) : null;
  const gapRetraceEntry =
    preEntryPeak !== null &&
    preEntryPeak > 0 &&
    entrySideGap !== null &&
    entrySideGap / preEntryPeak < 0.78;

  const afterEntry = entries.filter((e) => entry && e.ts >= entry.ts);
  const afterExit = entries.filter((e) => exit && e.ts >= exit.ts);
  const bidsAfterEntry = afterEntry
    .map(sideBid)
    .filter((v): v is number => v !== null);
  const bidsAfterExit = afterExit
    .map(sideBid)
    .filter((v): v is number => v !== null);
  const mfe =
    entryPrice !== null && bidsAfterEntry.length
      ? Math.max(...bidsAfterEntry) - entryPrice
      : null;
  const mae =
    entryPrice !== null && bidsAfterEntry.length
      ? Math.min(...bidsAfterEntry) - entryPrice
      : null;
  const missedUpside =
    exitPrice !== null && bidsAfterExit.length
      ? Math.max(...bidsAfterExit) - exitPrice
      : null;
  const earlyPlannedTakeProfit =
    exitReason === "planned take-profit" &&
    missedUpside !== null &&
    missedUpside >= 0.05;
  const settlementHoldDrawdown = entries.some((e) => {
    if (e.metrics?.settlementHold !== true) return false;
    const retain = num(e.metrics?.gapRetainRatio);
    const edge = num(e.metrics?.unrealizedEdge);
    return (retain !== null && retain < 0.6) || (edge !== null && edge < -0.08);
  });
  const sellPlaced = entries.some(
    (e) => e.type === "order" && e.action === "sell" && e.status === "placed",
  );
  const sellFilled = entries.some(
    (e) => e.type === "order" && e.action === "sell" && e.status === "filled",
  );

  return {
    slug,
    startTime,
    strategy,
    entryTime: num(entry?.ts),
    entrySide,
    entryPrice,
    entryGap,
    entrySignalStrength:
      entrySignalStrength === null ? null : parseFloat(entrySignalStrength.toFixed(4)),
    entryAskLiquidity,
    entryBid,
    exitTime: num(exit?.ts),
    exitReason,
    exitPrice,
    pnl,
    maxFavorableExcursion: mfe === null ? null : parseFloat(mfe.toFixed(4)),
    maxAdverseExcursion: mae === null ? null : parseFloat(mae.toFixed(4)),
    missedUpsideAfterExit:
      missedUpside === null ? null : parseFloat(missedUpside.toFixed(4)),
    gapRetraceEntry,
    earlyPlannedTakeProfit,
    settlementHoldDrawdown,
    sellUnfilled: sellPlaced && !sellFilled,
  };
}

function summarize(name: string, rows: MarketReport[]): SplitReport {
  const traded = rows.filter((r) => r.entryPrice !== null);
  const pnls = rows.map((r) => r.pnl).filter((v): v is number => v !== null);
  let running = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const pnl of pnls) {
    running += pnl;
    peak = Math.max(peak, running);
    maxDrawdown = Math.min(maxDrawdown, running - peak);
  }
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  const retracePnls = rows
    .filter((r) => r.gapRetraceEntry)
    .map((r) => r.pnl)
    .filter((v): v is number => v !== null);
  const nonRetracePnls = rows
    .filter((r) => !r.gapRetraceEntry)
    .map((r) => r.pnl)
    .filter((v): v is number => v !== null);
  return {
    name,
    count: rows.length,
    traded: traded.length,
    pnl: parseFloat(pnls.reduce((sum, p) => sum + p, 0).toFixed(4)),
    maxSingleLoss: losses.length ? Math.min(...losses) : 0,
    maxDrawdown: parseFloat(maxDrawdown.toFixed(4)),
    winRate: pnls.length ? wins.length / pnls.length : null,
    avgWin: wins.length
      ? parseFloat((wins.reduce((s, p) => s + p, 0) / wins.length).toFixed(4))
      : null,
    avgLoss: losses.length
      ? parseFloat((losses.reduce((s, p) => s + p, 0) / losses.length).toFixed(4))
      : null,
    pnlRetraceEntries: parseFloat(
      retracePnls.reduce((sum, p) => sum + p, 0).toFixed(4),
    ),
    pnlExcludingRetraceEntries: parseFloat(
      nonRetracePnls.reduce((sum, p) => sum + p, 0).toFixed(4),
    ),
    gapRetraceEntries: rows.filter((r) => r.gapRetraceEntry).length,
    earlyPlannedTakeProfits: rows.filter((r) => r.earlyPlannedTakeProfit).length,
    settlementHoldDrawdowns: rows.filter((r) => r.settlementHoldDrawdown).length,
    sellUnfilled: rows.filter((r) => r.sellUnfilled).length,
  };
}

function splitRows(rows: MarketReport[]): [MarketReport[], MarketReport[], MarketReport[]] {
  const trainEnd = Math.ceil(rows.length * 0.6);
  const validationEnd = trainEnd + Math.floor(rows.length * 0.2);
  return [
    rows.slice(0, trainEnd),
    rows.slice(trainEnd, validationEnd),
    rows.slice(validationEnd),
  ];
}

function printSummary(summary: SplitReport): void {
  console.log(
    [
      summary.name,
      `markets=${summary.count}`,
      `traded=${summary.traded}`,
      `pnl=${fmt(summary.pnl)}`,
      `maxLoss=${fmt(summary.maxSingleLoss)}`,
      `maxDD=${fmt(summary.maxDrawdown)}`,
      `winRate=${summary.winRate === null ? "-" : (summary.winRate * 100).toFixed(1) + "%"}`,
      `avgWin=${fmt(summary.avgWin)}`,
      `avgLoss=${fmt(summary.avgLoss)}`,
      `pnlRetrace=${fmt(summary.pnlRetraceEntries)}`,
      `pnlNoRetrace=${fmt(summary.pnlExcludingRetraceEntries)}`,
      `gapRetraceEntry=${summary.gapRetraceEntries}`,
      `earlyPlannedTP=${summary.earlyPlannedTakeProfits}`,
      `settlementHoldDD=${summary.settlementHoldDrawdowns}`,
      `sellUnfilled=${summary.sellUnfilled}`,
    ].join(" | "),
  );
}

const logDir = argValue("--log-dir") ?? "logs";
const fromSlug = argValue("--from-slug");
const latestFromSlug = argValue("--latest-from-slug");
const strategyFilter = argValue("--strategy");

const files = readdirSync(logDir)
  .filter((name) => /^early-bird-btc-updown-5m-\d+\.log$/.test(name))
  .sort()
  .map((name) => join(logDir, name));

let rows = files
  .map(reportMarket)
  .filter((r): r is MarketReport => r !== null)
  .filter((r) => !strategyFilter || r.strategy === strategyFilter)
  .filter((r) => !fromSlug || r.slug >= fromSlug)
  .sort((a, b) => a.startTime - b.startTime);

const latestRows = latestFromSlug
  ? rows.filter((r) => r.slug >= latestFromSlug)
  : [];

const [train, validation, test] = splitRows(rows);

console.log("# advantage-arb log replay report");
console.log(`logs=${logDir} strategy=${strategyFilter ?? "all"} markets=${rows.length}`);
console.log("");
printSummary(summarize("full", rows));
printSummary(summarize("train", train));
printSummary(summarize("validation", validation));
printSummary(summarize("test", test));
if (latestFromSlug) printSummary(summarize(`latest-from-${latestFromSlug}`, latestRows));

console.log("");
console.log(
  [
    "slug",
    "side",
    "entry",
    "entryGap",
    "signal",
    "exit",
    "reason",
    "pnl",
    "mfe",
    "mae",
    "missed",
    "retraceEntry",
    "sellUnfilled",
  ].join("\t"),
);
for (const r of rows) {
  console.log(
    [
      r.slug,
      r.entrySide ?? "-",
      fmt(r.entryPrice, 2),
      fmt(r.entryGap, 2),
      fmt(r.entrySignalStrength, 2),
      fmt(r.exitPrice, 2),
      r.exitReason ?? "-",
      fmt(r.pnl, 2),
      fmt(r.maxFavorableExcursion, 2),
      fmt(r.maxAdverseExcursion, 2),
      fmt(r.missedUpsideAfterExit, 2),
      r.gapRetraceEntry ? "yes" : "no",
      r.sellUnfilled ? "yes" : "no",
    ].join("\t"),
  );
}

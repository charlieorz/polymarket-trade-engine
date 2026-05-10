import { existsSync, mkdirSync, writeFileSync } from "fs";
import { delimiter, join } from "path";
import { Resvg } from "@resvg/resvg-js";
import { slotFromSlug } from "../../utils/slot.ts";

type LogEntry = Record<string, any>;
type Side = "UP" | "DOWN";
type Action = "buy" | "sell";

type PricePoint = {
  ts: number;
  price: number;
  ptb: number | null;
  gap: number | null;
};

type SignalPoint = {
  ts: number;
  signalId: string;
  action: Action;
  side: Side;
  label?: string;
  metrics?: Record<string, unknown>;
  market?: Record<string, number | null>;
};

type OrderPoint = {
  ts: number;
  requestId?: string;
  signalId?: string;
  action: Action;
  side: Side;
  status: string;
  price: number;
  shares?: number;
  label?: string;
  requestLatencyMs?: number;
  signalLatencyMs?: number;
  metrics?: Record<string, unknown>;
  market?: Record<string, number | null>;
};

export type TradeWindowImageOptions = {
  strategyName: string;
  slug: string;
  outputRoot?: string;
};

const METRIC_PRIORITY = [
  "remaining",
  "exitReason",
  "gap",
  "absGap",
  "currentSideGap",
  "peakSideGap",
  "settlementHold",
  "settlementProfit",
  "exitProfit",
  "settlementUpside",
  "settlementRequiredGap",
  "gapRetainRatio",
  "peakRetainRatio",
  "atr",
  "gapVelocity",
  "bestAsk",
  "bestBid",
  "entryPrice",
  "takeProfitPrice",
  "stopLossPrice",
  "unrealizedEdge",
  "entryAsk",
  "plannedTakeProfit",
  "plannedStopLoss",
];

const SVG_FONT_FAMILY =
  "'Noto Sans CJK SC', 'Noto Sans SC', 'Source Han Sans SC', 'PingFang SC', " +
  "'Microsoft YaHei', 'WenQuanYi Zen Hei', STHeiti, Arial, sans-serif";

const CJK_FONT_CANDIDATES = [
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf",
  "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
  "/usr/share/fonts/opentype/adobe-source-han-sans/SourceHanSansSC-Regular.otf",
  "/usr/share/fonts/opentype/source-han-sans/SourceHanSansSC-Regular.otf",
  "/System/Library/Fonts/STHeiti Medium.ttc",
  "/System/Library/Fonts/PingFang.ttc",
  "/Library/Fonts/Arial Unicode.ttf",
];

function splitFontPaths(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(new RegExp(`[${delimiter},]`))
    .map((part) => part.trim())
    .filter(Boolean);
}

function existingUnique(paths: string[]): string[] {
  return [...new Set(paths)].filter((fontPath) => existsSync(fontPath));
}

function cjkFontFiles(): string[] {
  return existingUnique([
    ...splitFontPaths(process.env.TRADE_WINDOW_FONT_FILES),
    ...splitFontPaths(process.env.TRADE_WINDOW_FONT_FILE),
    ...splitFontPaths(process.env.CJK_FONT_FILES),
    ...splitFontPaths(process.env.CJK_FONT_FILE),
    ...CJK_FONT_CANDIDATES,
  ]);
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

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmt(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "-";
    return Math.abs(value) >= 1000 ? value.toFixed(2) : value.toFixed(4);
  }
  return String(value);
}

function fmtUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "-";
  return "$" + value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function fmtElapsed(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const mm = Math.floor(s / 60)
    .toString()
    .padStart(2, "0");
  const ss = (s % 60).toString().padStart(2, "0");
  return `${mm}:${ss}`;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 1)) + "…";
}

function nearestPrice(points: PricePoint[], ts: number): PricePoint | null {
  if (points.length === 0) return null;
  let best = points[0]!;
  let bestDist = Math.abs(best.ts - ts);
  for (const p of points) {
    const d = Math.abs(p.ts - ts);
    if (d < bestDist) {
      best = p;
      bestDist = d;
    }
  }
  return best;
}

function collectRawPricePoints(entries: LogEntry[]): PricePoint[] {
  const points: PricePoint[] = [];
  let lastMarket: { priceToBeat?: number; gap?: number } | null = null;

  for (const e of entries) {
    if (e.type === "market_price") {
      lastMarket = { priceToBeat: e.priceToBeat ?? e.openPrice, gap: e.gap };
    } else if (e.type === "ticker" && typeof e.assetPrice === "number") {
      points.push({
        ts: e.ts,
        price: e.assetPrice,
        ptb: lastMarket?.priceToBeat ?? null,
        gap: lastMarket?.gap ?? null,
      });
    }
  }

  const byTs = new Map<number, PricePoint>();
  for (const p of points) byTs.set(p.ts, p);
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}

function fitPricePointsToWindow(
  raw: PricePoint[],
  marketStartMs: number,
  marketEndMs: number,
  closePrice: number | null,
): PricePoint[] {
  if (raw.length === 0) return [];

  const points = raw.filter((p) => p.ts >= marketStartMs && p.ts <= marketEndMs);
  const beforeStart = [...raw].reverse().find((p) => p.ts <= marketStartMs);
  const firstAfterStart = raw.find((p) => p.ts >= marketStartMs);
  const first = beforeStart ?? firstAfterStart ?? raw[0]!;

  if (!points.length || points[0]!.ts > marketStartMs) {
    points.unshift({ ...first, ts: marketStartMs });
  }

  const last = points[points.length - 1]!;
  if (last.ts < marketEndMs && closePrice !== null) {
    // 只有 resolution closePrice 才能代表市场窗口结束时的真实价格。
    // 如果 lifecycle 在 sell 后提前停止，日志没有后续 ticker，不能把最后
    // 一个 ticker 横向补到 05:00；否则图上会出现“价格卖出后不再波动”的假象。
    points.push({
      ...last,
      ts: marketEndMs,
      price: closePrice,
    });
  }

  return points;
}

function collectOrders(entries: LogEntry[]): OrderPoint[] {
  const orders = entries
    .filter((e) => e.type === "order")
    .filter((e) => e.status === "placed" || e.status === "filled")
    .map((e) => ({
      ts: e.ts,
      requestId: e.requestId,
      signalId: e.signalId,
      action: e.action as Action,
      side: e.side as Side,
      status: e.status as string,
      price: e.price as number,
      shares: e.shares,
      label: e.label,
      requestLatencyMs: e.requestLatencyMs,
      signalLatencyMs: e.signalLatencyMs,
      metrics: e.metrics,
      market: e.market,
    }));

  const placed = orders.filter((o) => o.status === "placed");
  return placed.length > 0 ? placed : orders;
}

function collectSignals(entries: LogEntry[]): SignalPoint[] {
  return entries
    .filter((e) => e.type === "strategy_signal")
    .map((e) => ({
      ts: e.ts,
      signalId: e.signalId,
      action: e.action as Action,
      side: e.side as Side,
      label: e.label,
      metrics: e.metrics,
      market: e.market,
    }));
}

function computePnl(entries: LogEntry[]): number | null {
  const resolution = entries.find(
    (e) => e.type === "resolution" && typeof e.pnl === "number",
  );
  if (resolution) return resolution.pnl;

  const filledOrders = entries.filter(
    (e) => e.type === "order" && e.status === "filled",
  );
  if (!filledOrders.length) return null;

  let pnl = 0;
  for (const order of filledOrders) {
    const price = typeof order.price === "number" ? order.price : null;
    const shares = typeof order.shares === "number" ? order.shares : null;
    if (price === null || shares === null) continue;
    pnl += order.action === "sell" ? price * shares : -price * shares;
    if (typeof order.fee === "number") pnl -= order.fee;
  }
  return parseFloat(pnl.toFixed(4));
}

function metricPairs(metrics?: Record<string, unknown>): [string, unknown][] {
  if (!metrics) return [];
  const entries = Object.entries(metrics).filter(
    ([, value]) => value !== undefined && typeof value !== "object",
  );
  const ranked: [string, unknown][] = [];
  for (const key of METRIC_PRIORITY) {
    const found = entries.find(([k]) => k === key);
    if (found) ranked.push(found);
  }
  for (const entry of entries) {
    if (!METRIC_PRIORITY.includes(entry[0])) ranked.push(entry);
  }
  return ranked;
}

function renderMetricChips(params: {
  metrics?: Record<string, unknown>;
  x: number;
  y: number;
  width: number;
  fill: string;
  text: string;
}): string {
  const pairs = metricPairs(params.metrics);
  if (!pairs.length) {
    return `<text x="${params.x}" y="${params.y + 18}" fill="#64748b" font-size="17">-</text>`;
  }

  const chips: string[] = [];
  let x = params.x;
  let y = params.y;
  let line = 0;
  let rendered = 0;

  for (const [key, value] of pairs) {
    const label = truncate(`${key}: ${fmt(value)}`, 24);
    const w = Math.min(180, Math.max(58, label.length * 8 + 18));
    if (x + w > params.x + params.width) {
      line++;
      if (line >= 2) break;
      x = params.x;
      y += 27;
    }
    chips.push(
      `<g><rect x="${x}" y="${y}" width="${w}" height="22" rx="5" fill="${params.fill}" opacity="0.9"/><text x="${x + 9}" y="${y + 15}" fill="${params.text}" font-size="15">${esc(label)}</text></g>`,
    );
    x += w + 6;
    rendered++;
  }

  if (rendered < pairs.length && line < 2) {
    chips.push(
      `<text x="${x}" y="${y + 16}" fill="#64748b" font-size="15">+${pairs.length - rendered}</text>`,
    );
  }

  return chips.join("");
}

function renderOrderMarker(params: {
  x: number;
  y: number;
  color: string;
  letter: string;
}): string {
  const { x, y, color, letter } = params;
  const box = 26;
  const boxX = x - box / 2;
  const boxY = y - 40;
  const triY = boxY + box;
  return `
    <g data-marker-shape="square-pointer">
      <rect x="${boxX}" y="${boxY}" width="${box}" height="${box}" rx="4" fill="${color}" stroke="#f8fafc" stroke-width="2"/>
      <path d="M ${x - 8} ${triY} L ${x + 8} ${triY} L ${x} ${y} Z" fill="${color}" stroke="#f8fafc" stroke-width="2" stroke-linejoin="round"/>
      <text x="${x}" y="${boxY + 18}" text-anchor="middle" font-size="17" font-weight="800" fill="#071018">${letter}</text>
    </g>`;
}

export function buildTradeWindowSvgFromLog(
  text: string,
  opts: TradeWindowImageOptions,
): string | null {
  const entries = parseAllJson(text);
  const slot = entries.find((e) => e.type === "slot" && e.action === "start");
  if (!slot) return null;

  const slug = opts.slug || slot.slug;
  const strategyName = opts.strategyName || slot.strategy || "unknown";
  const marketSlot = slotFromSlug(slug);
  const marketStartMs = marketSlot.startTime;
  const marketEndMs = marketSlot.endTime;
  const duration = Math.max(1, (marketEndMs - marketStartMs) / 1000);

  const resolution = entries.find((e) => e.type === "resolution");
  const rawPricePoints = collectRawPricePoints(entries);
  const ptb =
    resolution?.openPrice ??
    [...rawPricePoints].reverse().find((p) => p.ptb != null)?.ptb ??
    null;
  const lastWindowPrice = [...rawPricePoints]
    .reverse()
    .find((p) => p.ts <= marketEndMs);
  const hasObservedWindowEnd =
    lastWindowPrice != null && marketEndMs - lastWindowPrice.ts <= 2_500;
  const closePrice =
    resolution?.closePrice ?? (hasObservedWindowEnd ? lastWindowPrice.price : null);
  const pricePoints = fitPricePointsToWindow(
    rawPricePoints,
    marketStartMs,
    marketEndMs,
    closePrice,
  );
  const orders = collectOrders(entries);
  if (orders.length === 0 || pricePoints.length < 2) return null;

  const signals = collectSignals(entries);
  const signalsById = new Map(signals.map((s) => [s.signalId, s]));
  const pnl = computePnl(entries);
  const finalGap =
    ptb != null && closePrice != null
      ? parseFloat((closePrice - ptb).toFixed(2))
      : null;
  const finalDirection: Side | null =
    resolution?.direction ??
    (finalGap == null ? null : finalGap >= 0 ? "UP" : "DOWN");

  const width = 1600;
  const height = 1000;
  const chart = { x: 80, y: 170, w: 1318, h: 470 };
  const axisLabelX = 1418;
  const table = { x: 80, y: 706, w: 1440, rowH: 92 };
  // 底部指标区的列宽需要显式固定，避免交易标题、延迟与指标 chip 在 PNG 中互相覆盖。
  // 这里给“交易”列预留更宽空间，主要是兼容 SELL DOWN 这类最长标题。
  const tableColumns = {
    tradeX: table.x + 8,
    delayX: table.x + 410,
    signalX: table.x + 500,
    confirmX: table.x + 1008,
    signalW: 454,
    confirmW: 424,
  };
  const allPrices = [
    ...pricePoints.map((p) => p.price),
    ...(ptb != null ? [ptb] : []),
  ];
  const minPrice = Math.min(...allPrices);
  const maxPrice = Math.max(...allPrices);
  const pad = Math.max(1, (maxPrice - minPrice) * 0.12);
  const yMin = minPrice - pad;
  const yMax = maxPrice + pad;
  const xForTs = (ts: number) =>
    chart.x +
    Math.max(0, Math.min(1, (ts - marketStartMs) / (marketEndMs - marketStartMs))) *
      chart.w;
  const yForPrice = (price: number) =>
    chart.y + chart.h - ((price - yMin) / (yMax - yMin)) * chart.h;
  const sideColor = (side: Side) => (side === "UP" ? "#22c55e" : "#ef4444");

  const linePath = pricePoints
    .map(
      (p, i) =>
        `${i === 0 ? "M" : "L"} ${xForTs(p.ts).toFixed(1)} ${yForPrice(p.price).toFixed(1)}`,
    )
    .join(" ");
  const ptbY = ptb != null ? yForPrice(ptb) : null;

  const yTicks = [0, 0.25, 0.5, 0.75, 1]
    .map((t) => {
      const y = chart.y + chart.h * t;
      const price = yMax - (yMax - yMin) * t;
      return `<line x1="${chart.x}" y1="${y}" x2="${chart.x + chart.w}" y2="${y}" stroke="#26313c"/><text data-role="right-axis-label" x="${axisLabelX}" y="${y + 5}" fill="#8b98a8" font-size="22">${esc(fmtUsd(price))}</text>`;
    })
    .join("");

  const xTicks: string[] = [];
  for (let sec = 0; sec <= duration; sec += 5) {
    const x = chart.x + (sec / duration) * chart.w;
    const major = sec % 30 === 0 || sec === duration;
    xTicks.push(
      `<line data-x-tick="${sec}" x1="${x}" y1="${chart.y + chart.h}" x2="${x}" y2="${chart.y + chart.h + (major ? 10 : 5)}" stroke="${major ? "#64748b" : "#334155"}" stroke-width="1"/>`,
    );
    if (major) {
      xTicks.push(
        `<text x="${x}" y="${chart.y + chart.h + 31}" text-anchor="middle" fill="#8b98a8" font-size="17">${fmtElapsed(sec)}</text>`,
      );
    }
  }

  const orderMarks = orders
    .map((o) => {
      const p = o.market?.assetPrice ?? nearestPrice(pricePoints, o.ts)?.price;
      if (typeof p !== "number") return "";
      return renderOrderMarker({
        x: xForTs(o.ts),
        y: yForPrice(p),
        color: sideColor(o.side),
        letter: o.action === "buy" ? "B" : "S",
      });
    })
    .join("");

  const rows = orders.slice(0, 3).map((o, idx) => {
    const signal = o.signalId ? signalsById.get(o.signalId) : undefined;
    const y = table.y + 55 + idx * table.rowH;
    const delay =
      typeof o.signalLatencyMs === "number"
        ? `${(o.signalLatencyMs / 1000).toFixed(3)}s`
        : "-";
    // 标题只承担“交易方向/价格/数量”的快速定位职责，过长时截断，详细上下文放在右侧指标 chip。
    const title = truncate(
      `${o.action.toUpperCase()} ${o.side} @ ${fmt(o.price)} ${o.shares ? `x ${fmt(o.shares)}` : ""}`,
      34,
    );
    return `
      <g>
        <line x1="${table.x}" y1="${y - 26}" x2="${table.x + table.w}" y2="${y - 26}" stroke="#1f2b35"/>
        <text x="${tableColumns.tradeX}" y="${y}" fill="${sideColor(o.side)}" font-size="21" font-weight="800">${esc(title)}</text>
        <text x="${tableColumns.delayX}" y="${y}" fill="#cbd5e1" font-size="19">${esc(delay)}</text>
        ${renderMetricChips({
          metrics: signal?.metrics,
          x: tableColumns.signalX,
          y: y - 20,
          width: tableColumns.signalW,
          fill: "#1e293b",
          text: "#cbd5e1",
        })}
        ${renderMetricChips({
          metrics: o.metrics,
          x: tableColumns.confirmX,
          y: y - 20,
          width: tableColumns.confirmW,
          fill: "#26313c",
          text: "#f8fafc",
        })}
      </g>`;
  });

  return `
  <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${esc(SVG_FONT_FAMILY)}">
    <rect width="100%" height="100%" fill="#10161c"/>
    <text x="72" y="70" fill="#f8fafc" font-size="42" font-weight="800">${esc(slug)}</text>
    <text x="72" y="112" fill="#8b98a8" font-size="25">${esc(strategyName)}</text>
    <text x="72" y="150" fill="#e2e8f0" font-size="24">PTB ${esc(fmtUsd(ptb))}</text>
    <text x="280" y="150" fill="#e2e8f0" font-size="24">结束 ${esc(fmtUsd(closePrice))}</text>
    <text x="500" y="150" fill="${finalDirection === null ? "#94a3b8" : finalDirection === "DOWN" ? "#ef4444" : "#22c55e"}" font-size="24" font-weight="800">Gap ${finalGap == null ? "-" : `${finalGap >= 0 ? "+" : ""}${finalGap.toFixed(2)}`} ${finalDirection ?? ""}</text>
    <text x="720" y="150" fill="${pnl == null ? "#94a3b8" : pnl >= 0 ? "#22c55e" : "#ef4444"}" font-size="24" font-weight="800">PnL ${pnl == null ? "-" : `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`}</text>
    <rect x="${chart.x}" y="${chart.y}" width="${chart.w}" height="${chart.h}" rx="8" fill="#121a21" stroke="#26313c"/>
    ${yTicks}
    ${ptbY != null ? `<line x1="${chart.x}" y1="${ptbY}" x2="${chart.x + chart.w}" y2="${ptbY}" stroke="#f8fafc" stroke-width="2" stroke-dasharray="12 10" opacity="0.85"/>` : ""}
    <path d="${linePath}" fill="none" stroke="#f59e0b" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/>
    ${orderMarks}
    ${xTicks.join("")}
    <text x="${table.x + 8}" y="${table.y}" fill="#f8fafc" font-size="25" font-weight="800">交易指标快照</text>
    <text x="${tableColumns.tradeX}" y="${table.y + 34}" fill="#64748b" font-size="16">交易</text>
    <text x="${tableColumns.delayX}" y="${table.y + 34}" fill="#64748b" font-size="16">延迟</text>
    <text x="${tableColumns.signalX}" y="${table.y + 34}" fill="#64748b" font-size="16">策略识别指标</text>
    <text x="${tableColumns.confirmX}" y="${table.y + 34}" fill="#64748b" font-size="16">订单确认指标</text>
    ${rows.join("")}
    <text x="88" y="964" fill="#64748b" font-size="18">B/S 为订单确认时机；UP 使用绿色，DOWN 使用红色。</text>
  </svg>`;
}

export function renderTradeWindowImageFromLog(
  text: string,
  opts: TradeWindowImageOptions,
): string | null {
  const svg = buildTradeWindowSvgFromLog(text, opts);
  if (!svg) return null;

  const outputRoot = opts.outputRoot ?? "imgs";
  const dir = join(outputRoot, safeName(opts.strategyName || "unknown"));
  mkdirSync(dir, { recursive: true });
  const outPath = join(dir, `${safeName(opts.slug)}.png`);
  const fontFiles = cjkFontFiles();
  const png = new Resvg(svg, {
    fitTo: { mode: "width", value: 1600 },
    font: {
      loadSystemFonts: true,
      fontFiles,
      defaultFontFamily: "Noto Sans CJK SC",
      sansSerifFamily: "Noto Sans CJK SC",
    },
  })
    .render()
    .asPng();
  writeFileSync(outPath, png);
  return outPath;
}

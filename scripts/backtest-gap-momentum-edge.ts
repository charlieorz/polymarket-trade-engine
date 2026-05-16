import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { __gapMomentumEdgeTestHooks } from "../engine/strategy/gap-momentum-edge.ts";

type Side = "UP" | "DOWN";
type Profile = "conservative" | "neutral" | "aggressive";
type Level = [number, number];
type BookSide = { bids: Level[]; asks: Level[] } | null;
type BookSnapshot = { up: BookSide; down: BookSide };
type GmeConfig = ReturnType<
  typeof __gapMomentumEdgeTestHooks.readGapMomentumEdgeConfig
>;

type Quality = {
  ask: number;
  bid: number | null;
  askLiquidity: number;
  bidLiquidity: number;
  spread: number | null;
};

type ReplaySample = {
  ts: number;
  remaining: number;
  elapsed: number;
  price: number;
  priceToBeat: number;
  gap: number;
  upQuality: Quality | null;
  downQuality: Quality | null;
};

type ReplayMarket = {
  file: string;
  slug: string;
  slotEndMs: number;
  samples: ReplaySample[];
  resolution: {
    direction: Side;
    openPrice: number;
    closePrice: number;
    source: "explicit" | "inferred";
  } | null;
};

type ReplayTrade = {
  market: string;
  side: Side;
  entryTs: number;
  exitTs: number;
  entryPrice: number;
  exitPrice: number | null;
  shares: number;
  pnl: number;
  reason: string;
};

type Result = {
  markets: number;
  explicitResolutionMarkets: number;
  inferredResolutionMarkets: number;
  tradedMarkets: number;
  trades: number;
  pnl: number;
  winRate: number;
  avgPnlPerMarket: number;
  avgPnlPerTrade: number;
  maxDrawdown: number;
  settlementHeld: number;
  expiredEntries: number;
  expiredSells: number;
  score: number;
  tradesDetail?: ReplayTrade[];
};

type Variant = {
  name: string;
  profile: Profile;
  env: Record<string, string>;
  config: GmeConfig;
  validation?: Result;
  test?: Result;
};

type Position = {
  side: Side;
  tokenId: string;
  entryPrice: number;
  entryMs: number;
  entryGap: number;
  shares: number;
  takeProfitPrice: number;
  peakSideGap: number;
  takeProfitOrderPlaced: boolean;
  finalDirectTakeProfitPlaced: boolean;
};

type PendingEntry = {
  side: Side;
  tokenId: string;
  price: number;
  shares: number;
  expireAtMs: number;
  gap: number;
  takeProfitPrice: number;
};

type PendingSell = {
  price: number;
  orderType: "GTC" | "FOK";
  expireAtMs: number;
  reason: string;
};

const LOG_DIR = process.env.GME_BACKTEST_LOG_DIR ?? "logs";
const SPLIT_SEED =
  process.env.GME_BACKTEST_SPLIT_SEED ?? "gap-momentum-edge-2026-05-16";

function round(value: number, digits = 4): number {
  return Number(value.toFixed(digits));
}

function seedHash(seed: string): number {
  let hash = 2166136261;
  for (const char of seed) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed: string): () => number {
  let state = seedHash(seed) || 1;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: T[], seed: string): T[] {
  const random = seededRandom(seed);
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

function bestQuality(book: BookSide): Quality | null {
  if (!book || book.asks.length === 0) return null;
  const ask = book.asks[0]!;
  const bid = book.bids[0] ?? null;
  const askPrice = ask[0];
  const bidPrice = bid?.[0] ?? null;
  const askLiquidity = askPrice * ask[1];
  const bidLiquidity = bid ? bid[0] * bid[1] : 0;
  return {
    ask: askPrice,
    bid: bidPrice,
    askLiquidity,
    bidLiquidity,
    spread: bidPrice === null ? null : round(askPrice - bidPrice, 4),
  };
}

function qualityFromSnapshot(snapshot: BookSnapshot | null, side: Side): Quality | null {
  if (!snapshot) return null;
  return bestQuality(side === "UP" ? snapshot.up : snapshot.down);
}

async function loadMarket(path: string): Promise<ReplayMarket | null> {
  const text = await Bun.file(path).text();
  let slug =
    path
      .split("/")
      .at(-1)
      ?.replace(/^early-bird-/, "")
      .replace(/\.log$/, "") ?? path;
  let slotEndMs = 0;
  let latestBook: BookSnapshot | null = null;
  let latestRemaining: number | null = null;
  let resolution: ReplayMarket["resolution"] = null;
  let reachedSlotEnd = false;
  const samples: ReplaySample[] = [];

  for (const rawLine of text.split(/\n+/)) {
    const line = rawLine.trim();
    if (!line || !line.startsWith("{")) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type === "slot" && entry.action === "start") {
      slug = entry.slug ?? slug;
      slotEndMs = Number(entry.endTime ?? 0);
      continue;
    }
    if (entry.type === "slot" && entry.action === "end") {
      reachedSlotEnd = true;
      continue;
    }
    if (entry.type === "orderbook_snapshot") {
      latestBook = { up: entry.up ?? null, down: entry.down ?? null };
      continue;
    }
    if (entry.type === "remaining") {
      latestRemaining = Number(entry.seconds);
      continue;
    }
    if (entry.type === "resolution") {
      if (entry.direction === "UP" || entry.direction === "DOWN") {
        resolution = {
          direction: entry.direction,
          openPrice: Number(entry.openPrice),
          closePrice: Number(entry.closePrice),
          source: "explicit",
        };
      }
      continue;
    }
    if (entry.type !== "market_price") continue;
    if (latestRemaining === null || !latestBook) continue;
    if (latestRemaining > 300 || latestRemaining < 0) continue;

    const gap = Number(entry.gap);
    const priceToBeat = Number(entry.priceToBeat ?? entry.openPrice);
    const price = priceToBeat + gap;
    if (
      !Number.isFinite(gap) ||
      !Number.isFinite(priceToBeat) ||
      !Number.isFinite(price)
    ) {
      continue;
    }

    samples.push({
      ts: Number(entry.ts),
      remaining: latestRemaining,
      elapsed: 300 - latestRemaining,
      price,
      priceToBeat,
      gap,
      upQuality: qualityFromSnapshot(latestBook, "UP"),
      downQuality: qualityFromSnapshot(latestBook, "DOWN"),
    });
  }

  if (samples.length < 20) return null;
  if (resolution === null) {
    const last = samples.at(-1)!;
    if (!reachedSlotEnd && last.remaining > 5) return null;
    resolution = {
      direction: last.gap >= 0 ? "UP" : "DOWN",
      openPrice: last.priceToBeat,
      closePrice: last.price,
      source: "inferred",
    };
  }
  if (slotEndMs === 0) {
    const slugEnd = Number(slug.split("-").at(-1));
    slotEndMs = Number.isFinite(slugEnd) ? slugEnd * 1000 : samples.at(-1)!.ts;
  }
  return { file: path, slug, slotEndMs, samples, resolution };
}

function mockCtx(sample: ReplaySample) {
  const get = (side: Side) => (side === "UP" ? sample.upQuality : sample.downQuality);
  return {
    clobTokenIds: ["UP", "DOWN"],
    orderBook: {
      bestAskInfo(side: Side) {
        const q = get(side);
        return q ? { price: q.ask, liquidity: q.askLiquidity } : null;
      },
      bestBidInfo(side: Side) {
        const q = get(side);
        return q && q.bid !== null
          ? { price: q.bid, liquidity: q.bidLiquidity }
          : null;
      },
      getTickSize() {
        return "0.01";
      },
    },
  } as any;
}

function qualityFor(sample: ReplaySample, side: Side): Quality | null {
  return side === "UP" ? sample.upQuality : sample.downQuality;
}

function sideGap(side: Side, gap: number): number {
  return side === "UP" ? gap : -gap;
}

function fillPendingEntry(
  pending: PendingEntry,
  sample: ReplaySample,
): boolean {
  const quality = qualityFor(sample, pending.side);
  if (!quality) return false;
  return quality.ask <= pending.price;
}

function fillPendingSell(pos: Position, pending: PendingSell, sample: ReplaySample): boolean {
  const quality = qualityFor(sample, pos.side);
  if (!quality || quality.bid === null) return false;
  if (pending.orderType === "FOK") return quality.bid >= pending.price;
  return quality.bid >= pending.price;
}

function settlePnl(pos: Position, direction: Side): number {
  return (direction === pos.side ? 1 : 0) * pos.shares - pos.entryPrice * pos.shares;
}

function simulateMarket(
  market: ReplayMarket,
  config: GmeConfig,
): {
  pnl: number;
  trades: ReplayTrade[];
  settlementHeld: number;
  expiredEntries: number;
  expiredSells: number;
} {
  const stats = __gapMomentumEdgeTestHooks.createEdgeStats();
  const state = {
    entries: 0,
    pendingEntry: false,
    position: null as Position | null,
    closing: false,
    released: false,
    settlementHoldLogged: false,
  };
  let pendingEntry: PendingEntry | null = null;
  let pendingSell: PendingSell | null = null;
  let realizedCash = 0;
  let settlementHeld = 0;
  let expiredEntries = 0;
  let expiredSells = 0;
  const trades: ReplayTrade[] = [];

  for (const sample of market.samples) {
    __gapMomentumEdgeTestHooks.updateStats(
      stats,
      sample.price,
      sample.gap,
      sample.ts,
      config,
    );

    if (pendingEntry) {
      if (fillPendingEntry(pendingEntry, sample)) {
        realizedCash -= pendingEntry.price * pendingEntry.shares;
        state.entries++;
        state.pendingEntry = false;
        state.position = {
          side: pendingEntry.side,
          tokenId: pendingEntry.tokenId,
          entryPrice: pendingEntry.price,
          entryMs: sample.ts,
          entryGap: pendingEntry.gap,
          shares: pendingEntry.shares,
          takeProfitPrice: pendingEntry.takeProfitPrice,
          peakSideGap: Math.max(0, sideGap(pendingEntry.side, sample.gap)),
          takeProfitOrderPlaced: false,
          finalDirectTakeProfitPlaced: false,
        };
        pendingEntry = null;
      } else if (sample.ts >= pendingEntry.expireAtMs) {
        state.pendingEntry = false;
        pendingEntry = null;
        expiredEntries++;
      }
    }

    if (state.position) {
      state.position.peakSideGap = Math.max(
        state.position.peakSideGap,
        sideGap(state.position.side, sample.gap),
      );
    }

    if (state.position && pendingSell) {
      if (fillPendingSell(state.position, pendingSell, sample)) {
        const pos = state.position;
        realizedCash += pendingSell.price * pos.shares;
        const pnl = (pendingSell.price - pos.entryPrice) * pos.shares;
        trades.push({
          market: market.slug,
          side: pos.side,
          entryTs: pos.entryMs,
          exitTs: sample.ts,
          entryPrice: pos.entryPrice,
          exitPrice: pendingSell.price,
          shares: pos.shares,
          pnl: round(pnl),
          reason: pendingSell.reason,
        });
        state.position = null;
        state.closing = false;
        pendingSell = null;
      } else if (sample.ts >= pendingSell.expireAtMs) {
        state.closing = false;
        pendingSell = null;
        expiredSells++;
        if (state.position) {
          state.position.takeProfitOrderPlaced = false;
          state.position.finalDirectTakeProfitPlaced = false;
        }
      }
    }

    if (!pendingEntry && !state.position) {
      const entry = __gapMomentumEdgeTestHooks.chooseEntry({
        ctx: mockCtx(sample),
        gap: sample.gap,
        remaining: sample.remaining,
        elapsed: sample.elapsed,
        stats,
        state,
        config,
      });
      if (entry) {
        state.pendingEntry = true;
        pendingEntry = {
          side: entry.side,
          tokenId: entry.tokenId,
          price: entry.price,
          shares: entry.shares,
          expireAtMs: Math.min(
            market.slotEndMs - config.finalWindowSeconds * 1000,
            sample.ts + config.entryOrderTtlMs,
          ),
          gap: sample.gap,
          takeProfitPrice: entry.takeProfitPrice,
        };
      }
    }

    if (!state.position || state.closing || pendingSell) continue;
    const quality = qualityFor(sample, state.position.side);
    const exit = __gapMomentumEdgeTestHooks.chooseExit({
      ctx: mockCtx(sample),
      pos: state.position,
      gap: sample.gap,
      ask: quality?.ask ?? null,
      bid: quality?.bid ?? null,
      bidLiquidity: quality?.bidLiquidity ?? 0,
      remaining: sample.remaining,
      stats,
      config,
    });
    if (!exit) continue;
    if (exit.reason === "planned take-profit") {
      state.position.takeProfitOrderPlaced = true;
    }
    if (exit.reason === "final direct take-profit") {
      state.position.finalDirectTakeProfitPlaced = true;
    }
    if (exit.orderType === "FOK") {
      const pos = state.position;
      realizedCash += exit.price * pos.shares;
      const pnl = (exit.price - pos.entryPrice) * pos.shares;
      trades.push({
        market: market.slug,
        side: pos.side,
        entryTs: pos.entryMs,
        exitTs: sample.ts,
        entryPrice: pos.entryPrice,
        exitPrice: exit.price,
        shares: pos.shares,
        pnl: round(pnl),
        reason: exit.reason,
      });
      state.position = null;
      continue;
    }
    state.closing = true;
    pendingSell = {
      price: exit.price,
      orderType: exit.orderType,
      expireAtMs: Math.min(
        market.slotEndMs - config.holdOnlySeconds * 1000,
        sample.ts + exit.ttlMs,
      ),
      reason: exit.reason,
    };
  }

  if (state.position) {
    const pos = state.position;
    const pnl = settlePnl(pos, market.resolution!.direction);
    realizedCash += market.resolution!.direction === pos.side ? pos.shares : 0;
    settlementHeld++;
    trades.push({
      market: market.slug,
      side: pos.side,
      entryTs: pos.entryMs,
      exitTs: market.slotEndMs,
      entryPrice: pos.entryPrice,
      exitPrice: null,
      shares: pos.shares,
      pnl: round(pnl),
      reason: "settlement",
    });
  }

  return {
    pnl: round(realizedCash),
    trades,
    settlementHeld,
    expiredEntries,
    expiredSells,
  };
}

function summarize(
  markets: ReplayMarket[],
  config: GmeConfig,
  options: { includeTrades?: boolean } = {},
): Result {
  let pnl = 0;
  let peak = 0;
  let equity = 0;
  let maxDrawdown = 0;
  let settlementHeld = 0;
  let expiredEntries = 0;
  let expiredSells = 0;
  let tradedMarkets = 0;
  let explicitResolutionMarkets = 0;
  let inferredResolutionMarkets = 0;
  const trades: ReplayTrade[] = [];

  for (const market of markets) {
    if (market.resolution?.source === "explicit") explicitResolutionMarkets++;
    if (market.resolution?.source === "inferred") inferredResolutionMarkets++;
    const result = simulateMarket(market, config);
    pnl += result.pnl;
    equity += result.pnl;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    settlementHeld += result.settlementHeld;
    expiredEntries += result.expiredEntries;
    expiredSells += result.expiredSells;
    if (result.trades.length > 0) tradedMarkets++;
    trades.push(...result.trades);
  }

  const wins = trades.filter((trade) => trade.pnl > 0).length;
  const winRate = trades.length > 0 ? wins / trades.length : 0;
  const avgPnlPerMarket = markets.length > 0 ? pnl / markets.length : 0;
  const avgPnlPerTrade = trades.length > 0 ? pnl / trades.length : 0;
  const coverage = markets.length > 0 ? tradedMarkets / markets.length : 0;
  const underTradePenalty =
    tradedMarkets < Math.max(3, Math.floor(markets.length * 0.03))
      ? (Math.max(3, Math.floor(markets.length * 0.03)) - tradedMarkets) * 0.4
      : 0;
  const score =
    pnl -
    maxDrawdown * 0.35 +
    avgPnlPerTrade * 4 +
    winRate +
    Math.min(1, coverage / 0.08) -
    underTradePenalty;

  return {
    markets: markets.length,
    explicitResolutionMarkets,
    inferredResolutionMarkets,
    tradedMarkets,
    trades: trades.length,
    pnl: round(pnl),
    winRate: round(winRate),
    avgPnlPerMarket: round(avgPnlPerMarket),
    avgPnlPerTrade: round(avgPnlPerTrade),
    maxDrawdown: round(maxDrawdown),
    settlementHeld,
    expiredEntries,
    expiredSells,
    score: round(score),
    tradesDetail: options.includeTrades ? trades : undefined,
  };
}

function configFromEnv(env: Record<string, string>): GmeConfig {
  return __gapMomentumEdgeTestHooks.readGapMomentumEdgeConfig(env);
}

function buildVariants(): Variant[] {
  const specs: Array<{ name: string; profile: Profile; env: Record<string, string> }> = [
    {
      name: "conservative_c1",
      profile: "conservative",
      env: {
        GME_MIN_NET_EDGE: "0.05",
        GME_MIN_ABS_GAP: "14",
        GME_MIN_GAP_ATR: "3",
        GME_EARLY_MIN_GAP_ATR: "4",
        GME_LATE_MIN_GAP_ATR: "2",
        GME_MIN_PEAK_RETAIN_RATIO: "0.85",
        GME_MIN_TREND_CONSISTENCY: "0.7",
        GME_MIN_SIDE_VELOCITY_EMA: "0.12",
        GME_MAX_ENTRY_PRICE: "0.56",
      },
    },
    {
      name: "conservative_c2",
      profile: "conservative",
      env: {
        GME_MIN_NET_EDGE: "0.04",
        GME_MIN_ABS_GAP: "12",
        GME_MIN_GAP_ATR: "2.8",
        GME_EARLY_MIN_GAP_ATR: "3.6",
        GME_LATE_MIN_GAP_ATR: "1.8",
        GME_MIN_PEAK_RETAIN_RATIO: "0.82",
        GME_MIN_TREND_CONSISTENCY: "0.68",
        GME_MIN_SIDE_VELOCITY_EMA: "0.1",
        GME_MAX_ENTRY_PRICE: "0.58",
      },
    },
    {
      name: "conservative_c3",
      profile: "conservative",
      env: {
        GME_MIN_NET_EDGE: "0.035",
        GME_MIN_ABS_GAP: "10",
        GME_MIN_GAP_ATR: "2.6",
        GME_EARLY_MIN_GAP_ATR: "3.4",
        GME_LATE_MIN_GAP_ATR: "1.7",
        GME_MIN_PEAK_RETAIN_RATIO: "0.8",
        GME_MIN_TREND_CONSISTENCY: "0.65",
        GME_MIN_SIDE_VELOCITY_EMA: "0.08",
        GME_MAX_ENTRY_PRICE: "0.59",
      },
    },
    {
      name: "neutral_n1",
      profile: "neutral",
      env: {
        GME_MIN_NET_EDGE: "0.03",
        GME_MIN_ABS_GAP: "8",
        GME_MIN_GAP_ATR: "2",
        GME_EARLY_MIN_GAP_ATR: "3",
        GME_LATE_MIN_GAP_ATR: "1.5",
        GME_MIN_PEAK_RETAIN_RATIO: "0.75",
        GME_MIN_TREND_CONSISTENCY: "0.6",
        GME_MIN_SIDE_VELOCITY_EMA: "0.05",
        GME_MAX_ENTRY_PRICE: "0.6",
      },
    },
    {
      name: "neutral_n2",
      profile: "neutral",
      env: {
        GME_MIN_NET_EDGE: "0.025",
        GME_MIN_ABS_GAP: "8",
        GME_MIN_GAP_ATR: "1.8",
        GME_EARLY_MIN_GAP_ATR: "2.6",
        GME_LATE_MIN_GAP_ATR: "1.3",
        GME_MIN_PEAK_RETAIN_RATIO: "0.72",
        GME_MIN_TREND_CONSISTENCY: "0.58",
        GME_MIN_SIDE_VELOCITY_EMA: "0.03",
        GME_MAX_ENTRY_PRICE: "0.6",
      },
    },
    {
      name: "neutral_n3",
      profile: "neutral",
      env: {
        GME_MIN_NET_EDGE: "0.02",
        GME_MIN_ABS_GAP: "7",
        GME_MIN_GAP_ATR: "1.6",
        GME_EARLY_MIN_GAP_ATR: "2.4",
        GME_LATE_MIN_GAP_ATR: "1.2",
        GME_MIN_PEAK_RETAIN_RATIO: "0.7",
        GME_MIN_TREND_CONSISTENCY: "0.55",
        GME_MIN_SIDE_VELOCITY_EMA: "0.02",
        GME_MAX_ENTRY_PRICE: "0.6",
      },
    },
    {
      name: "aggressive_a1",
      profile: "aggressive",
      env: {
        GME_MIN_NET_EDGE: "0.015",
        GME_MIN_ABS_GAP: "6",
        GME_MIN_GAP_ATR: "1.4",
        GME_EARLY_MIN_GAP_ATR: "2.1",
        GME_LATE_MIN_GAP_ATR: "1",
        GME_MIN_PEAK_RETAIN_RATIO: "0.68",
        GME_MIN_TREND_CONSISTENCY: "0.52",
        GME_MIN_SIDE_VELOCITY_EMA: "0",
        GME_MAX_ENTRY_PRICE: "0.6",
      },
    },
    {
      name: "aggressive_a2",
      profile: "aggressive",
      env: {
        GME_MIN_NET_EDGE: "0.01",
        GME_MIN_ABS_GAP: "5",
        GME_MIN_GAP_ATR: "1.2",
        GME_EARLY_MIN_GAP_ATR: "1.8",
        GME_LATE_MIN_GAP_ATR: "0.9",
        GME_MIN_PEAK_RETAIN_RATIO: "0.65",
        GME_MIN_TREND_CONSISTENCY: "0.5",
        GME_MIN_SIDE_VELOCITY_EMA: "-0.02",
        GME_MAX_ENTRY_PRICE: "0.6",
      },
    },
    {
      name: "aggressive_a3",
      profile: "aggressive",
      env: {
        GME_MIN_NET_EDGE: "0.005",
        GME_MIN_ABS_GAP: "4",
        GME_MIN_GAP_ATR: "1",
        GME_EARLY_MIN_GAP_ATR: "1.5",
        GME_LATE_MIN_GAP_ATR: "0.8",
        GME_MIN_PEAK_RETAIN_RATIO: "0.6",
        GME_MIN_TREND_CONSISTENCY: "0.48",
        GME_MIN_SIDE_VELOCITY_EMA: "-0.05",
        GME_MAX_ENTRY_PRICE: "0.6",
      },
    },
  ];

  return specs.map((spec) => ({
    ...spec,
    config: configFromEnv(spec.env),
  }));
}

function splitMarkets(markets: ReplayMarket[]) {
  const ordered = shuffled(markets, SPLIT_SEED);
  const trainCount = Math.floor(ordered.length * 0.6);
  const validationCount = Math.floor(ordered.length * 0.2);
  const train = ordered.slice(0, trainCount);
  const validation = ordered.slice(trainCount, trainCount + validationCount);
  const test = ordered.slice(trainCount + validationCount);
  return { train, validation, test };
}

function selectValidationRepresentatives(variants: Variant[]): Variant[] {
  const sorted = [...variants].sort((a, b) => {
    const pnlDiff = (b.validation?.pnl ?? 0) - (a.validation?.pnl ?? 0);
    if (pnlDiff !== 0) return pnlDiff;
    return (a.validation?.maxDrawdown ?? 0) - (b.validation?.maxDrawdown ?? 0);
  });
  const best = sorted[0]!;
  const middle = sorted[Math.floor(sorted.length / 2)]!;
  const worst = sorted.at(-1)!;
  return [best, middle, worst];
}

function pickTestWinner(variants: Variant[]): Variant {
  return [...variants].sort((a, b) => {
    const aTest = a.test!;
    const bTest = b.test!;
    if (bTest.pnl !== aTest.pnl) return bTest.pnl - aTest.pnl;
    if (aTest.maxDrawdown !== bTest.maxDrawdown) {
      return aTest.maxDrawdown - bTest.maxDrawdown;
    }
    return bTest.trades - aTest.trades;
  })[0]!;
}

function compactResult(result: Result) {
  return {
    markets: result.markets,
    tradedMarkets: result.tradedMarkets,
    trades: result.trades,
    pnl: result.pnl,
    maxDrawdown: result.maxDrawdown,
    winRate: result.winRate,
    avgPnlPerTrade: result.avgPnlPerTrade,
    settlementHeld: result.settlementHeld,
    expiredEntries: result.expiredEntries,
    expiredSells: result.expiredSells,
    score: result.score,
  };
}

async function loadMarkets(): Promise<ReplayMarket[]> {
  const files = (await readdir(LOG_DIR))
    .filter((file) => /^early-bird-btc-updown-5m-\d+\.log$/.test(file))
    .sort();
  const loaded = await Promise.all(files.map((file) => loadMarket(join(LOG_DIR, file))));
  return loaded.filter((market): market is ReplayMarket => !!market && !!market.resolution);
}

async function main() {
  const markets = await loadMarkets();
  const { train, validation, test } = splitMarkets(markets);
  const variants = buildVariants();

  for (const variant of variants) {
    variant.validation = summarize(validation, variant.config);
  }

  const selected = selectValidationRepresentatives(variants);
  for (const variant of selected) {
    variant.test = summarize(test, variant.config, { includeTrades: true });
  }
  const winner = pickTestWinner(selected);

  const validationTable = variants
    .map((variant) => ({
      name: variant.name,
      profile: variant.profile,
      ...compactResult(variant.validation!),
    }))
    .sort((a, b) => b.pnl - a.pnl);

  const testTable = selected.map((variant) => ({
    name: variant.name,
    profile: variant.profile,
    ...compactResult(variant.test!),
  }));

  console.log(
    JSON.stringify(
      {
        logDir: LOG_DIR,
        splitSeed: SPLIT_SEED,
        scannedMarkets: markets.length,
        split: {
          train: train.length,
          validation: validation.length,
          test: test.length,
        },
        resolution: {
          explicit: markets.filter((market) => market.resolution?.source === "explicit").length,
          inferred: markets.filter((market) => market.resolution?.source === "inferred").length,
        },
        validationTable,
        selectedForTest: selected.map((variant) => ({
          name: variant.name,
          profile: variant.profile,
          validation: compactResult(variant.validation!),
        })),
        testTable,
        winner: {
          name: winner.name,
          profile: winner.profile,
          env: winner.env,
          validation: compactResult(winner.validation!),
          test: compactResult(winner.test!),
        },
      },
      null,
      2,
    ),
  );
}

await main();

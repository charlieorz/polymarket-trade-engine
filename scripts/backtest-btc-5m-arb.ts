import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { __btc5mArbTestHooks } from "../engine/strategy/btc-5m-arb.ts";

type Side = "UP" | "DOWN";
type Profile = "conservative" | "aggressive";
type Level = [number, number];
type BookSide = { bids: Level[]; asks: Level[] } | null;
type BookSnapshot = { up: BookSide; down: BookSide };
type B5aConfig = ReturnType<typeof __btc5mArbTestHooks.readBtc5mArbConfig>;
type B5aState = Parameters<typeof __btc5mArbTestHooks.chooseEntry>[0]["state"];

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
  kind: "advantage" | "reversal";
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
  advantageTrades: number;
  reversalTrades: number;
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
  config: B5aConfig;
  validation?: Result;
  test?: Result;
};

type Position = {
  kind: "advantage" | "reversal";
  side: Side;
  tokenId: string;
  entryPrice: number;
  entryMs: number;
  entryGap: number;
  initialShares: number;
  shares: number;
  takeProfitRatio: number;
  takeProfitPrice: number;
  costCovered: boolean;
  halfStopped: boolean;
  holdRestToSettlement: boolean;
};

type PendingEntry = {
  kind: "advantage" | "reversal";
  side: Side;
  tokenId: string;
  price: number;
  shares: number;
  expireAtMs: number;
  gap: number;
  takeProfitRatio: number;
  takeProfitPrice: number;
};

type PendingSell = {
  price: number;
  shares: number;
  orderType: "GTC" | "FOK" | "FAK";
  expireAtMs: number;
  reason: string;
  holdRestAfterFill: boolean;
};

const LOG_DIR = process.env.B5A_BACKTEST_LOG_DIR ?? "logs";
const SPLIT_SEED = process.env.B5A_BACKTEST_SPLIT_SEED ?? "btc-5m-arb-2026-05-17";
const EPSILON = 1e-9;

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

function fillPendingEntry(pending: PendingEntry, sample: ReplaySample): boolean {
  const quality = qualityFor(sample, pending.side);
  if (!quality) return false;
  return quality.ask <= pending.price;
}

function fillPendingSell(pos: Position, pending: PendingSell, sample: ReplaySample): boolean {
  const quality = qualityFor(sample, pos.side);
  if (!quality || quality.bid === null) return false;
  return quality.bid >= pending.price;
}

function settlePnl(pos: Position, direction: Side): number {
  return (direction === pos.side ? 1 : 0) * pos.shares - pos.entryPrice * pos.shares;
}

function createState(): B5aState {
  return {
    entryOrderSubmitted: false,
    pendingEntry: false,
    position: null,
    closing: false,
    released: false,
    settlementHoldLogged: false,
  };
}

function commitSell(
  market: ReplayMarket,
  sample: ReplaySample,
  pos: Position,
  pending: PendingSell,
  trades: ReplayTrade[],
): { remaining: number; pnl: number } {
  const shares = Math.min(pos.shares, pending.shares);
  const pnl = (pending.price - pos.entryPrice) * shares;
  trades.push({
    market: market.slug,
    side: pos.side,
    kind: pos.kind,
    entryTs: pos.entryMs,
    exitTs: sample.ts,
    entryPrice: pos.entryPrice,
    exitPrice: pending.price,
    shares,
    pnl: round(pnl),
    reason: pending.reason,
  });
  return { remaining: round(pos.shares - shares, 4), pnl };
}

function simulateMarket(
  market: ReplayMarket,
  config: B5aConfig,
): {
  pnl: number;
  trades: ReplayTrade[];
  settlementHeld: number;
  expiredEntries: number;
  expiredSells: number;
} {
  const stats = __btc5mArbTestHooks.createEdgeStats();
  const state = createState();
  let pendingEntry: PendingEntry | null = null;
  let pendingSell: PendingSell | null = null;
  let realizedCash = 0;
  let settlementHeld = 0;
  let expiredEntries = 0;
  let expiredSells = 0;
  const trades: ReplayTrade[] = [];

  for (const sample of market.samples) {
    __btc5mArbTestHooks.updateStats(stats, sample.price, sample.gap, sample.ts, config);

    if (pendingEntry) {
      if (fillPendingEntry(pendingEntry, sample)) {
        realizedCash -= pendingEntry.price * pendingEntry.shares;
        state.pendingEntry = false;
        state.position = {
          kind: pendingEntry.kind,
          side: pendingEntry.side,
          tokenId: pendingEntry.tokenId,
          entryPrice: pendingEntry.price,
          entryMs: sample.ts,
          entryGap: pendingEntry.gap,
          initialShares: pendingEntry.shares,
          shares: pendingEntry.shares,
          takeProfitRatio: pendingEntry.takeProfitRatio,
          takeProfitPrice: pendingEntry.takeProfitPrice,
          costCovered: false,
          halfStopped: false,
          holdRestToSettlement: false,
        };
        pendingEntry = null;
      } else if (sample.ts >= pendingEntry.expireAtMs) {
        state.pendingEntry = false;
        pendingEntry = null;
        expiredEntries++;
      }
    }

    if (state.position && pendingSell) {
      if (fillPendingSell(state.position, pendingSell, sample)) {
        const pos = state.position;
        const fill = commitSell(market, sample, pos, pendingSell, trades);
        realizedCash += pendingSell.price * Math.min(pos.shares, pendingSell.shares);
        pos.shares = fill.remaining;
        if (pendingSell.reason === "managed cost-cover take-profit") pos.costCovered = true;
        if (pendingSell.reason === "managed half stop-loss") pos.halfStopped = true;
        if (pendingSell.holdRestAfterFill) pos.holdRestToSettlement = true;
        state.closing = false;
        pendingSell = null;
        if (pos.shares <= EPSILON) state.position = null;
      } else if (sample.ts >= pendingSell.expireAtMs) {
        state.closing = false;
        pendingSell = null;
        expiredSells++;
      }
    }

    if (!pendingEntry && !state.position) {
      const entry = __btc5mArbTestHooks.chooseEntry({
        ctx: mockCtx(sample),
        gap: sample.gap,
        elapsed: sample.elapsed,
        stats,
        state,
        config,
      });
      if (entry) {
        state.entryOrderSubmitted = true;
        state.pendingEntry = true;
        pendingEntry = {
          kind: entry.kind,
          side: entry.side,
          tokenId: entry.tokenId,
          price: entry.price,
          shares: entry.shares,
          expireAtMs: Math.min(
            market.slotEndMs - (300 - config.entryEndElapsedSeconds) * 1000,
            sample.ts + config.entryOrderTtlMs,
          ),
          gap: sample.gap,
          takeProfitRatio: entry.takeProfitRatio,
          takeProfitPrice: entry.takeProfitPrice,
        };
      }
    }

    if (!state.position || state.closing || pendingSell) continue;
    const quality = qualityFor(sample, state.position.side);
    const exit = __btc5mArbTestHooks.chooseExit({
      ctx: mockCtx(sample),
      pos: state.position,
      gap: sample.gap,
      ask: quality?.ask ?? null,
      bid: quality?.bid ?? null,
      bidLiquidity: quality?.bidLiquidity ?? 0,
      elapsed: sample.elapsed,
      config,
    });
    if (!exit) continue;

    const sell: PendingSell = {
      price: exit.price,
      shares: exit.shares,
      orderType: exit.orderType,
      expireAtMs: Math.min(
        market.slotEndMs - (300 - config.holdOnlyStartElapsedSeconds) * 1000,
        sample.ts + exit.ttlMs,
      ),
      reason: exit.reason,
      holdRestAfterFill: exit.holdRestAfterFill,
    };

    if (sell.orderType === "FOK" || sell.orderType === "FAK") {
      if (fillPendingSell(state.position, sell, sample)) {
        const pos = state.position;
        const fill = commitSell(market, sample, pos, sell, trades);
        realizedCash += sell.price * Math.min(pos.shares, sell.shares);
        pos.shares = fill.remaining;
        if (sell.reason === "managed cost-cover take-profit") pos.costCovered = true;
        if (sell.reason === "managed half stop-loss") pos.halfStopped = true;
        if (sell.holdRestAfterFill) pos.holdRestToSettlement = true;
        if (pos.shares <= EPSILON) state.position = null;
      }
      continue;
    }

    state.closing = true;
    pendingSell = sell;
  }

  if (state.position) {
    const pos = state.position;
    const pnl = settlePnl(pos, market.resolution!.direction);
    realizedCash += market.resolution!.direction === pos.side ? pos.shares : 0;
    settlementHeld++;
    trades.push({
      market: market.slug,
      side: pos.side,
      kind: pos.kind,
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
  config: B5aConfig,
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
    advantageTrades: trades.filter((trade) => trade.kind === "advantage").length,
    reversalTrades: trades.filter((trade) => trade.kind === "reversal").length,
    settlementHeld,
    expiredEntries,
    expiredSells,
    score: round(score),
    tradesDetail: options.includeTrades ? trades : undefined,
  };
}

function configFromEnv(env: Record<string, string>): B5aConfig {
  return __btc5mArbTestHooks.readBtc5mArbConfig(env);
}

function buildVariants(): Variant[] {
  const baseEnv: Record<string, string> = {
    B5A_TICK_INTERVAL_MS: "200",
    B5A_STATS_INTERVAL_MS: "1000",
    B5A_SHARES: "6",
    B5A_ENTRY_START_SECONDS: "67",
    B5A_ENTRY_END_SECONDS: "257",
    B5A_MANAGED_EXIT_START_SECONDS: "267",
    B5A_HOLD_ONLY_START_SECONDS: "297",
    B5A_ENTRY_ORDER_TYPE: "GTC",
    B5A_TAKE_PROFIT_ORDER_TYPE: "GTC",
    B5A_STOP_LOSS_ORDER_TYPE: "FAK",
  };

  const entryProfiles: Array<{
    name: string;
    profile: Profile;
    env: Record<string, string>;
  }> = [
    {
      name: "conservative_a",
      profile: "conservative",
      env: {
        B5A_MAX_SPREAD: "0.03",
        B5A_MIN_ENTRY_LIQUIDITY_USD: "8",
        B5A_MIN_EXIT_LIQUIDITY_USD: "8",
        B5A_ADV_MIN_ABS_GAP: "6",
        B5A_ADV_MIN_MOMENTUM: "0.35",
        B5A_ADV_MIN_CUMULATIVE_GAP: "80",
        B5A_REV_MAX_ABS_GAP: "3",
        B5A_REV_MIN_MOMENTUM: "0.35",
      },
    },
    {
      name: "conservative_b",
      profile: "conservative",
      env: {
        B5A_MAX_SPREAD: "0.04",
        B5A_MIN_ENTRY_LIQUIDITY_USD: "7",
        B5A_MIN_EXIT_LIQUIDITY_USD: "7",
        B5A_ADV_MIN_ABS_GAP: "5",
        B5A_ADV_MIN_MOMENTUM: "0.28",
        B5A_ADV_MIN_CUMULATIVE_GAP: "55",
        B5A_REV_MAX_ABS_GAP: "4",
        B5A_REV_MIN_MOMENTUM: "0.28",
      },
    },
    {
      name: "aggressive_a",
      profile: "aggressive",
      env: {
        B5A_MAX_SPREAD: "0.05",
        B5A_MIN_ENTRY_LIQUIDITY_USD: "5",
        B5A_MIN_EXIT_LIQUIDITY_USD: "5",
        B5A_ADV_MIN_ABS_GAP: "4",
        B5A_ADV_MIN_MOMENTUM: "0.2",
        B5A_ADV_MIN_CUMULATIVE_GAP: "25",
        B5A_REV_MAX_ABS_GAP: "5",
        B5A_REV_MIN_MOMENTUM: "0.2",
      },
    },
    {
      name: "aggressive_b",
      profile: "aggressive",
      env: {
        B5A_MAX_SPREAD: "0.06",
        B5A_MIN_ENTRY_LIQUIDITY_USD: "4",
        B5A_MIN_EXIT_LIQUIDITY_USD: "4",
        B5A_ADV_MIN_ABS_GAP: "3",
        B5A_ADV_MIN_MOMENTUM: "0.14",
        B5A_ADV_MIN_CUMULATIVE_GAP: "10",
        B5A_REV_MAX_ABS_GAP: "6",
        B5A_REV_MIN_MOMENTUM: "0.14",
      },
    },
  ];

  const exitProfiles = [
    {
      name: "tp12_dyn24_stop52_67",
      env: {
        B5A_MIN_TAKE_PROFIT_RATIO: "0.12",
        B5A_MAX_TAKE_PROFIT_RATIO: "0.24",
        B5A_DYNAMIC_TP_PRICE_WEIGHT: "0.06",
        B5A_DYNAMIC_TP_GAP_WEIGHT: "0.04",
        B5A_DYNAMIC_TP_MOMENTUM_WEIGHT: "0.02",
        B5A_HALF_STOP_LOSS_RATIO: "0.52",
        B5A_FULL_STOP_LOSS_RATIO: "0.67",
      },
    },
    {
      name: "tp12_dyn36_stop52_67",
      env: {
        B5A_MIN_TAKE_PROFIT_RATIO: "0.12",
        B5A_MAX_TAKE_PROFIT_RATIO: "0.36",
        B5A_DYNAMIC_TP_PRICE_WEIGHT: "0.1",
        B5A_DYNAMIC_TP_GAP_WEIGHT: "0.08",
        B5A_DYNAMIC_TP_MOMENTUM_WEIGHT: "0.06",
        B5A_HALF_STOP_LOSS_RATIO: "0.52",
        B5A_FULL_STOP_LOSS_RATIO: "0.67",
      },
    },
    {
      name: "tp16_dyn42_stop55_70",
      env: {
        B5A_MIN_TAKE_PROFIT_RATIO: "0.16",
        B5A_MAX_TAKE_PROFIT_RATIO: "0.42",
        B5A_DYNAMIC_TP_PRICE_WEIGHT: "0.11",
        B5A_DYNAMIC_TP_GAP_WEIGHT: "0.1",
        B5A_DYNAMIC_TP_MOMENTUM_WEIGHT: "0.05",
        B5A_HALF_STOP_LOSS_RATIO: "0.55",
        B5A_FULL_STOP_LOSS_RATIO: "0.7",
      },
    },
    {
      name: "tp20_dyn48_stop58_72",
      env: {
        B5A_MIN_TAKE_PROFIT_RATIO: "0.2",
        B5A_MAX_TAKE_PROFIT_RATIO: "0.48",
        B5A_DYNAMIC_TP_PRICE_WEIGHT: "0.12",
        B5A_DYNAMIC_TP_GAP_WEIGHT: "0.1",
        B5A_DYNAMIC_TP_MOMENTUM_WEIGHT: "0.06",
        B5A_HALF_STOP_LOSS_RATIO: "0.58",
        B5A_FULL_STOP_LOSS_RATIO: "0.72",
      },
    },
  ];

  const specs: Array<{ name: string; profile: Profile; env: Record<string, string> }> = [];
  for (const entryProfile of entryProfiles) {
    for (const exitProfile of exitProfiles) {
      specs.push({
        name: `${entryProfile.name}_${exitProfile.name}`,
        profile: entryProfile.profile,
        env: {
          ...baseEnv,
          ...entryProfile.env,
          ...exitProfile.env,
        },
      });
    }
  }

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

function pickWinnerByPnl(variants: Variant[], split: "validation" | "test"): Variant {
  return [...variants].sort((a, b) => {
    const left = a[split]!;
    const right = b[split]!;
    if (right.pnl !== left.pnl) return right.pnl - left.pnl;
    if (left.maxDrawdown !== right.maxDrawdown) return left.maxDrawdown - right.maxDrawdown;
    return right.trades - left.trades;
  })[0]!;
}

function compactResult(result: Result) {
  return {
    markets: result.markets,
    tradedMarkets: result.tradedMarkets,
    trades: result.trades,
    advantageTrades: result.advantageTrades,
    reversalTrades: result.reversalTrades,
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
  const validationWinner = pickWinnerByPnl(variants, "validation");

  for (const variant of variants) {
    variant.test = summarize(test, variant.config, { includeTrades: true });
  }
  const testWinner = pickWinnerByPnl(variants, "test");

  const validationTable = variants
    .map((variant) => ({
      name: variant.name,
      profile: variant.profile,
      ...compactResult(variant.validation!),
    }))
    .sort((a, b) => b.pnl - a.pnl);

  const testTable = variants
    .map((variant) => ({
      name: variant.name,
      profile: variant.profile,
      env: variant.env,
      ...compactResult(variant.test!),
    }))
    .sort((a, b) => b.pnl - a.pnl);

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
        variantCount: variants.length,
        validationTable,
        testTable,
        validationWinner: {
          name: validationWinner.name,
          profile: validationWinner.profile,
          env: validationWinner.env,
          validation: compactResult(validationWinner.validation!),
          test: compactResult(validationWinner.test!),
        },
        winner: {
          selection: "test_pnl_best_as_requested",
          note:
            "Validation was evaluated before test. The request asks to use the test PnL best profile as default, so this is a final-test winner rather than an unbiased holdout estimate.",
          name: testWinner.name,
          profile: testWinner.profile,
          env: testWinner.env,
          validation: compactResult(testWinner.validation!),
          test: compactResult(testWinner.test!),
        },
      },
      null,
      2,
    ),
  );
}

await main();

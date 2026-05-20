import { mkdir, readdir } from "node:fs/promises";
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
  kind: "advantage";
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
  avgWin: number;
  avgLoss: number;
  grossProfit: number;
  grossLoss: number;
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
  train?: Result;
  validation?: Result;
  test?: Result;
};

type Position = {
  kind: "advantage";
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
  kind: "advantage";
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
const SPLIT_SEED = process.env.B5A_BACKTEST_SPLIT_SEED ?? "btc-5m-arb-2026-05-19-random-exrun2-v1";
const SPLIT_MODE = process.env.B5A_BACKTEST_SPLIT_MODE ?? "random";
const EXCLUDE_RUN_LOG = process.env.B5A_BACKTEST_EXCLUDE_RUN_LOG ?? "logs/early-bird-2026-05-19-09-52-58.log";
const MIN_VALIDATION_TRADED_MARKETS = Math.max(
  1,
  Number(process.env.B5A_BACKTEST_MIN_VALIDATION_TRADED_MARKETS ?? 20),
);
const REPORT_DIR = process.env.B5A_BACKTEST_REPORT_DIR ?? "reports/backtests";
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
      nowMs: sample.ts,
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

  const winningTrades = trades.filter((trade) => trade.pnl > 0);
  const losingTrades = trades.filter((trade) => trade.pnl < 0);
  const wins = winningTrades.length;
  const winRate = trades.length > 0 ? wins / trades.length : 0;
  const avgPnlPerMarket = markets.length > 0 ? pnl / markets.length : 0;
  const avgPnlPerTrade = trades.length > 0 ? pnl / trades.length : 0;
  const grossProfit = winningTrades.reduce((sum, trade) => sum + trade.pnl, 0);
  const grossLoss = losingTrades.reduce((sum, trade) => sum + trade.pnl, 0);
  const avgWin = winningTrades.length > 0 ? grossProfit / winningTrades.length : 0;
  const avgLoss = losingTrades.length > 0 ? grossLoss / losingTrades.length : 0;
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
    avgWin: round(avgWin),
    avgLoss: round(avgLoss),
    grossProfit: round(grossProfit),
    grossLoss: round(grossLoss),
    maxDrawdown: round(maxDrawdown),
    advantageTrades: trades.filter((trade) => trade.kind === "advantage").length,
    reversalTrades: 0,
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
    B5A_ENTRY_END_SECONDS: "217",
    B5A_MANAGED_EXIT_START_SECONDS: "222",
    B5A_HOLD_ONLY_START_SECONDS: "297",
    B5A_ENTRY_ORDER_TYPE: "GTC",
    B5A_TAKE_PROFIT_ORDER_TYPE: "GTC",
    B5A_STOP_LOSS_ORDER_TYPE: "FAK",
    B5A_ENTRY_TAKE_PROFIT_ENABLED: "false",
    B5A_MANAGED_TAKE_PROFIT_ENABLED: "true",
    B5A_STOP_LOSS_ENABLED: "true",
    B5A_SMALL_PROFIT_EXIT_MODE: "full_exit",
    B5A_HALF_STOP_HOLD_REST_TO_SETTLEMENT: "false",
    B5A_ENABLE_ADVANTAGE: "true",
    B5A_ENABLE_REVERSAL: "true",
    B5A_STOP_LOSS_START_SECONDS: "0",
    B5A_STOP_LOSS_MIN_HOLD_SECONDS: "0",
  };

  const entryProfiles: Array<{
    name: string;
    profile: Profile;
    env: Record<string, string>;
  }> = [
    {
      name: "wide_both_a",
      profile: "conservative",
      env: {
        B5A_MAX_SPREAD: "0.07",
        B5A_MIN_ENTRY_LIQUIDITY_USD: "3",
        B5A_MIN_EXIT_LIQUIDITY_USD: "3",
        B5A_ADV_MIN_ABS_GAP: "2",
        B5A_ADV_MIN_MOMENTUM: "0.08",
        B5A_ADV_MIN_CUMULATIVE_GAP: "5",
        B5A_MAX_ADVANTAGE_PRICE: "0.58",
        B5A_MAX_REVERSAL_PRICE: "0.52",
        B5A_REV_MAX_ABS_GAP: "8",
        B5A_REV_MIN_MOMENTUM: "0.08",
      },
    },
    {
      name: "wide_adv_only",
      profile: "conservative",
      env: {
        B5A_ENABLE_REVERSAL: "false",
        B5A_MAX_SPREAD: "0.07",
        B5A_MIN_ENTRY_LIQUIDITY_USD: "3",
        B5A_MIN_EXIT_LIQUIDITY_USD: "3",
        B5A_ADV_MIN_ABS_GAP: "2",
        B5A_ADV_MIN_MOMENTUM: "0.08",
        B5A_ADV_MIN_CUMULATIVE_GAP: "5",
        B5A_MAX_ADVANTAGE_PRICE: "0.58",
        B5A_MAX_REVERSAL_PRICE: "0.52",
        B5A_REV_MAX_ABS_GAP: "8",
        B5A_REV_MIN_MOMENTUM: "0.08",
      },
    },
    {
      name: "discount_reversal_only",
      profile: "conservative",
      env: {
        B5A_ENABLE_ADVANTAGE: "false",
        B5A_MAX_SPREAD: "0.07",
        B5A_MIN_ENTRY_LIQUIDITY_USD: "3",
        B5A_MIN_EXIT_LIQUIDITY_USD: "3",
        B5A_ADV_MIN_ABS_GAP: "999",
        B5A_ADV_MIN_MOMENTUM: "999",
        B5A_ADV_MIN_CUMULATIVE_GAP: "999",
        B5A_MAX_ADVANTAGE_PRICE: "0.45",
        B5A_MAX_REVERSAL_PRICE: "0.47",
        B5A_REV_MAX_ABS_GAP: "8",
        B5A_REV_MIN_MOMENTUM: "0.08",
      },
    },
    {
      name: "deep_reversal_only",
      profile: "conservative",
      env: {
        B5A_ENABLE_ADVANTAGE: "false",
        B5A_MAX_SPREAD: "0.07",
        B5A_MIN_ENTRY_LIQUIDITY_USD: "3",
        B5A_MIN_EXIT_LIQUIDITY_USD: "3",
        B5A_ADV_MIN_ABS_GAP: "999",
        B5A_ADV_MIN_MOMENTUM: "999",
        B5A_ADV_MIN_CUMULATIVE_GAP: "999",
        B5A_MAX_ADVANTAGE_PRICE: "0.45",
        B5A_MAX_REVERSAL_PRICE: "0.42",
        B5A_REV_MAX_ABS_GAP: "9",
        B5A_REV_MIN_MOMENTUM: "0.06",
      },
    },
    {
      name: "mid_reversal_only",
      profile: "conservative",
      env: {
        B5A_ENABLE_ADVANTAGE: "false",
        B5A_MAX_SPREAD: "0.07",
        B5A_MIN_ENTRY_LIQUIDITY_USD: "3",
        B5A_MIN_EXIT_LIQUIDITY_USD: "3",
        B5A_ADV_MIN_ABS_GAP: "999",
        B5A_ADV_MIN_MOMENTUM: "999",
        B5A_ADV_MIN_CUMULATIVE_GAP: "999",
        B5A_MAX_ADVANTAGE_PRICE: "0.45",
        B5A_MAX_REVERSAL_PRICE: "0.44",
        B5A_REV_MAX_ABS_GAP: "9",
        B5A_REV_MIN_MOMENTUM: "0.06",
      },
    },
    {
      name: "cheap_adv_only",
      profile: "conservative",
      env: {
        B5A_ENABLE_REVERSAL: "false",
        B5A_MAX_SPREAD: "0.07",
        B5A_MIN_ENTRY_LIQUIDITY_USD: "3",
        B5A_MIN_EXIT_LIQUIDITY_USD: "3",
        B5A_ADV_MIN_ABS_GAP: "1.5",
        B5A_ADV_MIN_MOMENTUM: "0.05",
        B5A_ADV_MIN_CUMULATIVE_GAP: "2",
        B5A_MAX_ADVANTAGE_PRICE: "0.5",
        B5A_MAX_REVERSAL_PRICE: "0.5",
        B5A_REV_MAX_ABS_GAP: "9",
        B5A_REV_MIN_MOMENTUM: "0.05",
      },
    },
    {
      name: "deep_adv_only",
      profile: "conservative",
      env: {
        B5A_ENABLE_REVERSAL: "false",
        B5A_MAX_SPREAD: "0.07",
        B5A_MIN_ENTRY_LIQUIDITY_USD: "3",
        B5A_MIN_EXIT_LIQUIDITY_USD: "3",
        B5A_ADV_MIN_ABS_GAP: "1.5",
        B5A_ADV_MIN_MOMENTUM: "0.05",
        B5A_ADV_MIN_CUMULATIVE_GAP: "2",
        B5A_MAX_ADVANTAGE_PRICE: "0.46",
        B5A_MAX_REVERSAL_PRICE: "0.5",
        B5A_REV_MAX_ABS_GAP: "9",
        B5A_REV_MIN_MOMENTUM: "0.05",
      },
    },
    {
      name: "mid_adv_only",
      profile: "conservative",
      env: {
        B5A_ENABLE_REVERSAL: "false",
        B5A_MAX_SPREAD: "0.07",
        B5A_MIN_ENTRY_LIQUIDITY_USD: "3",
        B5A_MIN_EXIT_LIQUIDITY_USD: "3",
        B5A_ADV_MIN_ABS_GAP: "1.5",
        B5A_ADV_MIN_MOMENTUM: "0.05",
        B5A_ADV_MIN_CUMULATIVE_GAP: "2",
        B5A_MAX_ADVANTAGE_PRICE: "0.52",
        B5A_MAX_REVERSAL_PRICE: "0.5",
        B5A_REV_MAX_ABS_GAP: "9",
        B5A_REV_MIN_MOMENTUM: "0.05",
      },
    },
    {
      name: "balanced_both",
      profile: "conservative",
      env: {
        B5A_MAX_SPREAD: "0.06",
        B5A_MIN_ENTRY_LIQUIDITY_USD: "4",
        B5A_MIN_EXIT_LIQUIDITY_USD: "4",
        B5A_ADV_MIN_ABS_GAP: "3",
        B5A_ADV_MIN_MOMENTUM: "0.12",
        B5A_ADV_MIN_CUMULATIVE_GAP: "10",
        B5A_MAX_ADVANTAGE_PRICE: "0.56",
        B5A_MAX_REVERSAL_PRICE: "0.5",
        B5A_REV_MAX_ABS_GAP: "6.5",
        B5A_REV_MIN_MOMENTUM: "0.12",
      },
    },
    {
      name: "loose_adv_only",
      profile: "aggressive",
      env: {
        B5A_ENABLE_REVERSAL: "false",
        B5A_MAX_SPREAD: "0.08",
        B5A_MIN_ENTRY_LIQUIDITY_USD: "2.5",
        B5A_MIN_EXIT_LIQUIDITY_USD: "2.5",
        B5A_ADV_MIN_ABS_GAP: "1.5",
        B5A_ADV_MIN_MOMENTUM: "0.05",
        B5A_ADV_MIN_CUMULATIVE_GAP: "2",
        B5A_MAX_ADVANTAGE_PRICE: "0.6",
        B5A_MAX_REVERSAL_PRICE: "0.52",
        B5A_REV_MAX_ABS_GAP: "9",
        B5A_REV_MIN_MOMENTUM: "0.05",
      },
    },
    {
      name: "current_reference",
      profile: "conservative",
      env: {
        B5A_MAX_SPREAD: "0.05",
        B5A_MIN_ENTRY_LIQUIDITY_USD: "6",
        B5A_MIN_EXIT_LIQUIDITY_USD: "6",
        B5A_ADV_MIN_ABS_GAP: "4.5",
        B5A_ADV_MIN_MOMENTUM: "0.26",
        B5A_ADV_MIN_CUMULATIVE_GAP: "45",
        B5A_MAX_ADVANTAGE_PRICE: "0.5",
        B5A_MAX_REVERSAL_PRICE: "0.5",
        B5A_REV_MAX_ABS_GAP: "4.5",
        B5A_REV_MIN_MOMENTUM: "0.26",
      },
    },
  ];

  const exitProfiles: Array<{ name: string; env: Record<string, string> }> = [
    {
      name: "no_half_delay30_stop35",
      env: {
        B5A_MANAGED_EXIT_START_SECONDS: "170",
        B5A_STOP_LOSS_START_SECONDS: "120",
        B5A_STOP_LOSS_MIN_HOLD_SECONDS: "30",
        B5A_HALF_STOP_LOSS_RATIO: "0.35",
        B5A_FULL_STOP_LOSS_RATIO: "0.35",
        B5A_FULL_TAKE_PROFIT_RATIO: "0.22",
        B5A_TAKE_PROFIT_PRICE_IMMEDIATE: "0.78",
      },
    },
    {
      name: "no_half_delay45_stop45",
      env: {
        B5A_MANAGED_EXIT_START_SECONDS: "190",
        B5A_STOP_LOSS_START_SECONDS: "150",
        B5A_STOP_LOSS_MIN_HOLD_SECONDS: "45",
        B5A_HALF_STOP_LOSS_RATIO: "0.45",
        B5A_FULL_STOP_LOSS_RATIO: "0.45",
        B5A_FULL_TAKE_PROFIT_RATIO: "0.28",
        B5A_TAKE_PROFIT_PRICE_IMMEDIATE: "0.82",
      },
    },
    {
      name: "half_delay45_stop30_50",
      env: {
        B5A_MANAGED_EXIT_START_SECONDS: "190",
        B5A_STOP_LOSS_START_SECONDS: "150",
        B5A_STOP_LOSS_MIN_HOLD_SECONDS: "45",
        B5A_HALF_STOP_LOSS_RATIO: "0.3",
        B5A_FULL_STOP_LOSS_RATIO: "0.5",
        B5A_FULL_TAKE_PROFIT_RATIO: "0.28",
        B5A_TAKE_PROFIT_PRICE_IMMEDIATE: "0.82",
      },
    },
    {
      name: "managed_tp_no_stop",
      env: {
        B5A_MANAGED_EXIT_START_SECONDS: "190",
        B5A_STOP_LOSS_ENABLED: "false",
        B5A_FULL_TAKE_PROFIT_RATIO: "0.28",
        B5A_TAKE_PROFIT_PRICE_IMMEDIATE: "0.82",
      },
    },
    {
      name: "current_stop_reference",
      env: {
        B5A_MANAGED_EXIT_START_SECONDS: "200",
        B5A_STOP_LOSS_START_SECONDS: "0",
        B5A_STOP_LOSS_MIN_HOLD_SECONDS: "0",
        B5A_HALF_STOP_LOSS_RATIO: "0.3",
        B5A_FULL_STOP_LOSS_RATIO: "0.45",
        B5A_FULL_TAKE_PROFIT_RATIO: "0.45",
        B5A_TAKE_PROFIT_PRICE_IMMEDIATE: "0.87",
      },
    },
  ];

  const shareProfiles = [
    { name: "shares2", env: { B5A_SHARES: "2" } },
    { name: "shares3", env: { B5A_SHARES: "3" } },
    { name: "shares4", env: { B5A_SHARES: "4" } },
  ];

  const executionProfiles = [
    { name: "passive", env: { B5A_ENTRY_ORDER_TYPE: "GTC", B5A_ENTRY_ORDER_TTL_MS: "2500" } },
    { name: "marketable", env: { B5A_ENTRY_ORDER_TYPE: "FAK", B5A_ENTRY_ORDER_TTL_MS: "750" } },
  ];

  const specs: Array<{ name: string; profile: Profile; env: Record<string, string> }> = [];
  for (const entryProfile of entryProfiles) {
    for (const exitProfile of exitProfiles) {
      for (const shareProfile of shareProfiles) {
        for (const executionProfile of executionProfiles) {
          specs.push({
            name: `${entryProfile.name}_${exitProfile.name}_${shareProfile.name}_${executionProfile.name}`,
            profile: entryProfile.profile,
            env: {
              ...baseEnv,
              ...entryProfile.env,
              ...exitProfile.env,
              ...shareProfile.env,
              ...executionProfile.env,
            },
          });
        }
      }
    }
  }

  return specs.map((spec) => ({
    ...spec,
    config: configFromEnv(spec.env),
  }));
}

function splitMarkets(markets: ReplayMarket[]) {
  const ordered =
    SPLIT_MODE === "random"
      ? shuffled(markets, SPLIT_SEED)
      : [...markets].sort((a, b) => a.slotEndMs - b.slotEndMs);
  const trainCount = Math.floor(ordered.length * 0.6);
  const validationCount = Math.floor(ordered.length * 0.2);
  const train = ordered.slice(0, trainCount);
  const validation = ordered.slice(trainCount, trainCount + validationCount);
  const test = ordered.slice(trainCount + validationCount);
  return { train, validation, test };
}

function pickWinnerByPnl(variants: Variant[], split: "train" | "validation" | "test"): Variant {
  return [...variants].sort((a, b) => {
    const left = a[split]!;
    const right = b[split]!;
    if (right.pnl !== left.pnl) return right.pnl - left.pnl;
    if (left.maxDrawdown !== right.maxDrawdown) return left.maxDrawdown - right.maxDrawdown;
    return right.trades - left.trades;
  })[0]!;
}

function isDefaultEligible(variant: Variant): boolean {
  return (
    variant.train!.pnl > 0 &&
    variant.validation!.pnl > 0 &&
    variant.validation!.tradedMarkets >= MIN_VALIDATION_TRADED_MARKETS
  );
}

function pickDefaultWinner(variants: Variant[]): {
  winner: Variant;
  eligibleCount: number;
  selection: string;
} {
  const eligible = variants.filter(isDefaultEligible);
  if (eligible.length > 0) {
    const winner = [...eligible].sort((a, b) => {
      const left = a.validation!;
      const right = b.validation!;
      const leftRobustScore =
        Math.min(a.train!.pnl, left.pnl) +
        left.pnl * 0.35 +
        Math.log1p(left.tradedMarkets) * 0.35 -
        left.maxDrawdown * 0.05 -
        a.config.shares * 0.15;
      const rightRobustScore =
        Math.min(b.train!.pnl, right.pnl) +
        right.pnl * 0.35 +
        Math.log1p(right.tradedMarkets) * 0.35 -
        right.maxDrawdown * 0.05 -
        b.config.shares * 0.15;
      if (rightRobustScore !== leftRobustScore) return rightRobustScore - leftRobustScore;
      if (right.pnl !== left.pnl) return right.pnl - left.pnl;
      if (right.tradedMarkets !== left.tradedMarkets) return right.tradedMarkets - left.tradedMarkets;
      if (left.maxDrawdown !== right.maxDrawdown) return left.maxDrawdown - right.maxDrawdown;
      if (b.train!.pnl !== a.train!.pnl) return b.train!.pnl - a.train!.pnl;
      if (a.config.shares !== b.config.shares) return a.config.shares - b.config.shares;
      return right.trades - left.trades;
    })[0]!;
    return {
      winner,
      eligibleCount: eligible.length,
      selection: "growth_train_validation_positive_with_participation_bonus",
    };
  }

  const lowRiskValidationPositive = variants.filter(
    (variant) =>
      variant.profile === "conservative" &&
      variant.config.shares <= 3 &&
      variant.validation!.pnl > 0 &&
      variant.validation!.tradedMarkets >= Math.min(15, MIN_VALIDATION_TRADED_MARKETS),
  );
  const pool = lowRiskValidationPositive.length > 0 ? lowRiskValidationPositive : variants;
  const winner = [...pool].sort((a, b) => {
    const left = a.validation!;
    const right = b.validation!;
    if (right.score !== left.score) return right.score - left.score;
    if (a.config.shares !== b.config.shares) return a.config.shares - b.config.shares;
    if (left.maxDrawdown !== right.maxDrawdown) return left.maxDrawdown - right.maxDrawdown;
    if (b.train!.pnl !== a.train!.pnl) return b.train!.pnl - a.train!.pnl;
    return right.trades - left.trades;
  })[0]!;
  return {
    winner,
    eligibleCount: eligible.length,
    selection:
      lowRiskValidationPositive.length > 0
        ? "fallback_low_risk_validation_positive_no_eligible_train_validation_candidate"
        : "fallback_no_eligible_train_validation_candidate",
  };
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
    avgWin: result.avgWin,
    avgLoss: result.avgLoss,
    grossProfit: result.grossProfit,
    grossLoss: result.grossLoss,
    settlementHeld: result.settlementHeld,
    expiredEntries: result.expiredEntries,
    expiredSells: result.expiredSells,
    score: result.score,
  };
}

async function loadMarkets(): Promise<ReplayMarket[]> {
  const excludedSlugs = await loadExcludedSlugs();
  const files = (await readdir(LOG_DIR))
    .filter((file) => /^early-bird-btc-updown-5m-\d+\.log$/.test(file))
    .filter((file) => !excludedSlugs.has(file.replace(/^early-bird-/, "").replace(/\.log$/, "")))
    .sort();
  const loaded = await Promise.all(files.map((file) => loadMarket(join(LOG_DIR, file))));
  return loaded.filter((market): market is ReplayMarket => !!market && !!market.resolution);
}

async function loadExcludedSlugs(): Promise<Set<string>> {
  const slugs = new Set<string>();
  if (!EXCLUDE_RUN_LOG) return slugs;
  try {
    const text = await Bun.file(EXCLUDE_RUN_LOG).text();
    for (const match of text.matchAll(/\[(btc-updown-5m-\d+)\]/g)) {
      slugs.add(match[1]!);
    }
  } catch {
    // Missing exclude logs should not block older backtest workflows.
  }
  return slugs;
}

async function main() {
  const markets = await loadMarkets();
  const { train, validation, test } = splitMarkets(markets);
  const variants = buildVariants();

  for (const variant of variants) {
    variant.train = summarize(train, variant.config);
    variant.validation = summarize(validation, variant.config);
  }
  const trainWinner = pickWinnerByPnl(variants, "train");
  const validationWinner = pickWinnerByPnl(variants, "validation");
  const {
    winner: defaultWinner,
    eligibleCount,
    selection: defaultSelection,
  } = pickDefaultWinner(variants);

  for (const variant of variants) {
    variant.test = summarize(test, variant.config, { includeTrades: true });
  }
  const testWinner = pickWinnerByPnl(variants, "test");

  const validationTable = variants
    .map((variant) => ({
      name: variant.name,
      profile: variant.profile,
      trainPnl: variant.train!.pnl,
      ...compactResult(variant.validation!),
    }))
    .sort((a, b) => b.pnl - a.pnl);

  const testTable = variants
    .map((variant) => ({
      name: variant.name,
      profile: variant.profile,
      env: variant.env,
      trainPnl: variant.train!.pnl,
      validationPnl: variant.validation!.pnl,
      validationMaxDrawdown: variant.validation!.maxDrawdown,
      validationWinRate: variant.validation!.winRate,
      ...compactResult(variant.test!),
    }))
    .sort((a, b) => {
      if (b.validationPnl !== a.validationPnl) return b.validationPnl - a.validationPnl;
      if (a.validationMaxDrawdown !== b.validationMaxDrawdown) {
        return a.validationMaxDrawdown - b.validationMaxDrawdown;
      }
      return b.pnl - a.pnl;
    });

  const output = {
    logDir: LOG_DIR,
    splitSeed: SPLIT_SEED,
    splitMode: SPLIT_MODE,
    excludeRunLog: EXCLUDE_RUN_LOG || null,
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
    selectionRules: {
      minValidationTradedMarkets: MIN_VALIDATION_TRADED_MARKETS,
      requireTrainPnlPositive: true,
      requireValidationPnlPositive: true,
      rankBy:
        "growth_train_validation_positive_with_participation_bonus; fallback=min_share_conservative_validation_positive_score",
      defaultEligibleCount: eligibleCount,
    },
    validationTable,
    testTable,
    trainWinner: {
      name: trainWinner.name,
      profile: trainWinner.profile,
      env: trainWinner.env,
      train: compactResult(trainWinner.train!),
      validation: compactResult(trainWinner.validation!),
      test: compactResult(trainWinner.test!),
    },
    validationWinner: {
      selection: "validation_pnl_best_report_only",
      name: validationWinner.name,
      profile: validationWinner.profile,
      env: validationWinner.env,
      train: compactResult(validationWinner.train!),
      validation: compactResult(validationWinner.validation!),
      test: compactResult(validationWinner.test!),
    },
    winner: {
      selection: defaultSelection,
      note:
        "The default profile is selected without looking at test results. Test metrics are reported after selection and are not used for choosing the default.",
      name: defaultWinner.name,
      profile: defaultWinner.profile,
      env: defaultWinner.env,
      train: compactResult(defaultWinner.train!),
      validation: compactResult(defaultWinner.validation!),
      test: compactResult(defaultWinner.test!),
      testTrades: defaultWinner.test!.tradesDetail,
    },
    testWinner: {
      selection: "test_pnl_best_report_only",
      name: testWinner.name,
      profile: testWinner.profile,
      env: testWinner.env,
      train: compactResult(testWinner.train!),
      validation: compactResult(testWinner.validation!),
      test: compactResult(testWinner.test!),
      testTrades: testWinner.test!.tradesDetail,
    },
  };

  await mkdir(REPORT_DIR, { recursive: true });
  const reportBase = join(REPORT_DIR, `btc-5m-arb-${SPLIT_SEED}`);
  await Bun.write(`${reportBase}.json`, JSON.stringify(output, null, 2));

  const csvHeader = [
    "name",
    "profile",
    "trainPnl",
    "validationPnl",
    "validationMaxDrawdown",
    "validationWinRate",
    "testPnl",
    "testMaxDrawdown",
    "testWinRate",
    "testTrades",
    "testTradedMarkets",
    "testAvgPnlPerTrade",
    "testGrossProfit",
    "testGrossLoss",
    "env",
  ];
  const csvRows = testTable.map((row) =>
    [
      row.name,
      row.profile,
      row.trainPnl,
      row.validationPnl,
      row.validationMaxDrawdown,
      row.validationWinRate,
      row.pnl,
      row.maxDrawdown,
      row.winRate,
      row.trades,
      row.tradedMarkets,
      row.avgPnlPerTrade,
      row.grossProfit,
      row.grossLoss,
      JSON.stringify(row.env),
    ]
      .map((value) => `"${String(value).replaceAll('"', '""')}"`)
      .join(","),
  );
  await Bun.write(
    `${reportBase}-valid-test-table.csv`,
    [csvHeader.join(","), ...csvRows].join("\n"),
  );

  console.log(
    JSON.stringify(
      {
        logDir: output.logDir,
        splitSeed: output.splitSeed,
        scannedMarkets: output.scannedMarkets,
        split: output.split,
        resolution: output.resolution,
        variantCount: output.variantCount,
        selectionRules: output.selectionRules,
        topValidation: validationTable.slice(0, 12),
        topTestByValidationRanking: testTable.slice(0, 12),
        winner: output.winner,
        testWinner: {
          ...output.testWinner,
          testTrades: output.testWinner.testTrades?.slice(0, 20) ?? [],
        },
        reportFiles: {
          json: `${reportBase}.json`,
          csv: `${reportBase}-valid-test-table.csv`,
        },
      },
      null,
      2,
    ),
  );
}

await main();

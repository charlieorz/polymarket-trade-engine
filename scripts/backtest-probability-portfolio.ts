import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  __probabilityPortfolioTestHooks,
  type BookQuality,
  type PortfolioConfig,
  type PortfolioEntryModel,
  type PortfolioLeg,
  type PortfolioRuntimeState,
  type PortfolioSide,
} from "../engine/strategy/probability-portfolio.ts";

type Level = [number, number];
type BookSide = { bids: Level[]; asks: Level[] } | null;
type BookSnapshot = { up: BookSide; down: BookSide };

type ReplaySample = {
  ts: number;
  remaining: number;
  price: number;
  priceToBeat: number;
  gap: number;
  upQuality: BookQuality | null;
  downQuality: BookQuality | null;
};

type ReplayMarket = {
  file: string;
  slug: string;
  slotEndMs: number;
  samples: ReplaySample[];
  resolution: {
    direction: PortfolioSide;
    openPrice: number;
    closePrice: number;
    source: "explicit" | "inferred";
  } | null;
};

type ReplayTrade = {
  market: string;
  side: PortfolioSide;
  model: PortfolioEntryModel;
  entryTs: number;
  exitTs: number;
  entryPrice: number;
  exitPrice: number | null;
  entryGap: number;
  pFairEntry: number;
  netEdgeEntry: number;
  scoreEntry: number;
  shares: number;
  pnl: number;
  reason: string;
};

type ReplayResult = {
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
  score: number;
  tradesDetail?: ReplayTrade[];
};

type Variant = {
  name: string;
  profile: "conservative" | "neutral" | "aggressive";
  config: PortfolioConfig;
};

const LOG_DIR = process.env.PP_BACKTEST_LOG_DIR ?? "logs";
const SPLIT_SEED = process.env.PP_BACKTEST_SPLIT_SEED ?? "probability-2026-05-12";

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

function bestQuality(book: BookSide): BookQuality | null {
  if (!book || book.asks.length === 0 || book.bids.length === 0) return null;
  const ask = book.asks[0]!;
  const bid = book.bids[0]!;
  const askPrice = ask[0];
  const bidPrice = bid[0];
  const askLiquidity = askPrice * ask[1];
  const bidLiquidity = bidPrice * bid[1];
  const depth = askLiquidity + bidLiquidity;
  return {
    ask: askPrice,
    bid: bidPrice,
    askLiquidity,
    bidLiquidity,
    spread: round(askPrice - bidPrice, 4),
    depthImbalance:
      depth > 0 ? round((bidLiquidity - askLiquidity) / depth, 4) : null,
  };
}

function qualityFromSnapshot(
  snapshot: BookSnapshot | null,
  side: PortfolioSide,
): BookQuality | null {
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
    if (latestRemaining > 300 || latestRemaining < 0) continue;

    samples.push({
      ts: Number(entry.ts),
      remaining: latestRemaining,
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

function makeLeg(params: {
  market: ReplayMarket;
  entry: ReturnType<
    typeof __probabilityPortfolioTestHooks.choosePortfolioEntry
  >;
  sample: ReplaySample;
  config: PortfolioConfig;
}): PortfolioLeg {
  const entry = params.entry!;
  return {
    id: `${params.market.slug}-${entry.side}-${entry.model}-${params.sample.ts}`,
    model: entry.model,
    side: entry.side,
    tokenId: entry.side,
    entryPrice: entry.ask,
    entryGap: params.sample.gap,
    entrySideGap: entry.sideGap,
    entryMs: params.sample.ts,
    shares: params.config.shares,
    pFairEntry: entry.pFair,
    netEdgeEntry: entry.netEdge,
    scoreEntry: entry.score,
    takeProfitPrice: entry.takeProfitPrice,
    stopLossPrice: entry.stopLossPrice,
    peakSideGap: Math.max(0, entry.sideGap),
    peakBid: entry.bid,
    trendInvalidSinceMs: null,
    riskExitAttempts: 0,
  };
}

function simulateMarket(
  market: ReplayMarket,
  config: PortfolioConfig,
): {
  pnl: number;
  trades: ReplayTrade[];
  settlementHeld: number;
} {
  const stats = __probabilityPortfolioTestHooks.createPortfolioStats();
  const state: PortfolioRuntimeState = {
    legs: [],
    closingLegIds: new Set<string>(),
    pendingEntryCount: 0,
    pendingEntrySideCounts: { UP: 0, DOWN: 0 },
    pendingEntryModelCounts: { continuation: 0, reversal: 0 },
    realizedCash: 0,
    released: false,
    settlementHoldLogged: false,
    openedLegCount: 0,
  };
  const trades: ReplayTrade[] = [];
  let settlementHeld = 0;

  for (const sample of market.samples) {
    const enteredLegIds = new Set<string>();
    __probabilityPortfolioTestHooks.updatePortfolioStats({
      stats,
      now: sample.ts,
      price: sample.price,
      gap: sample.gap,
      upQuality: sample.upQuality,
      downQuality: sample.downQuality,
      config,
    });

    const entry = __probabilityPortfolioTestHooks.choosePortfolioEntry({
      remaining: sample.remaining,
      gap: sample.gap,
      upQuality: sample.upQuality,
      downQuality: sample.downQuality,
      stats,
      state,
      config,
    });
    if (entry) {
      const leg = makeLeg({ market, entry, sample, config });
      state.realizedCash -= entry.ask * config.shares;
      state.openedLegCount++;
      state.legs.push(leg);
      enteredLegIds.add(leg.id);
    }

    for (const leg of [...state.legs]) {
      if (enteredLegIds.has(leg.id)) continue;
      const quality = leg.side === "UP" ? sample.upQuality : sample.downQuality;
      const bid = quality?.bid ?? null;
      __probabilityPortfolioTestHooks.updatePortfolioLeg(leg, sample.gap, bid);
      const exit = __probabilityPortfolioTestHooks.shouldExitPortfolioLeg({
        leg,
        state,
        gap: sample.gap,
        bid,
        remaining: sample.remaining,
        now: sample.ts,
        stats,
        config,
      });
      if (!exit || bid === null) continue;

      state.realizedCash += exit.price * leg.shares;
      state.legs = state.legs.filter((candidate) => candidate.id !== leg.id);
      trades.push({
        market: market.slug,
        side: leg.side,
        model: leg.model,
        entryTs: leg.entryMs,
        exitTs: sample.ts,
        entryPrice: leg.entryPrice,
        exitPrice: exit.price,
        entryGap: round(leg.entryGap, 4),
        pFairEntry: round(leg.pFairEntry, 4),
        netEdgeEntry: round(leg.netEdgeEntry, 4),
        scoreEntry: round(leg.scoreEntry, 4),
        shares: leg.shares,
        pnl: round((exit.price - leg.entryPrice) * leg.shares, 4),
        reason: exit.mode,
      });
    }
  }

  const heldLegs = [...state.legs];
  const payoutShares =
    market.resolution!.direction === "UP"
      ? heldLegs
          .filter((leg) => leg.side === "UP")
          .reduce((sum, leg) => sum + leg.shares, 0)
      : heldLegs
          .filter((leg) => leg.side === "DOWN")
          .reduce((sum, leg) => sum + leg.shares, 0);
  const finalPnl = state.realizedCash + payoutShares;
  for (const leg of heldLegs) {
    const legPnl =
      (market.resolution!.direction === leg.side ? 1 : 0) * leg.shares -
      leg.entryPrice * leg.shares;
    settlementHeld++;
    trades.push({
      market: market.slug,
      side: leg.side,
      model: leg.model,
      entryTs: leg.entryMs,
      exitTs: market.slotEndMs,
      entryPrice: leg.entryPrice,
      exitPrice: null,
      entryGap: round(leg.entryGap, 4),
      pFairEntry: round(leg.pFairEntry, 4),
      netEdgeEntry: round(leg.netEdgeEntry, 4),
      scoreEntry: round(leg.scoreEntry, 4),
      shares: leg.shares,
      pnl: round(legPnl, 4),
      reason: "settlement",
    });
  }

  return { pnl: round(finalPnl, 4), trades, settlementHeld };
}

function summarize(
  markets: ReplayMarket[],
  config: PortfolioConfig,
  options: { includeTrades?: boolean } = {},
): ReplayResult {
  let pnl = 0;
  let peak = 0;
  let equity = 0;
  let maxDrawdown = 0;
  let settlementHeld = 0;
  const trades: ReplayTrade[] = [];
  let tradedMarkets = 0;
  let explicitResolutionMarkets = 0;
  let inferredResolutionMarkets = 0;

  for (const market of markets) {
    if (market.resolution?.source === "explicit") explicitResolutionMarkets++;
    if (market.resolution?.source === "inferred") inferredResolutionMarkets++;
    const result = simulateMarket(market, config);
    pnl += result.pnl;
    equity += result.pnl;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    settlementHeld += result.settlementHeld;
    if (result.trades.length > 0) tradedMarkets++;
    trades.push(...result.trades);
  }

  const wins = trades.filter((trade) => trade.pnl > 0).length;
  const winRate = trades.length > 0 ? wins / trades.length : 0;
  const avgPnlPerMarket = markets.length > 0 ? pnl / markets.length : 0;
  const avgPnlPerTrade = trades.length > 0 ? pnl / trades.length : 0;
  const coverage = markets.length > 0 ? tradedMarkets / markets.length : 0;
  const coverageScore = Math.min(1, coverage / 0.14);
  const underTradePenalty =
    tradedMarkets < Math.max(4, Math.floor(markets.length * 0.08))
      ? (Math.max(4, Math.floor(markets.length * 0.08)) - tradedMarkets) * 0.35
      : 0;
  const score =
    pnl -
    maxDrawdown * 0.4 +
    avgPnlPerTrade * 5 +
    winRate +
    coverageScore -
    underTradePenalty;
  return {
    markets: markets.length,
    explicitResolutionMarkets,
    inferredResolutionMarkets,
    tradedMarkets,
    trades: trades.length,
    pnl: round(pnl, 4),
    winRate: round(winRate, 4),
    avgPnlPerMarket: round(avgPnlPerMarket, 4),
    avgPnlPerTrade: round(avgPnlPerTrade, 4),
    maxDrawdown: round(maxDrawdown, 4),
    settlementHeld,
    score: round(score, 4),
    tradesDetail: options.includeTrades ? trades : undefined,
  };
}

function buildVariants(base: PortfolioConfig): Variant[] {
  const variants: Variant[] = [];
  const profiles: Array<{
    profile: Variant["profile"];
    continuationEdge: number;
    reversalEdge: number;
    continuationScore: number;
    reversalScore: number;
    continuationAbsGap: number;
    reversalAbsGap: number;
    continuationRelativeGap: number;
    reversalRelativeGap: number;
    peakRetain: number;
    reversalRetrace: number;
    maxReversalRetrace: number;
    shortVelocity: number;
    midVelocity: number;
    continuationVotes: number;
    reversalVelocity: number;
    reversalVotes: number;
    flatTicks: number;
    sigmaMultiplier: number;
    maxContinuationAsk: number;
    maxReversalAsk: number;
    maxSpread: number;
    takeProfit: number;
    maxLoss: number;
  }> = [
    {
      profile: "conservative",
      continuationEdge: 0.03,
      reversalEdge: 0.04,
      continuationScore: 0.62,
      reversalScore: 0.58,
      continuationAbsGap: 7,
      reversalAbsGap: 9,
      continuationRelativeGap: 0.56,
      reversalRelativeGap: 0.72,
      peakRetain: 0.8,
      reversalRetrace: 0.12,
      maxReversalRetrace: 0.62,
      shortVelocity: 1.2,
      midVelocity: 2.6,
      continuationVotes: 3,
      reversalVelocity: 1.3,
      reversalVotes: 3,
      flatTicks: 1,
      sigmaMultiplier: 2.2,
      maxContinuationAsk: 0.66,
      maxReversalAsk: 0.58,
      maxSpread: 0.03,
      takeProfit: 0.09,
      maxLoss: 0.06,
    },
    {
      profile: "neutral",
      continuationEdge: 0.018,
      reversalEdge: 0.026,
      continuationScore: 0.54,
      reversalScore: 0.5,
      continuationAbsGap: 5.5,
      reversalAbsGap: 7,
      continuationRelativeGap: 0.42,
      reversalRelativeGap: 0.52,
      peakRetain: 0.68,
      reversalRetrace: 0.08,
      maxReversalRetrace: 0.74,
      shortVelocity: 0.45,
      midVelocity: 1.1,
      continuationVotes: 2,
      reversalVelocity: 0.55,
      reversalVotes: 2,
      flatTicks: 2,
      sigmaMultiplier: 1.65,
      maxContinuationAsk: 0.72,
      maxReversalAsk: 0.64,
      maxSpread: 0.04,
      takeProfit: 0.075,
      maxLoss: 0.075,
    },
    {
      profile: "aggressive",
      continuationEdge: 0.006,
      reversalEdge: 0.012,
      continuationScore: 0.44,
      reversalScore: 0.42,
      continuationAbsGap: 4,
      reversalAbsGap: 5.5,
      continuationRelativeGap: 0.28,
      reversalRelativeGap: 0.36,
      peakRetain: 0.56,
      reversalRetrace: 0.05,
      maxReversalRetrace: 0.82,
      shortVelocity: 0.15,
      midVelocity: 0.35,
      continuationVotes: 2,
      reversalVelocity: 0.18,
      reversalVotes: 2,
      flatTicks: 3,
      sigmaMultiplier: 1.25,
      maxContinuationAsk: 0.78,
      maxReversalAsk: 0.7,
      maxSpread: 0.055,
      takeProfit: 0.055,
      maxLoss: 0.095,
    },
  ];

  for (const profile of profiles) {
    for (const edgeScale of [0.85, 1, 1.2]) {
      for (const momentumScale of [0.8, 1, 1.25]) {
        for (const askScale of [0.96, 1.04]) {
          for (const riskScale of [0.9, 1.1]) {
            const minContinuationNetEdge = round(
              profile.continuationEdge * edgeScale,
              4,
            );
            const minReversalNetEdge = round(profile.reversalEdge * edgeScale, 4);
            const minContinuationScore = round(
              profile.continuationScore * (0.95 + (edgeScale - 1) * 0.2),
              4,
            );
            const minReversalScore = round(
              profile.reversalScore * (0.95 + (edgeScale - 1) * 0.2),
              4,
            );
            const minContinuationSideVelocityShort = round(
              profile.shortVelocity * momentumScale,
              4,
            );
            const minContinuationSideVelocityMid = round(
              profile.midVelocity * momentumScale,
              4,
            );
            const minReversalVelocityTowardZero = round(
              profile.reversalVelocity * momentumScale,
              4,
            );
            const takeProfitCents = round(profile.takeProfit * riskScale, 4);
            const maxLossCents = round(profile.maxLoss * riskScale, 4);
            variants.push({
              profile: profile.profile,
              name:
                `${profile.profile}` +
                `_e${edgeScale}` +
                `_m${momentumScale}` +
                `_a${askScale}` +
                `_r${riskScale}`,
              config: {
                ...base,
                allowOppositeSides: true,
                maxOpenLegs: 2,
                maxSameSideLegs: 2,
                maxEntriesPerMarket: 2,
                maxSameModelEntries: 1,
                minEntryRemaining: 28,
                maxEntryRemaining: 255,
                maxContinuationAsk: round(profile.maxContinuationAsk * askScale, 4),
                maxReversalAsk: round(profile.maxReversalAsk * askScale, 4),
                maxSpread: round(profile.maxSpread * askScale, 4),
                minContinuationAbsGap: profile.continuationAbsGap,
                minReversalAbsGap: profile.reversalAbsGap,
                minContinuationRelativeGap: profile.continuationRelativeGap,
                minReversalRelativeGap: profile.reversalRelativeGap,
                minContinuationNetEdge,
                minReversalNetEdge,
                minContinuationScore,
                minReversalScore,
                minContinuationPeakRetain: profile.peakRetain,
                minReversalPeakRetrace: profile.reversalRetrace,
                maxReversalPeakRetrace: profile.maxReversalRetrace,
                minContinuationSideVelocityShort,
                minContinuationSideVelocityMid,
                minContinuationMomentumVotes: profile.continuationVotes,
                maxContinuationFlatTicks: profile.flatTicks,
                minReversalVelocityTowardZero,
                minReversalMomentumVotes: profile.reversalVotes,
                maxReversalFlatTicks: profile.flatTicks,
                costBuffer: profile.profile === "aggressive" ? 0.006 : 0.009,
                sigmaMultiplier: profile.sigmaMultiplier,
                takeProfitCents,
                maxLossCents,
                catastrophicLossCents: Math.max(0.14, maxLossCents * 1.8),
              },
            });
          }
        }
      }
    }
  }
  return variants;
}

function printResult(
  label: string,
  rows: Array<{ name: string; profile?: string; result: ReplayResult }>,
  limit = 10,
): void {
  console.log(`\n${label}`);
  console.table(
    rows.slice(0, limit).map((row) => ({
      profile: row.profile,
      name: row.name,
      pnl: row.result.pnl,
      score: row.result.score,
      markets: row.result.markets,
      explicit: row.result.explicitResolutionMarkets,
      inferred: row.result.inferredResolutionMarkets,
      tradedMarkets: row.result.tradedMarkets,
      trades: row.result.trades,
      winRate: row.result.winRate,
      avgTrade: row.result.avgPnlPerTrade,
      maxDD: row.result.maxDrawdown,
      settlementHeld: row.result.settlementHeld,
    })),
  );
}

async function main() {
  const files = (await readdir(LOG_DIR))
    .filter((file) => /^early-bird-btc-updown-5m-\d+\.log$/.test(file))
    .sort()
    .map((file) => join(LOG_DIR, file));
  const markets = (await Promise.all(files.map(loadMarket)))
    .filter((market): market is ReplayMarket => market !== null)
    .sort((a, b) => a.slotEndMs - b.slotEndMs);

  if (markets.length < 15) {
    throw new Error(
      `not enough replayable markets in ${LOG_DIR}: ${markets.length}`,
    );
  }

  const randomizedMarkets = shuffled(markets, SPLIT_SEED);
  const trainEnd = Math.floor(randomizedMarkets.length * 0.6);
  const validationEnd = Math.floor(randomizedMarkets.length * 0.8);
  const train = randomizedMarkets
    .slice(0, trainEnd)
    .sort((a, b) => a.slotEndMs - b.slotEndMs);
  const validation = randomizedMarkets
    .slice(trainEnd, validationEnd)
    .sort((a, b) => a.slotEndMs - b.slotEndMs);
  const test = randomizedMarkets
    .slice(validationEnd)
    .sort((a, b) => a.slotEndMs - b.slotEndMs);
  const base = __probabilityPortfolioTestHooks.readProbabilityPortfolioConfig();
  const variants = buildVariants(base);

  console.log(
    `Scanned ${files.length} window logs from ${LOG_DIR}; loaded ${markets.length} replayable markets; explicit=${markets.filter((market) => market.resolution?.source === "explicit").length}; inferred=${markets.filter((market) => market.resolution?.source === "inferred").length}; random split seed=${SPLIT_SEED}; train=${train.length}, validation=${validation.length}, test=${test.length}; variants=${variants.length}`,
  );

  const trainRows = variants
    .map((variant) => ({
      name: variant.name,
      profile: variant.profile,
      variant,
      result: summarize(train, variant.config),
    }))
    .filter(
      (row) =>
        row.result.trades >= Math.max(5, Math.floor(train.length * 0.08)),
    )
    .sort((a, b) => b.result.score - a.result.score);
  printResult("Top train candidates", trainRows);

  const validationRows = trainRows
    .map((row) => ({
      name: row.name,
      profile: row.profile,
      variant: row.variant,
      result: summarize(validation, row.variant.config),
      trainResult: row.result,
    }))
    .sort((a, b) => b.result.score - a.result.score);
  printResult("Validation ranking from top train candidates", validationRows);

  if (validationRows.length === 0)
    throw new Error("no candidate survived validation");
  const pickRows = (
    start: number,
    count: number,
  ): typeof validationRows => {
    const rows: typeof validationRows = [];
    for (let i = start; i < validationRows.length && rows.length < count; i++) {
      rows.push(validationRows[i]!);
    }
    return rows;
  };
  const middleStart = Math.max(0, Math.floor(validationRows.length / 2) - 1);
  const selectedRows = [
    ...pickRows(0, 2).map((row, index) => ({
      label: `best-validation-${index + 1}`,
      row,
    })),
    ...pickRows(middleStart, 2).map((row, index) => ({
      label: `median-validation-${index + 1}`,
      row,
    })),
    ...pickRows(Math.max(0, validationRows.length - 2), 2).map(
      (row, index) => ({
        label: `worst-validation-${index + 1}`,
        row,
      }),
    ),
  ];

  const testRows = selectedRows.map((selected) => ({
    name: `${selected.label}:${selected.row.name}`,
    profile: selected.row.profile,
    result: summarize(test, selected.row.variant.config, {
      includeTrades: process.env.PP_BACKTEST_DUMP_TRADES === "1",
    }),
    selected,
  }));
  printResult(
    "Final holdout test for validation best 2 / median 2 / worst 2",
    testRows,
    6,
  );
  if (process.env.PP_BACKTEST_DUMP_TRADES === "1") {
    for (const testRow of testRows) {
      if (!testRow.result.tradesDetail) continue;
      console.log(`\nFinal holdout trades (${testRow.name}):`);
      console.table(
        testRow.result.tradesDetail.map((trade) => ({
          market: trade.market,
          side: trade.side,
          model: trade.model,
          entry: trade.entryPrice,
          exit: trade.exitPrice ?? "settle",
          gap: trade.entryGap,
          pFair: trade.pFairEntry,
          edge: trade.netEdgeEntry,
          score: trade.scoreEntry,
          pnl: trade.pnl,
          reason: trade.reason,
        })),
      );
    }
  }
  console.log("\nSelected env overrides:");
  for (const selected of selectedRows) {
    const selectedConfig = selected.row.variant.config;
    console.log(
      `\n# ${selected.label} (${selected.row.profile}) ${selected.row.name}`,
    );
    console.log(
      [
        `PP_MIN_CONTINUATION_NET_EDGE=${selectedConfig.minContinuationNetEdge}`,
        `PP_MIN_REVERSAL_NET_EDGE=${selectedConfig.minReversalNetEdge}`,
        `PP_MIN_CONTINUATION_SCORE=${selectedConfig.minContinuationScore}`,
        `PP_MIN_REVERSAL_SCORE=${selectedConfig.minReversalScore}`,
        `PP_ALLOW_OPPOSITE_SIDES=${selectedConfig.allowOppositeSides}`,
        `PP_MAX_OPEN_LEGS=${selectedConfig.maxOpenLegs}`,
        `PP_MAX_SAME_SIDE_LEGS=${selectedConfig.maxSameSideLegs}`,
        `PP_MAX_ENTRIES_PER_MARKET=${selectedConfig.maxEntriesPerMarket}`,
        `PP_MAX_SAME_MODEL_ENTRIES=${selectedConfig.maxSameModelEntries}`,
        `PP_MIN_ENTRY_REMAINING=${selectedConfig.minEntryRemaining}`,
        `PP_MAX_ENTRY_REMAINING=${selectedConfig.maxEntryRemaining}`,
        `PP_MAX_CONTINUATION_ASK=${selectedConfig.maxContinuationAsk}`,
        `PP_MAX_REVERSAL_ASK=${selectedConfig.maxReversalAsk}`,
        `PP_MIN_CONTINUATION_ABS_GAP=${selectedConfig.minContinuationAbsGap}`,
        `PP_MIN_CONTINUATION_RELATIVE_GAP=${selectedConfig.minContinuationRelativeGap}`,
        `PP_MIN_CONTINUATION_PEAK_RETAIN=${selectedConfig.minContinuationPeakRetain}`,
        `PP_MIN_CONTINUATION_SIDE_VELOCITY_SHORT=${selectedConfig.minContinuationSideVelocityShort}`,
        `PP_MIN_CONTINUATION_SIDE_VELOCITY_MID=${selectedConfig.minContinuationSideVelocityMid}`,
        `PP_MAX_CONTINUATION_FLAT_TICKS=${selectedConfig.maxContinuationFlatTicks}`,
        `PP_MIN_CONTINUATION_MOMENTUM_VOTES=${selectedConfig.minContinuationMomentumVotes}`,
        `PP_MIN_REVERSAL_ABS_GAP=${selectedConfig.minReversalAbsGap}`,
        `PP_MIN_REVERSAL_RELATIVE_GAP=${selectedConfig.minReversalRelativeGap}`,
        `PP_MIN_REVERSAL_PEAK_RETRACE=${selectedConfig.minReversalPeakRetrace}`,
        `PP_MAX_REVERSAL_PEAK_RETRACE=${selectedConfig.maxReversalPeakRetrace}`,
        `PP_MIN_REVERSAL_VELOCITY_TOWARD_ZERO=${selectedConfig.minReversalVelocityTowardZero}`,
        `PP_MAX_REVERSAL_FLAT_TICKS=${selectedConfig.maxReversalFlatTicks}`,
        `PP_MIN_REVERSAL_MOMENTUM_VOTES=${selectedConfig.minReversalMomentumVotes}`,
        `PP_COST_BUFFER=${selectedConfig.costBuffer}`,
        `PP_SIGMA_MULTIPLIER=${selectedConfig.sigmaMultiplier}`,
        `PP_MAX_SPREAD=${selectedConfig.maxSpread}`,
        `PP_MIN_EXIT_LIQUIDITY_USD=${selectedConfig.minExitLiquidityUsd}`,
        `PP_TAKE_PROFIT_CENTS=${selectedConfig.takeProfitCents}`,
        `PP_MAX_LOSS_CENTS=${selectedConfig.maxLossCents}`,
        `PP_CATASTROPHIC_LOSS_CENTS=${selectedConfig.catastrophicLossCents}`,
      ].join("\n"),
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

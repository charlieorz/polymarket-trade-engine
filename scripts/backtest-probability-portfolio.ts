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
  config: PortfolioConfig;
};

const LOG_DIR = process.env.PP_BACKTEST_LOG_DIR ?? "logs";

function round(value: number, digits = 4): number {
  return Number(value.toFixed(digits));
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

function qualityFromSnapshot(snapshot: BookSnapshot | null, side: PortfolioSide): BookQuality | null {
  if (!snapshot) return null;
  return bestQuality(side === "UP" ? snapshot.up : snapshot.down);
}

async function loadMarket(path: string): Promise<ReplayMarket | null> {
  const text = await Bun.file(path).text();
  let slug = path.split("/").at(-1)?.replace(/^early-bird-/, "").replace(/\.log$/, "") ?? path;
  let slotEndMs = 0;
  let latestBook: BookSnapshot | null = null;
  let latestRemaining: number | null = null;
  let resolution: ReplayMarket["resolution"] = null;
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
        };
      }
      continue;
    }
    if (entry.type !== "market_price") continue;
    if (latestRemaining === null || !latestBook) continue;

    const gap = Number(entry.gap);
    const priceToBeat = Number(entry.priceToBeat ?? entry.openPrice);
    const price = priceToBeat + gap;
    if (!Number.isFinite(gap) || !Number.isFinite(priceToBeat) || !Number.isFinite(price)) {
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

  if (samples.length < 20 || resolution === null) return null;
  if (slotEndMs === 0) {
    const slugEnd = Number(slug.split("-").at(-1));
    slotEndMs = Number.isFinite(slugEnd) ? slugEnd * 1000 : samples.at(-1)!.ts;
  }
  return { file: path, slug, slotEndMs, samples, resolution };
}

function makeLeg(params: {
  market: ReplayMarket;
  entry: ReturnType<typeof __probabilityPortfolioTestHooks.choosePortfolioEntry>;
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

function simulateMarket(market: ReplayMarket, config: PortfolioConfig): {
  pnl: number;
  trades: ReplayTrade[];
  settlementHeld: number;
} {
  const stats = __probabilityPortfolioTestHooks.createPortfolioStats();
  const state: PortfolioRuntimeState = {
    legs: [],
    closingLegIds: new Set<string>(),
    realizedCash: 0,
    released: false,
    settlementHoldLogged: false,
    openedLegCount: 0,
  };
  const trades: ReplayTrade[] = [];
  let settlementHeld = 0;

  for (const sample of market.samples) {
    __probabilityPortfolioTestHooks.updatePortfolioStats({
      stats,
      now: sample.ts,
      price: sample.price,
      gap: sample.gap,
      upQuality: sample.upQuality,
      downQuality: sample.downQuality,
      config,
    });

    for (const leg of [...state.legs]) {
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

    const entry = __probabilityPortfolioTestHooks.choosePortfolioEntry({
      remaining: sample.remaining,
      gap: sample.gap,
      upQuality: sample.upQuality,
      downQuality: sample.downQuality,
      stats,
      state,
      config,
    });
    if (!entry) continue;

    state.realizedCash -= entry.ask * config.shares;
    state.openedLegCount++;
    state.legs.push(makeLeg({ market, entry, sample, config }));
  }

  const heldLegs = [...state.legs];
  const payoutShares =
    market.resolution!.direction === "UP"
      ? heldLegs.filter((leg) => leg.side === "UP").reduce((sum, leg) => sum + leg.shares, 0)
      : heldLegs.filter((leg) => leg.side === "DOWN").reduce((sum, leg) => sum + leg.shares, 0);
  const finalPnl = state.realizedCash + payoutShares;
  for (const leg of heldLegs) {
    const legPnl = (market.resolution!.direction === leg.side ? 1 : 0) * leg.shares - leg.entryPrice * leg.shares;
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

  for (const market of markets) {
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
  const score = pnl - maxDrawdown * 0.35 + avgPnlPerTrade * 8 + winRate;
  return {
    markets: markets.length,
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
  const continuationEdges = [0.015, 0.025, 0.035];
  const reversalEdges = [0.02, 0.03, 0.04];
  const continuationScores = [0.56, 0.62];
  const reversalScores = [0.52, 0.58];
  const costBuffers = [0.008, 0.012];
  const sigmaMultipliers = [1.4, 1.8, 2.2, 2.6, 3.0];
  const maxSpreads = [0.03, 0.04];
  const takeProfits = [0.07, 0.09, 0.12];
  const maxLosses = [0.05, 0.07, 0.09];

  for (const minContinuationNetEdge of continuationEdges) {
    for (const minReversalNetEdge of reversalEdges) {
      for (const minContinuationScore of continuationScores) {
        for (const minReversalScore of reversalScores) {
          for (const costBuffer of costBuffers) {
            for (const maxSpread of maxSpreads) {
              for (const sigmaMultiplier of sigmaMultipliers) {
                for (const takeProfitCents of takeProfits) {
                  for (const maxLossCents of maxLosses) {
                    variants.push({
                      name:
                        `ce${minContinuationNetEdge}` +
                        `_re${minReversalNetEdge}` +
                        `_cs${minContinuationScore}` +
                        `_rs${minReversalScore}` +
                        `_cb${costBuffer}` +
                        `_sm${sigmaMultiplier}` +
                        `_sp${maxSpread}` +
                        `_tp${takeProfitCents}` +
                        `_sl${maxLossCents}`,
                      config: {
                        ...base,
                        minContinuationNetEdge,
                        minReversalNetEdge,
                        minContinuationScore,
                        minReversalScore,
                        costBuffer,
                        sigmaMultiplier,
                        maxSpread,
                        takeProfitCents,
                        maxLossCents,
                        catastrophicLossCents: Math.max(base.catastrophicLossCents, maxLossCents * 1.8),
                      },
                    });
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  return variants;
}

function printResult(label: string, rows: Array<{ name: string; result: ReplayResult }>, limit = 10): void {
  console.log(`\n${label}`);
  console.table(
    rows.slice(0, limit).map((row) => ({
      name: row.name,
      pnl: row.result.pnl,
      score: row.result.score,
      markets: row.result.markets,
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
    throw new Error(`not enough replayable markets in ${LOG_DIR}: ${markets.length}`);
  }

  const trainEnd = Math.floor(markets.length * 0.6);
  const validationEnd = Math.floor(markets.length * 0.8);
  const train = markets.slice(0, trainEnd);
  const validation = markets.slice(trainEnd, validationEnd);
  const test = markets.slice(validationEnd);
  const base = __probabilityPortfolioTestHooks.readProbabilityPortfolioConfig();
  const variants = buildVariants(base);

  console.log(
    `Loaded ${markets.length} markets from ${LOG_DIR}; split train=${train.length}, validation=${validation.length}, test=${test.length}`,
  );

  const trainRows = variants
    .map((variant) => ({ name: variant.name, variant, result: summarize(train, variant.config) }))
    .filter((row) => row.result.trades >= Math.max(5, Math.floor(train.length * 0.08)))
    .sort((a, b) => b.result.score - a.result.score);
  printResult("Top train candidates", trainRows);

  const validationRows = trainRows
    .slice(0, 25)
    .map((row) => ({
      name: row.name,
      variant: row.variant,
      result: summarize(validation, row.variant.config),
      trainResult: row.result,
    }))
    .sort((a, b) => b.result.score - a.result.score);
  printResult("Validation ranking from top train candidates", validationRows);

  const selected = validationRows[0];
  if (!selected) throw new Error("no candidate survived validation");

  const testResult = summarize(test, selected.variant.config, {
    includeTrades: process.env.PP_BACKTEST_DUMP_TRADES === "1",
  });
  printResult("Final holdout test", [{ name: selected.name, result: testResult }], 1);
  if (testResult.tradesDetail) {
    console.log("\nFinal holdout trades:");
    console.table(
      testResult.tradesDetail.map((trade) => ({
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
  console.log("\nSelected env overrides:");
  const selectedConfig = selected.variant.config;
  console.log(
    [
      `PP_MIN_CONTINUATION_NET_EDGE=${selectedConfig.minContinuationNetEdge}`,
      `PP_MIN_REVERSAL_NET_EDGE=${selectedConfig.minReversalNetEdge}`,
      `PP_MIN_CONTINUATION_SCORE=${selectedConfig.minContinuationScore}`,
      `PP_MIN_REVERSAL_SCORE=${selectedConfig.minReversalScore}`,
      `PP_COST_BUFFER=${selectedConfig.costBuffer}`,
      `PP_SIGMA_MULTIPLIER=${selectedConfig.sigmaMultiplier}`,
      `PP_MAX_SPREAD=${selectedConfig.maxSpread}`,
      `PP_TAKE_PROFIT_CENTS=${selectedConfig.takeProfitCents}`,
      `PP_MAX_LOSS_CENTS=${selectedConfig.maxLossCents}`,
      `PP_CATASTROPHIC_LOSS_CENTS=${selectedConfig.catastrophicLossCents}`,
    ].join("\n"),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

import { describe, expect, test } from "bun:test";
import { __probabilityPortfolioTestHooks } from "../../../engine/strategy/probability-portfolio.ts";

function quality(overrides = {}) {
  return {
    ask: 0.5,
    bid: 0.49,
    askLiquidity: 80,
    bidLiquidity: 120,
    spread: 0.01,
    depthImbalance: 0.2,
    ...overrides,
  };
}

function seededStats() {
  const stats = __probabilityPortfolioTestHooks.createPortfolioStats();
  stats.priceDeltas = [1, 1.2, 0.8, 1.1, 0.9, 1.3, 1.1, 0.7, 1, 1.2];
  stats.gapDeltas = [0.7, 0.8, 0.9, 1, 0.8, 0.9, 1.1, 1, 0.9, 1.2];
  stats.atr = 1;
  stats.gapAtr = 0.8;
  stats.gapVelocityEma = 1;
  stats.fastGapEma = 18;
  stats.slowGapEma = 14;
  stats.peakAbsGap = 20;
  stats.absGapWindow = [7, 8, 9, 10, 11, 12, 14, 15, 16, 17, 18, 19, 20];
  return stats;
}

describe("probability-portfolio entry and payoff", () => {
  test("accepts a continuation when fair probability clears ask and cost buffer", () => {
    const config = {
      ...__probabilityPortfolioTestHooks.readProbabilityPortfolioConfig({}),
      maxEntriesPerMarket: 1,
      minContinuationNetEdge: 0.01,
      minContinuationScore: 0.5,
    };
    const entry = __probabilityPortfolioTestHooks.choosePortfolioEntry({
      remaining: 120,
      gap: 20,
      upQuality: quality({ ask: 0.52, bid: 0.51 }),
      downQuality: quality({ ask: 0.49, bid: 0.48 }),
      stats: seededStats(),
      state: { legs: [], realizedCash: 0, openedLegCount: 0 },
      config,
    });

    expect(entry?.model).toBe("continuation");
    expect(entry?.side).toBe("UP");
  });

  test("counts pending entry orders against per-market limits", () => {
    const config = {
      ...__probabilityPortfolioTestHooks.readProbabilityPortfolioConfig({}),
      maxEntriesPerMarket: 1,
      maxOpenLegs: 1,
      minContinuationNetEdge: 0.01,
      minContinuationScore: 0.5,
    };
    const entry = __probabilityPortfolioTestHooks.choosePortfolioEntry({
      remaining: 120,
      gap: 20,
      upQuality: quality({ ask: 0.52, bid: 0.51 }),
      downQuality: quality({ ask: 0.49, bid: 0.48 }),
      stats: seededStats(),
      state: {
        legs: [],
        realizedCash: 0,
        openedLegCount: 0,
        pendingEntryCount: 1,
        pendingEntrySideCounts: { UP: 1, DOWN: 0 },
      },
      config,
    });

    expect(entry).toBeNull();
  });

  test("blocks opposite-side entries unless explicitly enabled", () => {
    const config = {
      ...__probabilityPortfolioTestHooks.readProbabilityPortfolioConfig({}),
      allowOppositeSides: false,
      maxOpenLegs: 2,
      maxEntriesPerMarket: 2,
      minContinuationNetEdge: 0.01,
      minContinuationScore: 0.5,
    };
    const entry = __probabilityPortfolioTestHooks.choosePortfolioEntry({
      remaining: 120,
      gap: 20,
      upQuality: quality({ ask: 0.52, bid: 0.51 }),
      downQuality: quality({ ask: 0.49, bid: 0.48 }),
      stats: seededStats(),
      state: {
        legs: [
          {
            id: "down",
            model: "reversal",
            side: "DOWN",
            tokenId: "down",
            entryPrice: 0.45,
            entryGap: -10,
            entrySideGap: 10,
            entryMs: 1,
            shares: 6,
            pFairEntry: 0.7,
            netEdgeEntry: 0.1,
            scoreEntry: 0.7,
            takeProfitPrice: 0.55,
            stopLossPrice: 0.38,
            peakSideGap: 10,
            peakBid: 0.48,
            trendInvalidSinceMs: null,
            riskExitAttempts: 0,
          },
        ],
        realizedCash: -2.7,
        openedLegCount: 1,
      },
      config,
    });

    expect(entry).toBeNull();
  });

  test("blocks continuation after the advantage-side gap stalls", () => {
    const stats = seededStats();
    stats.gapDeltas = [0.9, 1.1, 1.2, 0.05, 0, 0.04];
    const config = {
      ...__probabilityPortfolioTestHooks.readProbabilityPortfolioConfig({}),
      maxContinuationFlatTicks: 1,
      minContinuationSideVelocityShort: 0.1,
      minContinuationSideVelocityMid: 0.1,
      minContinuationNetEdge: 0.01,
      minContinuationScore: 0.5,
    };
    const entry = __probabilityPortfolioTestHooks.choosePortfolioEntry({
      remaining: 120,
      gap: 20,
      upQuality: quality({ ask: 0.52, bid: 0.51 }),
      downQuality: quality({ ask: 0.49, bid: 0.48 }),
      stats,
      state: { legs: [], realizedCash: 0, openedLegCount: 0 },
      config,
    });

    expect(entry).toBeNull();
  });

  test("allows one reversal and one continuation on the same side", () => {
    const config = {
      ...__probabilityPortfolioTestHooks.readProbabilityPortfolioConfig({}),
      allowOppositeSides: true,
      maxOpenLegs: 2,
      maxSameSideLegs: 2,
      maxEntriesPerMarket: 2,
      maxSameModelEntries: 1,
      minContinuationNetEdge: 0.01,
      minContinuationScore: 0.5,
    };
    const entry = __probabilityPortfolioTestHooks.choosePortfolioEntry({
      remaining: 120,
      gap: 20,
      upQuality: quality({ ask: 0.52, bid: 0.51 }),
      downQuality: quality({ ask: 0.49, bid: 0.48 }),
      stats: seededStats(),
      state: {
        legs: [
          {
            id: "up-reversal",
            model: "reversal",
            side: "UP",
            tokenId: "up",
            entryPrice: 0.4,
            entryGap: -12,
            entrySideGap: 12,
            entryMs: 1,
            shares: 6,
            pFairEntry: 0.7,
            netEdgeEntry: 0.1,
            scoreEntry: 0.7,
            takeProfitPrice: 0.5,
            stopLossPrice: 0.33,
            peakSideGap: 12,
            peakBid: 0.45,
            trendInvalidSinceMs: null,
            riskExitAttempts: 0,
          },
        ],
        realizedCash: -2.4,
        openedLegCount: 1,
      },
      config,
    });

    expect(entry?.model).toBe("continuation");
    expect(entry?.side).toBe("UP");
  });

  test("blocks repeated continuation chasing in the same market", () => {
    const config = {
      ...__probabilityPortfolioTestHooks.readProbabilityPortfolioConfig({}),
      allowOppositeSides: true,
      maxOpenLegs: 2,
      maxSameSideLegs: 2,
      maxEntriesPerMarket: 2,
      maxSameModelEntries: 1,
      minContinuationNetEdge: 0.01,
      minContinuationScore: 0.5,
    };
    const entry = __probabilityPortfolioTestHooks.choosePortfolioEntry({
      remaining: 120,
      gap: 20,
      upQuality: quality({ ask: 0.52, bid: 0.51 }),
      downQuality: quality({ ask: 0.49, bid: 0.48 }),
      stats: seededStats(),
      state: {
        legs: [
          {
            id: "up-continuation",
            model: "continuation",
            side: "UP",
            tokenId: "up",
            entryPrice: 0.5,
            entryGap: 12,
            entrySideGap: 12,
            entryMs: 1,
            shares: 6,
            pFairEntry: 0.7,
            netEdgeEntry: 0.1,
            scoreEntry: 0.7,
            takeProfitPrice: 0.6,
            stopLossPrice: 0.43,
            peakSideGap: 12,
            peakBid: 0.55,
            trendInvalidSinceMs: null,
            riskExitAttempts: 0,
          },
        ],
        realizedCash: -3,
        openedLegCount: 1,
      },
      config,
    });

    expect(entry).toBeNull();
  });

  test("computes guaranteed payoff from balanced UP/DOWN legs", () => {
    const view = __probabilityPortfolioTestHooks.portfolioView({
      realizedCash: -5.7,
      legs: [
        {
          id: "up",
          model: "continuation",
          side: "UP",
          tokenId: "up",
          entryPrice: 0.5,
          entryGap: 10,
          entrySideGap: 10,
          entryMs: 1,
          shares: 6,
          pFairEntry: 0.7,
          netEdgeEntry: 0.1,
          scoreEntry: 0.7,
          takeProfitPrice: 0.6,
          stopLossPrice: 0.42,
          peakSideGap: 10,
          peakBid: 0.55,
          trendInvalidSinceMs: null,
          riskExitAttempts: 0,
        },
        {
          id: "down",
          model: "reversal",
          side: "DOWN",
          tokenId: "down",
          entryPrice: 0.45,
          entryGap: 8,
          entrySideGap: -8,
          entryMs: 2,
          shares: 6,
          pFairEntry: 0.6,
          netEdgeEntry: 0.08,
          scoreEntry: 0.65,
          takeProfitPrice: 0.55,
          stopLossPrice: 0.38,
          peakSideGap: 0,
          peakBid: 0.48,
          trendInvalidSinceMs: null,
          riskExitAttempts: 0,
        },
      ],
    });

    expect(view.guaranteedPnl).toBeCloseTo(0.3);
    expect(view.balancedShares).toBe(6);
  });
});

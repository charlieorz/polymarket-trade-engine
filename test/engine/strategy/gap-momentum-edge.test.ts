import { describe, expect, test } from "bun:test";
import { __gapMomentumEdgeTestHooks } from "../../../engine/strategy/gap-momentum-edge.ts";

function mockCtx({
  upAsk = 0.58,
  upBid = 0.56,
  downAsk = 0.58,
  downBid = 0.56,
  tick = "0.01",
} = {}) {
  return {
    clobTokenIds: ["up-token", "down-token"],
    orderBook: {
      bestAskInfo(side: "UP" | "DOWN") {
        return {
          price: side === "UP" ? upAsk : downAsk,
          liquidity: 20,
        };
      },
      bestBidInfo(side: "UP" | "DOWN") {
        return {
          price: side === "UP" ? upBid : downBid,
          liquidity: 20,
        };
      },
      getTickSize() {
        return tick;
      },
    },
  } as any;
}

function readyStats() {
  return {
    ...__gapMomentumEdgeTestHooks.createEdgeStats(),
    atr: 2,
    sideVelocityEma: { UP: 0.4, DOWN: 0.4 },
    gapHistory: [4, 6, 8, 10, 12, 14, 16],
    peakSideGap: { UP: 16, DOWN: 0 },
    cumulativeGap: 700,
  };
}

const basePosition = {
  side: "UP" as const,
  tokenId: "up-token",
  entryPrice: 0.57,
  entryMs: 1_000,
  entryGap: 16,
  shares: 6,
  takeProfitPrice: 0.75,
  peakSideGap: 18,
  takeProfitOrderPlaced: false,
  finalDirectTakeProfitPlaced: false,
};

describe("gap-momentum-edge", () => {
  test("parses conservative defaults", () => {
    const config = __gapMomentumEdgeTestHooks.readGapMomentumEdgeConfig({});
    expect(config.shares).toBe(6);
    expect(config.maxEntriesPerMarket).toBe(1);
    expect(config.entryOrderType).toBe("GTC");
    expect(config.takeProfitOrderType).toBe("FOK");
    expect(config.finalDirectTakeProfitOrderType).toBe("FOK");
    expect(config.finalExitOrderType).toBe("FOK");
    expect(config.noEntryFirstSeconds).toBe(120);
    expect(config.maxEntryElapsedSeconds).toBe(250);
    expect(config.minCumulativeGap).toBe(500);
  });

  test("computes fair probability from volatility and time", () => {
    const low = __gapMomentumEdgeTestHooks.computeFairProbability({
      sideGap: 4,
      remaining: 180,
      atr: 2,
    });
    const high = __gapMomentumEdgeTestHooks.computeFairProbability({
      sideGap: 16,
      remaining: 180,
      atr: 2,
    });
    const late = __gapMomentumEdgeTestHooks.computeFairProbability({
      sideGap: 16,
      remaining: 30,
      atr: 2,
    });
    expect(high.pFair).toBeGreaterThan(low.pFair);
    expect(late.pFair).toBeGreaterThan(high.pFair);
  });

  test("uses passive GTC buy price below the ask", () => {
    expect(
      __gapMomentumEdgeTestHooks.passiveBuyPrice({
        ask: 0.58,
        bid: 0.56,
        tick: 0.01,
        maxPrice: 0.6,
      }),
    ).toBe(0.57);
  });

  test("chooses one advantage-side entry inside configured window", () => {
    const entry = __gapMomentumEdgeTestHooks.chooseEntry({
      ctx: mockCtx(),
      gap: 16,
      remaining: 180,
      elapsed: 120,
      stats: readyStats(),
      state: {
        entries: 0,
        pendingEntry: false,
        position: null,
        closing: false,
        released: false,
        settlementHoldLogged: false,
      },
      config: __gapMomentumEdgeTestHooks.readGapMomentumEdgeConfig({
        GME_MIN_NET_EDGE: "0.01",
      }),
    });

    expect(entry?.side).toBe("UP");
    expect(entry?.price).toBe(0.57);
    expect(entry?.shares).toBe(6);
  });

  test("blocks entry after elapsed 250 seconds", () => {
    const entry = __gapMomentumEdgeTestHooks.chooseEntry({
      ctx: mockCtx(),
      gap: 16,
      remaining: 45,
      elapsed: 251,
      stats: readyStats(),
      state: {
        entries: 0,
        pendingEntry: false,
        position: null,
        closing: false,
        released: false,
        settlementHoldLogged: false,
      },
      config: __gapMomentumEdgeTestHooks.readGapMomentumEdgeConfig({
        GME_MIN_NET_EDGE: "0.01",
      }),
    });
    expect(entry).toBeNull();
  });

  test("blocks entry before elapsed 120 seconds", () => {
    const entry = __gapMomentumEdgeTestHooks.chooseEntry({
      ctx: mockCtx(),
      gap: 16,
      remaining: 245,
      elapsed: 119,
      stats: readyStats(),
      state: {
        entries: 0,
        pendingEntry: false,
        position: null,
        closing: false,
        released: false,
        settlementHoldLogged: false,
      },
      config: __gapMomentumEdgeTestHooks.readGapMomentumEdgeConfig({
        GME_MIN_NET_EDGE: "0.01",
      }),
    });
    expect(entry).toBeNull();
  });

  test("requires cumulative gap to agree with the current entry side", () => {
    const entry = __gapMomentumEdgeTestHooks.chooseEntry({
      ctx: mockCtx(),
      gap: 16,
      remaining: 160,
      elapsed: 140,
      stats: {
        ...readyStats(),
        cumulativeGap: -20,
      },
      state: {
        entries: 0,
        pendingEntry: false,
        position: null,
        closing: false,
        released: false,
        settlementHoldLogged: false,
      },
      config: __gapMomentumEdgeTestHooks.readGapMomentumEdgeConfig({
        GME_MIN_NET_EDGE: "0.01",
      }),
    });
    expect(entry).toBeNull();
  });

  test("uses FOK for planned take-profit at the current bid", () => {
    const exit = __gapMomentumEdgeTestHooks.chooseExit({
      ctx: mockCtx({ upBid: 0.76, upAsk: 0.78 }),
      pos: { ...basePosition, takeProfitPrice: 0.75 },
      gap: 20,
      ask: 0.78,
      bid: 0.76,
      bidLiquidity: 20,
      remaining: 120,
      elapsed: 180,
      stats: readyStats(),
    });
    expect(exit?.orderType).toBe("FOK");
    expect(exit?.reason).toBe("planned take-profit");
    expect(exit?.price).toBe(0.76);
  });

  test("holds inside the final five seconds even with a high bid", () => {
    const exit = __gapMomentumEdgeTestHooks.chooseExit({
      ctx: mockCtx({ upBid: 0.92, upAsk: 0.93 }),
      pos: { ...basePosition },
      gap: 20,
      ask: 0.93,
      bid: 0.92,
      bidLiquidity: 20,
      remaining: 5,
      elapsed: 295,
      stats: readyStats(),
    });
    expect(exit).toBeNull();
  });

  test("uses FOK for final direct take-profit at the current bid", () => {
    const exit = __gapMomentumEdgeTestHooks.chooseExit({
      ctx: mockCtx({ upBid: 0.92, upAsk: 0.94 }),
      pos: { ...basePosition },
      gap: 20,
      ask: 0.94,
      bid: 0.92,
      bidLiquidity: 20,
      remaining: 30,
      elapsed: 270,
      stats: readyStats(),
    });
    expect(exit?.orderType).toBe("FOK");
    expect(exit?.reason).toBe("final direct take-profit");
    expect(exit?.price).toBe(0.92);
  });

  test("does not perform a losing final FOK exit", () => {
    const exit = __gapMomentumEdgeTestHooks.chooseExit({
      ctx: mockCtx({ upBid: 0.4, upAsk: 0.42 }),
      pos: { ...basePosition },
      gap: -5,
      ask: 0.42,
      bid: 0.4,
      bidLiquidity: 20,
      remaining: 20,
      elapsed: 280,
      stats: {
        ...readyStats(),
        atr: 2,
        peakSideGap: { UP: 18, DOWN: 5 },
      },
    });
    expect(exit).toBeNull();
  });
});

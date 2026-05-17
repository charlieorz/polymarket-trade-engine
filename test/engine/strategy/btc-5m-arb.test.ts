import { describe, expect, test } from "bun:test";
import { __btc5mArbTestHooks } from "../../../engine/strategy/btc-5m-arb.ts";

function mockCtx({
  upAsk = 0.58,
  upBid = 0.56,
  downAsk = 0.5,
  downBid = 0.48,
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

function baseState() {
  return {
    entryOrderSubmitted: false,
    pendingEntry: false,
    position: null,
    closing: false,
    released: false,
    settlementHoldLogged: false,
  };
}

function advantageStats() {
  return {
    ...__btc5mArbTestHooks.createEdgeStats(),
    sideVelocityEma: { UP: 0.35, DOWN: -0.35 },
    gapHistory: [4, 6, 8, 10],
    lastGap: 10,
    cumulativeGap: 120,
  };
}

function reversalStats() {
  return {
    ...__btc5mArbTestHooks.createEdgeStats(),
    sideVelocityEma: { UP: -0.35, DOWN: 0.35 },
    gapHistory: [5, 4, 3],
    lastGap: 3,
    cumulativeGap: 20,
  };
}

const basePosition = {
  kind: "advantage" as const,
  side: "UP" as const,
  tokenId: "up-token",
  entryPrice: 0.57,
  entryMs: 1_000,
  entryGap: 10,
  initialShares: 6,
  shares: 6,
  takeProfitRatio: 0.18,
  takeProfitPrice: 0.67,
  costCovered: false,
  halfStopped: false,
  holdRestToSettlement: false,
};

describe("btc-5m-arb", () => {
  test("parses the requested timing and order-type defaults", () => {
    const config = __btc5mArbTestHooks.readBtc5mArbConfig({});
    expect(config.shares).toBe(6);
    expect(config.entryStartElapsedSeconds).toBe(67);
    expect(config.entryEndElapsedSeconds).toBe(257);
    expect(config.managedExitStartElapsedSeconds).toBe(267);
    expect(config.holdOnlyStartElapsedSeconds).toBe(297);
    expect(config.entryOrderType).toBe("GTC");
    expect(config.takeProfitOrderType).toBe("GTC");
    expect(config.stopLossOrderType).toBe("FAK");
    expect(config.maxAdvantagePrice).toBe(0.65);
    expect(config.maxReversalPrice).toBe(0.52);
    expect(config.minTakeProfitRatio).toBeGreaterThanOrEqual(0.12);
  });

  test("chooses an advantage entry only inside the 67-257 second window", () => {
    const config = __btc5mArbTestHooks.readBtc5mArbConfig({
      B5A_ADV_MIN_ABS_GAP: "4",
      B5A_ADV_MIN_MOMENTUM: "0.2",
      B5A_ADV_MIN_CUMULATIVE_GAP: "30",
    });
    const entry = __btc5mArbTestHooks.chooseEntry({
      ctx: mockCtx({ upAsk: 0.58, upBid: 0.56 }),
      gap: 10,
      elapsed: 130,
      stats: advantageStats(),
      state: baseState(),
      config,
    });
    expect(entry?.kind).toBe("advantage");
    expect(entry?.side).toBe("UP");
    expect(entry?.price).toBe(0.57);
    expect(entry?.shares).toBe(6);

    expect(
      __btc5mArbTestHooks.chooseEntry({
        ctx: mockCtx(),
        gap: 10,
        elapsed: 66,
        stats: advantageStats(),
        state: baseState(),
        config,
      }),
    ).toBeNull();
    expect(
      __btc5mArbTestHooks.chooseEntry({
        ctx: mockCtx(),
        gap: 10,
        elapsed: 258,
        stats: advantageStats(),
        state: baseState(),
        config,
      }),
    ).toBeNull();
  });

  test("chooses a reversal entry below the reversal price cap", () => {
    const entry = __btc5mArbTestHooks.chooseEntry({
      ctx: mockCtx({ downAsk: 0.51, downBid: 0.49, upAsk: 0.7 }),
      gap: 3,
      elapsed: 150,
      stats: reversalStats(),
      state: baseState(),
      config: __btc5mArbTestHooks.readBtc5mArbConfig({
        B5A_REV_MAX_ABS_GAP: "4",
        B5A_REV_MIN_MOMENTUM: "0.2",
      }),
    });
    expect(entry?.kind).toBe("reversal");
    expect(entry?.side).toBe("DOWN");
    expect(entry?.price).toBeLessThanOrEqual(0.52);
  });

  test("does not submit a second entry after any entry order has been submitted", () => {
    const entry = __btc5mArbTestHooks.chooseEntry({
      ctx: mockCtx(),
      gap: 10,
      elapsed: 150,
      stats: advantageStats(),
      state: { ...baseState(), entryOrderSubmitted: true },
    });
    expect(entry).toBeNull();
  });

  test("uses dynamic take-profit with a minimum 12 percent ratio", () => {
    const ratio = __btc5mArbTestHooks.dynamicTakeProfitRatio({
      kind: "advantage",
      price: 0.64,
      absGap: 4,
      momentum: 0.18,
      maxPrice: 0.65,
      config: __btc5mArbTestHooks.readBtc5mArbConfig({}),
    });
    expect(ratio).toBeGreaterThanOrEqual(0.12);
  });

  test("takes profit but never stops loss in the entry window", () => {
    const tp = __btc5mArbTestHooks.chooseExit({
      ctx: mockCtx({ upBid: 0.68, upAsk: 0.69 }),
      pos: { ...basePosition },
      gap: -8,
      ask: 0.69,
      bid: 0.68,
      bidLiquidity: 20,
      elapsed: 180,
    });
    expect(tp?.reason).toBe("dynamic take-profit");
    expect(tp?.orderType).toBe("GTC");

    const stop = __btc5mArbTestHooks.chooseExit({
      ctx: mockCtx({ upBid: 0.2, upAsk: 0.22 }),
      pos: { ...basePosition },
      gap: -20,
      ask: 0.22,
      bid: 0.2,
      bidLiquidity: 20,
      elapsed: 180,
    });
    expect(stop).toBeNull();
  });

  test("applies managed take-profit priority in the 267-297 second window", () => {
    const priceTp = __btc5mArbTestHooks.chooseExit({
      ctx: mockCtx({ upBid: 0.88, upAsk: 0.9 }),
      pos: { ...basePosition },
      gap: 10,
      ask: 0.9,
      bid: 0.88,
      bidLiquidity: 20,
      elapsed: 270,
    });
    expect(priceTp?.reason).toBe("managed price take-profit");
    expect(priceTp?.shares).toBe(6);

    const fullTp = __btc5mArbTestHooks.chooseExit({
      ctx: mockCtx({ upBid: 0.8, upAsk: 0.82 }),
      pos: { ...basePosition },
      gap: 10,
      ask: 0.82,
      bid: 0.8,
      bidLiquidity: 20,
      elapsed: 270,
    });
    expect(fullTp?.reason).toBe("managed full take-profit");
    expect(fullTp?.shares).toBe(6);

    const costCover = __btc5mArbTestHooks.chooseExit({
      ctx: mockCtx({ upBid: 0.62, upAsk: 0.64 }),
      pos: { ...basePosition },
      gap: 10,
      ask: 0.64,
      bid: 0.62,
      bidLiquidity: 20,
      elapsed: 270,
    });
    expect(costCover?.reason).toBe("managed cost-cover take-profit");
    expect(costCover?.shares).toBeLessThan(6);
    expect(costCover?.holdRestAfterFill).toBe(true);
  });

  test("skips stop-loss when gap still agrees with the held side", () => {
    const exit = __btc5mArbTestHooks.chooseExit({
      ctx: mockCtx({ upBid: 0.2, upAsk: 0.22 }),
      pos: { ...basePosition },
      gap: 12,
      ask: 0.22,
      bid: 0.2,
      bidLiquidity: 20,
      elapsed: 270,
    });
    expect(exit).toBeNull();
  });

  test("uses FAK for managed half and full stop-loss exits", () => {
    const half = __btc5mArbTestHooks.chooseExit({
      ctx: mockCtx({ upBid: 0.27, upAsk: 0.29 }),
      pos: { ...basePosition },
      gap: -12,
      ask: 0.29,
      bid: 0.27,
      bidLiquidity: 20,
      elapsed: 270,
    });
    expect(half?.reason).toBe("managed half stop-loss");
    expect(half?.orderType).toBe("FAK");
    expect(half?.shares).toBe(3);
    expect(half?.holdRestAfterFill).toBe(true);

    const full = __btc5mArbTestHooks.chooseExit({
      ctx: mockCtx({ upBid: 0.18, upAsk: 0.2 }),
      pos: { ...basePosition },
      gap: -12,
      ask: 0.2,
      bid: 0.18,
      bidLiquidity: 20,
      elapsed: 270,
    });
    expect(full?.reason).toBe("managed full stop-loss");
    expect(full?.orderType).toBe("FAK");
    expect(full?.shares).toBe(6);
  });

  test("holds through settlement from second 297 onward", () => {
    const exit = __btc5mArbTestHooks.chooseExit({
      ctx: mockCtx({ upBid: 0.95, upAsk: 0.96 }),
      pos: { ...basePosition },
      gap: -20,
      ask: 0.96,
      bid: 0.95,
      bidLiquidity: 20,
      elapsed: 297,
    });
    expect(exit).toBeNull();
  });
});

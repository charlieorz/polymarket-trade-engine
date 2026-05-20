import { describe, expect, test } from "bun:test";
import { __btc5mHfArbTestHooks } from "../../../engine/strategy/btc-5m-hf-arb.ts";

function mockCtx({
  upAsk = 0.52,
  upBid = 0.5,
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
    pendingEntry: false,
    position: null,
    closing: false,
    realizedPnl: 0,
    marketLossBlocked: false,
    released: false,
    settlementHoldLogged: false,
  };
}

function advantageStats() {
  return {
    ...__btc5mHfArbTestHooks.createEdgeStats(),
    sideVelocityEma: { UP: 0.35, DOWN: -0.35 },
    gapHistory: [4, 6, 8, 10],
    lastGap: 10,
    cumulativeGap: 120,
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
  halfStopLossRatio: 0.3,
  fullStopLossRatio: 0.5,
  costCovered: false,
  halfStopped: false,
  holdRestToSettlement: false,
  recentTrendFactor: 0,
};

describe("btc-5m-hf-arb", () => {
  test("parses the requested timing and order-type defaults", () => {
    const config = __btc5mHfArbTestHooks.readBtc5mHfArbConfig({});
    expect(config.shares).toBe(6);
    expect(config.maxMarketLoss).toBe(2);
    expect(config.entryStartElapsedSeconds).toBe(30);
    expect(config.entryEndElapsedSeconds).toBe(280);
    expect(config.managedExitStartElapsedSeconds).toBe(80);
    expect(config.holdOnlyStartElapsedSeconds).toBe(300);
    expect(config.entryOrderType).toBe("FAK");
    expect(config.takeProfitOrderType).toBe("FAK");
    expect(config.stopLossOrderType).toBe("FAK");
    expect(config.minEntryPrice).toBe(0.48);
    expect(config.maxEntryPrice).toBe(0.52);
    expect(config.maxAdvantagePrice).toBe(0.52);
    expect(config.maxSpread).toBe(0.05);
    expect(config.advantageMinAbsGap).toBe(2.5);
    expect(config.advantageMinMomentum).toBe(0.12);
    expect(config.advantageMinCumulativeGap).toBe(10);
    expect(config.takeProfitPriceImmediate).toBe(0.66);
    expect(config.fullTakeProfitRatio).toBe(0.14);
    expect(config.halfStopLossRatio).toBe(0.24);
    expect(config.fullStopLossRatio).toBe(0.24);
    expect(config.stopLossStartElapsedSeconds).toBe(60);
    expect(config.stopLossMinHoldSeconds).toBe(8);
    expect(config.minTakeProfitRatio).toBeGreaterThanOrEqual(0.02);
    expect(config.entryTakeProfitEnabled).toBe(true);
    expect(config.managedTakeProfitEnabled).toBe(true);
    expect(config.stopLossEnabled).toBe(true);
    expect(config.smallProfitExitMode).toBe("full_exit");
    expect(config.halfStopHoldRestToSettlement).toBe(false);
    expect(config.recentResultWindow).toBe(10);
    expect(config.recentCandleWindow).toBe(50);
  });

  test("chooses an advantage entry only inside the configured entry window", () => {
    const config = __btc5mHfArbTestHooks.readBtc5mHfArbConfig({
      B5H_ADV_MIN_ABS_GAP: "4",
      B5H_ADV_MIN_MOMENTUM: "0.2",
      B5H_ADV_MIN_CUMULATIVE_GAP: "30",
    });
    const entry = __btc5mHfArbTestHooks.chooseEntry({
      ctx: mockCtx({ upAsk: 0.52, upBid: 0.5 }),
      gap: 10,
      elapsed: 130,
      stats: advantageStats(),
      state: baseState(),
      config,
    });
    expect(entry?.kind).toBe("advantage");
    expect(entry?.side).toBe("UP");
    expect(entry?.price).toBe(0.52);
    expect(entry?.shares).toBe(6);

    expect(
      __btc5mHfArbTestHooks.chooseEntry({
        ctx: mockCtx(),
        gap: 10,
        elapsed: 29,
        stats: advantageStats(),
        state: baseState(),
        config,
      }),
    ).toBeNull();
    expect(
      __btc5mHfArbTestHooks.chooseEntry({
        ctx: mockCtx(),
        gap: 10,
        elapsed: 281,
        stats: advantageStats(),
        state: baseState(),
        config,
      }),
    ).toBeNull();
  });

  test("does not place reversal entries when advantage conditions are absent", () => {
    const entry = __btc5mHfArbTestHooks.chooseEntry({
      ctx: mockCtx({ downAsk: 0.51, downBid: 0.49, upAsk: 0.7 }),
      gap: 3,
      elapsed: 150,
      stats: {
        ...__btc5mHfArbTestHooks.createEdgeStats(),
        sideVelocityEma: { UP: -0.35, DOWN: 0.35 },
        gapHistory: [5, 4, 3],
        lastGap: 3,
        cumulativeGap: -20,
      },
      state: baseState(),
      config: __btc5mHfArbTestHooks.readBtc5mHfArbConfig({
        B5H_ADV_MIN_ABS_GAP: "2",
        B5H_ADV_MIN_MOMENTUM: "0.2",
        B5H_ADV_MIN_CUMULATIVE_GAP: "5",
      }),
    });
    expect(entry).toBeNull();
  });

  test("blocks new entries while an order or position is active, or after market loss limit", () => {
    const entry = __btc5mHfArbTestHooks.chooseEntry({
      ctx: mockCtx(),
      gap: 10,
      elapsed: 150,
      stats: advantageStats(),
      state: { ...baseState(), pendingEntry: true },
    });
    expect(entry).toBeNull();
    expect(
      __btc5mHfArbTestHooks.chooseEntry({
        ctx: mockCtx(),
        gap: 10,
        elapsed: 150,
        stats: advantageStats(),
        state: { ...baseState(), marketLossBlocked: true },
      }),
    ).toBeNull();
  });

  test("uses recent 50-window candles as a directional factor", () => {
    const candles = Array.from({ length: 50 }, (_, index) => ({
      open: 100 + index,
      high: 103 + index,
      low: 99 + index,
      close: 102 + index,
      direction: "UP" as const,
    }));
    const factor = __btc5mHfArbTestHooks.recentTrendFactor(
      "UP",
      candles,
      __btc5mHfArbTestHooks.readBtc5mHfArbConfig({}),
    );
    expect(factor).toBeGreaterThan(0);

    const blocked = __btc5mHfArbTestHooks.chooseEntry({
      ctx: mockCtx({ upAsk: 0.52, upBid: 0.5 }),
      gap: 10,
      elapsed: 130,
      stats: advantageStats(),
      state: baseState(),
      recentCandles: candles,
      config: __btc5mHfArbTestHooks.readBtc5mHfArbConfig({
        B5H_RECENT_TREND_MIN_BIAS: "0.9",
      }),
    });
    expect(blocked).toBeNull();
  });

  test("uses dynamic take-profit with a higher minimum entry-window ratio", () => {
    const ratio = __btc5mHfArbTestHooks.dynamicTakeProfitRatio({
      price: 0.64,
      absGap: 4,
      momentum: 0.18,
      maxPrice: 0.65,
      config: __btc5mHfArbTestHooks.readBtc5mHfArbConfig({}),
    });
    expect(ratio).toBeGreaterThanOrEqual(0.06);
  });

  test("takes entry-window take-profit and allows enabled entry-window stop-loss", () => {
    const tp = __btc5mHfArbTestHooks.chooseExit({
      ctx: mockCtx({ upBid: 0.68, upAsk: 0.69 }),
      pos: { ...basePosition },
      gap: -8,
      ask: 0.69,
      bid: 0.68,
      bidLiquidity: 20,
      elapsed: 180,
      config: __btc5mHfArbTestHooks.readBtc5mHfArbConfig({
        B5H_ENTRY_TAKE_PROFIT_ENABLED: "true",
      }),
    });
    expect(tp?.reason).toBe("dynamic take-profit");
    expect(tp?.orderType).toBe("FAK");

    const disabledStop = __btc5mHfArbTestHooks.chooseExit({
      ctx: mockCtx({ upBid: 0.2, upAsk: 0.22 }),
      pos: { ...basePosition, fullStopLossRatio: 0.67 },
      gap: -20,
      ask: 0.22,
      bid: 0.2,
      bidLiquidity: 20,
      elapsed: 180,
      config: __btc5mHfArbTestHooks.readBtc5mHfArbConfig({
        B5H_STOP_LOSS_ENABLED: "false",
      }),
    });
    expect(disabledStop).toBeNull();

    const enabledStop = __btc5mHfArbTestHooks.chooseExit({
      ctx: mockCtx({ upBid: 0.2, upAsk: 0.22 }),
      pos: { ...basePosition, fullStopLossRatio: 0.67 },
      gap: -20,
      ask: 0.22,
      bid: 0.2,
      bidLiquidity: 20,
      elapsed: 180,
      config: __btc5mHfArbTestHooks.readBtc5mHfArbConfig({
        B5H_STOP_LOSS_ENABLED: "true",
        B5H_FULL_STOP_LOSS_RATIO: "0.67",
      }),
    });
    expect(enabledStop?.reason).toBe("managed half stop-loss");
  });

  test("applies managed take-profit priority in the managed-exit window", () => {
    const priceTp = __btc5mHfArbTestHooks.chooseExit({
      ctx: mockCtx({ upBid: 0.88, upAsk: 0.9 }),
      pos: { ...basePosition },
      gap: 10,
      ask: 0.9,
      bid: 0.88,
      bidLiquidity: 20,
      elapsed: 230,
      config: __btc5mHfArbTestHooks.readBtc5mHfArbConfig({
        B5H_ENTRY_TAKE_PROFIT_ENABLED: "false",
      }),
    });
    expect(priceTp?.reason).toBe("managed price take-profit");
    expect(priceTp?.shares).toBe(6);

    const fullTp = __btc5mHfArbTestHooks.chooseExit({
      ctx: mockCtx({ upBid: 0.8, upAsk: 0.82 }),
      pos: { ...basePosition },
      gap: 10,
      ask: 0.82,
      bid: 0.8,
      bidLiquidity: 20,
      elapsed: 230,
      config: __btc5mHfArbTestHooks.readBtc5mHfArbConfig({
        B5H_ENTRY_TAKE_PROFIT_ENABLED: "false",
        B5H_FULL_TAKE_PROFIT_RATIO: "0.28",
        B5H_TAKE_PROFIT_PRICE_IMMEDIATE: "0.9",
      }),
    });
    expect(fullTp?.reason).toBe("managed full take-profit");
    expect(fullTp?.shares).toBe(6);

    const costCover = __btc5mHfArbTestHooks.chooseExit({
      ctx: mockCtx({ upBid: 0.62, upAsk: 0.64 }),
      pos: { ...basePosition },
      gap: 10,
      ask: 0.64,
      bid: 0.62,
      bidLiquidity: 20,
      elapsed: 230,
      config: __btc5mHfArbTestHooks.readBtc5mHfArbConfig({
        B5H_ENTRY_TAKE_PROFIT_ENABLED: "false",
        B5H_TAKE_PROFIT_PRICE_IMMEDIATE: "0.9",
        B5H_FULL_TAKE_PROFIT_RATIO: "0.2",
      }),
    });
    expect(costCover?.reason).toBe("managed small-profit full-exit");
    expect(costCover?.shares).toBe(6);
    expect(costCover?.holdRestAfterFill).toBe(false);

    const legacyCostCover = __btc5mHfArbTestHooks.chooseExit({
      ctx: mockCtx({ upBid: 0.62, upAsk: 0.64 }),
      pos: { ...basePosition },
      gap: 10,
      ask: 0.64,
      bid: 0.62,
      bidLiquidity: 20,
      elapsed: 230,
      config: __btc5mHfArbTestHooks.readBtc5mHfArbConfig({
        B5H_ENTRY_TAKE_PROFIT_ENABLED: "false",
        B5H_TAKE_PROFIT_PRICE_IMMEDIATE: "0.9",
        B5H_FULL_TAKE_PROFIT_RATIO: "0.2",
        B5H_SMALL_PROFIT_EXIT_MODE: "cost_cover_hold",
      }),
    });
    expect(legacyCostCover?.reason).toBe("managed cost-cover take-profit");
    expect(legacyCostCover?.shares).toBeLessThan(6);
    expect(legacyCostCover?.holdRestAfterFill).toBe(true);
  });

  test("skips stop-loss when gap still agrees with the held side", () => {
    const exit = __btc5mHfArbTestHooks.chooseExit({
      ctx: mockCtx({ upBid: 0.2, upAsk: 0.22 }),
      pos: { ...basePosition },
      gap: 12,
      ask: 0.22,
      bid: 0.2,
      bidLiquidity: 20,
      elapsed: 230,
      config: __btc5mHfArbTestHooks.readBtc5mHfArbConfig({
        B5H_STOP_LOSS_ENABLED: "true",
        B5H_FULL_STOP_LOSS_RATIO: "0.67",
      }),
    });
    expect(exit).toBeNull();
  });

  test("uses FAK for managed half and full stop-loss exits", () => {
    const half = __btc5mHfArbTestHooks.chooseExit({
      ctx: mockCtx({ upBid: 0.27, upAsk: 0.29 }),
      pos: { ...basePosition, fullStopLossRatio: 0.67 },
      gap: -12,
      ask: 0.29,
      bid: 0.27,
      bidLiquidity: 20,
      elapsed: 230,
      config: __btc5mHfArbTestHooks.readBtc5mHfArbConfig({
        B5H_STOP_LOSS_ENABLED: "true",
        B5H_FULL_STOP_LOSS_RATIO: "0.67",
      }),
    });
    expect(half?.reason).toBe("managed half stop-loss");
    expect(half?.orderType).toBe("FAK");
    expect(half?.shares).toBe(3);
    expect(half?.holdRestAfterFill).toBe(false);

    const legacyHalf = __btc5mHfArbTestHooks.chooseExit({
      ctx: mockCtx({ upBid: 0.27, upAsk: 0.29 }),
      pos: { ...basePosition, fullStopLossRatio: 0.67 },
      gap: -12,
      ask: 0.29,
      bid: 0.27,
      bidLiquidity: 20,
      elapsed: 230,
      config: __btc5mHfArbTestHooks.readBtc5mHfArbConfig({
        B5H_STOP_LOSS_ENABLED: "true",
        B5H_FULL_STOP_LOSS_RATIO: "0.67",
        B5H_HALF_STOP_HOLD_REST_TO_SETTLEMENT: "true",
      }),
    });
    expect(legacyHalf?.reason).toBe("managed half stop-loss");
    expect(legacyHalf?.holdRestAfterFill).toBe(true);

    const full = __btc5mHfArbTestHooks.chooseExit({
      ctx: mockCtx({ upBid: 0.18, upAsk: 0.2 }),
      pos: { ...basePosition },
      gap: -12,
      ask: 0.2,
      bid: 0.18,
      bidLiquidity: 20,
      elapsed: 230,
      config: __btc5mHfArbTestHooks.readBtc5mHfArbConfig({
        B5H_STOP_LOSS_ENABLED: "true",
      }),
    });
    expect(full?.reason).toBe("managed full stop-loss");
    expect(full?.orderType).toBe("FAK");
    expect(full?.shares).toBe(6);
  });

  test("holds through settlement from second 300 onward", () => {
    const exit = __btc5mHfArbTestHooks.chooseExit({
      ctx: mockCtx({ upBid: 0.95, upAsk: 0.96 }),
      pos: { ...basePosition },
      gap: -20,
      ask: 0.96,
      bid: 0.95,
      bidLiquidity: 20,
      elapsed: 300,
    });
    expect(exit).toBeNull();
  });
});

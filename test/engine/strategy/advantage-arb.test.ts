import { describe, expect, test } from "bun:test";
import { __advantageArbTestHooks } from "../../../engine/strategy/advantage-arb.ts";

const basePosition = {
  side: "UP" as const,
  tokenId: "up-token",
  entryPrice: 0.76,
  entryGap: 10.9,
  entryAbsGap: 10.9,
  entryMs: 1_000,
  shares: 6,
  takeProfitPrice: 0.86,
  stopLossPrice: 0.64,
  peakSideGap: 22.88,
  peakBid: 0.87,
  adverseSinceMs: null,
  velocityAdverseSinceMs: null,
  settlementInvalidSinceMs: null,
  riskExitAttempts: 0,
};

function statsWith(overrides = {}) {
  return {
    ...__advantageArbTestHooks.createEdgeStats(),
    atr: 0.84,
    ...overrides,
  };
}

describe("advantage-arb risk exits", () => {
  test("parses interval and ATR defaults from env-like input", () => {
    expect(__advantageArbTestHooks.readConfig({}).tickIntervalMs).toBe(200);
    expect(__advantageArbTestHooks.readConfig({}).statsIntervalMs).toBe(1000);
    expect(__advantageArbTestHooks.readConfig({}).atrPeriod).toBe(14);
    expect(
      __advantageArbTestHooks.readConfig({
        ADV_ARB_TICK_INTERVAL_MS: "100",
        ADV_ARB_ATR_PERIOD: "21",
      }).atrPeriod,
    ).toBe(21);
  });

  test("updates ATR with configurable periods", () => {
    for (const period of [7, 14, 21]) {
      const stats = __advantageArbTestHooks.createEdgeStats();
      const config = __advantageArbTestHooks.readConfig({
        ADV_ARB_ATR_PERIOD: String(period),
        ADV_ARB_STATS_INTERVAL_MS: "1000",
      });
      __advantageArbTestHooks.updateStats(stats, 100, 10, 1_000, config);
      __advantageArbTestHooks.updateStats(stats, 104, 14, 2_000, config);
      expect(stats.atr).toBe(4);
      __advantageArbTestHooks.updateStats(stats, 106, 16, 3_000, config);
      expect(stats.atr).toBeCloseTo((4 * (period - 1) + 2) / period, 6);
    }
  });

  test("computes entry signal strength safely", () => {
    expect(__advantageArbTestHooks.computeEntrySignalStrength(8, null)).toBeNull();
    expect(__advantageArbTestHooks.computeEntrySignalStrength(8, 0)).toBeGreaterThan(
      1_000_000,
    );
    expect(__advantageArbTestHooks.computeEntrySignalStrength(8, 2)).toBe(4);
  });

  test("blocks entry in the first and last configured windows", () => {
    const config = __advantageArbTestHooks.readConfig({
      ADV_ARB_NO_ENTRY_FIRST_SECONDS: "5",
      ADV_ARB_NO_ENTRY_LAST_SECONDS: "45",
    });
    expect(
      __advantageArbTestHooks.canEnterByTime({
        now: 1_004,
        slotStartMs: 1_000,
        slotEndMs: 301_000,
        remaining: 240,
        config,
      }).reason,
    ).toBe("first-window-block");
    expect(
      __advantageArbTestHooks.canEnterByTime({
        now: 260_500,
        slotStartMs: 1_000,
        slotEndMs: 301_000,
        remaining: 40,
        config,
      }).reason,
    ).toBe("last-window-block");
  });

  test("uses a dynamic stop price based on entry ask", () => {
    expect(__advantageArbTestHooks.plannedStopLossPrice(0.76)).toBe(0.64);
    expect(__advantageArbTestHooks.plannedStopLossPrice(0.52)).toBe(0.48);
  });

  test("locks the planned take profit when bid and liquidity are sufficient", () => {
    const exit = __advantageArbTestHooks.shouldTakeProfit({
      pos: { ...basePosition },
      gap: 15.47,
      bid: 0.86,
      bidLiquidity: 494,
      remaining: 208,
      stats: statsWith(),
    });

    expect(exit).toEqual({
      price: 0.86,
      reason: "planned take-profit",
      mode: "planned",
    });
  });

  test("does not lock planned take profit into an insufficient top bid", () => {
    const exit = __advantageArbTestHooks.shouldTakeProfit({
      pos: { ...basePosition, peakSideGap: 15.47 },
      gap: 15.47,
      bid: 0.86,
      bidLiquidity: 2,
      remaining: 208,
      stats: statsWith(),
    });

    expect(exit).toBeNull();
  });

  test("delays planned take profit while gap trend still supports the position", () => {
    const exit = __advantageArbTestHooks.shouldTakeProfit({
      pos: { ...basePosition, peakSideGap: 24 },
      gap: 23,
      bid: 0.86,
      bidLiquidity: 494,
      remaining: 180,
      stats: statsWith({
        gapVelocityEma: 0.4,
        gapVelocityHistory: [0.2, 0.3, 0.1, 0.4],
      }),
    });

    expect(exit).toBeNull();
  });

  test("blocks obvious retrace entry after peak side gap weakens", () => {
    const stats = __advantageArbTestHooks.createEdgeStats();
    stats.peakSideGapBySide.DOWN = 20;
    stats.gapVelocityEma = 1;
    stats.weakTrendSinceMsBySide.DOWN = 1_000;
    const result = __advantageArbTestHooks.detectAntiRetraceEntry({
      stats,
      side: "DOWN",
      currentSideGap: 9,
      entrySignalStrength: 2,
      now: 3_500,
      config: __advantageArbTestHooks.readConfig({
        ADV_ARB_ENTRY_WEAK_TREND_CONFIRM_MS: "2000",
      }),
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("weak-side-gap-velocity");
  });

  test("exits on price stop after the minimum hold time", () => {
    const exit = __advantageArbTestHooks.shouldEarlyStopLoss({
      pos: { ...basePosition },
      gap: 8.2,
      bid: 0.63,
      now: basePosition.entryMs + 3_001,
      remaining: 170,
      stats: statsWith(),
    });

    expect(exit?.price).toBe(0.63);
    expect(exit?.reason).toBe("price stop-loss");
  });

  test("prefers gap retrace stop after confirmation", () => {
    const exit = __advantageArbTestHooks.shouldEarlyStopLoss({
      pos: {
        ...basePosition,
        adverseSinceMs: basePosition.entryMs + 3_000,
      },
      gap: 0.8,
      bid: 0.7,
      now: basePosition.entryMs + 5_100,
      remaining: 170,
      stats: statsWith(),
    });

    expect(exit?.reason).toBe("gap retrace stop-loss");
    expect(exit?.mode).toBe("gap-retrace");
  });

  test("invalidates settlement hold when side gap rapidly deteriorates", () => {
    const pos = {
      ...basePosition,
      peakSideGap: 20,
      settlementInvalidSinceMs: 10_000,
    };
    const view = __advantageArbTestHooks.settlementView({
      pos,
      gap: 9,
      bid: 0.7,
      remaining: 20,
      atr: 0.5,
      stats: statsWith({ gapVelocityEma: -1 }),
      now: 12_000,
      config: __advantageArbTestHooks.readConfig({
        ADV_ARB_SETTLEMENT_INVALIDATE_CONFIRM_MS: "1500",
      }),
    });

    expect(view.holdToSettlement).toBe(false);
    expect(view.holdInvalidated).toBe(true);
  });
});

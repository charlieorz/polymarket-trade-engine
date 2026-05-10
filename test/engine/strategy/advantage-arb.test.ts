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
};

const stats = {
  atr: 0.84,
  gapVelocity: null,
  lastPrice: null,
  lastGap: null,
  lastUpdateMs: 0,
};

describe("advantage-arb risk exits", () => {
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
      stats,
    });

    expect(exit).toEqual({ price: 0.86, reason: "planned take-profit" });
  });

  test("does not lock planned take profit into an insufficient top bid", () => {
    const exit = __advantageArbTestHooks.shouldTakeProfit({
      pos: { ...basePosition, peakSideGap: 15.47 },
      gap: 15.47,
      bid: 0.86,
      bidLiquidity: 2,
      remaining: 208,
      stats,
    });

    expect(exit).toBeNull();
  });

  test("exits on price stop after the minimum hold time", () => {
    const exit = __advantageArbTestHooks.shouldEarlyStopLoss({
      pos: { ...basePosition },
      gap: 8.2,
      bid: 0.63,
      now: basePosition.entryMs + 3_001,
      remaining: 170,
      stats,
    });

    expect(exit?.price).toBe(0.63);
    expect(exit?.reason).toBe("price stop-loss");
  });
});

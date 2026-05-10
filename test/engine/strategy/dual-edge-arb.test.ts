import { describe, expect, test } from "bun:test";
import { __dualEdgeArbTestHooks } from "../../../engine/strategy/dual-edge-arb.ts";

type Side = "UP" | "DOWN";

function quality(overrides = {}) {
  return {
    ask: 0.62,
    bid: 0.61,
    askLiquidity: 80,
    bidLiquidity: 120,
    spread: 0.01,
    depthImbalance: 0.2,
    ...overrides,
  };
}

function seededStats(params: {
  gapDeltas: number[];
  priceDeltas?: number[];
  absGapWindow?: number[];
  peakAbsGap?: number;
  fastGapEma?: number;
  slowGapEma?: number;
  rsi?: number | null;
  quotesSide?: Side;
}) {
  const stats = __dualEdgeArbTestHooks.createSignalStats();
  stats.gapDeltas = params.gapDeltas;
  stats.priceDeltas = params.priceDeltas ?? params.gapDeltas;
  stats.absGapWindow =
    params.absGapWindow ?? [4, 5, 6, 7, 8, 9, 10, 11, 12, 12.5, 13, 13.5, 14];
  stats.peakAbsGap = params.peakAbsGap ?? 16;
  stats.atr = 1.5;
  stats.gapAtr = 1.2;
  stats.gapVelocityEma = params.gapDeltas.at(-1) ?? 0;
  stats.fastGapEma = params.fastGapEma ?? 14;
  stats.slowGapEma = params.slowGapEma ?? 10;
  if (params.rsi !== undefined) {
    Object.defineProperty(stats.rsi, "value", { value: params.rsi });
  }
  const side = params.quotesSide ?? "UP";
  stats.quotes[side] = [
    { ts: 1_000, ask: 0.59, bid: 0.56, spread: 0.03 },
    { ts: 4_000, ask: 0.62, bid: 0.61, spread: 0.01 },
  ];
  return stats;
}

describe("dual-edge-arb entry gates", () => {
  test("accepts a continuation only when gap, trend, PGR, price, and edge align", () => {
    const entry = __dualEdgeArbTestHooks.evaluateContinuationCandidate({
      side: "UP",
      gap: 25,
      remaining: 140,
      quality: quality({ ask: 0.5, bid: 0.49, bidLiquidity: 180 }),
      stats: seededStats({
        gapDeltas: [0.8, 0.9, 1, 1.1, 1.2, 1, 1.1, 1.2, 1.1, 1.2],
        peakAbsGap: 25,
        fastGapEma: 25,
        slowGapEma: 18,
        rsi: 70,
      }),
    });

    expect(entry?.model).toBe("continuation");
    expect(entry?.side).toBe("UP");
  });

  test("blocks continuation entries after the advantage has already retraced", () => {
    const entry = __dualEdgeArbTestHooks.evaluateContinuationCandidate({
      side: "UP",
      gap: 15,
      remaining: 140,
      quality: quality(),
      stats: seededStats({
        gapDeltas: [0.4, 0.5, 0.2, -0.2, -0.3, -0.4],
        peakAbsGap: 24,
        fastGapEma: 14,
        slowGapEma: 15,
        rsi: 42,
      }),
    });

    expect(entry).toBeNull();
  });

  test("requires reversal candidates to move toward zero with weak-side bid confirmation", () => {
    const stats = seededStats({
      gapDeltas: [-1.8, -1.2, -0.7, -0.2, 0.5, 0.8, 1.1, 1.2, 1.3, 1.4],
      absGapWindow: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17],
      peakAbsGap: 28,
      fastGapEma: -15,
      slowGapEma: -18,
      rsi: 61,
      quotesSide: "UP",
    });
    stats.quotes.UP = [
      { ts: 1_000, ask: 0.37, bid: 0.27, spread: 0.1 },
      { ts: 4_000, ask: 0.39, bid: 0.38, spread: 0.01 },
    ];
    const entry = __dualEdgeArbTestHooks.evaluateReversalCandidate({
      side: "UP",
      gap: -18,
      remaining: 90,
      quality: quality({ ask: 0.39, bid: 0.38 }),
      stats,
    });

    expect(entry?.model).toBe("reversal");
    expect(entry?.side).toBe("UP");
  });

  test("blocks reversal candidates without weak-side bid improvement", () => {
    const stats = seededStats({
      gapDeltas: [-1.8, -1.2, -0.7, -0.2, 0.5, 0.8, 1.1, 1.2, 1.3, 1.4],
      absGapWindow: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17],
      peakAbsGap: 24,
      fastGapEma: -15,
      slowGapEma: -18,
      rsi: 61,
      quotesSide: "UP",
    });
    stats.quotes.UP = [
      { ts: 1_000, ask: 0.39, bid: 0.39, spread: 0 },
      { ts: 4_000, ask: 0.39, bid: 0.38, spread: 0.01 },
    ];

    const entry = __dualEdgeArbTestHooks.evaluateReversalCandidate({
      side: "UP",
      gap: -18,
      remaining: 90,
      quality: quality({ ask: 0.39, bid: 0.38 }),
      stats,
    });

    expect(entry).toBeNull();
  });
});

describe("dual-edge-arb exits", () => {
  const basePosition = {
    model: "continuation" as const,
    side: "UP" as const,
    tokenId: "up-token",
    entryPrice: 0.62,
    entryGap: 15,
    entryAbsGap: 15,
    entrySideGap: 15,
    entryMs: 1_000,
    shares: 6,
    pFairEntry: 0.85,
    netEdgeEntry: 0.12,
    takeProfitPrice: 0.7,
    stopLossPrice: 0.54,
    peakSideGap: 18,
    peakBid: 0.71,
    trendInvalidSinceMs: null,
    riskExitAttempts: 0,
  };

  test("does not stop out a fresh position on a small price dip while trend still supports it", () => {
    const exit = __dualEdgeArbTestHooks.shouldExit({
      pos: { ...basePosition },
      gap: 16,
      bid: 0.57,
      remaining: 150,
      now: 5_000,
      stats: seededStats({
        gapDeltas: [0.2, 0.3, 0.4, 0.5],
        peakAbsGap: 18,
        fastGapEma: 16,
        slowGapEma: 13,
        rsi: 60,
      }),
    });

    expect(exit).toBeNull();
  });

  test("lets a winning trend run instead of taking conservative profit immediately", () => {
    const exit = __dualEdgeArbTestHooks.shouldExit({
      pos: { ...basePosition, peakBid: 0.7 },
      gap: 17,
      bid: 0.7,
      remaining: 150,
      now: 20_000,
      stats: seededStats({
        gapDeltas: [0.2, 0.4, 0.5, 0.6],
        peakAbsGap: 18,
        fastGapEma: 17,
        slowGapEma: 14,
        rsi: 64,
      }),
    });

    expect(exit).toBeNull();
  });

  test("exits a confirmed trend invalidation after the hold window", () => {
    const pos = {
      ...basePosition,
      trendInvalidSinceMs: 14_000,
    };
    const exit = __dualEdgeArbTestHooks.shouldExit({
      pos,
      gap: 2,
      bid: 0.55,
      remaining: 110,
      now: 20_000,
      stats: seededStats({
        gapDeltas: [-0.6, -0.5, -0.4, -0.4],
        peakAbsGap: 18,
        fastGapEma: 4,
        slowGapEma: 9,
        rsi: 35,
      }),
    });

    expect(exit?.mode).toBe("trend-invalid");
  });
});

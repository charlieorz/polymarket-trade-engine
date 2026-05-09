import { afterEach, describe, expect, test } from "bun:test";
import sinon, { type SinonFakeTimers } from "sinon";
import {
  gapReversal,
  GAP_REVERSAL_DEFAULTS,
} from "../../../engine/strategy/gap-reversal.ts";
import type {
  OrderRequest,
  StrategyContext,
} from "../../../engine/strategy/types.ts";

type Side = "UP" | "DOWN";

class FakeOrderBook {
  private asks: Record<Side, { price: number; liquidity: number } | null> = {
    UP: { price: 0.5, liquidity: 100 },
    DOWN: { price: 0.5, liquidity: 100 },
  };
  private bids: Record<Side, number | null> = {
    UP: 0.48,
    DOWN: 0.48,
  };

  bestAskInfo(side: Side): { price: number; liquidity: number } | null {
    return this.asks[side];
  }

  bestBidPrice(side: Side): number | null {
    return this.bids[side];
  }

  getTickSize(_tokenId: string): string {
    return "0.01";
  }

  setAsk(side: Side, price: number, liquidity = 100): void {
    this.asks[side] = { price, liquidity };
  }

  setBid(side: Side, price: number): void {
    this.bids[side] = price;
  }
}

type Harness = {
  clock: SinonFakeTimers;
  ctx: StrategyContext;
  book: FakeOrderBook;
  ticker: { price: number | undefined; divergence: number | null };
  posted: OrderRequest[];
  releases: () => number;
  cleanup: () => void;
  setPostHook: (fn: (order: OrderRequest) => void) => void;
};

function makeHarness(): Harness {
  const clock = sinon.useFakeTimers({
    now: 0,
    toFake: [
      "Date",
      "setTimeout",
      "setInterval",
      "clearTimeout",
      "clearInterval",
    ],
    shouldClearNativeTimers: true,
  });

  const book = new FakeOrderBook();
  const ticker = { price: undefined as number | undefined, divergence: 0 };
  const posted: OrderRequest[] = [];
  let releases = 0;
  let postHook: (order: OrderRequest) => void = () => {};

  const ctx: StrategyContext = {
    slug: "btc-updown-5m-100",
    slotStartMs: 10_000,
    slotEndMs: 310_000,
    clobTokenIds: ["UP_TOKEN", "DOWN_TOKEN"],
    orderBook: book as any,
    log: () => {},
    getOrderById: async () => null,
    postOrders: (orders) => {
      posted.push(...orders);
      for (const order of orders) postHook(order);
    },
    cancelOrders: async () => ({ canceled: [], not_canceled: {} }),
    emergencySells: async () => {},
    blockBuys: () => {},
    blockSells: () => {},
    hold: () => {
      return () => {
        releases++;
      };
    },
    pendingOrders: [] as any,
    orderHistory: [],
    ticker: ticker as any,
    getMarketResult: () => ({
      startTime: 10_000,
      endTime: 310_000,
      completed: false,
      openPrice: 100,
      closePrice: null,
    }),
  };

  return {
    clock,
    ctx,
    book,
    ticker,
    posted,
    releases: () => releases,
    cleanup: () => {},
    setPostHook: (fn) => {
      postHook = fn;
    },
  };
}

async function startStrategy(h: Harness): Promise<void> {
  const cleanup = await gapReversal(h.ctx);
  h.cleanup = cleanup ?? (() => {});
}

async function runPrices(h: Harness, prices: number[]): Promise<void> {
  for (const price of prices) {
    h.ticker.price = price;
    await h.clock.tickAsync(GAP_REVERSAL_DEFAULTS.SAMPLE_INTERVAL_MS);
  }
}

afterEach(() => {
  delete process.env.PROD;
  delete process.env.ALLOW_GAP_REVERSAL_PROD;
});

describe("gap-reversal strategy", () => {
  test("does not enter during the first 30 seconds after market open", async () => {
    const h = makeHarness();
    await startStrategy(h);

    await h.clock.tickAsync(25_000);
    await runPrices(h, [100.16, 100.12, 100.08, 100.04, 100.02]);

    expect(h.posted).toHaveLength(0);
    h.cleanup();
    h.clock.restore();
  });

  test("gap > 0 with negative momentum posts a passive DOWN GTC buy", async () => {
    const h = makeHarness();
    await startStrategy(h);

    await h.clock.tickAsync(41_000);
    await runPrices(h, [100.18, 100.13, 100.08, 100.04, 100.02]);

    expect(h.posted).toHaveLength(1);
    expect(h.posted[0]!.req).toMatchObject({
      tokenId: "DOWN_TOKEN",
      action: "buy",
      price: 0.49,
      shares: GAP_REVERSAL_DEFAULTS.SHARES,
    });
    expect(h.posted[0]!.req.orderType).toBeUndefined();
    h.cleanup();
    h.clock.restore();
  });

  test("gap < 0 with positive momentum posts a passive UP GTC buy", async () => {
    const h = makeHarness();
    await startStrategy(h);

    await h.clock.tickAsync(41_000);
    await runPrices(h, [99.82, 99.87, 99.92, 99.96, 99.98]);

    expect(h.posted).toHaveLength(1);
    expect(h.posted[0]!.req).toMatchObject({
      tokenId: "UP_TOKEN",
      action: "buy",
      price: 0.49,
      shares: GAP_REVERSAL_DEFAULTS.SHARES,
    });
    h.cleanup();
    h.clock.restore();
  });

  test("does not place overlapping entries while a buy is pending", async () => {
    const h = makeHarness();
    await startStrategy(h);

    await h.clock.tickAsync(41_000);
    await runPrices(
      h,
      [100.18, 100.13, 100.08, 100.04, 100.02, 100.06, 100.03, 100.01],
    );

    expect(h.posted).toHaveLength(1);
    h.cleanup();
    h.clock.restore();
  });

  test("filled position stop-loss posts a GTC sell when gap does not flip", async () => {
    const h = makeHarness();
    h.book.setBid("DOWN", 0.42);
    h.setPostHook((order) => {
      if (order.req.action === "buy") order.onFilled?.(order.req.shares);
    });
    await startStrategy(h);

    await h.clock.tickAsync(41_000);
    await runPrices(h, [100.18, 100.13, 100.08, 100.04, 100.02]);
    await runPrices(
      h,
      [100.03, 100.04, 100.05, 100.05, 100.05, 100.05, 100.05],
    );

    const sells = h.posted.filter((o) => o.req.action === "sell");
    expect(sells.length).toBeGreaterThan(0);
    expect(sells[0]!.req).toMatchObject({
      tokenId: "DOWN_TOKEN",
      action: "sell",
      price: 0.42,
      orderType: "GTC",
    });
    h.cleanup();
    h.clock.restore();
  });

  test("profitable position posts a GTC take-profit sell when momentum stalls", async () => {
    const h = makeHarness();
    h.book.setBid("UP", 0.55);
    h.setPostHook((order) => {
      if (order.req.action === "buy") order.onFilled?.(order.req.shares);
    });
    await startStrategy(h);

    await h.clock.tickAsync(41_000);
    await runPrices(h, [99.82, 99.87, 99.92, 99.96, 99.98]);
    await runPrices(
      h,
      [
        100.03, 100.031, 100.03, 100.031, 100.03, 100.031, 100.03, 100.031,
        100.03,
      ],
    );

    const sells = h.posted.filter((o) => o.req.action === "sell");
    expect(sells.length).toBeGreaterThan(0);
    expect(sells[0]!.req).toMatchObject({
      tokenId: "UP_TOKEN",
      action: "sell",
      price: 0.55,
      orderType: "GTC",
    });
    h.cleanup();
    h.clock.restore();
  });

  test("final 30 seconds uses FAK to exit a non-advantaged position", async () => {
    const h = makeHarness();
    h.book.setBid("DOWN", 0.41);
    h.setPostHook((order) => {
      if (order.req.action === "buy") order.onFilled?.(order.req.shares);
    });
    await startStrategy(h);

    await h.clock.tickAsync(41_000);
    await runPrices(h, [100.18, 100.13, 100.08, 100.04, 100.02]);

    h.ticker.price = undefined;
    await h.clock.tickAsync(240_000);
    await runPrices(h, [100.03, 100.03, 100.03, 100.03]);

    const sells = h.posted.filter((o) => o.req.action === "sell");
    expect(sells.length).toBeGreaterThan(0);
    expect(sells[0]!.req).toMatchObject({
      tokenId: "DOWN_TOKEN",
      action: "sell",
      price: 0.41,
      orderType: "FAK",
    });
    h.cleanup();
    h.clock.restore();
  });
});

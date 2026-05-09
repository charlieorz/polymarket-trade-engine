import { describe, test, expect } from "bun:test";
import sinon from "sinon";
import { SimUserChannel } from "../../engine/user-channel.ts";
import type { OrderRequest } from "../../engine/strategy/types.ts";
import { EarlyBirdSimClient, type BookSnapshot } from "../../engine/client.ts";

// SimUserChannel exposes processOrderEvent / processTradeEvent as protected.
// This subclass surfaces them so tests can drive raw event sequences and
// assert how the channel routes them to onFilled / onFailed callbacks.
class TestableChannel extends SimUserChannel {
  pushOrderEvent(evt: {
    id: string;
    type: string;
    status: string;
    associate_trades?: string[];
  }): void {
    (this as any).processOrderEvent(evt);
  }

  pushTradeEvent(evt: {
    id: string;
    status: string;
    size: string;
    taker_order_id: string;
    maker_orders?: { order_id: string; matched_amount: string }[];
  }): void {
    (this as any).processTradeEvent(evt);
  }
}

const NULL_BOOK: BookSnapshot = {
  bestAsk: null,
  bestAskLiquidity: null,
  bestBid: null,
  bestBidLiquidity: null,
};

function makeChannel(): TestableChannel {
  return new TestableChannel({ getBook: () => NULL_BOOK });
}

function makeRequest(
  overrides: Partial<OrderRequest["req"]> = {},
): OrderRequest {
  return {
    req: {
      tokenId: "tok-1",
      action: "buy",
      price: 0.99,
      shares: 6,
      ...overrides,
    },
    expireAtMs: Date.now() + 60_000,
  };
}

describe("UserChannelBase taker fill handling (prod scenario)", () => {
  // In production, a taker order (one that matches immediately on placement)
  // never receives an order UPDATE MATCHED event — only TRADE events with
  // status MATCHED → MINED → CONFIRMED. Before the fix, the channel waited
  // for `t.matched` to flip via processOrderEvent, so MINED was buffered
  // forever and onFilled never fired.

  test("taker-only flow: TRADE MATCHED then TRADE MINED fires onFilled", () => {
    const channel = makeChannel();
    let filledShares = 0;
    let failedReason: string | null = null;

    const req = makeRequest();
    req.onFilled = (n) => {
      filledShares = n;
    };
    req.onFailed = (r) => {
      failedReason = r;
    };

    channel.trackOrder("order-1", req);

    // Trade matched first (no order event arrives for takers)
    channel.pushTradeEvent({
      id: "trade-1",
      status: "MATCHED",
      size: "6",
      taker_order_id: "order-1",
      maker_orders: [],
    });

    // onFilled must NOT fire on MATCHED alone — wait for MINED
    expect(filledShares).toBe(0);

    channel.pushTradeEvent({
      id: "trade-1",
      status: "MINED",
      size: "6",
      taker_order_id: "order-1",
      maker_orders: [],
    });

    expect(filledShares).toBe(6);
    expect(failedReason).toBeNull();
  });

  test("taker flow: MINED arriving before MATCHED still settles (race)", () => {
    const channel = makeChannel();
    let filledShares = 0;

    const req = makeRequest();
    req.onFilled = (n) => {
      filledShares = n;
    };
    channel.trackOrder("order-1", req);

    // MINED first (out of order)
    channel.pushTradeEvent({
      id: "trade-1",
      status: "MINED",
      size: "6",
      taker_order_id: "order-1",
    });
    // No fill yet — channel hasn't seen MATCHED
    expect(filledShares).toBe(0);

    // MATCHED arrives late — should now drain the buffered mined amount
    channel.pushTradeEvent({
      id: "trade-1",
      status: "MATCHED",
      size: "6",
      taker_order_id: "order-1",
    });
    expect(filledShares).toBe(6);
  });

  test("trade events arriving before trackOrder are buffered and replayed", () => {
    const channel = makeChannel();
    let filledShares = 0;

    // WS races ahead of the HTTP placement response — both events arrive
    // before trackOrder is invoked.
    channel.pushTradeEvent({
      id: "trade-1",
      status: "MATCHED",
      size: "6",
      taker_order_id: "order-1",
    });
    channel.pushTradeEvent({
      id: "trade-1",
      status: "MINED",
      size: "6",
      taker_order_id: "order-1",
    });

    const req = makeRequest();
    req.onFilled = (n) => {
      filledShares = n;
    };
    channel.trackOrder("order-1", req);

    expect(filledShares).toBe(6);
  });

  test("maker flow still works: order UPDATE MATCHED + trade MINED settles", () => {
    const channel = makeChannel();
    let filledShares = 0;

    const req = makeRequest();
    req.onFilled = (n) => {
      filledShares = n;
    };
    channel.trackOrder("order-1", req);

    // Maker's order event lists all trades up-front
    channel.pushOrderEvent({
      id: "order-1",
      type: "UPDATE",
      status: "MATCHED",
      associate_trades: ["trade-1"],
    });
    expect(filledShares).toBe(0); // still waiting for MINED

    channel.pushTradeEvent({
      id: "trade-1",
      status: "MINED",
      size: "6",
      taker_order_id: "other-order",
      maker_orders: [{ order_id: "order-1", matched_amount: "6" }],
    });

    expect(filledShares).toBe(6);
  });

  test("maker flow: TRADE MATCHED arriving before order UPDATE doesn't drop trades", () => {
    const channel = makeChannel();
    let filledShares = 0;

    const req = makeRequest();
    req.onFilled = (n) => {
      filledShares = n;
    };
    channel.trackOrder("order-1", req);

    // Trade MATCHED arrives first for a maker order
    channel.pushTradeEvent({
      id: "trade-1",
      status: "MATCHED",
      size: "6",
      taker_order_id: "other-order",
      maker_orders: [{ order_id: "order-1", matched_amount: "6" }],
    });

    // Then order UPDATE MATCHED with the authoritative trade list arrives.
    // The previous "replace associatedTrades" behavior would clobber trade-1
    // and prematurely settle when MINED arrived; with merge it stays correct.
    channel.pushOrderEvent({
      id: "order-1",
      type: "UPDATE",
      status: "MATCHED",
      associate_trades: ["trade-1"],
    });

    channel.pushTradeEvent({
      id: "trade-1",
      status: "MINED",
      size: "6",
      taker_order_id: "other-order",
      maker_orders: [{ order_id: "order-1", matched_amount: "6" }],
    });

    expect(filledShares).toBe(6);
  });

  test("multi-trade taker order waits for all MINED events before settling", () => {
    const channel = makeChannel();
    let filledShares = 0;

    const req = makeRequest({ shares: 10 });
    req.onFilled = (n) => {
      filledShares = n;
    };
    channel.trackOrder("order-1", req);

    // First trade matched and mined
    channel.pushTradeEvent({
      id: "trade-1",
      status: "MATCHED",
      size: "6",
      taker_order_id: "order-1",
    });
    // Second trade matched (still pending)
    channel.pushTradeEvent({
      id: "trade-2",
      status: "MATCHED",
      size: "4",
      taker_order_id: "order-1",
    });

    channel.pushTradeEvent({
      id: "trade-1",
      status: "MINED",
      size: "6",
      taker_order_id: "order-1",
    });
    // Premature settle would fire here without the size-vs-associatedTrades guard
    expect(filledShares).toBe(0);

    channel.pushTradeEvent({
      id: "trade-2",
      status: "MINED",
      size: "4",
      taker_order_id: "order-1",
    });

    expect(filledShares).toBe(10);
  });
});

describe("FAK simulation handling", () => {
  test("sim client records partial FAK fills", async () => {
    const book: BookSnapshot = {
      bestAsk: null,
      bestAskLiquidity: null,
      bestBid: 0.5,
      bestBidLiquidity: 1.5,
    };
    const client = new EarlyBirdSimClient(() => book);

    const [placed] = await client.postMultipleOrders([
      {
        tokenId: "tok-1",
        action: "sell",
        price: 0.5,
        shares: 6,
        tickSize: "0.01",
        negRisk: false,
        feeRateBps: 0,
        orderType: "FAK",
      },
    ]);

    expect(placed?.orderId).toBeTruthy();
    const order = await client.getOrderById(placed!.orderId);
    expect(order?.status).toBe("filled");
    expect(order?.actualShares).toBe(3);
  });

  test("sim user channel settles FAK with the immediately fillable partial size", async () => {
    const previousDelay = process.env.SIM_BALANCE_DELAY_MS;
    process.env.SIM_BALANCE_DELAY_MS = "0";

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

    const book: BookSnapshot = {
      bestAsk: null,
      bestAskLiquidity: null,
      bestBid: 0.5,
      bestBidLiquidity: 1.5,
    };
    const channel = new SimUserChannel({ getBook: () => book });
    let filledShares = 0;

    channel.subscribe("condition");
    channel.trackOrder("order-1", {
      req: {
        tokenId: "tok-1",
        action: "sell",
        price: 0.5,
        shares: 6,
        orderType: "FAK",
      },
      expireAtMs: Date.now() + 60_000,
      onFilled: (shares) => {
        filledShares = shares;
      },
    });

    await clock.tickAsync(200);

    expect(filledShares).toBe(3);

    channel.destroy();
    clock.restore();
    if (previousDelay === undefined) delete process.env.SIM_BALANCE_DELAY_MS;
    else process.env.SIM_BALANCE_DELAY_MS = previousDelay;
  });
});

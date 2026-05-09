import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  buildTradeWindowSvgFromLog,
  renderTradeWindowImageFromLog,
} from "../../engine/analysis/trade-window-image.ts";

describe("trade window image renderer", () => {
  test("renders a PNG from structured trade diagnostics", () => {
    const start = 1777108200000;
    const end = start + 300_000;
    const signalId = "sig-test";
    const requestId = "req-test";
    const raw = [
      {
        ts: start,
        type: "slot",
        action: "start",
        slug: "btc-updown-5m-1777108200",
        startTime: start,
        endTime: end,
        strategy: "late-entry",
      },
      { ts: start + 1000, type: "remaining", seconds: 299 },
      {
        ts: start + 1000,
        type: "ticker",
        assetPrice: 77640,
        coinbasePrice: 77640,
      },
      {
        ts: start + 1000,
        type: "market_price",
        openPrice: 77643,
        gap: -3,
        priceToBeat: 77643,
      },
      {
        ts: start + 90_000,
        type: "strategy_signal",
        signalId,
        action: "buy",
        side: "DOWN",
        label: "unit-test",
        metrics: { gapSafety: 42, rsi: 30 },
        market: { assetPrice: 77635, priceToBeat: 77643, gap: -8 },
      },
      {
        ts: start + 90_120,
        type: "order",
        requestId,
        signalId,
        action: "buy",
        side: "DOWN",
        status: "placed",
        price: 0.9,
        shares: 6,
        label: "unit-test",
        signalLatencyMs: 120,
        requestLatencyMs: 80,
        metrics: { gapSafety: 43, rsi: 29 },
        market: { assetPrice: 77634, priceToBeat: 77643, gap: -9 },
      },
      {
        ts: start + 150_000,
        type: "ticker",
        assetPrice: 77630,
        coinbasePrice: 77630,
      },
      {
        ts: end,
        type: "resolution",
        direction: "DOWN",
        openPrice: 77643,
        closePrice: 77630,
        unfilledShares: 0,
        payout: 0,
        pnl: 0.5,
      },
      { ts: end, type: "slot", action: "end", slug: "btc-updown-5m-1777108200" },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n");

    const outputRoot = mkdtempSync(join(tmpdir(), "trade-window-img-"));
    const svg = buildTradeWindowSvgFromLog(raw, {
      strategyName: "late-entry",
      slug: "btc-updown-5m-1777108200",
      outputRoot,
    });
    const outPath = renderTradeWindowImageFromLog(raw, {
      strategyName: "late-entry",
      slug: "btc-updown-5m-1777108200",
      outputRoot,
    });

    expect(svg).toContain("00:00");
    expect(svg).toContain("05:00");
    expect(svg).toContain('data-x-tick="5"');
    expect(svg).toContain('data-marker-shape="square-pointer"');
    expect(svg).toContain('data-role="right-axis-label" x="1418"');
    expect(svg).toContain("PnL +$0.50");
    expect(svg).toContain("策略识别指标");
    expect(svg).toContain("订单确认指标");
    expect(svg).not.toContain("浅色圆点");

    expect(outPath).toBe(
      join(outputRoot, "late-entry", "btc-updown-5m-1777108200.png"),
    );
    expect(existsSync(outPath!)).toBe(true);
    expect(readFileSync(outPath!).subarray(0, 8).toString("hex")).toBe(
      "89504e470d0a1a0a",
    );
  });
});

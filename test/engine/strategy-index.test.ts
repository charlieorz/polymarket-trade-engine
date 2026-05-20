import { describe, expect, test } from "bun:test";
import { strategies } from "../../engine/strategy/index.ts";

describe("strategy registry", () => {
  test("registers advantage-arb strategy", () => {
    expect(typeof strategies["advantage-arb"]).toBe("function");
  });

  test("registers dual-edge-arb strategy", () => {
    expect(typeof strategies["dual-edge-arb"]).toBe("function");
  });

  test("registers probability-portfolio strategy", () => {
    expect(typeof strategies["probability-portfolio"]).toBe("function");
  });

  test("registers gap-momentum-edge strategy", () => {
    expect(typeof strategies["gap-momentum-edge"]).toBe("function");
  });

  test("registers btc-5m-dual-edge strategy", () => {
    expect(typeof strategies["btc-5m-dual-edge"]).toBe("function");
  });
});

import { describe, expect, test } from "bun:test";
import { strategies } from "../../engine/strategy/index.ts";

describe("strategy registry", () => {
  test("registers advantage-arb strategy", () => {
    expect(typeof strategies["advantage-arb"]).toBe("function");
  });
});

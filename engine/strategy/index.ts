import type { Strategy } from "./types.ts";
import { simulationStrategy } from "./simulation.ts";
import { lateEntry } from "./late-entry.ts";
import { advantageArb } from "./advantage-arb.ts";
import { dualEdgeArb } from "./dual-edge-arb.ts";

export const strategies: Record<string, Strategy> = {
  "simulation": simulationStrategy,
  "late-entry": lateEntry,
  "advantage-arb": advantageArb,
  "dual-edge-arb": dualEdgeArb,
};

export const DEFAULT_STRATEGY = "simulation";

export type { Strategy, StrategyContext } from "./types.ts";

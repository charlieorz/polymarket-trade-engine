import type { Strategy } from "./types.ts";
import { simulationStrategy } from "./simulation.ts";
import { lateEntry } from "./late-entry.ts";
import { advantageArb } from "./advantage-arb.ts";
import { dualEdgeArb } from "./dual-edge-arb.ts";
import { probabilityPortfolio } from "./probability-portfolio.ts";
import { gapMomentumEdge } from "./gap-momentum-edge.ts";
import { btc5mArb } from "./btc-5m-arb.ts";
import { btc5mDualEdge } from "./btc-5m-dual-edge.ts";

export const strategies: Record<string, Strategy> = {
  "simulation": simulationStrategy,
  "late-entry": lateEntry,
  "advantage-arb": advantageArb,
  "dual-edge-arb": dualEdgeArb,
  "probability-portfolio": probabilityPortfolio,
  "gap-momentum-edge": gapMomentumEdge,
  "btc-5m-arb": btc5mArb,
  "btc-5m-dual-edge": btc5mDualEdge,
};

export const DEFAULT_STRATEGY = "simulation";

export type { Strategy, StrategyContext } from "./types.ts";

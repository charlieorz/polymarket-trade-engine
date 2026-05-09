/**
 * 分时间段运行 gap-reversal 参数组合。
 *
 * 默认顺序运行 4 组参数，每组 4 小时。每组会写入独立目录：
 *   logs/gap-reversal-sweeps/<run-id>/<phase-name>/
 *   state/gap-reversal-sweeps/<run-id>/<phase-name>/early-bird.json
 *
 * 常用命令：
 *   bun scripts/run-gap-reversal-sweep.ts
 *   bun scripts/run-gap-reversal-sweep.ts --hours 2
 *   bun scripts/run-gap-reversal-sweep.ts --minutes 30 --asset eth
 */

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

type Phase = {
  name: string;
  description: string;
  env: Record<string, string>;
};

const PHASES: Phase[] = [
  {
    name: "01-conservative",
    description:
      "更严格入场：较小 gap、更强动量、更低买入价，适合先观察误触发率。",
    env: {
      GAP_REVERSAL_SECOND_FLIP: "2.5",
      GAP_REVERSAL_MAX_ENTRY_GAP_PCT: "0.0005",
      GAP_REVERSAL_MIN_MOMENTUM_PCT_PER_SEC: "0.00005",
      GAP_REVERSAL_MAX_ENTRY_PRICE: "0.54",
      GAP_REVERSAL_MIN_ENTRY_LIQUIDITY_USD: "25",
      GAP_REVERSAL_TAKE_PROFIT_MIN_USD: "0.25",
      GAP_REVERSAL_TAKE_PROFIT_MIN_PRICE_DELTA: "0.04",
      GAP_REVERSAL_STOP_LOSS_GRACE_MS: "3000",
      GAP_REVERSAL_ADVERSE_EXPANSION_RATIO: "1.2",
    },
  },
  {
    name: "02-balanced",
    description: "默认参数，用作对照组。",
    env: {
      GAP_REVERSAL_SECOND_FLIP: "3",
      GAP_REVERSAL_MAX_ENTRY_GAP_PCT: "0.0008",
      GAP_REVERSAL_MIN_MOMENTUM_PCT_PER_SEC: "0.00003",
      GAP_REVERSAL_MAX_ENTRY_PRICE: "0.57",
      GAP_REVERSAL_MIN_ENTRY_LIQUIDITY_USD: "15",
      GAP_REVERSAL_TAKE_PROFIT_MIN_USD: "0.25",
      GAP_REVERSAL_TAKE_PROFIT_MIN_PRICE_DELTA: "0.04",
      GAP_REVERSAL_STOP_LOSS_GRACE_MS: "3000",
      GAP_REVERSAL_ADVERSE_EXPANSION_RATIO: "1.25",
    },
  },
  {
    name: "03-opportunistic",
    description:
      "更宽松入场：允许更大 gap、更低动量、更高买入价，用于观察交易频率上限。",
    env: {
      GAP_REVERSAL_SECOND_FLIP: "4",
      GAP_REVERSAL_MAX_ENTRY_GAP_PCT: "0.001",
      GAP_REVERSAL_MIN_MOMENTUM_PCT_PER_SEC: "0.00002",
      GAP_REVERSAL_MAX_ENTRY_PRICE: "0.6",
      GAP_REVERSAL_MIN_ENTRY_LIQUIDITY_USD: "10",
      GAP_REVERSAL_TAKE_PROFIT_MIN_USD: "0.25",
      GAP_REVERSAL_TAKE_PROFIT_MIN_PRICE_DELTA: "0.04",
      GAP_REVERSAL_STOP_LOSS_GRACE_MS: "3500",
      GAP_REVERSAL_ADVERSE_EXPANSION_RATIO: "1.35",
    },
  },
  {
    name: "04-fast-exit",
    description: "入场接近默认，但止盈/止损更快，用于观察回撤控制效果。",
    env: {
      GAP_REVERSAL_SECOND_FLIP: "3",
      GAP_REVERSAL_MAX_ENTRY_GAP_PCT: "0.0008",
      GAP_REVERSAL_MIN_MOMENTUM_PCT_PER_SEC: "0.00003",
      GAP_REVERSAL_MAX_ENTRY_PRICE: "0.57",
      GAP_REVERSAL_MIN_ENTRY_LIQUIDITY_USD: "15",
      GAP_REVERSAL_TAKE_PROFIT_MIN_USD: "0.18",
      GAP_REVERSAL_TAKE_PROFIT_MIN_PRICE_DELTA: "0.03",
      GAP_REVERSAL_STOP_LOSS_GRACE_MS: "2000",
      GAP_REVERSAL_ADVERSE_EXPANSION_RATIO: "1.15",
    },
  },
];

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function parseDurationMs(): number {
  const minutes = argValue("--minutes");
  if (minutes) return Number(minutes) * 60_000;

  const hours = argValue("--hours") ?? "4";
  return Number(hours) * 60 * 60_000;
}

function isoTag(): string {
  return new Date()
    .toISOString()
    .replace("T", "-")
    .replace(/:/g, "-")
    .slice(0, 19);
}

function parentEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

async function runPhase(phase: Phase, runId: string, durationMs: number) {
  const logDir = join("logs", "gap-reversal-sweeps", runId, phase.name);
  const stateDir = join("state", "gap-reversal-sweeps", runId, phase.name);
  mkdirSync(logDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  const manifest = {
    name: phase.name,
    description: phase.description,
    durationMs,
    logDir,
    stateDir,
    env: phase.env,
  };
  writeFileSync(
    join(logDir, "phase-config.json"),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );

  const args = [
    "run",
    "index.ts",
    "--strategy",
    "gap-reversal",
    "--always-log",
  ];
  const rounds = argValue("--rounds");
  if (rounds) args.push("--rounds", rounds);

  const env: Record<string, string> = {
    ...parentEnv(),
    ...phase.env,
    FORCE_PROD: "false",
    PROD: "false",
    LOG_DIR: logDir,
    STATE_DIR: stateDir,
    LOCK_DIR: stateDir,
  };

  const asset = argValue("--asset");
  if (asset) env.MARKET_ASSET = asset;
  const window = argValue("--window");
  if (window) env.MARKET_WINDOW = window;

  console.log(`\n[gap-reversal-sweep] start ${phase.name}`);
  console.log(`[gap-reversal-sweep] ${phase.description}`);
  console.log(`[gap-reversal-sweep] logs: ${logDir}`);
  console.log(`[gap-reversal-sweep] state: ${stateDir}`);

  const child = Bun.spawn(["bun", ...args], {
    env,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });

  const timer = setTimeout(() => {
    console.log(
      `\n[gap-reversal-sweep] stopping ${phase.name} after ${durationMs}ms`,
    );
    child.kill("SIGINT");
  }, durationMs);

  const exitCode = await child.exited;
  clearTimeout(timer);

  if (exitCode !== 0) {
    throw new Error(`${phase.name} exited with code ${exitCode}`);
  }
  console.log(`[gap-reversal-sweep] done ${phase.name}`);
}

const durationMs = parseDurationMs();
if (!Number.isFinite(durationMs) || durationMs <= 0) {
  throw new Error(
    "Duration must be positive. Use --hours <n> or --minutes <n>.",
  );
}

const runId = argValue("--run-id") ?? isoTag();

for (const phase of PHASES) {
  await runPhase(phase, runId, durationMs);
}

console.log(`\n[gap-reversal-sweep] all phases completed: ${runId}`);

# BTC 5m FAK 单仓循环套利策略

本文档说明 `btc-5m-arb` 的策略逻辑、参数选择、回测结果和部署步骤。

## 策略逻辑

- 只交易 `MARKET_ASSET=btc`、`MARKET_WINDOW=5m` 市场。
- 入场价格限制在 `B5A_MIN_ENTRY_PRICE=0.48` 到 `B5A_MAX_ENTRY_PRICE=0.52`。
- 买单、止盈卖单、止损卖单均使用 `FAK`，默认固定 `B5A_SHARES=6`。
- 一个 5 分钟窗口内允许多次交易，但任何时刻只允许一个 pending buy、一个持仓或一个 pending sell。
- 平仓后可以继续寻找下一笔入场；如果本窗口已实现 PnL 低于 `-B5A_MAX_MARKET_LOSS`，本窗口停止新买入。
- `[280, 300]` 秒不再买入；该阶段仍允许根据止盈止损逻辑卖出，也可以持有到结算。
- 入场时锁定动态止盈/止损参数：早入场给更高止盈和更宽止损，晚入场降低止盈和收紧止损。
- 策略在内存中维护最近 `B5A_RECENT_RESULT_WINDOW=10` 个市场结果，用线性递增权重计算当前候选方向 bias；默认仅作为轻量过滤和打分，不作为强预测模型。
- 全局 `MAX_SESSION_LOSS=20` 仍由 `EarlyBird` 层控制，达到后进程退出。

## 参数选择

回测脚本：

```bash
bun run scripts/backtest-btc-5m-arb.ts
```

本次选择流程：

- 日志目录：`logs/`
- 排除最新诊断运行：`logs/early-bird-2026-05-19-09-52-58.log`
- 可回放市场：1544
- 随机切分：train=926、validation=308、test=310
- seed：`btc-5m-arb-2026-05-19-random-exrun2-v1`
- 网格数量：312
- 默认选择规则：只用 train/validation 选参，test 只做最终评价。

当前默认：

```text
profile=cheap_adv_only_no_half_delay45_stop45_hold_winners_shares6_fak_recent_strict
train pnl=15.54, validation pnl=1.32, test pnl=-2.52, excluded latest-run pnl=1.02
```

结论：严格满足 0.48-0.52、FAK、6 shares、单窗口亏损 2 美元后，test 尚未转正。因此该参数只适合继续模拟盘观察，不建议直接扩大实盘资金。`testWinner` 虽然 test 为正，但 train/validation 为负，不能作为默认参数。

报告文件：

- `reports/backtests/btc-5m-arb-btc-5m-arb-2026-05-19-random-exrun2-v1.json`
- `reports/backtests/btc-5m-arb-btc-5m-arb-2026-05-19-random-exrun2-v1-valid-test-table.csv`

## 模拟盘运行

本地前台运行：

```bash
APP_DIR="$PWD" ENV_FILE="$PWD/.env.sim" BUN_EXECUTABLE="$(command -v bun)" scripts_ops/run_sim_btc_5m_arb.sh
```

服务器 systemd：

```bash
sudo cp scripts_ops/poly-trader-btc-5m-arb-sim.service /etc/systemd/system/poly-trader-btc-5m-arb-sim.service
sudo systemctl daemon-reload
sudo systemctl start poly-trader-btc-5m-arb-sim.service
journalctl -u poly-trader-btc-5m-arb-sim.service -f
```

如果达到 `MAX_SESSION_LOSS` 后需要重新开始模拟盘，先确认原因，再重置模拟 state：

```bash
bun run scripts/reset-state.ts
sudo systemctl restart poly-trader-btc-5m-arb-sim.service
```

## 实盘运行

实盘默认被 `B5A_ALLOW_PROD=false` 阻止。只有在连续小额模拟确认后，才应在 `.env.prod` 中改为：

```dotenv
B5A_ALLOW_PROD=true
MAX_SESSION_LOSS=20
```

前台试运行：

```bash
APP_DIR="$PWD" ENV_FILE="$PWD/.env.prod" BUN_EXECUTABLE="$(command -v bun)" scripts_ops/run_prod_btc_5m_arb.sh
```

服务器 systemd：

```bash
sudo cp scripts_ops/poly-trader-btc-5m-arb-prod.service /etc/systemd/system/poly-trader-btc-5m-arb-prod.service
sudo systemctl daemon-reload
sudo systemctl start poly-trader-btc-5m-arb-prod.service
journalctl -u poly-trader-btc-5m-arb-prod.service -f
```

停止服务：

```bash
sudo systemctl stop poly-trader-btc-5m-arb-prod.service
```

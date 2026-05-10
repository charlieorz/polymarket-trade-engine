# dual-edge-arb 策略说明

`dual-edge-arb` 是在 `advantage-arb` 之后新增的保守型双模型策略。名称中的 `dual-edge` 表示同一套策略只允许两类互斥 edge：

1. 优势侧延续：gap、动量、盘口和 fair probability 同时支持当前优势侧时，买优势侧。
2. 劣势侧反转：gap 已过度扩张并开始向 0 回归，且劣势侧盘口改善时，买劣势侧。

每个 market 只允许下一单。策略默认保留 `PROD` 保护，只用于模拟和参数验证。

## 数据使用边界

离线 replay 默认使用 `logs/` 下全部可评价 market 日志，不再只从最新下载批次开始。脚本按时间顺序切分：

- train: 前 60%
- validation: 中间 20%
- test: 最后 20%

参数只应在 train/validation 上调整，test 只用于最后一次 PnL 评价。`scripts/analyze-dual-edge-arb-logs.ts` 只用当前 tick 之前已经出现的 ticker/orderbook 更新信号；离线日志中的 `openPrice` 存在 resolution 记录里，脚本读取它作为 `priceToBeat`，这是日志格式限制，实盘/模拟运行时 `priceToBeat` 是市场已知信息。

## 入场因子

公共过滤：

- `remaining` 在 `45s ~ 240s`
- `spread <= 0.03`
- `bestAskLiquidity >= 18`
- `bestBidLiquidity >= 6`
- `ask >= 0.28`
- 优势侧延续 `ask <= 0.60`
- 只有一个未持仓状态才允许入场

优势侧延续模型：

- `absGap >= 9`
- `normGap = absGap / ATR >= 3`
- `peakGapRatio >= 0.82`
- 3 秒和 10 秒 gap 动量不能反向
- EMA 快慢线方向必须支持当前优势侧
- gap RSI 必须支持当前优势侧
- `netEdge >= 0.035`
- 综合分数 `continuationScore >= 0.96`

劣势侧反转模型：

- `absGap >= 12`
- `normGap >= 4`
- `gapZ >= 1.2`
- `peakRetrace` 在 `0.16 ~ 0.55`
- gap 必须正在向 0 回归
- gap 加速度必须反向于当前优势侧
- EMA 翻转或 RSI 翻转至少满足一个
- 劣势侧 3 秒 bid slope 必须为正
- `netEdge >= 0.045`
- 综合分数 `reversalScore >= 0.80`
- 反转分数必须比延续分数至少高 `0.05`

反转单更难，因此要求更高 edge，并且必须有盘口确认，避免“看到 gap 大就猜顶/猜底”。

## 出场逻辑

出场全部基于当前 side 的 best bid，而不是理论价格。

- 默认最短持仓 `12s`，防止刚成交后被单个 EV 快照立即洗出。
- 普通价格止损要求最短持仓后才触发，且趋势不能继续支持仓位。
- 灾难止损为 `entry - 0.14`，不等待趋势确认。
- 动态止盈默认 `entry + 0.08`，但如果 gap 和盘口仍支持持仓，不会立刻止盈。
- 已盈利后，如果 best bid 从峰值回撤 `0.04`，触发 trailing take-profit。
- 末段 `<=75s` 且已有至少 `0.045` 利润时锁利。
- `<=30s` 默认退出；只有 fair probability、side gap 和结算 edge 足够强时才持有到 settlement。

这组规则直接针对当前日志暴露的问题：追回撤入场、gap 未明显恶化却立即止损、优势仍扩大时过早止盈。

## 默认阈值选择

`DUAL_EDGE_MIN_CONTINUATION_SCORE=0.96` 和 `DUAL_EDGE_MAX_CONTINUATION_ASK=0.60` 是根据全量 `logs/` 的 train/validation replay 选择的保守默认值。较低分数或更高 ask 会多触发早期高价 continuation 单，在 train split 上出现大额回撤。

当前可调参数前缀为 `DUAL_EDGE_`，常用参数：

- `DUAL_EDGE_MIN_CONTINUATION_SCORE`
- `DUAL_EDGE_MIN_REVERSAL_SCORE`
- `DUAL_EDGE_MIN_CONTINUATION_PGR`
- `DUAL_EDGE_MIN_REVERSAL_PEAK_RETRACE`
- `DUAL_EDGE_MAX_CONTINUATION_ASK`
- `DUAL_EDGE_MAX_REVERSAL_ASK`
- `DUAL_EDGE_TAKE_PROFIT_CENTS`
- `DUAL_EDGE_MAX_LOSS_CENTS`
- `DUAL_EDGE_MIN_HOLD_MS`

## 本地 replay 基线

命令：

```bash
bun run scripts/analyze-dual-edge-arb-logs.ts --log-dir logs
```

当前有 resolution 可评价的样本为 85 个 market。默认参数结果：

| split | markets | trades | pnl | max loss | win rate |
| --- | ---: | ---: | ---: | ---: | ---: |
| full | 85 | 5 | +2.10 | 0.00 | 100.0% |
| train | 51 | 3 | +1.38 | 0.00 | 100.0% |
| validation | 17 | 1 | +0.66 | 0.00 | 100.0% |
| test | 17 | 1 | +0.06 | 0.00 | 100.0% |

这个结果只说明当前默认阈值在这批可评价日志上更保守，不能直接当作生产收益结论。后续应继续扩大样本，优先比较 `continuationScore`、`maxAsk`、`PGR` 和止盈/止损参数，而不是在 test split 上反复调参。

## 本地调参方法

单组参数 replay：

```bash
DUAL_EDGE_MIN_CONTINUATION_SCORE=0.94 \
DUAL_EDGE_MAX_CONTINUATION_ASK=0.62 \
bun run scripts/analyze-dual-edge-arb-logs.ts --log-dir logs
```

只看旧版最新下载批次时才使用 `--from-slug`，正常调参不要加：

```bash
bun run scripts/analyze-dual-edge-arb-logs.ts --log-dir logs --from-slug btc-updown-5m-1778400000
```

建议关注指标：

- train/validation PnL：参数选择只看这两段。
- test PnL：只做最终报告，不参与选择。
- maxLoss 和 maxDD：比 winRate 更重要，当前策略目标是先降低亏损扩散。
- traded：交易过少时结果不稳定；交易过多时容易回到 advantage-arb 的亏损模式。
- continuation/reversal 数量：反转模型若长期为 0，说明阈值过紧或样本里缺少高质量反转。

推荐 grid search 范围：

| 参数 | 建议范围 | 说明 |
| --- | --- | --- |
| `DUAL_EDGE_MIN_CONTINUATION_SCORE` | `0.90,0.92,0.94,0.96,0.98` | 主过滤器，越高越少交易 |
| `DUAL_EDGE_MAX_CONTINUATION_ASK` | `0.56,0.58,0.60,0.62,0.64` | 控制高价追单风险 |
| `DUAL_EDGE_MIN_CONTINUATION_PGR` | `0.80,0.84,0.88,0.92` | 过滤 peak 回撤后的追单 |
| `DUAL_EDGE_MIN_CONTINUATION_NET_EDGE` | `0.03,0.04,0.05,0.06` | 防止价格已经吃掉 edge |
| `DUAL_EDGE_MIN_ENTRY_REMAINING` | `45,75,100,120` | 避免过晚/过早信号 |
| `DUAL_EDGE_MAX_ENTRY_REMAINING` | `180,210,240` | 控制太早入场 |
| `DUAL_EDGE_TAKE_PROFIT_CENTS` | `0.06,0.08,0.10,0.12` | 锁利速度 |
| `DUAL_EDGE_MAX_LOSS_CENTS` | `0.05,0.06,0.08,0.10` | 普通止损宽度 |
| `DUAL_EDGE_CATASTROPHIC_LOSS_CENTS` | `0.10,0.12,0.14` | 无确认硬止损 |
| `DUAL_EDGE_MIN_REVERSAL_SCORE` | `0.78,0.82,0.86,0.90` | 反转模型主阈值 |
| `DUAL_EDGE_MIN_REVERSAL_PEAK_RETRACE` | `0.12,0.16,0.20,0.25` | 反转确认强度 |
| `DUAL_EDGE_MAX_REVERSAL_ASK` | `0.50,0.56,0.60,0.64` | 反转侧价格上限 |

手工 grid 的推荐顺序：

1. 固定出场参数，只扫 `MIN_CONTINUATION_SCORE x MAX_CONTINUATION_ASK`。
2. 选出 train/validation maxDD 最小且 PnL 非负的组合。
3. 再局部扫 `PGR` 和 `NET_EDGE`。
4. 最后只微调止盈/止损参数。
5. 确认最终参数后，再看一次 test。

当前推荐部署参数：

```env
POLY_STRATEGY=dual-edge-arb
DUAL_EDGE_MIN_CONTINUATION_SCORE=0.96
DUAL_EDGE_MAX_CONTINUATION_ASK=0.60
DUAL_EDGE_MIN_CONTINUATION_PGR=0.82
DUAL_EDGE_MIN_CONTINUATION_NET_EDGE=0.035
DUAL_EDGE_TAKE_PROFIT_CENTS=0.08
DUAL_EDGE_MAX_LOSS_CENTS=0.08
DUAL_EDGE_CATASTROPHIC_LOSS_CENTS=0.14
DUAL_EDGE_MIN_HOLD_MS=12000
```

## 服务器端模拟部署

当前策略仍保留 `PROD` guard，只适合模拟盘部署。服务器部署步骤：

1. 更新代码并安装依赖：

```bash
cd /home/poly/polymarket-trade-engine
git pull
bun install
```

2. 编辑 `.env.sim`，确认：

```env
PROD=false
FORCE_PROD=false
POLY_STRATEGY=dual-edge-arb
TICKER=polymarket,coinbase
MARKET_ASSET=btc
MARKET_WINDOW=5m
MAX_SESSION_LOSS=20
WALLET_BALANCE=50
```

3. 确认脚本可执行并试跑一轮：

```bash
chmod +x scripts_ops/run_sim_advantage_arb.sh
POLY_ROUNDS=1 scripts_ops/run_sim_advantage_arb.sh
```

4. systemd user service 示例：

```ini
[Unit]
Description=Polymarket dual-edge-arb simulation
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/poly/polymarket-trade-engine
Environment=APP_DIR=/home/poly/polymarket-trade-engine
Environment=ENV_FILE=/home/poly/polymarket-trade-engine/.env.sim
Environment=PATH=/home/poly/.bun/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/home/poly/polymarket-trade-engine/scripts_ops/run_sim_advantage_arb.sh
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

5. 启动和查看日志：

```bash
systemctl --user daemon-reload
systemctl --user enable --now polymarket-dual-edge-arb-sim.service
systemctl --user status polymarket-dual-edge-arb-sim.service
journalctl --user -u polymarket-dual-edge-arb-sim.service -f
```

6. 拉回服务器日志后，本地复盘：

```bash
rsync -av poly@server:/home/poly/polymarket-trade-engine/logs/ logs/
bun run scripts/analyze-dual-edge-arb-logs.ts --log-dir logs
```

如果 systemd 报 `/usr/bin/env: 'bun': No such file or directory`，用 `command -v bun` 找到服务器上的绝对路径，并把 service 里的 `PATH` 或脚本里的 Bun 路径改成实际值。

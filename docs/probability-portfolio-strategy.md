# Probability Portfolio Strategy

`probability-portfolio` 是一个模拟盘优先的新策略，用来实现 `pp_v1` 中的概率估计、趋势/反转双模型和组合 payoff 管理思路。

## 运行

```bash
bun run index.ts --strategy probability-portfolio --rounds 10 --always-log
```

策略内置生产保护：`PROD=true` 时会直接退出。要实盘必须先移除代码中的 guard，并重新做最新日志回放、小资金模拟盘和人工风控检查。

## 核心逻辑

- 用 `gap = currentPrice - priceToBeat`、剩余时间和近期波动估计 UP/DOWN 结算概率。
- 入场条件是 `pFair - ask - executionBuffer >= minNetEdge`，而不是只看 gap 绝对值。
- `continuation` 买当前优势侧，要求 gap 继续沿优势方向扩张。
- `reversal` 买当前劣势侧，要求极端偏离后已经出现向 0 回归的速度、加速度或盘口确认。
- 持仓管理以组合为中心：如果 UP/DOWN 双边已经形成正的最差结算 payoff，临近结算会优先持有组合，而不是机械止损单腿。
- 默认每个市场最多开 1 条腿，避免在 5m 噪声窗口里反复进出。要更激进地测试组合腿，把 `PP_MAX_ENTRIES_PER_MARKET=2`。

## 调参入口

```bash
bun run backtest:pp
```

回放脚本会读取 `logs/early-bird-btc-updown-5m-*.log`，按时间顺序切分：

- train: 前 60%
- validation: 中间 20%
- test: 最后 20%

脚本只用 train 生成候选、用 validation 排序，最后单独报告 holdout test。不要用 test 结果反向挑参数。

## 主要参数

| 参数 | 作用 | 当前默认 |
| --- | --- | --- |
| `PP_SHARES` | 每条腿股数 | `6` |
| `PP_MAX_OPEN_LEGS` | 同时打开的最大腿数 | `2` |
| `PP_MAX_SAME_SIDE_LEGS` | 同侧最大腿数 | `1` |
| `PP_MAX_ENTRIES_PER_MARKET` | 单市场最多开仓次数 | `1` |
| `PP_MIN_CONTINUATION_NET_EDGE` | 趋势单最小净 edge | `0.015` |
| `PP_MIN_REVERSAL_NET_EDGE` | 反转单最小净 edge | `0.02` |
| `PP_MIN_CONTINUATION_SCORE` | 趋势单综合分阈值 | `0.56` |
| `PP_MIN_REVERSAL_SCORE` | 反转单综合分阈值 | `0.52` |
| `PP_COST_BUFFER` | 执行成本缓冲 | `0.008` |
| `PP_SIGMA_MULTIPLIER` | 剩余波动放大系数，校准过度自信概率 | `1.4` |
| `PP_MAX_SPREAD` | 最大 spread | `0.04` |
| `PP_TAKE_PROFIT_CENTS` | 单腿止盈触发价差 | `0.09` |
| `PP_MAX_LOSS_CENTS` | 单腿确认止损价差 | `0.05` |
| `PP_SETTLEMENT_MIN_GUARANTEED_PNL` | 组合结算保护最小保底收益 | `0.06` |

## 当前日志回放结论

本地 `logs/` 下可回放市场数为 93 个。初始更激进的多腿/重复进场设置在 train 和 validation 表现较好，但 holdout test 明显转负，说明存在 regime shift 或过度交易风险。第二轮修正集中在两点：

- `PP_SIGMA_MULTIPLIER=1.4`：放大剩余波动尺度，降低小样本 rolling sigma 造成的过度自信概率。
- `PP_MAX_LOSS_CENTS=0.05`：压缩 continuation 失效后的单笔亏损尾部。

在同一时间切分下，train/validation 选择出的当前默认参数 holdout test 为小幅正收益，但样本只有 19 个市场，不能视为稳定实盘证据。如果要模拟盘偏激测试，优先只调：

```bash
PP_MAX_ENTRIES_PER_MARKET=2
```

这个激进组合只适合模拟盘观察，不应直接迁移实盘。

# Gap Momentum Edge Strategy

`gap-momentum-edge` 是一个 BTC 5m 模拟盘优先策略。它只买当前 gap 优势方向：

- `gap > 0` 买 `UP`
- `gap < 0` 买 `DOWN`

策略默认每个市场最多成功入场 1 次，每次固定买入 6 份，入场和普通止盈窗口为开盘后 `[60s, 250s]`，最后 `[260s, 295s]` 只做尾段阈值止盈/止损判断，`[295s, 300s]` 直接持有到结算。

## 运行

```bash
bun run index.ts --strategy gap-momentum-edge --rounds 10 --always-log
```

策略内置生产保护：`PROD=true` 时会直接退出。要实盘必须先做最新日志回放、小资金模拟盘和人工风控检查。

## 核心逻辑

- 入场不是只看 `price < 0.6`，而是要求 `pFair - price - costBuffer >= minNetEdge`。
- `pFair` 由当前优势侧 gap、ATR 波动和剩余时间估算。gap 越大、剩余时间越短、波动越低，结算概率越高。
- 新增累计 gap 因子：每次统计更新累加有符号 gap。入场方向必须同时与当前 gap 和累计 gap 方向一致，避免只因为瞬时跳动反向追入。
- GTC 入场使用被动价格，默认挂在 best ask 下方，避免主动吃单。
- 普通止盈使用 FOK，以当前 bid 兑现，避免 GTC 挂单过期后错过退出；默认倍率为 `1.4`。
- `[260s, 295s]` 尾段使用 FOK 阈值止盈/止损：`bid >= GME_FINAL_TAKE_PROFIT_RATIO` 时止盈；持仓反方向结算概率达到 `GME_FINAL_STOP_LOSS_RATIO` 时止损。
- 最后 5 秒不再新增卖单，直接持有到结算。

## 默认参数

| 参数 | 作用 | 默认 |
| --- | --- | --- |
| `GME_SHARES` | 单次固定买入份数 | `6` |
| `GME_MAX_ENTRIES_PER_MARKET` | 单市场最大成功入场次数 | `1` |
| `GME_NO_ENTRY_FIRST_SECONDS` | 前多少秒不入场 | `60` |
| `GME_MAX_ENTRY_ELAPSED_SECONDS` | 最晚入场 elapsed 秒数 | `250` |
| `GME_FINAL_WINDOW_SECONDS` | 尾段管理窗口 | `40` |
| `GME_FINAL_ACTION_START_SECONDS` | 尾段止盈止损开始 elapsed 秒数 | `260` |
| `GME_FINAL_ACTION_END_SECONDS` | 尾段止盈止损结束 elapsed 秒数 | `295` |
| `GME_HOLD_ONLY_SECONDS` | 最后强制持有秒数 | `5` |
| `GME_ENTRY_ORDER_TYPE` | 入场订单类型 | `GTC` |
| `GME_ENTRY_ORDER_TTL_MS` | 入场本地 TTL | `2500` |
| `GME_TAKE_PROFIT_ORDER_TYPE` | 普通止盈订单类型 | `FOK` |
| `GME_FINAL_DIRECT_TP_ORDER_TYPE` | 最后 40 秒直接止盈订单类型 | `FOK` |
| `GME_FINAL_EXIT_ORDER_TYPE` | 尾段止损订单类型 | `FOK` |
| `GME_MAX_ENTRY_PRICE` | 最大入场价格 | `0.6` |
| `GME_TAKE_PROFIT_MULTIPLIER` | 普通止盈倍率 | `1.4` |
| `GME_FINAL_TAKE_PROFIT_RATIO` | 尾段止盈 bid 阈值 | `0.9` |
| `GME_FINAL_STOP_LOSS_RATIO` | 尾段反方向概率止损阈值 | `0.7` |
| `GME_MIN_ABS_GAP` | 最小绝对 gap | `3.5` |
| `GME_MIN_GAP_ATR` | 最小 gap/ATR | `0.85` |
| `GME_MIN_PEAK_RETAIN_RATIO` | 最小 peak retain ratio | `0.5` |
| `GME_MIN_TREND_CONSISTENCY` | 最小趋势一致性 | `0.38` |
| `GME_MIN_SIDE_VELOCITY_EMA` | 最小优势侧 gap 动量 EMA | `-0.18` |
| `GME_MIN_CUMULATIVE_GAP` | 累计 gap 同向最小阈值 | `20` |
| `GME_MIN_NET_EDGE` | 最小净 edge | `0.008` |

当前默认参数来自 `logs/` 下 685 个可回放 BTC 5m 市场的固定 seed 随机切分回放。参数集覆盖保守、均衡和激进共 16 组，validation 用于调参诊断；按当前要求，默认组合使用 test 表现最优的 `neutral_tp40_f90_s70`。该组合在 test 集仍为负，不能据此直接扩大实盘规模。

## 风险边界

这个策略只在 `[260s,295s]` 做阈值止损，且二元市场尾段跳变很快，亏损市场仍可能接近满亏。`MAX_SESSION_LOSS` 是主要熔断边界，建议模拟盘保持：

```env
MAX_SESSION_LOSS=20
WALLET_BALANCE=50
```

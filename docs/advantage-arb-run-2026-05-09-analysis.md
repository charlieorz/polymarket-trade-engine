# advantage-arb 2026-05-09 Simulation Analysis

## 数据覆盖

当前本地 `state/early-bird.json` 显示本次拷贝数据只包含 34 个 completed markets，而不是完整 288 个 5m 轮次。主日志显示运行在 2026-05-09 21:21:15 UTC 触发止损退出：

- `sessionPnl`: -0.42
- `sessionLoss`: -21.48
- 止损阈值: -20.00
- 有 resolution 的市场: 27
- 实际成交入场: 27
- 成交卖出退出: 22
- 持仓到 resolution: 5
- 未入场/未完成 resolution 的市场: 7

## 总体归因

这次结果接近 0 不是因为策略稳定，而是大额亏损和若干大额结算盈利相互抵消。27 个有 resolution 的市场里，16 胜、11 负，盈利合计 +21.06，亏损合计 -21.48。

核心问题有三类：

1. 尾盘卖单过期时间缺陷：`placeSell()` 默认 `expireAtMs = slotEnd - 30s`。当最后 30 秒内触发止盈/止损时，卖单在进入重试队列前已经过期，日志出现大量 `SELL ... failed (order expired before placement)`，实际只剩持仓到结算。
2. 止盈过度依赖 trailing：多笔交易已经到达 planned take-profit，但策略等待优势从峰值回撤，等到回撤确认时 bid 已经失去利润窗口。
3. 固定止损过宽：默认 `STOP_LOSS_PRICE=0.48` 对 0.70-0.76 的高价入场过宽，单笔亏损可达 0.28-0.70/股，而常规止盈只有 0.08-0.12/股。

## 实际参与市场

| market | side | buy | sell/exit | pnl | 关键归因 |
| --- | --- | ---: | ---: | ---: | --- |
| 1778352000 | DOWN | 0.61 | 0.86 | +1.50 | trailing take-profit |
| 1778352300 | DOWN | 0.70 | 0.78 | +0.48 | planned TP 到过 0.80，实际 trailing 较保守 |
| 1778352600 | UP | 0.66 | 0.81 | +0.90 | trailing take-profit |
| 1778352900 | DOWN | 0.62 | 0.51 | -0.66 | 到过 0.72 planned TP，未锁利后回撤止损 |
| 1778353200 | UP | 0.70 | 0.15 | -3.30 | 从未到 planned TP，优势快速反转，固定/回撤止损太慢 |
| 1778353500 | UP | 0.67 | 0.36 | -1.86 | 到过 0.79 planned TP，未锁利后回撤止损 |
| 1778353800 | DOWN | 0.61 | 0.34 | -1.62 | 回撤止损，resolution 后盘口才接近 0.99，盘中无有效 TP |
| 1778354100 | DOWN | 0.53 | 0.87 | +2.04 | trailing 捕获大趋势 |
| 1778354400 | DOWN | 0.64 | 0.28 | -2.16 | 入场后反向波动，曾在 29.8s 到 0.80 但太晚 |
| 1778355000 | DOWN | 0.76 | held | +1.44 | 到过 0.86，后续尾盘卖单因过期缺陷未放置，靠结算盈利 |
| 1778355300 | DOWN | 0.73 | 0.45 | -1.68 | 盘中未有效到 TP，回撤止损 |
| 1778355600 | UP | 0.76 | 0.97 | +1.26 | 尾盘高概率锁利 |
| 1778355900 | DOWN | 0.74 | 0.50 | -1.44 | 从未到 planned TP，gap reversal stop-loss |
| 1778356200 | UP | 0.72 | 0.97 | +1.50 | 高概率锁利 |
| 1778356500 | UP | 0.52 | 0.38 | -0.84 | 成交后优势衰减，后续到过 TP 但策略先止损 |
| 1778356800 | DOWN | 0.71 | 0.79 | +0.48 | trailing take-profit |
| 1778357100 | DOWN | 0.71 | 0.80 | +0.54 | trailing take-profit |
| 1778357400 | DOWN | 0.71 | 0.97 | +1.56 | 高概率锁利 |
| 1778357700 | DOWN | 0.68 | 0.50 | -1.08 | 到过 0.79 planned TP，未锁利后回撤止损 |
| 1778358300 | UP | 0.65 | 0.75 | +0.60 | trailing take-profit |
| 1778358900 | UP | 0.73 | 0.98 | +1.50 | 高概率锁利 |
| 1778359500 | DOWN | 0.68 | held | +1.92 | 尾盘卖单过期缺陷，靠结算盈利 |
| 1778359800 | UP | 0.76 | held | -4.56 | 到过 0.86 planned TP，最后止损信号卖单未放置，结算亏损 |
| 1778360100 | UP | 0.72 | held | +1.68 | 到过 0.83，尾盘卖单过期缺陷，靠结算盈利 |
| 1778360400 | UP | 0.52 | held | +2.88 | 到过 0.65 后大趋势继续，尾盘卖单过期缺陷，靠结算盈利 |
| 1778360700 | UP | 0.76 | 0.89 | +0.78 | trailing take-profit |
| 1778361300 | UP | 0.56 | 0.18 | -2.28 | 从未到 planned TP，回撤止损 |

## 未参与/未成交市场

| market | 状态 | 主要原因 |
| --- | --- | --- |
| 1778354700 | no trade | 优势很强但 ask 约 0.97，超过 `MAX_ENTRY_ASK` 且无利润空间 |
| 1778358000 | no trade | 大部分窗口 gap 不足；最佳候选 ask 0.84 仍高于上限 |
| 1778358600 | no trade | gap 多数不足或 ask 过低/过高；最佳候选 ask 0.80 高于上限 |
| 1778359200 | no trade | gap 早期不足，后期 ask 0.93 且无利润空间 |
| 1778361000 | buy expired | 有 2 个通过入场条件的候选，BUY UP 0.70 未成交直到过期 |
| 1778361600 | shutdown partial | 运行止损触发前刚进入窗口；候选 ask 0.82 高于上限 |
| 1778361900 | shutdown partial | 止损退出时刚启动，缺少有效 market_price |

## btc-updown-5m-1778359800 重点归因

这笔不是“最后流动性太差导致不能止盈/止损”的单一问题。

- 入场：remaining 236.8s，BUY UP 0.76，成交时 gap +10.90，ask liquidity 40.80，bid liquidity 379.22。
- planned TP：0.86。remaining 207.8s 时 best bid 已到 0.86，bid liquidity 494.02，spread 0.01，已经有可执行的锁利窗口。
- 策略未止盈原因：当前逻辑把固定目标价当成最低门槛，还要求 trailing 回撤；等到回撤足够明确时，bid 已经回落，利润窗口消失。
- 止损信号：remaining 6.8s，gap +1.28，best ask 0.07，best bid 0.06，bid liquidity 22.71。这个深度足够覆盖 6 shares 的模拟卖出规模。
- 实际未止损原因：卖单默认过期时间为 `slotEnd - 30s`，此时已经在过去，订单还没放置就失败。随后 `closing=false` 导致同一尾盘窗口反复生成失败卖单。
- 最终：closePrice 80771.88 < openPrice 80780.40，UP 持仓结算为 0，PnL -4.56。

结论：`1778359800` 的主要责任是止盈参数/逻辑错过了 0.86 的可执行利润窗口，加上尾盘卖单过期缺陷导致最后止损没有真正下单；尾盘盘口确实变差，但不是根因。

## 已实现优化

1. 图片字体：SVG 显式使用 CJK fallback，`Resvg` 自动加载常见 Noto/Source Han/WenQuanYi/PingFang/STHeiti 字体；服务器也可通过 `TRADE_WINDOW_FONT_FILE(S)` 或 `CJK_FONT_FILE(S)` 指定字体。
2. 计划止盈：当 bid 达到 planned take-profit 且顶层 bid liquidity 足够时，直接锁定利润，不再必须等待 trailing 回撤。
3. 动态价格止损：每笔仓位的 stop price 变为 `max(ADV_ARB_STOP_LOSS_PRICE, entryAsk - ADV_ARB_MAX_PRICE_LOSS)`，默认最大价格亏损 0.12。
4. 尾盘卖单过期：默认卖单过期时间改为 `slotEndMs`，避免最后 30 秒内的止盈/止损卖单一进入队列就过期。
5. 日志指标：交易指标里补充 `bestBidLiquidity`，便于后续判断止盈是否真的可执行。

## 参数建议

当前默认已经改为更偏“稳定锁利”：

- `ADV_ARB_MAX_PRICE_LOSS=0.10-0.14`：默认 0.12；想进一步降低回撤可试 0.08-0.10。
- `ADV_ARB_TAKE_PROFIT_MIN_BID_LIQUIDITY=6-20`：默认 6 USDC，刚好覆盖 6 shares 量级；实盘建议提高到预期成交额的 2-3 倍。
- `ADV_ARB_MAX_ENTRY_ASK=0.70-0.74`：当前仍保留 0.76，但本轮高价入场是主要亏损来源；下一轮 sweep 建议比较 0.72 和 0.70。
- `ADV_ARB_MIN_ABS_GAP=8-12`：当前 8 对 5m BTC 波动偏激进；如果交易频次可下降，建议试 10 或 12。

按本轮日志做粗略反事实估算：只要在盘中 planned TP 可执行时锁利，27 个有 resolution 的市场从 -0.42 改善到约 +5.70，亏损市场从 11 个降到 5 个。这个估算基于结构化日志的 top bid 和 liquidity，不等同于实盘成交保证，但方向上说明“先锁计划利润”比默认 trailing 更适合稳定收益目标。

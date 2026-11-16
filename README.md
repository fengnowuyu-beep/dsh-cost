# dsh-cost · 对话消费金额

DSH 桌面端（DeepSeek Harness）的独立插件：**在输入框下方显示本对话花了多少钱**，点开看每条计费行的金额。除了 token，它还统计这个对话生成了多少张图、转写了多少语音。它原本是 [dsh-toolbox](../dsh-toolbox) 的一部分，现在单独拆出来，可以独立启停、独立升级。

| 功能 | 位置 |
| --- | --- |
| **本对话消费** | 输入框下方，紧挨 DSH 自带的 token 用量胶囊 |
| **金额明细** | 总额下方一条构成条，按 token / 生图 / 语音 的实际占比分段（悬停看各段金额）；点开胶囊看输入·缓存未命中 / 输入·缓存命中（缓存读取） / 缓存写入 / 输出，各自金额与 token 数，外加缓存命中率、高峰样本、按模型金额、价格来源与时间 |
| **生图** | 独立一组（浅琥珀底 + 左侧强调条 +「估算」chip）：按模型列出张数与金额，按交付像素计价；多模型时带合计行 |
| **语音** | 另一组（同样的估算标记）：按 `paraformer-v2` 每秒单价计语音时长；工作区转写单独一行，多来源时带合计行；没有语音则不出现 |
| **子代理分摊** | 总额**包含**本对话派生的所有子代理（最多向下三层），面板里每个子代理一行、带被委派时的任务名 |
| **价格来源** | 内置官方价目表（离线可用），或在后台从 DeepSeek 官方价格页抓取，也支持自定义 JSON 地址；媒体价目随插件附带 |
| **设置页** | 设置 → 消费金额：开关、显示位置、计入子代理、**计入生图与语音**、**计入工作区语音转写**、货币、汇率、计价来源、有效期、手动刷新 |

## 金额是怎么算的

- **口径与 token 计数一致**：金额由会话日志折叠而来，替换规则与 DSH 自己的 `tokenUsage` 投影完全相同（同一 `(turn, step)` 覆盖、`llm/retry-started` 清空），所以金额描述的永远是 token 胶囊显示的那批 token。
- **按每条样本发生的时刻计价**：高峰时段（UTC 周一至周五 01:00–04:00、06:00–10:00）按高峰价，其余按空闲价（半价）；中国法定节假日无法自动识别（设置页有说明）。
- **缓存写入**按「缓存未命中」价格计费（官方价目表没有单独的缓存写入行）。
- **模型识别**：优先用消息自带的 `provider/model`，其次用当时的 `request/header` / `request/context`；退役别名（`deepseek-v4-flash`、`deepseek-chat`、`deepseek-reasoner`）映射到 `deepseek-flash`。
- **两种货币**：官方同时公布人民币与美元标价，切换货币会立即重算；某个模型缺对应货币时按设置里的汇率换算。

### 看不了的对话也能算

旧实现只认**本进程里活着**的会话，切到任何没被加载过的对话就报「不在本进程中」——而底部 token 胶囊照常工作，因为它读的是页面自己的投影。现在分两条路：

- 会话**在本进程里**：用 `sessions` 服务 + 增量折合（只在日志增长时算新增部分）；
- 会话**只在存档里**：用 `sessionPersistence.open(id, 'read')` 读取（只读打开，**不夺取写所有权**，别的进程正在写也能读），折合后只保留结果、丢弃事件数组。

给一个会话定价**绝不应该**把它 resume 起来——那会凭空启动一个 agent。

### 子代理也算进来

DSH 给每个子代理**各自一个会话**，所以主对话自己的 token 从来不是全部账单。关联方式是：委派方自己的会话日志里有一条 `subagent/catalog` 事件，带 `childId` 与这次委派的任务名。因此既不需要子代理头上有血缘字段，也不用扫描整个会话库，而且直播会话与存档会话走同一条路径。

本机真实数据核对过：92 个根会话、94 个一级、63 个二级，链接关系就是这条事件。一个有 66 个子代理的真实对话，主对话自己只花了 ¥0.8579，子代理花了 ¥14.3105，总额 ¥15.1684——只看主对话会低估 94%。

- 最多向下三层、最多 64 个会话；超出时面板明确写「子代理层数过多，只统计了前几层」。
- 设置里可以关掉「计入子代理费用」，关掉后只算本对话。
- 存档会话只缓存**折合后的报告**（键是日志长度 + 价格版本），不保留事件数组——一个 66 个子代理的对话若把事件都留在内存里是几百 MB。

## 生图与语音（估算）

token 投影里没有这两笔钱，因为它们按别的单位计费；但它们同样写进了会话日志，所以照样能从日志折出来：

| 服务 | 谁在调 | 计费单位 | 日志里的痕迹 |
| --- | --- | --- | --- |
| **MiniMax H3-Image** | `dsh-image-gen` 插件（openai-compat 通道） | ¥ / 交付图片，随像素档位变 | `Generated one image with openai-compat/MiniMax-H3-Image (832x1248)`、`Generated 4 of 4 images.`、`Edited one image …`；失败是 `Error: …`（不计费） |
| **阿里云百炼 paraformer-v2** | `录音转写` 工作区的 `_工具/cloud_asr.py` | ¥/秒（0.00008，≈¥0.288/小时），只计语音时长 | 脚本结尾的 `计费 3742s ≈ 0.30 元` |

**必须说清楚：这两个数字是估算，面板里标着「估算」。**

- 官方对图片其实按 token 计费（文本输入 ¥15/百万、图片输入 ¥10/百万、**图片输出 ¥25/百万**）。日志里没有 token 数，所以按官方公布的「单张生成费用参考」在 1K/2K/4K 三档之间按交付像素线性插值：1K 文生图 ¥0.1430、2K ¥0.1531、4K ¥0.4522，改图 1 张参考图 ¥0.1744（3 张 ¥0.2346），极速版另有一套。**4K 限时 5 折**（≥1660 万像素、2026-11-18 00:00 前）按时间建模，不是硬编码进档位。实际费用会随 prompt token 长度浮动，所以单张价格会有几分钱的出入。
- 语音按秒计，且官方口径只对判定为语音的时长计费、静音不计——`cloud_asr.py` 打印的正是这个口径的秒数。
- **每月 10 小时免费额度没有建模**：面板报的是「按标价该花多少」，不是账单。

### 语音怎么找到的

`cloud_asr.py` 每次云端转写都会把 `cloud.usage_duration_s` / `cost_cny` 写进 `segments-chN.json`，而本机真实的转写几乎都在**终端**里跑（会话日志只见两次联调用例）。所以语音有两条来源：

1. **对话内**：日志里 `计费 Ns ≈ ¥X` 那一行；
2. **该工作区**：以会话的 `cwd` 为根，向下最多两层找 `segments-*.json`（`<录音目录>/03-数据/segments-ch0.json` 正好两层）。再深就不算了——那会变成「cwd 是父目录的对话把下面每个项目的账单都算给自己」，比漏算更糟；评估副本与 `.dropped.json` 也不会重复计入。

两边按 `--wav` 的音频路径去重，同一次转写只算一次。工作区扫描只在打开面板/胶囊时发生，结果缓存（有转写 2 分钟、没有 10 分钟），单次最多 800 个目录、200 个文件。

## 安装与启用

```powershell
# 在 DSH 里：设置 → 插件 → 安装，填入目录或包名
E:/Data/Project/DeepSeekHarness/DSH-Homemade-Plugins/dsh-cost
```

或在 profile 的 `package.json` 里加依赖与 bundle（与同目录的其它插件一致）：

```jsonc
"dependencies": { "dsh-cost": "link:E:/Data/Project/DeepSeekHarness/DSH-Homemade-Plugins/dsh-cost" },
"dsh": { "profile": { "bundles": [ /* … */ "dsh-cost" ] } }
```

然后在 profile 目录执行 `pnpm install`，重启 DSH。

> **改完代码要重启才生效**：载入器会缓存已 import 的模块。页面半边会自行拾取新 bundle，但 Host 半边（路由、价格、计价）必须重启 DSH 才加载。

## 核对真实数据

`tools/cost-audit.mjs` 只读地给**真实存档会话**定价，并核对「逐条折合 = 一次性折合」，同时打印这个对话树的分摊：

```powershell
node tools/cost-audit.mjs                          # 最近写入的那个对话
node tools/cost-audit.mjs <sessionId> --all        # 指定会话，列全部子代理
node tools/cost-audit.mjs --port=9845              # Host 在别的端口时，让价格表取自它
```

价格表优先取**运行中 Host 的**（`prices.get`），所以它给出的数字就是胶囊上的数字；抓不到就用插件附带的那份。

**这个工具必须懒加载。** 早先的版本为了建「父子表」把所有会话日志都解码一遍，在有几百个会话的机器上直接吃光内存（实测 3.6 GB 后 OOM）。父子关系本来就写在对话自己的日志里（`subagent/catalog`），所以现在只解码被问到的那一个对话和有上限的子代理；512 MB 堆就能跑完。

## 从 dsh-toolbox 迁移

拆分后第一次启动时，本插件会**一次性**读取旧插件的 `~/.dsh/toolbox/settings.json` 里的 `cost` 配置，并把 `prices.json` 复制到自己的目录，所以货币、汇率、价格缓存都不会丢。旧文件不会被修改（它仍属于另一个插件）。

## 状态与路径

```
~/.dsh/cost/settings.json     设置
~/.dsh/cost/prices.json       价格缓存
~/.dsh/cost/logs/cost.log     被拒绝的计价请求、价格刷新记录
```

## 开发

```powershell
npm test    # 109 个用例，全部离线，不需要 DSH 在跑
```

| 测试 | 覆盖 |
| --- | --- |
| `test/host.test.mjs` | 真实路由处理函数：回环围栏、方法校验、设置往返与越界回退、**首次启动接管旧插件配置**、直播/存档会话定价、**生图金额并入总额与开关**、**子代理汇总与层级上限/开关**、价格路由、文案键中英齐备 |
| `test/cost.test.mjs` | 折叠替换规则、重试清空、逐模型、高峰/空闲、跨币种、未定价 token、每行金额与总额自洽、**多会话合并（桶名与计费名不可混用）** |
| `test/media.test.mjs` | 图片结果解析（单张/批量/改图/失败）、1K/2K/4K 档位与 4K 限时折、跨档插值、改图参考图档、跨币种、语音秒数解析与计价、失败调用不计费、**工作区扫描的深度上限/忽略目录/`.dropped` 排除**、按 wav 去重、合并报表 |
| `test/pricing.test.mjs` | 官方价格页解析（用抓下来的 en/zh 页面做夹具）、高峰判定、别名、换算、外部 JSON、刷新失败保留上一份 |
| `test/client.test.mjs` | 注册落位、字典键一致、**胶囊的真实渲染（含失败必须可见）**、**子代理分摊面板**、开关与货币、计价结果的记忆化、**面板朝有空间的一侧弹出**、设置页保存与读取失败 |

## English summary

`dsh-cost` shows what the current DSH conversation cost, under the composer next to the
shell's own token pill. The amount is folded from the same Session log the token pill counts,
priced from DeepSeek's published table (cache hit/miss separated, peak and off-peak hours), and
rolled up over every subagent conversation the parent delegated to — discovered through the
`subagent/catalog` record in the delegating log, so a stored conversation is priced without
resuming an agent. Clicking the pill opens the per-line breakdown and the per-subagent share;
the settings page switches currency, price source, freshness and the subagent roll-up.

Image generation (MiniMax H3-Image) and speech recognition (Bailian `paraformer-v2`) are billed
on images and seconds, so they are folded from the tool results that name them —
`Generated one image with openai-compat/MiniMax-H3-Image (832x1248)` and the transcription
script's `计费 3742s ≈ 0.30 元` — rather than from the token projection. Those figures are
**estimates**: the vendor bills images by token, so the panel interpolates its published
per-image reference over the delivered pixels (1K/2K/4K, including the date-bounded 4K
promo). Speech also picks up the runs a workspace recorded on disk (`segments-*.json` under
the conversation's cwd, two levels deep at most, de-duplicated by audio path), because this
user's real transcriptions happen in a terminal, not in the log. `npm test` runs 109 offline
specs, including the image and speech estimates.

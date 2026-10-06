---
title: delegate 测试与验证
owner: Adg preset 维护者
status: current
last_reviewed: 2026-10-05
---

# testing-guide.md — delegate

两层验证，别把它们混成一层：

- **机制层**（自动化、可离线）：工具计划、请求装配、两条派发路径的分支、错误口径、入口与 bundle 的形状 —— 全在 `delegate/test/delegate.test.mjs` 里，用假服务与假调用方跑。
- **装载层**（只能重启后观测）：`cordis.patch.yml` 能不能被 loader 装载、`delegate` 真出现在调度者的工具面里、子代理真的按这次的 `toolFilter` 与 `persona` 建立 —— 单元测试与静态自检都看不到这些。

## 命令

```sh
cd delegate && node --test test                        # 机制层：单元测试（零副作用：不起进程、不碰真会话、不写磁盘）
cd delegate && node --test --test-isolation=none test  # DSH 沙箱（workspace-write）里跑这一条
```

`node --test` 默认按测试文件起子进程跑用例，受限沙箱会拦跨进程的管道 stdio（EPERM）；`--test-isolation=none` 让用例在同一进程里跑。前提是仓库根的 `node_modules/` 解析桥在位（见 [AGENTS.md](AGENTS.md) 的「命令」）。

## 用例总表

| 用例 | 对象 | 断言内容 | 对应不变量 | 载体 |
|---|---|---|---|---|
| D1 | `createDelegateTool()` 用**真的** `defineTool` | 参数是隐式属性映射（必填收成顶层 `required: ['description','prompt']`）、`tools` 是 string 数组；output 是对象根 + `additionalProperties:false` + 六个字段；两个反向对照（对象根写进 `parameters` ⇒ `parameters.type must be a value schema object`；缺 `output` ⇒ 读 `output.render` 的 TypeError）；`isConcurrencySafe(合法实参) === true`、`({}) === false` | I11 | `delegate/test/delegate.test.mjs` D1 |
| D2 | `planToolFilter` / `delegate` | `tools` 省略 ⇒ `toolFilter` 只有 `deny`、没有 `allow`；瘦 profile（`['Read','delegate']`）⇒ deny 只有 `delegate`；`tools` 回显 `[]`；note 以「未过滤」开头 | I1 / I2 | D2 |
| D3 | 同上 | 给清单 ⇒ `allow` 与 `deny` 同时下发，`allow` 只留清单里的可用名 | I1 | D3 |
| D4 | 同上 | 未知名剔除、同名去重、`ignored` 保持点名顺序、逐条进 `tools_note`；空字符串这种坏值抛错 | I3 | D4 |
| D5 | 同上 | 六个内置名被点名也不进 `allow`（且仍在 `deny` 里）；`notify_user` **不在**名单里、可以进 `allow`；`tools: []` ⇒ `allow: []` + 「空清单」 | I1 | D5 |
| D6 | 同上 | `run_code` ⇒ 抛错（消息含 `run_code` 与「PTC 传输保留名」），且发生在调用任何服务之前 | I5 | D6 |
| D7 | `assertCallerAgent` / `delegate` | 没有 `exec.agent` ⇒ 抛错；缺 `subagents` 服务 ⇒ 报清楚是哪个服务 | — | D7 |
| D8 | `buildRequest` | persona 省略 ⇒ 没有 `persona` 键（也没有 `maxDepth`）；给了 ⇒ 原样带上；键序恰为 `label,prompt,parent[,persona][,toolFilter]` | I7 / I8 | D8 |
| D9 | `delegate` + 假 `subagents` | 缺省与显式 `background: true` 都走 `startContinuable`（`start` 零调用），spec 键恰为 `provider,label,request,signal`，`provider === 'spawn'`、`signal` 同源、`request.parent` 就是调用方；`childId` 取不到 ⇒ 抛错；`view` 的实参就是那个 Agent 对象 | I4 / I8 / I10 | D9 |
| D10 | `delegate` + 假 run | `background: false` 走 `start('spawn', …)` 并取 `run.id`；`run.result` 在下个 tick 拒绝 ⇒ 注入的 `warn` 收到一条含 id 与错误消息的记录（既不是 unhandled rejection，也不是成功）；`foregroundRunId({})` 抛错；`superviseOneShotRun` 对没有 `result` 的 run 返回 `false` | I9 | D10 |
| D11 | `readRestrictableNames` | `view` 不是函数 / 返回 `{}` / 返回空 `Set` ⇒ 三种都抛错且零服务调用；形状对了返回 `Set` | I6 | D11 |
| D12 | 三个源文件 + `package.json` | 入口三件套在位；`name` = patch 的 `id` = 包名；`type` / `main` / `dsh.bundle.patch` 正确；**没有** `dependencies`；纯逻辑层零 `import`；两个源文件里没有盘符绝对路径与用户根 | I11 | D12 |
| D13 | 真 `defineTool` 编出的定义 | 在假服务上跑通一次完整调用，`output.render` 出一行含 id 与人话的文本 | — | D13 |

**测试纪律**：造工具定义一律用**真的** `defineTool`（作者侧 schema 方言与 `output` 硬要求只有真实现判得了）；假件只替换服务、调用方与子代理运行时，**不**替换 schema 编译器。用例之间不共享可变状态，所以可以任意顺序、并发跑。

## 迁移矩阵

**无。** 本插件不持有持久状态、不产出需要版本迁移的制品：每次调用只读一次工具视图、建立一次子代理会话，会话本身由平台的迁移链负责。

## 消费方契约测试

消费方只有两处：preset 的调度 persona（调 `delegate`；本插件不要求 preset 写任何东西 —— `delegate` 是全局层工具名，不需要写进 preset 的委派行，也进不了任何一次委派的 `tools`：它在内置 deny 名单里），以及平台的委派运行时。对平台的每一条契约面都被一条用例钉住形状，改名或改形状会当场红：

| 契约面 | 用例 |
|---|---|
| `SubagentRuntime.startContinuable(spec)` 的 spec 键与 `ContinuableStart.childId` | D9 |
| `SubagentRuntime.start(name, request)` 的实参顺序与 `SubagentRun.id` / `SubagentRun.result` | D10 |
| `ToolRestriction{allow?, deny?}` 的两侧下发与"只减不增"的用法 | D2 / D3 / D5 |
| `SubagentStartRequest` 的键集（含"省略即没有"的 `persona`，以及**永不出现**的 `maxDepth`） | D8 / D9 |
| `tools.view(agent).restrictableNames`（含读不出时的 fail-closed 分支） | D11 |
| `defineTool` 的作者侧 parameters 方言与 output 对象根方言 | D1 / D13 |

## 验证 ≠ 装载

- **能证明的**：工具计划、请求装配、两条派发路径的分支、错误口径、入口与 bundle 的形状、零依赖。
- **证明不了的**：`delegate/cordis.patch.yml` 能被 loader 装载；`delegate` 真出现在调度者的工具面里；子代理真的按这次的 `toolFilter` 与 `persona` 建立。
- **一条很容易踩的假证据**：用例里的 `subagents` 是假件 —— "D9 通过"只说明本插件**交给平台的 spec 形状**对，不说明平台接受了它。provider 是否声明了 `toolFilter` / `persona` 能力、`restrict()` 是否放行那批名字，只有真实挂载（或一次真委派）能观测。

## 人工 review 项

**未观测**：`view` 的非公开性（类型面是 `private`，本机解析到的实现里是原型方法）在 dsh 升级后是否还成立；量法：升级后跑 `cd delegate && node --test test`，再做一次真实委派，看是否抛 I6 的自诊断错。
**未观测**：scope key 约定（`exec.agent` 就是 scope key）在别的 dsh 版本里是否也成立 —— 不成立会**静默**退化成"只有全局层"的对照表；量法：真实会话里用 `tools: ["Read"]` 委派一次，断言 `tools_note` 没有把 `Read` 列为忽略。
**未观测**：内置 deny 六个名字与真实 profile 的交集；量法：装齐 `adg-permission` / `adg-notify` 后委派一次，断言不抛 unknown-name 错，并在 `list_agents` 上确认该子代理的工具面里没有这六个名字（`notify_user` 例外：它不在名单里，给了就该出现）。
**未观测**：persona 的遮蔽净效果；量法：真派一次带 persona 的子代理，读它会话日志里的 `deployment:persona-prefix` 段，确认部署 persona 没有残留。
**未观测**：前台一次性路径的终局（本工具不等待）；量法：`background: false` 真派一次，确认子代理在 `subagent/catalog` 里出现并自行收尾；若发生基建故障，日志里应能找到那条 `warn`。
**未观测**：并发多条委派时对照表读数的稳定性；量法：并发派两条，断言两条的 `tools` / `tools_note` 一致。

## 交付前的最小闭环

```sh
cd delegate && node --test test
cd delegate && node --test --test-isolation=none test
```

两条全绿即机制层通过。`node tools/check-preset.mjs` 与四条 `tools/check-bundle-flavor.mjs` 断言验的是 preset 源文件与产物，**不在本模块的闭环里**；但改了 `delegate/lib/delegate.mjs` 的 `BUILTIN_DENY` 就该跑一次 `node tools/check-preset.mjs` —— 它的 5c 块会从本模块抠那个数组的**字面量**判名字在不在（缺 `agent` / `delegate` ⇒ ERROR）。装载层的复核按 [AGENTS.md](AGENTS.md) 的「生效方式」一节做。
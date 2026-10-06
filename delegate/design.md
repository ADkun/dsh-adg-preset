---
title: delegate 设计
owner: Adg preset 维护者
status: current
last_reviewed: 2026-10-05
---

# design.md — delegate（`delegate` 工具）

本文件是 `delegate` 的设计真相：它负责什么、依赖什么、哪些不变量不许破、对外交出什么形状。
红线（违反即返工的清单）在 [AGENTS.md](AGENTS.md)，判据与用例全表在 [testing-guide.md](testing-guide.md)。

## 职责与边界

**负责**

- 在全局层注册工具 `delegate`，让调度智能体**在每一次委派时**现给子代理指定工具集合与 persona。
- 在调用平台**之前**把调用方给的 `tools` 与本次可用的全局工具名对照：未知名与内置禁用名剔除并回显，`run_code` 当场拒绝。
- 把请求装配成平台的 `SubagentStartRequest` 形状，并按两条路径派发（可续后台 / 前台一次性）。
- 如实回报这次下发了什么（`tools` / `tools_note`）、子代理 id 是哪种来源（`kind`）、有没有给 persona。

**不负责**

- 不等待子代理跑完、不汇总它的输出 —— 前台一次性只交出 run 的 id，结局由会话与 `subagent/catalog` 承担。
- 不改任何既有状态：不动会话日志、不动文件权限、不动别的子代理（与 `permission/` 的边界正相反）。
- 不实现"后台一次性"路径，因此也不解析 `jobs` 服务。
- 不写 persona 的内容、不校验 persona 模板里的 `{{…}}`（那是平台 `deployment:persona-prefix` 的事）。
- 不给自己做装载：`install.ps1` / `install.sh` 的接线、以及 preset 侧要不要提到它，都不在本模块内。

## 依赖关系

- **Node 内建**：无 —— 纯逻辑层零 `import`；入口只 import `@deepseek-ai/dsh-tools` 的 `defineTool`。
- **可选 peer**：`@deepseek-ai/dsh-tools`（运行期由 dsh 供给；版本以根 `AGENTS.md` 的「外部依赖与 ref 解析」的解析结果为准，本文件不写版本字面量）。
- **运行期服务**：`tools`（由 `inject` 声明，用于 `ctx.tools.register`）；`subagents`（`@deepseek-ai/dsh-subagent` 的 `SubagentRuntime`，**调用那一刻**才 `ctx.get`）。
- **不依赖**：`jobs`（没有一次性后台路径，见 I4）；`sessions`、`sessionPersistence`、`sandboxPolicy` 一概不碰。
- **被依赖**：preset 的调度 persona（唯一消费方：它调 `delegate`）；`delegate/cordis.patch.yml`（装进 profile 的 bundle 入口）。
- **跨模块改动路由**：改工具名 → `preset/agent.cordis.yml` 的调度 persona + `tools/check-preset.mjs` 的 `KNOWN_TOOLS`；改装法 → `install.ps1` / `install.sh`。

## 核心数据模型

### ToolPlan（`planToolFilter(requested, knownNames)` 的产物，只读）

```
{
  provided: boolean,                     // 调用方有没有给 tools
  denyNames: string[],                   // 内置名单 ∩ 本次可用名 —— 真正下发的 deny
  tools: string[],                       // 真正下发的 allow（未给 tools 时是 []）
  ignored: [{name, reason}],             // 点名叫不动的：reason = 'denied' | 'unknown'，保持点名先后顺序
  filter: {allow?: string[], deny: string[]} | undefined,   // 交给平台的 ToolRestriction；undefined = 不下滤镜
}
```

`filter` 的两种形状就是全部内容：省略 `tools` ⇒ 只 deny；给了 `tools` ⇒ allow + deny。

### 不变量

**I1 内置 deny 名单是安全边界，这六个名字恒不给子代理。**
`agent` / `delegate` / `workflow` / `ralph` / `set_child_permission` / `ask_user_question`，硬编码在 `BUILTIN_DENY`。
前四个是**能再开子代理**的入口：`agent` 是 preset 里那条静态委派行的 toolName（子代理从祖先层继承得到它）、`delegate` 是本插件的动态版、`workflow` 与 `ralph` 是编排引擎（`ralph` 那行的 config 是 `subagentProvider: spawn`）—— 放进任何一个，"一跳可达"当场失效，孙代理对调度者不可见、不可 steer。后两个（`set_child_permission` / `ask_user_question`）只认 live runtime root。
`notify_user` **刻意不在名单里**：它是单向、不阻塞的提醒，调度 persona 的【需要用户本人的事】明确允许给子代理用，好让撞上登录墙的后台子代理自己第一时间喊人，不必等调度者中转。
下发方式：调用方给了 `tools` ⇒ `{allow: <清单∩可用名>, deny: <内置名单∩可用名>}`；省略 `tools` ⇒ 只 `{deny: …}`（平台语义是"先按 deny 去掉、再按 allow 只留"，两者都只减不增）。
载体：D5；`delegate/lib/delegate.mjs` 的 `BUILTIN_DENY`。

**I2 内置名单必须与本次可用名求交，禁止整体照发。**
理由：名单里可能含本 profile 未注册的名字（没装 `adg-permission` 就没有 `set_child_permission`），而平台 `tools.restrict()` 对 allow 与 deny 里的未知名**都**校验（`tools.restrict() names unknown global tool "x"; known global tools: …`）—— 整体照发会让每次委派都当场失败（根 `AGENTS.md` 红线 7 / 10 同源）。
载体：D2 的瘦 profile 断言。
**未观测**：真实 profile 里这六个名字与本插件同装时的交集到底有几个；量法：装齐 `adg-permission` / `adg-notify` 后在新会话里委派一次，断言不抛 unknown-name 错，并在 `list_agents` 上确认该子代理的工具面里没有这六个名字。

**I3 未知名与内置禁用名一律"剔除 + 回显"，不让整次调用失败。**
`tools_note` 逐条列出 `名字（内置禁用）` / `名字（这次没有这个工具名）`，保持点名顺序。
理由：`tools_note` 是模型唯一能看见"我点名的名字没生效"的地方；静默丢弃会让它以为工具已经给下去了。
载体：D4。

**I4 后台一律 continuable；没有"后台一次性"路径。**
`background` 缺省 `true` ⇒ `subagents.startContinuable({provider:'spawn', label, request, signal})`，取 `childId`；`false` ⇒ `subagents.start('spawn', {...request, signal})`，取 run 的 `id`。
理由：本仓库只有后台的可续子代理是活的、能接续、能 steer；平台那条一次性后台路径要经 `jobs.start` 与 `settleStart`，本插件用不到，也就不解析 `jobs` 服务。
`kind` 的 enum 保留 `background` **只为与平台词表一致** —— 本实现不产出这个值。
载体：D9 / D10；`delegate/index.mjs` 的 `apply`。

**I5 `run_code` 当场拒绝 —— 选"抛错"，不是"剔除并写明"。**
理由三条：①它不是拼错的名字，而是要 PTC 传输本身，放行会让调用方以为子代理能跑程序；②平台对 allow 与 deny 两侧都为它抛错，本插件替它挡在前面并给出可诊断的中文消息；③剔除后继续会让这次委派"看起来成功"，与「不许把失败写成成功」相冲。
（另一条可选口径——剔除并写进 `tools_note`——被否掉，理由如上；要改回必须由人决定，见 AGENTS.md 的「停止并升级人类」。）
载体：D6。

**I6 读不出可用工具名 ⇒ fail-closed 抛错，不许跳过校验继续派。**
对照表 = `exec.agent.ctx.tools.view(exec.agent).restrictableNames`。`view` 不是函数、或返回值不是非空 `Set`，都抛一条自诊断错（消息里带上"读到了什么"）。
理由：没有对照表，既保证不了 I1（名单里可能有未注册名），也替模型挡不下未知名 —— "跳过校验继续派"只有两种结局：丢掉边界，或让平台在子代理建立时才抛未知名错。
载体：D11。
**未观测**：`view` 在 `@deepseek-ai/dsh-tools` 的类型面是 `private`（本机解析到的实现里它是原型上的普通方法，运行期可调用）；哪天它变成 `#private` 或改名，本插件会以自诊断错拒绝委派，而不是静默放过；量法：升级 dsh 后跑 `cd delegate && node --test test`，再做一次真实委派看是否抛 I6 的自诊断错。

**I7 persona 只在给了的时候出现，且语义是"遮蔽"不是"追加"。**
`request` 里没有 `persona` 键 = 子代理没有 persona 段；给了 = 平台把它注册成该子代理上的 scoped `deployment:persona-prefix` 段，**遮蔽**该子代理的部署 persona（模板插值语义与部署 persona 相同，本插件不碰）。
载体：D8。
**未观测**：遮蔽的净效果（部署 persona 是否真的整段落下去）；量法：真派一次带 persona 的子代理，读它会话日志里的 `deployment:persona-prefix` 段，确认部署 persona 没有残留。

**I8 `maxDepth` 一律不传。**
一跳可达 = 平台默认值 1 + deny `delegate`；写 `0` 会让每次委派以 `subagent depth 1 exceeds maxDepth 0` 失败。
载体：D8 / D9。

**I9 工具结果只声明"建立并投递"，不声明子代理的结局；前台 run 的终局必须被接管。**
`background:false` 时那个 run 没人 await，`run.result` 一旦以基建故障 reject 就会成为 unhandled rejection（Node 默认崩进程）——所以挂一个终局观察者，故障走注入的 `warn`（运行时是 `ctx.logger.warn`）如实报出。`id` / `childId` 取不到时抛错，绝不回显一个 undefined 当成功。
载体：D10。

**I10 对照表从**调用方自己的**工具视图读：`view(exec.agent)`。**
理由：dsh-scope 的 scope key 就是持有 `.ctx` 的那个 Agent 对象（`dsh-agent-loop` 里 `this.scope = createScope(loopCtx, this); this.ctx = this.scope.ctx;`），旁证是 dsh-agent 的路由一律 `scopeTarget(agent, agent)`。
载体：D9（断言 `view` 的实参就是那个 Agent 对象）。
**未观测**：若某个 dsh 版本里 Agent 不再是 scope key，`view()` 会**静默**返回"只有全局层"的集合（不抛错）⇒ 点名的 agent 面工具会被误报成"这次没有这个工具名"；量法：真实会话里让调度者用 `tools: ["Read"]`（它自己工具面里的一个 agent 面名字）委派一次，断言 `tools_note` 里没有把 `Read` 列为忽略。

**I11 工具名三处一致，且本插件不注册任何别的名字。**
`delegate/index.mjs` 的 `export const name`（`adg-delegate`）= `delegate/cordis.patch.yml` 的 insert 行 `id`；包名同值。global 层重名注册会让整个 profile 的插件加载失败 ⇒ preset 里禁止再插同名行。
载体：D12；`node tools/check-preset.mjs`。

## 对外接口

**模型面（工具契约）**

| 项 | 值 |
|---|---|
| 名字 | `delegate`（全 DSH 唯一；模板里的工具名必须是它） |
| 参数 | `description` ✱ / `prompt` ✱ / `tools?`（string[]）/ `persona?` / `background?`（缺省 `true`） |
| 输出 | `description` / `subagent_id` / `kind`（`continuable` \| `background` \| `foreground`）/ `tools` / `tools_note` / `persona`（`set` \| `unset`） |
| render | 一行：`<description> → <kind> 子代理 <subagent_id>（<tools_note>）` |
| 并发 | `isConcurrencySafe: () => true` —— 只建立会话并投递，不改既有状态（实参不成立时平台那层包装会保守地回 `false`） |
| 超时 | `timeoutMs: 15000` —— 只等"建立 + 投递"（可续 = 子代理 inbox 接受初始 prompt；前台 = 子代理被发布）。比 `permission/` 的 30 秒小，因为那边等的是另一个会话的一次完整读写往返 |

**库接口（`delegate/lib/delegate.mjs`，零 import）**

常量：`TOOL_NAME` / `SUBAGENT_PROVIDER`（`'spawn'`）/ `SUBAGENT_KINDS` / `BUILTIN_DENY` / `RESERVED_PTC_NAME`（`'run_code'`）。
函数：`assertCallerAgent(exec)` / `readRestrictableNames(parent)` / `planToolFilter(requested, knownNames)` / `toolsNote(plan)` / `buildRequest(args, parent, filter)` / `continuableChildId(started)` / `foregroundRunId(run)` / `superviseOneShotRun(run, warn)` / `delegate(args, exec, deps)`。

**装配接口（`delegate/index.mjs`）**

`name` / `inject` / `TOOL_NAME` / `createDelegateTool(deps)` / `apply(ctx)`；`deps = {defineTool?, services?, warn?}` —— `services()` 只回 `{subagents}`，`warn` 指到 `ctx.logger.warn`。

## 非功能红线

- **性能预算**：一次调用只做一次 `view()` 读 + 一次服务调用；不遍历子代理目录、不读会话、不写盘、不起进程。
- **一致性纪律**：工具面与 persona 只在**这一次**生效；本插件不注册中间件、不写全局状态、不改别的会话。
- **并发与幂等**：可以并发派发多条（对照表是只读的），每条各建立一个新的可续子代理；"重复调用同一个 id"不在本插件的职责内。
**未观测**：并发多条时 `view()` 的读数在被别的插件改动 scoped layer 的窗口里是否稳定；量法：并发派两条，断言两条的 `tools` / `tools_note` 一致。
- **数据安全**：不读也不写会话内容；不落盘；不写死本机路径；唯一一条日志是前台基建故障的 `warn`，只带 run 的 id 与错误消息，**不带** prompt 正文。

## For Agents

**动手前先读**：本文件 → `delegate/test/delegate.test.mjs`（用例就是契约）→ 平台契约里的 `ToolRestriction`、`SubagentStartRequest`、`tools.view()`。

**绝不能做**：放行内置 deny 名单里的名字；把未知名静默丢掉；剔除 `run_code` 后继续；读不出对照表还继续派；给子代理传 `maxDepth`；解析 `jobs`；让前台 run 的 `result` 逃逸成 unhandled rejection。

**停止并升级人类**：要改内置 deny 名单的内容或语义、要让子代理拿回 `delegate`、要把 I6 从 fail-closed 改成"跳过校验"、要动工具名 —— 这四条都在改能力边界，必须由人决定。

## 测试与验证

判据、用例全表与未观测项在 [testing-guide.md](testing-guide.md)。
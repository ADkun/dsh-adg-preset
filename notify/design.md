---
title: notify 模块设计
owner: Adg preset 维护者
status: current
last_reviewed: 2026-10-04
---

## 职责与边界

负责：把「让用户知道该他动手了」收敛成一个**已注册的工具 `notify_user`** 和一条**可单独验证的 toast 通路** —— 工具的参数 / 描述 / 返回结构，一次 Windows toast 的构造与投递（PowerShell 5.1 宿主、XML 模板、声音与存活时间），失败时的**可读错误**，以及"把这个包部署进每个 profile 并选中它"的三件套（稳定副本、`file:` 依赖、`dsh.profile.bundles` 条目）。

不负责（逐条防越权）：

- 不拥有"什么时候该通知用户"这个判断：撞上登录墙 / 验证码 / 二次验证 / 需要用户在本机动手或拍板时**由子代理自己决定**要不要调（触发面写在 `notify_user` 的 description 里）；本模块只负责"把话推出去"。
- 不拥有用户问答通道：通知是**单向**的，弹出去就结束 —— 不阻塞、不等待回话、不投递任何回复。要用户**回答**问题仍然走 dsh 自己的会话：子代理停手、把未决问题写进最终结果，调度者用 `ask_user_question` 转达（被委派的子代理没有人类答主）。本模块不提供等待、回调、轮询。
- 不拥有浏览器：浏览器能力（`skills/adg-browser-use` + `browser/` 工具链）撞上登录墙时"开一个有头窗口让人进去"是 `browser/` 的职责（见 `browser/design.md` 的「核心数据模型」一节），本模块不碰浏览器、不碰登录态。
- 不拥有 preset 与工具目录：`notify_user` 进不进子代理的工具面由调度者**每次委派时**的 `delegate` `tools` 决定；本模块只保证"这个名字在全局层被注册"，不替调度者做工具面决策。
- 不拥有 dsh 的插件装载：本模块给的是 `dsh.bundle.patch` + patch 行 + 一个能被解析的包；"profile 有没有选中它""运行期 loader 有没有 import 它"分别是 dsh 的 `reconcileProfilePlugins` 与 loader 的事 —— 本模块只能在安装脚本里**读回来断言**到"装了且被选中"这一层。
- 不拥有设置页：没有 `dsh.client`、没有 UI，参数只有工具自己的三个字段。
- 不拥有跨平台：toast 机制**只存在于 Windows**；非 Windows 上 `sendToast` 直接抛错，不做"降级成写日志"（那会让"通知成功"变成一句谎话，见 I6）。

## 依赖关系

- 依赖：Node 内建的 `node:child_process` / `node:fs` / `node:path` / `node:url`，以及系统上的 **Windows PowerShell 5.1**（`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`）。零第三方包。
- 依赖（可选 peer）：`@deepseek-ai/dsh-tools`（`peerDependenciesMeta.optional`），只用来取 `defineTool`。运行期它由 dsh 自己的解析拦截层供给：profile 的 `node_modules` 里**没有**这个目录，本机原生解析（`createRequire(...).resolve.paths`）从 profile 的插件目录出发也找不到它，而同类插件（真目录、无自己的 `node_modules`、却 import 了 profile 里不存在的 `@deepseek-ai/*` 包）在生产里正常工作 ⇒ **这不是漏配依赖**（I12）。仓库根的 `node_modules/@deepseek-ai` Junction 只为让 `notify/test` 能在开发机上跑起来（见 [testing-guide.md](testing-guide.md) 的自测前提）。
- 被依赖：
  - `install.ps1` / `install.sh` 的第 2b 步（把 `notify/` 拷到 `${DSH_HOME:-~/.dsh}/plugins/adg-notify/` 稳定副本）与第 4c / 4c-1 步（逐 profile `dsh plugin --profile <n> add file:<稳定副本>` + 读回来断言三格）。
  - 调度 persona 与每次委派的 `tools`（`notify_user` 由调度者按需给）与 `tools/check-preset.mjs` 的 `KNOWN_TOOLS`（已收这个名字）。
- 跨模块改动路由：改工具名 / 参数 / 描述 → 先读 `tools/check-preset.mjs` 的 `KNOWN_TOOLS` 与 `delegate` 侧的名字口径；改部署形状（落点、装法、写进哪个列表）→ 先读 `install.ps1` / `install.sh` 的第 2b / 4c 步与 I8 / I9；改 toast 行为 → 先读 I4 / I5。

## 核心数据模型

三个对象都是**不可变值对象**（创建后内容冻结，修改＝新对象，无状态机）：Notification（要投递的内容）、ToastRequest（投递计划）、ToastResult（返回值）。另有两条作者侧契约（工具定义）与一组装配契约（装载与可见性），同样以不变量表达、没有状态机。

### Notification（不可变值对象）

一次调用要投递的东西：`title`（已 trim，空则用默认标题 `DSH 通知`）、`message`（已规范化，空则抛错）、`silent`（布尔）、`disappearAfterMs`（整数毫秒）。

- **I1** 每一行只 `trimEnd`、不 `trimStart`（正文里的缩进 / 对齐是有意义的），而**标题额外做一次 `trim()`**。理由：标题两边带空白时 Windows 会把通知标题渲染成带空格的怪样子。载体：`notify/test/notify.test.mjs` 的 D5 用例（`cd notify && node --test test`，期望 exit 0）。
- **I2** `message` 为空字符串 / 全空白 / 非字符串时**抛错，不发一个空通知**；`title` 非字符串、`disappearAfterMs` 非整数同样抛错。载体：D2 / D5 用例。
- **I3** `silent` 只按**值**判定（`typeof args.silent === 'boolean'`），不按"键在不在"判定；未传或 `undefined` 时落到默认出声。理由：`dsh-tools` 的参数校验会**就地补齐已声明的属性** —— `tool.execute({ message: 'x' })` 进到 `execute` 的 `args` 里 `title` / `silent` 键**存在但值为 `undefined`**，按键判定会把默认值判反；也不许写成 `silent: undefined`（那会盖掉默认值）。载体：D3 用例。

### ToastRequest（投递计划，不可变值对象）

`scriptPath`（默认 `PACKAGE_ROOT/scripts/toast.ps1`）、`powerShellPath`、`argv`、`timeoutMs`。

- **I4** 执行器**只能是 Windows PowerShell 5.1**（`.ps1` 必须 ASCII-only、无 BOM），命令行固定为 `-NoProfile -NonInteractive -ExecutionPolicy Bypass -File <script> -Title <…> -Body <…> -AppId <…> -Sound <default|silent> -DisappearAfterMs <n>`；`-Body` 传的是已 join 的多行字符串（PowerShell 侧按行拆成多个 `<text>`）。理由：`pwsh` 没有 `Windows.UI.Notifications` 的 WinRT 投影；5.1 按 ANSI 代码页解码无 BOM 脚本，非 ASCII 会乱码，所以中文只走 `-Title` / `-Body` 实参。脚本路径由 `import.meta.url` 推出、PowerShell 路径由 `%SystemRoot%` 推出，都不写死本机路径。载体：D5 / D6 / D7 用例。
- **I5** 存活时间与 Windows toast 的 `duration` 对齐：`<= 0` → `scenario="reminder"`（常驻提醒，不设 `ExpirationTime`，留在通知中心直到用户处理）；`> 7000` → `duration="long"`；否则 `short`。默认 `0`（⇒ 常驻）。理由：这是一条"该你动手了"的通知，8 秒（long duration）在实机上读作"还没来得及看就没了"；常驻才是它该有的形态。`silent` 时追加 `<audio silent="true"/>`。AppId 默认借 PowerShell 自己的 AppUserModelID（`{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe`）—— 零模块、零 COM 注册的代价是通知归属显示为 Windows PowerShell。可用环境变量覆盖（只为排错与测试）：`ADG_NOTIFY_TOAST_SCRIPT` / `ADG_NOTIFY_POWERSHELL` / `ADG_NOTIFY_TIMEOUT_MS` / `ADG_NOTIFY_APP_ID`。载体：D5 用例。

### ToastResult（返回值，不可变值对象）

`{ shown: true, mechanism: 'toast', title, message, disappearAfterMs, sound, scriptPath, powerShellPath }`。

- **I6** **失败不是一种返回，而是一次抛出。** 全部失败路径——非 Windows 平台 / toast 机制不可用 / 脚本不存在 / 脚本不是普通文件 / PowerShell 可执行文件不存在 / `spawn` 同步抛错 / 子进程 `error` 事件 / 非零退出码 / 被信号杀死 / 超时——一律抛 `Error`，消息里带**具体是哪一个**（路径、退出码、信号、毫秒数）；其中"PowerShell 不存在"那条**抛错前不起进程**，"超时"那条抛错前先 `child.kill()`。理由：任何"静默成功"或返回 `shown: false` 的写法都会让上游子代理以为用户已经被提醒过了。载体：D4 用例。

### 装载与可见性（本模块 ↔ profile / preset）

- **I7** 本插件的 patch 行落在**全局层**（profile 级 bundle 的 `insert` 没有 scope），而 `dsh-tools` 的可见性判据是"global 层 + 链上祖先层" ⇒ **`notify_user` 这个全局名字对 Adg 的所有 agent 可见**，调度者在 `delegate` 的 `tools` 里写它就能用（它不在 `BUILTIN_DENY` 里）；反过来，**同一层重名注册会直接失败**（那会拖垮整个 profile 的插件加载），所以 preset 里禁止再注册一个 `notify_user`。载体：D1 用例；在仓库根跑 `node tools/check-preset.mjs`。
- **I8** **"装了包"与"被选中"是两件事，必须同时成立**：bundle 装载只遍历该 profile 的 `dsh.profile.bundles`，而只写列表、包装不上会让这个 profile 启动报错。所以 `install.*` 第 4c 步做安装、第 4c-1 步**读回来断言三格**（`node_modules` 里是真目录 + `dependencies` 有它 + `dsh.profile.bundles` 有它）。载体：`install.*` 第 4c-1 步的输出。
- **I9** **"每个 profile 都装了 adg-notify"是那些点它的 `tools` 成立的前提，而它由"同一次安装"兜住。** `restrict()` 是挂载期判据 —— 一个 profile 只要挂了 Adg bundle 而没装本插件，**每一次委派**都会抛 `names unknown global tool notify_user`，整个 preset 变成不可用。当前为何安全：`install.ps1` / `install.sh` 在**同一次运行**里先做第 2b 步、再逐 profile 做第 4c 步，同一个脚本也负责生成并链接 preset bundle，**没有"只装 bundle 不装插件"的开关**。**这条前提是脆的**：第 4c 步失败只如实报告、不中断（宿主在跑时 pnpm 可能删不掉目录），所以"bundle 装上了、插件没装上"是**可能出现的中间态** —— 此时脚本会打印 `adg-notify 没装进 …` 与手工命令，用户必须看到它。将来若把两步拆成可分别跳过的开关，要么从委派的 `tools` 里撤掉这个名字，要么把插件安装改成硬前置。
- **I10** 稳定副本按**内容**（SHA256）比对后再拷；内容没变就不碰它。理由：免得 pnpm 在下次 `dsh plugin add` 时又要重装一遍（宿主在跑时那一步会 `os error 32`）。载体：`install.*` 第 2b 步；判据＝源码没变时它不重拷（输出里说明已是最新）。
- **I11** **稳定副本与各 profile 的副本是硬链接（同一个文件），"刷新稳定副本"就等于"刷新所有 profile 副本"。** profile 的 `node_modules/adg-notify/` 不是拷贝，而是 pnpm 对 `file:` 依赖做的**硬链接目录**；第 2b 步用 `Copy-Item` 就地覆盖（文件 ID 前后不变，是就地重写而不是替换文件）⇒ 链接存活、profile 副本当场就是新内容，**不必 `dsh plugin remove` + `add`**。反过来：仓库源与稳定副本在**不同盘**，不可能硬链接 ⇒ 改了仓库里 `notify/` 的源码**不会**自动同步到稳定副本，必须重跑一次 `install.*`。量法：`fsutil hardlink list <稳定副本>\package.json` 与对 profile 副本的同一条命令应返回同一组路径，`fsutil file queryFileID` 两处应返回同一个 ID（读数是当场读数、不作锚）。载体：[评] 这两条命令。
- **I12** 运行期不依赖 profile 的 `node_modules` 里有 `@deepseek-ai/dsh-tools`：本机原生解析从 profile 的插件目录出发找不到它，而同类插件在生产里正常工作 ⇒ 这个裸 import 由 **dsh 自己的解析拦截层**供给（见「依赖关系」）。载体：[评] 读 `notify/index.mjs` 的 import 与 `notify/package.json` 的 `peerDependenciesMeta`。

### 工具定义（作者侧契约，不可变值对象）

`defineTool` 的两个入参：`parameters`（参 schema）、`output`（`{ schema, render }`）。

- **I13** `output` 必须是 `{ schema, render }` 且 `render` 是函数，否则抛 `TypeError: tool "<name>" must declare output { schema, render, presentationMeta? }`；`run_code` 是保留名。载体：D2 用例。
- **I14** **作者侧的 schema 方言是"隐式属性映射"，不是对象根 JSON Schema。** `parameters` 写成 `{ message: { type:'string', required:true, description }, title: {…}, silent: {…} }` —— **key 就是属性名**，必填由属性上的 `required: true` 表达；写成 `{ type:'object', properties:{…} }` 会被当场判死：`JsonSchemaError: unsupported JSON schema: parameters.type must be a value schema object`，顶层 `additionalProperties` 同样被拒。`output.schema` **反过来**要对象根形状 `{ type:'object', additionalProperties:<显式布尔>, properties:{…} }`（缺那个显式布尔会被拒）。理由：这个抛错发生在 `apply()` 注册的那一刻，也就是说形状写错＝**插件一挂载就崩**，而它不会在任何"只跑 stub"的自测里暴露。载体：D2 的三条用例，其中一条是**反向对照**（把错形状喂给真 `defineTool` 并断言它抛错，否则"不抛错"那条可能只是在空转）；纪律是造定义必须用**真的** `defineTool`（`createNotifyUserTool()` 因此支持注入 `defineTool`）。

## 对外接口

- 工具：`notify_user` —— 参数 `message`（string，**必填**）/ `title`（string，可选）/ `silent`（boolean，可选）；`isConcurrencySafe: () => true`；`timeoutMs: 15000`；`output` 形状见 I13。description 写的是**触发面**：必须由人在本机完成的阻塞点（登录墙 / 验证码 / 二次验证 / 设备确认，或需要用户拍板、出示凭据、在本机操作某个窗口）；正文要写清「卡在哪 / 用户具体要做什么 / 完成后回来告诉我什么」，并明写"这是单向通知，不会阻塞、也不会等待用户回话：调用后立刻返回，用户是否看到不影响本步继续"，以及"用户不在电脑前时通知可能没被看到 —— 不要把它当成『已获得用户确认』，也不要用它代替 `send_message`"。
- 命令行契约：`notify/cli.mjs` 的 `usage()` 是唯一真相源（子命令、选项、退出码都在那里）；在 `notify/` 里跑 `node cli.mjs help` 打印它。退出码：**0 = 已投递 / 1 = 没投出去（stderr 给原因）/ 2 = 用法错误**（与 `browser/cli.mjs`、`tools/check-preset.mjs` 的 0/1/2 同形）。这条命令只验证机制能不能弹，**不验证 dsh 有没有装载本插件**。
- 库接口：`notify/index.mjs` 导出 `name`（= `adg-notify`）/ `inject`（= `['tools']`）/ `TOOL_NAME`（= `notify_user`）/ `createNotifyUserTool()` / `apply()`；`notify/lib/toast.mjs` 导出 `sendToast()` 与一组默认值常量（`DEFAULT_TITLE` / `DEFAULT_DISAPPEAR_AFTER_MS` / `DEFAULT_TIMEOUT_MS` / `DEFAULT_APP_ID` / `DEFAULT_SCRIPT_PATH` / `PACKAGE_ROOT` / `SOUND_VALUES` / `resolvePowershellPath()` / `normalizeNotification()` / `buildToastArgs()`）。`createNotifyUserTool(deps)` 的依赖可注入（`send` 默认 = `sendToast`），这是测试能在不弹窗的前提下覆盖注册与失败路径的原因。
- 装配接口（指针化，取值以文件本身为准，本文不复制）：`notify/cordis.patch.yml` 声明 patch 行（`id` 与 `name` 都必须是 `adg-notify`，落全局层）；`notify/package.json` 声明 `main` / `exports` / `files`（进 profile 副本的清单）/ `scripts.test` / `dsh.bundle.patch` / 可选 peer 依赖。

## 非功能红线

只列技能要求的四类。操作型红线集中在 `notify/AGENTS.md` 的「红线」一节（R1..R12），**那里是唯一清单**，本文件不再抄一份 —— 两份互相重复的清单正是同一条规定要改两处的来源。

- **性能预算**：一次投递的上界＝工具 `timeoutMs` 与 `sendToast` 的超时（默认 15 秒），超时即 `child.kill()` + 抛错。**禁止在链路里做重试循环或等待用户回话** —— 那会把一次工具调用变成阻塞，与"单向、不阻塞"的接口语义冲突。来源：接口语义（I6）＋ Windows toast 是"投递完就返回"的机制。载体：[机检] 超时用例（D4）；[评] 读 `sendToast` 的控制流。
- **一致性纪律**：**禁止把"没弹出去"写成"弹过了"**（I6 / R4）；**禁止把 `.ps1` 写成非 ASCII 或带 BOM**（I4 / R2）。来源：前者是这个工具唯一的价值所在（用户真的看到了）；后者是 Windows PowerShell 5.1 的 ANSI 解码行为。载体：[机检] D4 / D6 用例。
- **并发与幂等**：`isConcurrencySafe: () => true` ⇒ 同一会话里允许并发调用；本模块**不做去重、不做重试**，每次调用就是一条通知意图（不幂等）。来源：`notify/index.mjs` 的工具声明。**未观测**：两条通知几乎同时投递时 Windows 会不会吞掉其中一条；量法：在 `notify/` 里跑 `node cli.mjs send --message a && node cli.mjs send --message b`，看通知中心是两条还是一条。
- **数据安全**：本模块无加密、无访问控制，**通知标题与正文会驻留 Windows 通知中心**，因此按"会被旁人看到"对待 —— 正文里**不写凭据 / 令牌 / 一次性验证码**，只写"要在哪个窗口做什么"；**禁止借通知绕过登录墙、做验证码识别或代替用户输账号密码**。来源：`preset/design.md` 的 R20 ＋ `skills/adg-browser-use` 的登录墙约束 ＋ 通知驻留通知中心这一机制事实。载体：[评] 读那次委派的 `tools` / `prompt` 与通知正文。

## For Agents

动手前先读：`notify/AGENTS.md` → 本文件 → 改工具契约再读 `tools/check-preset.mjs` 的 `KNOWN_TOOLS` 与 `delegate` 侧的名字口径。

绝不能做：`notify/AGENTS.md` 的「红线」一节 R1..R12；本文件的 I2（发空通知）、I6（把失败当成功）、I7（同名两层注册）、I9（把"装 bundle"与"装插件"拆成可分别跳过的两步）、I11（以为改仓库源码会自动同步到 profile）、I14（把 schema 写成对象根形状）。

停止并升级人类：要改工具名；要把通知做成**阻塞式**（等用户回话）；要加设置页 / UI；要引入第三方依赖；要在非 Windows 平台上"降级成写日志"。

## 测试与验证

见 [testing-guide.md](testing-guide.md)：用例总表按本文件的不变量编号（I1..I14）互指，另含消费方契约测试、未观测项与交付前的最小闭环。
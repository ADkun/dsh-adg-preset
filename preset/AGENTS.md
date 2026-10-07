# AGENTS.md — preset（Adg preset 的定义）

本模块是 Adg 多智能体模式的**定义**：一份调度 persona（`## 你手上的子代理` 名册 + 分派与验收规则）与 `delegation` 组里那条唯一的委派行（委派行数以 `node tools/check-preset.mjs` 当场报出的为准）。**没有固定专家名册**：子代理的目标、边界、验收标准、工具面与可选 persona 全由调度者在每次委派时经全局工具 `delegate` 现给。
`preset.yml` / `agent.cordis.yml` / `bundle.package.json` 是 **bundle 的源**（唯一真相源，仓库里没有"已安装的第二份"）；`bundle/` 下的生成物不许手改，它由 `tools/gen-preset-bundle.mjs` 生成、装进 profile 的 `dsh.profile.bundles`。
**任何改动都要重新生成 + 重新安装 + 重启 dsh + 新对话才生效**（见「生效方式」）。设计细节与不变量一律在 `design.md`，验证判据在 `testing-guide.md`。

## 命令

零依赖，只要 Node（`browser/package.json` 与 `notify/package.json` 都声明 `>= 22`）。仓库根没有 `package.json`。

```sh
# 静态自检（逐行文本扫描，不是 YAML 解析器）：exit 0 通过 / 1 有 ERROR / 2 读不到目标文件
node tools/check-preset.mjs

# 生成 bundle（产物落在被 .gitignore 排除的 bundle/ 下；install.* 每次按探测结果重跑）
node tools/gen-preset-bundle.mjs                                     # plain
node tools/gen-preset-bundle.mjs --with-billion-context              # bili：注入上下文工具 + compaction-basic.auto=false
node tools/gen-preset-bundle.mjs --with-save-token                   # save-token：注入 save_token_expand
node tools/gen-preset-bundle.mjs --with-billion-context --with-save-token   # bili+save-token

# 产物自检（check-preset 看的是源文件，产物是它的盲区）：四种味道都要跑，判据 exit 0
node tools/gen-preset-bundle.mjs bundle/adg-plain && node tools/check-bundle-flavor.mjs bundle/adg-plain/cordis.patch.yml plain
node tools/gen-preset-bundle.mjs --with-billion-context bundle/adg-bili && node tools/check-bundle-flavor.mjs bundle/adg-bili/cordis.patch.yml bili
node tools/gen-preset-bundle.mjs --with-save-token bundle/adg-save-token && node tools/check-bundle-flavor.mjs bundle/adg-save-token/cordis.patch.yml save-token
node tools/gen-preset-bundle.mjs --with-billion-context --with-save-token bundle/adg-bili-save-token && node tools/check-bundle-flavor.mjs bundle/adg-bili-save-token/cordis.patch.yml bili+save-token
# 味道键必须写 `bili+save-token`（写成 `bili-save-token` 会 exit 2「未知的味道键」；稳定目录名才是 …-bili-save-token）

# 探测与味道映射（别在别处重写这份判定；味道键 / 稳定目录名 / 注入清单只有一份，在 tools/flavors.mjs）
node tools/has-bundle.mjs ~/.dsh/profiles web               # 每 profile 一行 `<profile>\t1|0`，退出码恒 0
node tools/has-bundle.mjs ~/.dsh/profiles web --package=dsh-plugin-save-token
node tools/resolve-flavor.mjs --billion-context --save-token                 # → `<味道键>\t<稳定目录名>\t<gen 旗标>`

# 首装或重装（技能 + preset bundle + browser 工具链 + notify / permission / delegate 子插件）
sh install.sh                                                     # macOS / Linux
powershell -ExecutionPolicy Bypass -File .\install.ps1            # Windows
# 只给某个 profile 用 bili 注入版：sh install.sh --billion-context=on web  /  ... -BillionContext on -Profiles web
```

**读数是当场读数，不作锚**：上面各脚本打印的通过/警告条数、字节数、行坐标都随文件变动而漂；要它们就当场跑脚本读它自己的输出，别把数字抄进文档。

## 红线

每条只写结论与理由（**违反即返工**）；载体的含义是该条靠什么被钉住。根 `AGENTS.md`「关键红线」里的其余各条同样适用于本模块。

| # | 红线 | 来源 / 载体 |
|---|---|---|
| 1 | 禁止把 `validated` 当 `mounted`：`check-preset.mjs` exit 0 只证明"文本没被发现违规"，不证明 YAML 可解析、不证明已重新安装、更不证明挂载成功。理由：静态检查与运行期注册是两件事，混起来会对着坏 preset 安排工作。 | `preset/design.md` 的「PresetRevision」；真实挂载（`agentPresets.resolve('adg')` 的 `.broken` 为空） |
| 2 | 禁止没重启 dsh 就宣称已生效：dsh 读的是 profile 里注册的声明行，文件改动不会替换已挂载的 preset。理由：旧会话里的模式选择在起步时就锁定了。 | 重启 + 新对话里真实委派一次 |
| 3 | 禁止给承载体积旋钮的三行写回覆盖值（`compaction-basic` / `tool-result-pruner` / `tool-web`）：一律用插件出厂默认；一并禁止把交付侧的证据落点判据（按【拆解立目标】里的【验收标准】逐条判定）简化成"让子代理自报"。理由：截断会把工具**已经取到**的事实切掉，子代理只能重取或拿残缺证据下结论；提前压缩让上下文不可逆失真 —— 两者都比不裁更贵；而拿不出前后对比数字就无法判断改动是否真的省了成本，所以确实要改体积旋钮时，必须按 `preset/design.md` 的「PresetRevision」里那条对比数字的不变量，改动前后各按 `preset/testing-guide.md` 的「怎么重新测量」跑一次会话审计。 | `tools/check-preset.mjs`（旋钮行）；`tools/check-preset.mjs` 的 persona 段存在性检查 + `preset/design.md`（证据落点判据） |
| 4 | 禁止在 persona 里写 token / 读取预算或字数次数上限，也禁止把 `## 约束` 与 `## 验收标准` 改写成分步流程与固定字段表。理由：那把子代理的注意力从"做对"挪到"少写"；这两个锚段约束的是"派给谁 / 派几次 / 材料怎么中转 / 写下来的东西怎么组织"。 | `tools/check-preset.mjs` 的段存在性检查；`preset/design.md` 的「对外接口」 |
| 5 | 禁止加回通用 `subagent` / `subagent_fork` 委派行；也禁止把 `agent` / `delegate` / `workflow` / `ralph` / `set_child_permission` / `ask_user_question` 从 `adg-delegate` 的 `BUILTIN_DENY` 里删掉、放宽或绕过，或经 `delegate` 的 `tools` 把它们发给子代理。理由：前四个都能**再开子代理**（`agent` 是本 preset 那条静态委派行的 toolName、`delegate` 是它的动态版、`workflow` / `ralph` 是编排引擎），一放就破坏"一跳可达"（孙代理对调度者不可见、不可 steer），并让承载编排约束的那几段整段失效；后两个只认 live runtime root。`notify_user` **刻意不在名单里** —— 它是单向提醒，允许给子代理用。 | `delegate/AGENTS.md` 的 R1 / `delegate/test/delegate.test.mjs` 的 D5；`tools/check-preset.mjs` |
| 6 | 禁止给委派行写 `maxDepth`，也禁止 `delegate` 给子代理传 `maxDepth`：写 `0` 会让每一次委派以 `subagent depth 1 exceeds maxDepth 0` 失败。 | `tools/check-preset.mjs`；`delegate/AGENTS.md` 的 R6 |
| 7 | 禁止给任何请求设 `maxTokens` / `agentOptions` / `reasoningEffort`：输出只占账单很小一份，压它损伤质量；`reasoningEffort` 在手工声明的路由上让每次委派直接报 `UNSUPPORTED_REASONING_EFFORT`。 | `tools/check-preset.mjs` |
| 8 | 委派行的 `toolFilter.allow` 与 `delegate` 的 `tools` 里只能写**已注册**的工具名。合法名单的唯一来源是 `tools/check-preset.mjs` 的 `KNOWN_TOOLS`；`bash` / `read_image` / `subagent_codex` / `subagent_claude_code` 是**条件性注册**的名字，未注册时脚本只给 WARN（`read_image` 就属这一类）。理由：`dsh-tools` 的 `restrict()` 遇到未知名直接抛 `names unknown global tool …`，那一次委派当场失败；经 `delegate` 的 `tools` 点名的未知名则由插件剔除后**逐条写进 `tools_note`**（不许静默丢掉）。 | `tools/check-preset.mjs`；`delegate/AGENTS.md` 的 R2 / R3 |
| 9 | 有 `pwsh` 就必须同给 `job_list` / `job_output` / `job_kill`（这条落在每次委派现给的 `tools` 上）。理由：缺了它们，子代理起的后台作业没有人能收。 | `tools/check-preset.mjs`；`preset/agent.cordis.yml` 调度 persona 的【派给谁】 |
| 10 | 子代理的工具面不写 `skill`：技能按**渐进式披露**放在 `skills/` 里，需要技能的委派由调度者给出技能文件的绝对路径 +「先 read 该文件再动手」，不内联、不复述技能正文（技能面只归调度智能体）。 | `tools/check-preset.mjs` 的 WARN；`preset/design.md` 的「DelegationRow 与动态工具面」 |
| 11 | 禁止把构建期注入名手写进 `preset/agent.cordis.yml`：清单只有一份，在 `tools/flavors.mjs` 的 `INJECTION_GROUPS`。理由：两头都是缺陷 —— 不给，那两个插件的指令会要求子代理去调它没有的工具；给了但目标 profile 没装那个插件，撞红线 8。 | `tools/check-preset.mjs`（手写即 ERROR）+ 四条 `check-bundle-flavor.mjs` 断言 |
| 12 | 禁止删掉或绕过浏览器任务的权限闸门，也禁止把它写成"权限强制"。理由：闸门是**提示级**的——权限在**委派那一刻**被捕获，子代理不能自升权；写成强制会让调度者放弃如实交代环境。父代理事后要改一个**已经派出去**的子代理的权限，只走 `set_child_permission`（`adg-permission` 插件；血缘与"不得高于调用方"两条守卫在代码里），**禁止**把闸门改写成"切完权限旧子代理就自动能用"。 | `preset/design.md` 的「SchedulerPersona」与「非功能红线」；`permission/design.md`；真实委派 |
| 13 | 禁止让子代理自己问用户：`ask_user_question` 不进任何一次 `delegate` 的 `tools`（它同样在 `adg-delegate` 的 `BUILTIN_DENY` 里）。理由：子代理调用它拿 `DELEGATED_CALLER`，该错误文本自己规定要把未决问题写进最终结果。 | `tools/check-preset.mjs`；`delegate/AGENTS.md` 的 R1 |
| 14 | 禁止把「请用户手动登录」写成失败路径，或派发前预先禁止登录：那是浏览器任务的**正常入口**，不是失败。 | `preset/design.md` 的「非功能红线」；人工 review |
| 15 | composition 里每个 `@deepseek-ai/*` 包名都必须对着当前安装核对（判定口径的唯一本体是 `preset/design.md` 的「核心数据模型」里那条包名核对不变量；改动后怎么生效、怎么复核见本文件「生效方式」表同名那行）。 | 真实挂载；静态自检发现不了 |
| 16 | `preset/agent.cordis.yml` 是 **UTF-8 无 BOM**：用按 ANSI 猜测编码的文本工具（Windows PowerShell 的 `Get-Content` / `Set-Content`）读写会乱码并改变行数。读写一律走 UTF-8 感知的路径。 | 改完 `node tools/check-preset.mjs` + 复核行数与内容 |
| 17 | 禁止把工具面当成提示。委派行的 `toolFilter.allow` 与每次现给的 `delegate` `tools` 恰好等于子代理那次可见的工具目录（连 preset 自己注册的工具一起被裁；`toolFilter` 是交集、只减不增，动态的 `tools` 就是最终面）⇒ 禁止在 persona 里要求子代理做它那次工具面之外的事，也禁止承诺"子代理之间默认能互相转交一个任务"。 | `tools/check-preset.mjs` 的名字校验 + 一次真实委派 |

**编号连续**：本表条目按上表顺序连续编号，没有空号 —— #3 这一条同时覆盖两项判据（体积旋钮写回 + 交付侧证据落点判据），两项都要照做，不要拆成两条。

**未观测**：不重启 dsh 时新开的会话会不会直接加入重注册后的声明；量法：改一次源文件、重装 bundle，不重启就新开一个会话，读 `agentPresets.resolve('adg')` 的解析结果与调度 persona 名册是否已是新版。

## 跨模块路由

| 你要做什么 | 先读 | 再读 |
|---|---|---|
| 改委派能力 / 工具面映射（派什么、给哪些工具） | `skills/adg-delegation/SKILL.md` | 本文件「红线」→ `preset/design.md` 的「DelegationRow 与动态工具面」→ 改完跑上节第 1 条命令 |
| 改 `delegate` 插件本身（工具名 / 参数 / deny 名单 / 装载） | `delegate/AGENTS.md` | `delegate/design.md` → `delegate/testing-guide.md` |
| 改调度 persona 的名册或分派规则 | `preset/design.md` 的「SchedulerPersona」 | `preset/testing-guide.md` 的「用例总表」 |
| 改浏览器那一段委派口径（模式 / 登录态 / 权限闸门） | `preset/design.md` 的「SchedulerPersona」 | `browser/AGENTS.md`（它消费的命令行契约）→ 根 `README.md` 的「浏览器工具链与登录态资产」一节 |
| 改 composition 的 tool 行 / 体积旋钮 | `preset/design.md` 的「非功能红线」 | `tools/design.md`（判错口径） |
| 改通知子插件（`notify_user` 的参数 / toast / 装载） | `notify/AGENTS.md` → `notify/design.md` | `notify/testing-guide.md` |
| 改权限插件（`set_child_permission` 的守卫 / 写入路径 / 装载） | `permission/AGENTS.md` → `permission/design.md` | `permission/testing-guide.md`；消费方只有一处：`preset/agent.cordis.yml` 调度 persona 的【浏览器：权限】段、浏览器任务委派得起来的前提 |
| 只想弄懂怎么装到本机 | 根 `README.md` 的「安装」一节 | `install.ps1` / `install.sh` |

## 版本区

本模块在版本区里的文档就是 `preset/AGENTS.md`（本文件，路由）→ [`design.md`](design.md)（设计、状态机与不变量）→ [`testing-guide.md`](testing-guide.md)（用例全表与未观测项）这三份，加**不在版本区**的临时工作目录 `docs-work/`（过程件住那里，交付前清空到空目录）。完整清单与根入口见根 `AGENTS.md` 的「版本区」一节，此处不另抄。
给人看的安装与使用说明在根 `README.md`。

**未观测**：本模块文档与源文件之间是否还有别的未登记漂移；量法：按根 `AGENTS.md`「Quality Gates」的文档合规那行逐条自检一遍，把发现的漂移就地写进对应文档。

## 生效方式

改动怎么生效、怎么复核（**口径不同，别承诺错**）：

| 改了什么 | 怎么生效 | 怎么复核 |
|---|---|---|
| `preset/` 任何文件（含改委派能力 / 工具面映射） | 重跑生成 + 重装 bundle（`install.*` 会自动做），再**重启 dsh**，然后在**新对话**里选 Adg 多智能体模式 | 按根 `README.md` 的「真实挂载验证」一节做一次**真实挂载**；静态自检证明不了挂载 |
| 只切换注入组 / 味道（同一份源文件分四种味道、四个稳定落点） | 重新生成 + 重装 bundle + 重启 dsh + 新会话 | 先看该 profile 的 `node_modules/dsh-adg-preset` 链接的是哪一份稳定目录，再用 `node tools/check-bundle-flavor.mjs <那份文件> <味道键>` 断言那一份（`install.*` 装完已经这么断言）；再在新会话里用 `delegate` 派一个子代理，让它报工具目录里看得见注入的那几个名字 |
| composition 里写的 `@deepseek-ai/*` 包名 | 包名会随 dsh 升级改名，改完必须真实挂载 | `agentPresets.resolve('adg')` 的 `.broken` 为空；用旧名会报 `… never started` |
| `notify/` 任何文件 | 重装子插件（`install.*`：稳定副本 + `dsh plugin --profile <p> add`）+ 重启 dsh + 新会话 | `cd notify && node --test test`，再在新会话里委派一次（委派时把 `notify_user` 给子代理）让它调一次 `notify_user` |
| `permission/` 任何文件 | 同上口径：重装子插件（`install.*` 的同一批步骤也覆盖 `adg-permission`）+ 重启 dsh + 新会话 | `cd permission && node --test test`，再在新会话里对任一**已经派出去**的子代理调一次 `set_child_permission`（运行中期望 `applied=live`、已停下期望 `applied=persisted`；把权限改到超过自己的那次期望被拒） |
| `delegate/` 任何文件 | 重装子插件（`install.*` 的 2b-2 / 4c-4 / 4c-5 步：稳定副本 + `dsh plugin --profile <p> add`）+ **重启 dsh** + 新会话 | `cd delegate && node --test test`；再在新会话里让调度者用一次 `delegate`（给一个 `tools` 清单与一段 persona），核对 `tools_note` 与子代理实际拿到的工具面 |
| 本模块任何 `.md` 文档 | 立即生效（只是文件） | 按 `adg-doc-criterion` 技能的质量红线清单自检 |

**已知限制**：dsh 正在运行时 `pnpm` 会因文件被占用而失败（`os error 32` / `ERR_PNPM_PACKAGE_MANAGER_REMOVE_MODULES_DIR`），脚本会如实报告并继续；包已在位时不算失败。要真正装/换依赖先关掉 dsh。

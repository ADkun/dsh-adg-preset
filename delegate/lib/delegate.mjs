// adg-delegate 的纯逻辑层：本次工具计划（内置 deny / 未知名剔除 / PTC 保留名拒绝）、
// 委派请求装配、以及「可续后台」与「前台一次性」两条派发路径。
//
// 这里**零 import**：不碰 cordis、不碰文件系统、不碰真会话对象 —— 全是可离线单测的纯函数
// （唯一例外 `readRestrictableNames`，它只读调用方 ctx 上的工具视图，喂假对象同样成立）。
// 见 test/delegate.test.mjs 与 design.md 的 I1..I10。
// 插件的服务解析与注册在 ../index.mjs。

/** 工具名：全 DSH 内唯一；调度 persona 里写的就是这个字符串。 */
export const TOOL_NAME = 'delegate';

/** 子代理 provider 名：与 preset 那条唯一委派行用的同一个（`provider: spawn`）。 */
export const SUBAGENT_PROVIDER = 'spawn';

/** 子代理的来源词表：回显给调用方，让它知道该拿哪个 id 去接续。 */
export const SUBAGENT_KINDS = Object.freeze(['continuable', 'background', 'foreground']);

/**
 * 内置 deny 名单（安全边界，硬编码）：这些名字**永远**不进子代理的工具面，
 * 即使调用方在 `tools` 里点名要它们。清单只此一份，别在别处再拼一遍。
 *
 * 前四个是**能再开子代理**的入口 —— 放进任何一个，"一跳可达"当场失效：
 * - `agent`：preset 的 delegation 组里那条**静态**委派行的 toolName，子代理会从祖先层继承到它。
 * - `delegate`：本插件的入口，同一个委派机制的**动态**版。
 * - `workflow` / `ralph`：编排引擎，都能起子代理（`ralph` 那行的 config 是 `subagentProvider: spawn`）。
 *
 * 后两个只认 live runtime root：
 * - `set_child_permission` / `ask_user_question`：子代理拿不到人类答主，也没有"自己派出去的子代理"这回事。
 *
 * 刻意**不在**名单里的：`notify_user`。它是单向、不阻塞的提醒，而调度 persona 的
 * 【需要用户本人的事】明确允许"让拿到 `notify_user` 的它自己发一条单向提醒" ——
 * 后台子代理撞上登录墙时就该能自己第一时间喊人，不必等调度者中转。
 */
export const BUILTIN_DENY = Object.freeze([
  'agent',
  'delegate',
  'workflow',
  'ralph',
  'set_child_permission',
  'ask_user_question',
]);

/**
 * PTC 传输保留名。它出现在 `toolFilter` 的 allow 或 deny 里，平台的 `tools.restrict()`
 * 都会直接抛错（`cannot name reserved PTC mode presentation transport "run_code"`），
 * 所以本插件**替它挡在前面**：调用方点名它，本工具当场拒绝（口径与理由见 design.md 的 I5）。
 */
export const RESERVED_PTC_NAME = 'run_code';

/**
 * 调用方（调度）智能体。没有它就没有"派出去"这回事 —— 与平台 subagent 工具同一条口径。
 * @param {{agent?: object}} [exec] 工具执行上下文
 * @returns {object} 调用方 Agent
 */
export function assertCallerAgent(exec) {
  const parent = exec?.agent;
  if (parent === undefined) {
    throw new Error(`${TOOL_NAME}: 需要一个调用方智能体（exec.agent 是 undefined）`);
  }
  return parent;
}

/**
 * 本次**可用的全局工具名** = 调用方工具视图里的 `restrictableNames`。
 *
 * 这就是平台的 `tools.restrict()` 拿来做未知名校验的那张对照表 —— 本工具只是替它挡在前面，
 * 让调用方当场拿到「哪个名字不成立」的反馈，而不是等子代理建立时才炸。
 *
 * 读不出就**抛错**，不猜也不跳过（fail-closed）：内置 deny 是安全边界，而名单里可能含
 * 本 profile 未注册的名字（例如没装 `@deepseek-ai/dsh-tool-workflow` 就没有 `workflow`，
 * 没装 `adg-permission` 就没有 `set_child_permission`）；没有对照表就既
 * 保证不了边界、又可能下发一个平台会抛 `names unknown global tool` 的名字。
 *
 * @param {object} parent 调用方 Agent（`exec.agent`）
 * @returns {Set<string>} 本次可用的全局工具名
 */
export function readRestrictableNames(parent) {
  const tools = parent?.ctx?.tools;
  const view = tools?.view;
  if (typeof view !== 'function') {
    throw new Error(
      `${TOOL_NAME}: 读不出本次可用的全局工具名（exec.agent.ctx.tools.view 不是函数，API 形状变了）` +
        ' —— 拒绝在无法校验工具名、也无法安全下发内置 deny 名单的前提下委派',
    );
  }
  const read = view.call(tools, parent);
  const names = read?.restrictableNames;
  if (!(names instanceof Set) || names.size === 0) {
    throw new Error(
      `${TOOL_NAME}: 读不出本次可用的全局工具名` +
        `（tools.view(agent).restrictableNames 不是非空 Set，读到 ${describeValue(names)}）—— 拒绝委派`,
    );
  }
  return names;
}

/**
 * 把调用方给的 `tools` 与本次可用的全局工具名对照，算出这次真正下发的 `toolFilter`。
 *
 * 语义（与平台 `ToolRestriction` 同形，两者都是"只减不增"）：
 * - `tools` 省略 ⇒ 只下发 `{deny: <内置名单∩可用名>}`，子代理拿到它继承到的全部减去那几项。
 * - `tools` 给了 ⇒ 下发 `{allow: <清单∩可用名>, deny: <内置名单∩可用名>}`，先按 deny 去掉、再按 allow 只留。
 * - `tools` 是空数组 ⇒ `{allow: [], …}`：什么都不给。
 *
 * 三条处理口径（`ignored` 与 `tools` 一起回显给调用方，**不静默丢弃**）：
 * - 对照表里没有的名字 → `reason: 'unknown'`，剔除并写进 tools_note；
 * - 内置 deny 名单里的名字 → `reason: 'denied'`，剔除并写进 tools_note；
 * - `run_code` → **抛错**（唯一会让整次调用失败的名单项，理由见 design.md 的 I5）。
 *
 * @param {unknown} requested `args.tools` 原值
 * @param {Set<string>} knownNames 本次可用的全局工具名
 * @returns {{provided: boolean, denyNames: string[], tools: string[], ignored: {name: string, reason: 'unknown'|'denied'}[], filter: {allow?: string[], deny: string[]}|undefined}}
 */
export function planToolFilter(requested, knownNames) {
  if (!(knownNames instanceof Set)) {
    throw new Error(`${TOOL_NAME}: 内部错误 —— 可用工具名清单必须是 Set（got ${describeValue(knownNames)}）`);
  }
  if (requested !== undefined && !Array.isArray(requested)) {
    throw new Error(`${TOOL_NAME}: tools 必须是字符串数组（got ${describeValue(requested)}）`);
  }

  // 内置名单必须与本次可用名**求交**：未注册的名字写进 deny 会让平台当场抛
  // `tools.restrict() names unknown global tool …`，整次委派失败。
  const denyNames = BUILTIN_DENY.filter((toolName) => knownNames.has(toolName));

  if (requested === undefined) {
    return {
      provided: false,
      denyNames,
      tools: [],
      ignored: [],
      // 一个名字都减不掉时（这六个名字都不在本 profile）就没有要下发的滤镜。
      filter: denyNames.length === 0 ? undefined : { deny: denyNames },
    };
  }

  const tools = [];
  const ignored = [];
  const seen = new Set();
  for (const raw of requested) {
    if (typeof raw !== 'string' || raw === '') {
      throw new Error(`${TOOL_NAME}: tools 里只能放工具名字符串（got ${describeValue(raw)}）`);
    }
    if (raw === RESERVED_PTC_NAME) {
      throw new Error(
        `${TOOL_NAME}: 拒绝把 ${RESERVED_PTC_NAME} 放进本次工具面 —— 它是 PTC 传输保留名，` +
          '平台的 tools.restrict() 对它直接抛错；要限制的是工具，不是承载它们的传输。',
      );
    }
    if (seen.has(raw)) continue;
    seen.add(raw);
    if (BUILTIN_DENY.includes(raw)) {
      // 先判内置名单：这些名字给不了子代理是**本次设计**，不是本 profile 的偶然缺装。
      ignored.push({ name: raw, reason: 'denied' });
      continue;
    }
    if (!knownNames.has(raw)) {
      ignored.push({ name: raw, reason: 'unknown' });
      continue;
    }
    tools.push(raw);
  }

  return { provided: true, denyNames, tools, ignored, filter: { allow: tools, deny: denyNames } };
}

/**
 * `tools_note`：一句人话，说明这次是"未过滤 = 拿到继承到的全部"还是"只保留 N 个"，
 * 并列出被忽略的点名（未知名 / 内置禁用）。这是给模型看的反馈，不是日志。
 *
 * @param {ReturnType<typeof planToolFilter>} plan
 * @returns {string}
 */
export function toolsNote(plan) {
  const parts = [];
  if (!plan.provided) {
    parts.push(
      plan.denyNames.length === 0
        ? '未过滤：子代理拿到它继承到的全部工具（本次没有需要减去的内置名单项）'
        : `未过滤：子代理拿到它继承到的全部工具（另按内置 deny 名单减去 ${plan.denyNames.length} 项：${plan.denyNames.join('、')}）`,
    );
  } else if (plan.tools.length === 0) {
    parts.push('空清单：本次不给子代理任何工具');
  } else {
    parts.push(`只保留 ${plan.tools.length} 个：${plan.tools.join('、')}`);
  }
  if (plan.ignored.length > 0) {
    const described = plan.ignored.map(
      (item) => `${item.name}（${item.reason === 'denied' ? '内置禁用' : '这次没有这个工具名'}）`,
    );
    parts.push(`忽略了 ${plan.ignored.length} 个点名的名字：${described.join('、')}`);
  }
  return parts.join('；');
}

/**
 * 装配子代理委派请求。**永远不设 `maxDepth`**：平台默认 1，一跳可达由「内置 deny `delegate`」
 * 与这个默认值共同保证（preset 侧红线 6 是同一口径）。
 *
 * `persona` / `toolFilter` 只在有值时出现 —— 省略 persona 就是"子代理没有 persona 段"，
 * 不能退化成空字符串段。
 *
 * @param {{description: string, prompt: string, persona?: string}} args
 * @param {object} parent 调用方 Agent
 * @param {{allow?: string[], deny: string[]}|undefined} filter
 * @returns {object} SubagentStartRequest 形状
 */
export function buildRequest(args, parent, filter) {
  const request = {
    label: args.description,
    prompt: [{ type: 'text', text: args.prompt }],
    parent,
  };
  if (args.persona !== undefined) request.persona = args.persona;
  if (filter !== undefined) request.toolFilter = filter;
  return request;
}

/**
 * 后台 + continuable 时返回的 `childId`。取不到就抛错，绝不回显一个 undefined 当成功。
 * @param {unknown} started `startContinuable` 的返回值
 * @returns {string}
 */
export function continuableChildId(started) {
  const childId = started?.childId;
  if (typeof childId !== 'string' || childId === '') {
    throw new Error(
      `${TOOL_NAME}: startContinuable 没有返回 childId（got ${describeValue(childId)}）` +
        ' —— 子代理可能已建立，但没有可接续的 id，不能当成成功回报',
    );
  }
  return childId;
}

/**
 * 前台一次性 run 的 `id`。同上：取不到就抛错。
 * @param {unknown} run `subagents.start` 的返回值
 * @returns {string}
 */
export function foregroundRunId(run) {
  const id = run?.id;
  if (typeof id !== 'string' || id === '') {
    throw new Error(
      `${TOOL_NAME}: subagents.start 没有返回带 id 的 run（got ${describeValue(id)}）—— 不能当成成功回报`,
    );
  }
  return id;
}

/**
 * 接管**前台一次性** run 的终局。
 *
 * 本工具只是"建立并投递"，不等子代理跑完就返回 —— 于是这个 run 的 `result` 没人 await，
 * 它一旦以基础设施故障 reject 就会变成 unhandled rejection（Node 默认会让进程崩）。
 * 所以这里挂一个终局观察者：既不让拒绝逃逸，也不把它写成成功 —— 走注入的 `warn`
 * 报出去（运行时是 `ctx.logger.warn`），子代理本身的结局仍由它的会话与 catalog 承担。
 *
 * @param {{id?: string, result?: Promise<unknown>}} run
 * @param {(message: string) => void} [warn]
 * @returns {boolean} 是否挂上了观察者
 */
export function superviseOneShotRun(run, warn) {
  const settled = run?.result;
  if (settled === undefined || typeof settled.then !== 'function') return false;
  settled.then(
    () => undefined,
    (error) => {
      try {
        warn?.(
          `[${TOOL_NAME}] 前台一次性子代理 ${String(run?.id)} 以基础设施故障收尾（本工具已返回、不再等它）：` +
            `${error?.message ?? String(error)}`,
        );
      } catch {
        /* 故意吞掉：观察者自己失败不该再抛一次，真正要报的是上面那条 */
      }
    },
  );
  return true;
}

/**
 * 跑一次委派。抽出来是为了自测能直接喂假服务与假调用方（不起 cordis、不碰真会话）。
 *
 * @param {{description: string, prompt: string, tools?: string[], persona?: string, background?: boolean}} args
 * @param {{agent?: object, signal?: AbortSignal}} exec 工具执行上下文
 * @param {{services?: () => object, warn?: (message: string) => void}} [deps]
 * @returns {Promise<{description: string, subagent_id: string, kind: string, tools: string[], tools_note: string, persona: 'set'|'unset'}>}
 */
export async function delegate(args, exec, deps = {}) {
  const parent = assertCallerAgent(exec);
  const knownNames = readRestrictableNames(parent);
  const plan = planToolFilter(args.tools, knownNames);
  const request = buildRequest(args, parent, plan.filter);
  const signal = exec?.signal;

  // 缺省后台 continuable：只有后台的可续子代理才是活的、能接续、能 steer。
  if (args.background ?? true) {
    const subagents = requireSubagents(deps);
    const started = await subagents.startContinuable({
      provider: SUBAGENT_PROVIDER,
      label: args.description,
      request,
      signal,
    });
    return delegationResult(args, 'continuable', continuableChildId(started), plan);
  }

  const subagents = requireSubagents(deps);
  const run = await subagents.start(SUBAGENT_PROVIDER, { ...request, signal });
  superviseOneShotRun(run, deps.warn);
  return delegationResult(args, 'foreground', foregroundRunId(run), plan);
}

/**
 * 本工具结果。`tools` 回显真的下发的清单（省略 tools 时是空数组，清单在 tools_note 里讲清）。
 * @returns {{description: string, subagent_id: string, kind: string, tools: string[], tools_note: string, persona: 'set'|'unset'}}
 */
function delegationResult(args, kind, subagentId, plan) {
  return {
    description: args.description,
    subagent_id: subagentId,
    kind,
    tools: plan.tools,
    tools_note: toolsNote(plan),
    persona: args.persona === undefined ? 'unset' : 'set',
  };
}

/**
 * `subagents` 服务（`@deepseek-ai/dsh-subagent` 的 `SubagentRuntime`）。
 * 不解析 `jobs`：本插件的后台一律走 continuable，**没有**"后台一次性"那条路径（design.md 的 I4）。
 */
function requireSubagents(deps) {
  const services = deps.services?.() ?? {};
  if (services.subagents === undefined) {
    throw new Error(`${TOOL_NAME}: 需要 subagents 服务（@deepseek-ai/dsh-subagent 的 SubagentRuntime）`);
  }
  return services.subagents;
}

/**
 * 诊断用的值描述。读不出东西时要能说清"读到了什么"，而不是只说"读不出"。
 * @param {unknown} value
 * @returns {string}
 */
function describeValue(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (value instanceof Set) return `Set(size=${value.size})`;
  if (Array.isArray(value)) return `Array(length=${value.length})`;
  return typeof value;
}
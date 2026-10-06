// adg-delegate 的 cordis 插件入口：注册全局工具 `delegate`。
//
// 入口形状由 dsh 的插件契约规定：
//   - 命名导出 `name` / `inject` / `apply`（契约要求的入口三件套）
//   - `name` 必须与 cordis.patch.yml 里 insert 行的 `id` 一致
//   - 工具定义走 `defineTool`（`output` 是硬要求，缺了直接 TypeError）
//
// 本文件只做「解析服务 + 派发」；纯逻辑（工具计划、请求装配、两条路径）在 lib/delegate.mjs，
// 可离线自测。契约与红线见 AGENTS.md / design.md。

import { defineTool } from '@deepseek-ai/dsh-tools';

import { SUBAGENT_KINDS, TOOL_NAME, delegate } from './lib/delegate.mjs';

/** 插件名：必须等于 cordis.patch.yml 里 insert 行的 `id`。 */
export const name = 'adg-delegate';

/** 本插件只依赖 tools 服务；其余服务（subagents）在**调用那一刻**才 `ctx.get` ——
 *  缺哪个就报哪个，而不是让整个 profile 起不来。 */
export const inject = ['tools'];

export { TOOL_NAME };

/**
 * 工具描述。写给「一眼判断何时该用、以及它做到了平台自带的 subagent 工具做不到的那件事」：
 * 平台每个 subagent 实例的 toolFilter 在**挂载期**写死，而本工具在**每一次委派**时现给。
 */
const DESCRIPTION = [
  '派一个子代理去做一件事，并**在这一次委派**指定它拿到的工具集合与 persona（这是平台自带委派做不到的：那边的滤镜在挂载期就写死了）。要按任务现配能力面就用本工具，别用那条挂载期写死的静态委派工具。',
  '`tools` 省略 = 不过滤，它拿到自己继承到的全部工具（再减去内置 deny 名单）；给了 = 只保留清单里那些；空数组 = 什么都不给。',
  '`persona` 省略 = 它没有 persona 段；给了 = 这一次用它遮蔽子代理本来带的 persona。',
  '缺省后台：派出的是 continuable 子代理，返回可接续、可 steer 的会话 id；`background: false` 是前台一次性，返回它的 id 但不等于它跑完了。',
  '清单里不成立的名字**不会**让整次调用失败，会逐条出现在 `tools_note` 里；`run_code` 例外，点名它当场报错。',
  '`agent` / `delegate` / `workflow` / `ralph` / `set_child_permission` / `ask_user_question` 永远不给子代理 —— 前四个都能再开子代理，这一步就是一跳可达；`notify_user` 可以给（单向提醒，撞上登录墙时它自己喊人）。',
].join(' ');

/** 输出 schema：工具结果就是这六个字段。 */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    description: { type: 'string', required: true, description: '回显这次委派的短标签' },
    subagent_id: {
      type: 'string',
      required: true,
      description: '子代理会话 id（可续后台 = childId；前台 = run 的 id），拿它去 list_agents / send_message 接续',
    },
    kind: { type: 'string', required: true, enum: [...SUBAGENT_KINDS], description: '这次派出的是哪种来源' },
    tools: {
      type: 'array',
      required: true,
      items: { type: 'string' },
      description: '本次实际下发的工具清单；`tools` 省略时是空数组（未过滤的意思写在 tools_note 里）',
    },
    tools_note: { type: 'string', required: true, description: '一句人话：这次是"未过滤 = 拿到继承的全部"还是"只保留 N 个"，以及被忽略的点名' },
    persona: { type: 'string', required: true, enum: ['set', 'unset'], description: 'set = 这一次给了 persona；unset = 没给，子代理没有 persona 段' },
  },
};

/**
 * 造出 `delegate` 的工具定义。
 * 单独导出是为了让自测能用**真的** `defineTool` 造一遍定义 —— 作者侧 schema 方言
 * 写错时，真 `defineTool` 会当场抛 `JsonSchemaError`（见 design.md 的 D1）。
 *
 * @param {{defineTool?: Function, services?: () => object, warn?: (message: string) => void}} [deps]
 * @returns {object} dsh-tools 的 ToolDefinition
 */
export function createDelegateTool(deps = {}) {
  // 允许注入 `defineTool` 只是为了自测能拿真实现再编译一遍；运行时永远用真货。
  const compile = deps.defineTool ?? defineTool;

  return compile({
    name: TOOL_NAME,
    description: DESCRIPTION,
    // 作者侧方言是**隐式属性映射**（key 就是属性名），不是对象根 JSON Schema：
    // 写成 `{type:'object',properties:{…}}` 会被 `parameterSchemaSpecToJsonSchema` 拒掉
    // （`parameters.type must be a value schema object`）。必填由属性上的 `required: true` 表达。
    parameters: {
      description: {
        type: 'string',
        required: true,
        description: '短标签：进结算通知与 list_agents，用「谁、做什么」的形状，别写成长句。',
      },
      prompt: {
        type: 'string',
        required: true,
        description:
          '自足的委派正文：目标 / 要做什么 / 不要做什么 / 约束 / 验收标准。子代理看不到你与用户的对话，缺什么它只能猜。',
      },
      tools: {
        type: 'array',
        items: { type: 'string' },
        description:
          '这一次给这个子代理的全局工具名清单。省略 = 不过滤（它拿到继承到的全部，再减去内置 deny 名单）；给了 = 只保留这些；空数组 = 什么都不给。',
      },
      persona: {
        type: 'string',
        description: '这一次给这个子代理的 persona 文本（遮蔽它本来带的 persona 段）。省略 = 不给 persona 段。',
      },
      background: {
        type: 'boolean',
        description:
          'true（缺省）= 后台 continuable 子代理，返回可接续、可 steer 的会话 id；false = 前台一次性，返回它的 id 但不等于它跑完了。',
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [
        { type: 'text', text: `${value.description} → ${value.kind} 子代理 ${value.subagent_id}（${value.tools_note}）` },
      ],
    },
    // 它只建立会话并投递初始 prompt，不改任何既有状态 —— 可以并发派发多条。
    isConcurrencySafe: () => true,
    // 本工具**不等待子代理跑完**：等的是「建立 + 投递」这一步（可续路径是子代理 inbox
    // 接受初始 prompt，前台路径是子代理被发布），都是秒级动作。比 permission 的 30 秒小，
    // 因为那边等的是另一个会话的一次完整读写往返。
    timeoutMs: 15000,
    async execute(args, exec) {
      return delegate(args, exec, deps);
    },
  });
}

/**
 * 注册 `delegate`。
 * 服务在**每次调用**时现取：注册顺序、以及某些服务是否挂载，都不该由 apply 时机决定。
 * `jobs` 故意不解析 —— 本插件的后台一律走 continuable（见 design.md 的 I4）。
 *
 * @param {object} ctx cordis 上下文（global 层）
 */
export function apply(ctx) {
  ctx.tools.register(
    createDelegateTool({
      services: () => ({
        subagents: ctx.get('subagents'),
      }),
      warn: (message) => ctx.logger?.warn?.(message),
    }),
  );
  ctx.logger?.debug?.(`[${name}] 已注册 ${TOOL_NAME}`);
}
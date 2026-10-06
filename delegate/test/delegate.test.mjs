// adg-delegate 的单元测试（零依赖：node:test + node:assert/strict）。
//
// 覆盖 design.md 的 I1..I10（用例编号前缀与「用例总表」一一对应）。
// 全程不写磁盘、不起 cordis、不碰真会话；唯一的外部真件是 `@deepseek-ai/dsh-tools` 的
// 真 `defineTool`（作者侧 schema 方言写错必须当场炸，这是 D1 的全部意义）。
//
// 跑法：cd delegate && node --test test
//       DSH 沙箱里加 --test-isolation=none（见 testing-guide.md）。

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { defineTool } from '@deepseek-ai/dsh-tools';

import { createDelegateTool } from '../index.mjs';
import {
  BUILTIN_DENY,
  RESERVED_PTC_NAME,
  SUBAGENT_KINDS,
  SUBAGENT_PROVIDER,
  TOOL_NAME,
  assertCallerAgent,
  buildRequest,
  delegate,
  foregroundRunId,
  planToolFilter,
  readRestrictableNames,
  superviseOneShotRun,
  toolsNote,
} from '../lib/delegate.mjs';

/** 模块根目录：从 import.meta.url 推，绝不写死本机绝对路径。 */
const MODULE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 一份「典型 profile」的可用全局工具名：六个内置禁用名全在，外加 `notify_user`（它故意**不在**名单里）。 */
const KNOWN = [
  'Read',
  'Write',
  'Edit',
  'Bash',
  'Glob',
  'Grep',
  'web_search',
  'agent',
  'delegate',
  'workflow',
  'ralph',
  'set_child_permission',
  'ask_user_question',
  'notify_user',
  'compress',
  'send_message',
];

const BASE_ARGS = {
  description: '读一下 preset 的委派行',
  prompt: '目标：数清委派行条数。要做什么：只读 preset/agent.cordis.yml。不要做什么：不要改文件。验收标准：报出条数与行号。',
};

/**
 * 假调用方智能体。`view` 除了给对照表，还记下自己被喂的实参 ——
 * 「scope key ＝ 调用方 Agent 自己」是本插件依赖的平台约定，D9 会断言它。
 */
function fakeParent(names = KNOWN, seen = []) {
  return {
    id: 'scheduler-session-1',
    ctx: {
      tools: {
        view(scope) {
          seen.push(scope);
          return { restrictableNames: new Set(names) };
        },
      },
    },
  };
}

/** 假 SubagentRuntime：只实现本插件会调的两个方法，并把收到的 spec/request 原样记下来。 */
function fakeSubagents() {
  const calls = { startContinuable: [], start: [] };
  return {
    calls,
    async startContinuable(spec) {
      calls.startContinuable.push(spec);
      return { childId: 'child-session-1', messageId: 'message-1' };
    },
    async start(provider, request) {
      calls.start.push({ provider, request });
      return { id: 'run-session-1', result: new Promise(() => {}), dispose: async () => {} };
    },
  };
}

function depsFor(subagents, warn) {
  return { services: () => ({ subagents }), ...(warn === undefined ? {} : { warn }) };
}

test('D1 工具定义能用真的 defineTool 编出来（作者侧方言与 output 对象根方言）', () => {
  const definition = createDelegateTool();

  assert.equal(definition.name, TOOL_NAME);
  assert.equal(TOOL_NAME, 'delegate');

  // parameters：隐式属性映射 + 属性上的 required:true → 顶层 required 数组；根是隐式开对象。
  assert.deepEqual(Object.keys(definition.parameters.properties), [
    'description',
    'prompt',
    'tools',
    'persona',
    'background',
  ]);
  assert.deepEqual(definition.parameters.required, ['description', 'prompt']);
  assert.deepEqual(definition.parameters.properties.tools.items, { type: 'string' });
  assert.equal(definition.parameters.properties.background.type, 'boolean');
  assert.ok(!('additionalProperties' in definition.parameters));

  // output：对象根 + 显式 additionalProperties:false + 属性上的 required:true。
  assert.equal(definition.output.schema.type, 'object');
  assert.equal(definition.output.schema.additionalProperties, false);
  assert.deepEqual(definition.output.schema.required, [
    'description',
    'subagent_id',
    'kind',
    'tools',
    'tools_note',
    'persona',
  ]);
  assert.deepEqual(definition.output.schema.properties.kind.enum, [...SUBAGENT_KINDS]);
  assert.deepEqual(definition.output.schema.properties.persona.enum, ['set', 'unset']);

  // 编出来的 `isConcurrencySafe(args)` 会先按 parameters 校验一遍实参，再问作者侧那支函数：
  // 实参不成立时返回 false（调度器保守地当独占），实参成立时才是本工具声明的 true。
  assert.equal(definition.isConcurrencySafe({ description: BASE_ARGS.description, prompt: BASE_ARGS.prompt }), true);
  assert.equal(definition.isConcurrencySafe({}), false);
  assert.equal(typeof definition.timeoutMs, 'number');

  // 反向对照一：把对象根形状写进 parameters，真 defineTool 当场拒（证明上面那套形状不是"随便写都过"）
  assert.throws(
    () =>
      defineTool({
        name: 'probe-object-root',
        description: 'd',
        parameters: { type: 'object', properties: { a: { type: 'string' } } },
        output: { schema: definition.output.schema, render: () => [] },
        async execute() {
          return {};
        },
      }),
    /parameters\.type must be a value schema object/,
  );

  // 反向对照二：output 是硬要求，缺了直接炸（真实现是读 `output.render` 时的 TypeError）
  assert.throws(
    () =>
      defineTool({
        name: 'probe-no-output',
        description: 'd',
        parameters: { a: { type: 'string' } },
        async execute() {
          return {};
        },
      }),
    /reading 'render'/,
  );
});

test('D2 tools 省略 ⇒ 只下发 deny、不含 allow；deny 必须与可用名求交', async () => {
  const subagents = fakeSubagents();
  const parent = fakeParent();
  const out = await delegate({ ...BASE_ARGS }, { agent: parent, signal: undefined }, depsFor(subagents));

  const filter = subagents.calls.startContinuable[0].request.toolFilter;
  assert.deepEqual(Object.keys(filter), ['deny']);
  assert.equal('allow' in filter, false);
  assert.deepEqual(filter.deny, [...BUILTIN_DENY]);
  assert.ok(filter.deny.every((name) => KNOWN.includes(name)));

  assert.deepEqual(out.tools, []);
  assert.equal(out.kind, 'continuable');
  assert.equal(out.subagent_id, 'child-session-1');
  assert.equal(out.persona, 'unset');
  assert.match(out.tools_note, /^未过滤：子代理拿到它继承到的全部工具/);
  assert.match(out.tools_note, new RegExp(`减去 ${BUILTIN_DENY.length} 项：${BUILTIN_DENY.join('、')}`));

  // 瘦 profile（只有 Read + delegate）：其余五个名字根本不在表里 ——
  // agent/workflow/ralph 要看对应工具插件是否挂载、set_child_permission 要看有没有装 adg-permission，
  // 绝不能把未注册的名字塞进 deny（平台会抛 names unknown global tool，整次委派失败）。
  const lean = fakeSubagents();
  await delegate({ ...BASE_ARGS }, { agent: fakeParent(['Read', 'delegate']), signal: undefined }, depsFor(lean));
  assert.deepEqual(lean.calls.startContinuable[0].request.toolFilter, { deny: ['delegate'] });
});

test('D3 tools 给清单 ⇒ allow 与 deny 同时下发（allow 只留清单里的可用名）', async () => {
  const subagents = fakeSubagents();
  const out = await delegate(
    { ...BASE_ARGS, tools: ['Read', 'Bash', 'delegate'], persona: '你是一个只读侦察兵' },
    { agent: fakeParent(), signal: undefined },
    depsFor(subagents),
  );

  const filter = subagents.calls.startContinuable[0].request.toolFilter;
  assert.deepEqual(Object.keys(filter).sort(), ['allow', 'deny']);
  assert.deepEqual(filter.allow, ['Read', 'Bash']);
  assert.deepEqual(filter.deny, [...BUILTIN_DENY]);
  assert.deepEqual(out.tools, ['Read', 'Bash']);
  assert.equal(out.persona, 'set');
  assert.match(out.tools_note, /^只保留 2 个：Read、Bash/);
  assert.match(out.tools_note, /忽略了 1 个点名的名字：delegate（内置禁用）/);
});

test('D4 清单里的未知名被剔除、去重，并逐条出现在 tools_note 里（不静默丢弃）', async () => {
  const subagents = fakeSubagents();
  const out = await delegate(
    { ...BASE_ARGS, tools: ['Read', 'Read', 'nosuch_tool', 'agent_brower', ''] },
    { agent: fakeParent(), signal: undefined },
    depsFor(subagents),
  ).catch((error) => error);

  // 空字符串是"不是工具名"的坏值（不是未知名），当场抛
  assert.ok(out instanceof Error);
  assert.match(out.message, /tools 里只能放工具名字符串/);

  const subagents2 = fakeSubagents();
  const out2 = await delegate(
    { ...BASE_ARGS, tools: ['Read', 'Read', 'nosuch_tool', 'agent_brower'] },
    { agent: fakeParent(), signal: undefined },
    depsFor(subagents2),
  );
  assert.deepEqual(out2.tools, ['Read']);
  assert.match(out2.tools_note, /只保留 1 个：Read/);
  assert.match(out2.tools_note, /忽略了 2 个点名的名字/);
  assert.match(out2.tools_note, /nosuch_tool（这次没有这个工具名）/);
  assert.match(out2.tools_note, /agent_brower（这次没有这个工具名）/);

  // 纯函数层直接读：ignored 的结构就是模型看到的那份反馈
  // ignored 保持调用方点名的先后顺序（模型能一眼对上自己写的清单，而不是被重排过的一份）
  const plan = planToolFilter(['Read', 'nosuch_tool', 'delegate'], new Set(KNOWN));
  assert.deepEqual(plan.ignored, [
    { name: 'nosuch_tool', reason: 'unknown' },
    { name: 'delegate', reason: 'denied' },
  ]);
  assert.match(toolsNote(plan), /Read/);
});

test('D5 内置 deny 六个名字即使被点名也不进 allow（且仍在 deny 里）；notify_user 不在名单里', async () => {
  const subagents = fakeSubagents();
  const out = await delegate(
    { ...BASE_ARGS, tools: [...BUILTIN_DENY, 'Read'] },
    { agent: fakeParent(), signal: undefined },
    depsFor(subagents),
  );

  const filter = subagents.calls.startContinuable[0].request.toolFilter;
  assert.deepEqual(filter.allow, ['Read']);
  for (const denied of BUILTIN_DENY) {
    assert.ok(!filter.allow.includes(denied), `${denied} 不该进 allow`);
  }
  assert.deepEqual(filter.deny, [...BUILTIN_DENY]);
  assert.deepEqual(out.tools, ['Read']);
  for (const denied of BUILTIN_DENY) {
    assert.match(out.tools_note, new RegExp(`${denied}（内置禁用）`));
  }
  assert.match(out.tools_note, new RegExp(`忽略了 ${BUILTIN_DENY.length} 个点名的名字`));

  // 反向对照：notify_user **刻意不在**名单里 —— 点名它就该真的给下去
  // （它单向、不阻塞；撞上登录墙的后台子代理要能自己第一时间提醒人，而不是等调度者中转）
  const notifySubagents = fakeSubagents();
  const outNotify = await delegate(
    { ...BASE_ARGS, tools: ['Read', 'notify_user'] },
    { agent: fakeParent(), signal: undefined },
    depsFor(notifySubagents),
  );
  const notifyFilter = notifySubagents.calls.startContinuable[0].request.toolFilter;
  assert.deepEqual(notifyFilter.allow, ['Read', 'notify_user']);
  assert.deepEqual(notifyFilter.deny, [...BUILTIN_DENY]);
  assert.deepEqual(outNotify.tools, ['Read', 'notify_user']);

  // 空数组：什么都不给 —— allow 下单时必须是"已定义的空清单"，不能退化成不下发 allow
  const none = fakeSubagents();
  const out2 = await delegate({ ...BASE_ARGS, tools: [] }, { agent: fakeParent(), signal: undefined }, depsFor(none));
  assert.deepEqual(none.calls.startContinuable[0].request.toolFilter.allow, []);
  assert.deepEqual(out2.tools, []);
  assert.match(out2.tools_note, /^空清单：本次不给子代理任何工具/);
});

test('D6 点名 run_code ⇒ 当场拒绝（抛错），且在调用任何服务之前', async () => {
  const subagents = fakeSubagents();
  await assert.rejects(
    () => delegate({ ...BASE_ARGS, tools: ['Read', RESERVED_PTC_NAME] }, { agent: fakeParent(), signal: undefined }, depsFor(subagents)),
    (error) => {
      assert.match(error.message, /run_code/);
      assert.match(error.message, /PTC 传输保留名/);
      return true;
    },
  );
  assert.equal(subagents.calls.startContinuable.length, 0);
  assert.equal(subagents.calls.start.length, 0);

  // 纯函数层：run_code 走的是"抛错"，不是"剔除并写明"
  assert.throws(() => planToolFilter([RESERVED_PTC_NAME], new Set(KNOWN)), /run_code/);
});

test('D7 没有调用方智能体（exec.agent undefined）⇒ 抛错', async () => {
  assert.throws(() => assertCallerAgent(undefined), /delegate: 需要一个调用方智能体/);
  await assert.rejects(
    () => delegate({ ...BASE_ARGS }, {}, depsFor(fakeSubagents())),
    /delegate: 需要一个调用方智能体（exec.agent 是 undefined）/,
  );
  // 缺 subagents 服务也要报清楚（缺哪个报哪个）
  await assert.rejects(() => delegate({ ...BASE_ARGS }, { agent: fakeParent(), signal: undefined }, {}), /需要 subagents 服务/);
});

test('D8 persona 省略 ⇒ request 里没有 persona 键；给了 ⇒ 原样带上；maxDepth 一律不传', () => {
  const parent = fakeParent();
  const withoutPersona = buildRequest(BASE_ARGS, parent, { deny: ['delegate'] });
  assert.equal('persona' in withoutPersona, false);
  assert.equal('maxDepth' in withoutPersona, false);
  assert.deepEqual(Object.keys(withoutPersona), ['label', 'prompt', 'parent', 'toolFilter']);
  assert.deepEqual(withoutPersona.prompt, [{ type: 'text', text: BASE_ARGS.prompt }]);
  assert.equal(withoutPersona.label, BASE_ARGS.description);
  assert.equal(withoutPersona.parent, parent);

  const withPersona = buildRequest({ ...BASE_ARGS, persona: '你是只读侦察兵' }, parent, undefined);
  assert.equal(withPersona.persona, '你是只读侦察兵');
  assert.equal('toolFilter' in withPersona, false);
  assert.equal('maxDepth' in withPersona, false);
  assert.deepEqual(Object.keys(withPersona), ['label', 'prompt', 'parent', 'persona']);
});

test('D9 background 缺省 true ⇒ 走 startContinuable，且 spec 就是平台要的那一组键', async () => {
  const seen = [];
  const parent = fakeParent(KNOWN, seen);
  const subagents = fakeSubagents();
  const signal = new AbortController().signal;

  const out = await delegate({ ...BASE_ARGS }, { agent: parent, signal }, depsFor(subagents));

  assert.equal(subagents.calls.startContinuable.length, 1);
  assert.equal(subagents.calls.start.length, 0);
  const spec = subagents.calls.startContinuable[0];
  assert.deepEqual(Object.keys(spec), ['provider', 'label', 'request', 'signal']);
  assert.equal(spec.provider, SUBAGENT_PROVIDER);
  assert.equal(SUBAGENT_PROVIDER, 'spawn');
  assert.equal(spec.label, BASE_ARGS.description);
  assert.equal(spec.signal, signal);
  assert.equal(spec.request.parent, parent);
  assert.deepEqual(spec.request.prompt, [{ type: 'text', text: BASE_ARGS.prompt }]);
  assert.equal(spec.request.maxDepth, undefined);
  assert.equal('maxDepth' in spec.request, false);

  assert.equal(out.kind, SUBAGENT_KINDS[0]);
  assert.equal(out.subagent_id, 'child-session-1');
  assert.equal(out.description, BASE_ARGS.description);

  // 对照表是从**调用方自己的**工具视图里读的：view 的实参必须是那个 Agent 对象
  assert.deepEqual(seen, [parent]);

  // background: true 显式给了也走同一条路
  const again = fakeSubagents();
  const out2 = await delegate({ ...BASE_ARGS, background: true }, { agent: parent, signal }, depsFor(again));
  assert.equal(again.calls.startContinuable.length, 1);
  assert.equal(out2.kind, 'continuable');

  // childId 取不到不许当成功回报
  const broken = {
    calls: { startContinuable: [], start: [] },
    async startContinuable() {
      return { messageId: 'message-1' };
    },
    async start() {
      throw new Error('不该走这条路');
    },
  };
  await assert.rejects(() => delegate({ ...BASE_ARGS }, { agent: parent, signal }, depsFor(broken)), /没有返回 childId/);
});

test('D10 background:false ⇒ 走 start(...)，取出 run.id，并接管 run 终局（不等待、不静默）', async () => {
  const warnings = [];
  const parent = fakeParent();
  const signal = new AbortController().signal;
  const calls = { start: [] };
  const subagents = {
    calls: { startContinuable: [], start: calls.start },
    async startContinuable() {
      throw new Error('background:false 不该走可续路径');
    },
    async start(provider, request) {
      calls.start.push({ provider, request });
      return {
        id: 'run-session-7',
        // 终局在下一个 tick 才到：观察者必须在工具已经返回之后仍然接得住它
        result: new Promise((_resolve, reject) => setTimeout(() => reject(new Error('provider exploded')), 0)),
        dispose: async () => {},
      };
    },
  };

  const out = await delegate({ ...BASE_ARGS, background: false }, { agent: parent, signal }, depsFor(subagents, (message) => warnings.push(message)));

  assert.equal(calls.start.length, 1);
  assert.equal(calls.start[0].provider, SUBAGENT_PROVIDER);
  assert.equal(calls.start[0].request.parent, parent);
  assert.equal(calls.start[0].request.signal, signal);
  assert.equal(out.kind, 'foreground');
  assert.equal(out.subagent_id, 'run-session-7');
  assert.equal(foregroundRunId({ id: 'x' }), 'x');
  assert.throws(() => foregroundRunId({}), /没有返回带 id 的 run/);

  // run.result 的拒绝既不逃逸成 unhandled rejection，也不被写成成功：走注入的 warn 报出去
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /run-session-7/);
  assert.match(warnings[0], /provider exploded/);

  // 没有 result 的 run（形状不符）不许假装接管成功
  assert.equal(superviseOneShotRun({ id: 'x' }, () => {}), false);
  assert.equal(superviseOneShotRun({ id: 'x', result: Promise.resolve() }, () => {}), true);
});

test('D11 读不出可用工具名（view 形状不符）⇒ fail-closed 抛错，且不调用任何服务', async () => {
  const subagents = fakeSubagents();
  const noView = { id: 'a', ctx: {} };
  const notSet = { id: 'a', ctx: { tools: { view: () => ({}) } } };
  const emptySet = { id: 'a', ctx: { tools: { view: () => ({ restrictableNames: new Set() }) } } };

  await assert.rejects(() => delegate(BASE_ARGS, { agent: noView }, depsFor(subagents)), /tools\.view 不是函数/);
  await assert.rejects(() => delegate(BASE_ARGS, { agent: notSet }, depsFor(subagents)), /不是非空 Set/);
  await assert.rejects(() => delegate(BASE_ARGS, { agent: emptySet }, depsFor(subagents)), /不是非空 Set/);
  assert.equal(subagents.calls.startContinuable.length, 0);
  assert.equal(subagents.calls.start.length, 0);

  // 形状对了就是一张 Set
  const known = readRestrictableNames(fakeParent());
  assert.ok(known instanceof Set);
  assert.ok(known.has('delegate'));
});

test('D12 入口三件套 / 工具名三处一致 / 零依赖 / 无本机绝对路径', async () => {
  const entry = await readFile(join(MODULE_ROOT, 'index.mjs'), 'utf8');
  const lib = await readFile(join(MODULE_ROOT, 'lib', 'delegate.mjs'), 'utf8');
  const patch = await readFile(join(MODULE_ROOT, 'cordis.patch.yml'), 'utf8');
  const pkg = JSON.parse(await readFile(join(MODULE_ROOT, 'package.json'), 'utf8'));

  assert.match(entry, /export const name = 'adg-delegate';/);
  assert.match(entry, /export const inject = \['tools'\];/);
  assert.match(entry, /export function apply\(ctx\) \{/);
  assert.match(patch, /^\s*- id: adg-delegate$/m);
  assert.match(patch, /^\s*name: adg-delegate$/m);
  assert.match(patch, /^- insert:$/m);

  assert.equal(pkg.name, 'adg-delegate');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.main, './index.mjs');
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');

  // 纯逻辑层零 import：不碰 cordis、不碰 dsh-*
  assert.ok(!/^\s*import\s/m.test(lib));
  assert.ok(!/from\s+'@deepseek-ai\//.test(lib));

  for (const [file, source] of [
    ['index.mjs', entry],
    ['lib/delegate.mjs', lib],
  ]) {
    assert.ok(!/[A-Za-z]:[\\/]/.test(source), `${file} 里出现盘符绝对路径`);
    assert.ok(!/~[\\/]/.test(source), `${file} 里出现用户根路径`);
  }
});

test('D13 真 defineTool 编出的定义能在假服务上跑通一次完整调用并 render 出一行人话', async () => {
  const subagents = fakeSubagents();
  const definition = createDelegateTool({ services: () => ({ subagents }) });
  const value = await definition.execute({ ...BASE_ARGS, tools: ['Read'] }, { agent: fakeParent(), signal: undefined });

  assert.equal(value.subagent_id, 'child-session-1');
  assert.equal(value.kind, 'continuable');
  assert.deepEqual(value.tools, ['Read']);
  const rendered = definition.output.render({}, value);
  assert.equal(rendered[0].type, 'text');
  assert.match(rendered[0].text, /child-session-1/);
  assert.match(rendered[0].text, /只保留 1 个：Read/);
});
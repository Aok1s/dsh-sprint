/**
 * dsh-sprint — 插件入口（宿主端）。
 *
 * 只做两件事：注册一个工具 sprint（action + payload_json，和 StudyHub 同形），
 * 以及一条命令 /sprint。真正的逻辑在 lib/sprint.js。
 *
 * 为什么用「一个工具 + action」而不是十几个工具：模型一次就能看到全部动作，
 * 参数也只有一个 JSON 串，和 StudyHub 保持一致，学一次两边都会用。
 */
import Schema from 'schemastery';
import { ACTIONS, runSprint, sessionRoot } from './lib/sprint.js';
import { registerSkills } from './lib/skills.js';
import { registerUi, noteDir } from './lib/ui.js';

let defineTool = (d) => d;
try { ({ defineTool } = await import('@deepseek-ai/dsh-tools')); }
catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; }

export const name = 'dsh-sprint';
export const inject = [];

export const Config = Schema.object({
  python: Schema.string().default('python').description('跑抽取脚本用的 Python 解释器'),
});

const DESCRIPTION = [
  '考前速成整理流程的工具：资料抽取、任务状态、LaTeX 渲染与交付自检。',
  'action 必填；其余参数放在 payload_json 里（JSON 对象字符串）。',
  '可用 action：' + ACTIONS.join('、') + '。',
  '典型顺序：project.init → scan.pdf / scan.ppt / scan.shots → 模型写内容 → render.tex → render.preview → check.accept。',
  '输出目录默认 <项目>/_work，可用 config.set 改；交付件默认回到项目根目录。',
  '判成功只看 PDF 是否生成与日志里 ^! 是否为 0——本机退出码会假报 127。',
].join(' ');

export function apply(ctx, rawConfig = {}) {
  const config = { python: rawConfig?.python || 'python' };

  ctx.inject(['tools'], (c) => c.tools.register(defineTool({
    name: 'sprint',
    description: DESCRIPTION,
    parameters: {
      action: { type: 'string', enum: ACTIONS, required: true },
      payload_json: { type: 'string', description: '动作参数，JSON 对象字符串；只读动作可省略' },
      dir: { type: 'string', description: '项目目录，默认当前会话工作区' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(a, exec) {
      let args = {};
      if (a.payload_json) {
        try { args = JSON.parse(a.payload_json); }
        catch (e) { throw new Error('payload_json 不是合法 JSON：' + e.message); }
      }
      if (a.dir) args.dir = a.dir;
      // 记下这次落在哪个项目：网页与挂件下次打开直接接着用，不用再手填路径。
      try { noteDir(a.dir || exec?.agent?.session?.header?.cwd); } catch { /* 记不住不影响执行 */ }
      const value = await runSprint(a.action, args, exec, config);
      return JSON.parse(JSON.stringify(value && typeof value === 'object' && !Array.isArray(value) ? value : { result: value }));
    },
  })));

  ctx.inject(['commands'], (c) => c.commands.register({
    name: 'sprint',
    description: '考前速成整理：查看进度、初始化项目、编译与自检',
    input: { hint: 'init <科目> | status | template | check <pdf> | help' },
    handler: async ({ agent, rawInput }) => {
      const dir = agent?.session?.header?.cwd;
      if (!dir) return { kind: 'error', text: '当前会话没有工作区。' };
      const [verb, ...rest] = String(rawInput || '').trim().split(/\s+/);
      const exec = { agent };
      try {
        if (!verb || verb === 'status') {
          const st = await runSprint('project.status', { dir }, exec, config);
          if (!st.initialized) return { kind: 'info', text: '还没初始化。用 /sprint init <科目名>。' };
          const lines = ['科目：' + st.subject, '输出：' + st.outDir, '交付：' + st.deliverDir,
            '任务：' + Object.keys(st.tasks || {}).length + ' 项', '文件：' + (st.files || []).length + ' 个'];
          return { kind: 'success', text: lines.join('\n') };
        }
        if (verb === 'init') {
          const r = await runSprint('project.init', { dir, subject: rest.join(' ') || undefined }, exec, config);
          return { kind: 'success', text: '已初始化：' + r.subject + '\n输出目录：' + r.outDir };
        }
        if (verb === 'template') {
          const r = await runSprint('template.install', { dir }, exec, config);
          return { kind: 'success', text: '模板：' + r.file };
        }
        if (verb === 'check') {
          const r = await runSprint('check.accept', { dir, pdf: rest[0] }, exec, config);
          return { kind: r.ok ? 'success' : 'error', text: r.checks.map((x) => (x.ok ? '✓ ' : '✗ ') + x.name + '：' + x.detail).join('\n') };
        }
        return { kind: 'info', text: '用法：/sprint init <科目> | status | template | check <pdf>' };
      } catch (e) {
        return { kind: 'error', text: e.message };
      }
    },
  }));

  // 界面：自带网页 /dsh-sprint/ui + 两个 JSON 接口；无头部署没有 webServer 就整体跳过。
  registerUi(ctx, config);

  // 技能：告诉模型这套流程怎么走（宿主没有技能注册表就跳过）
  ctx.inject(['skills'], (s) => registerSkills(s));

  // 启动时把当前工作区的情况放进系统提示，模型不必先跑一次 help
  ctx.inject(['systemPrompt'], (p) => p.systemPrompt.section({
    name: 'dsh-sprint',
    content: '用 sprint 工具做考前速成整理：project.init 建 _work，scan.* 抽资料，render.tex 编译，check.accept 自检。判成功看 PDF 与日志 ^!，别看退出码。',
  }));
  void sessionRoot;
}
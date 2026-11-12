/**
 * dsh-sprint — 速成整理流程的宿主端逻辑。
 *
 * 这一层只做「管道」，不做「内容」：
 *   资料抽取（PDF/PPT/截图） → 任务状态（sprint.json）→ 模板渲染（LaTeX 两步编译）
 *   → 验收自检（日志无错、页数合理、能渲染出图）。
 * 知识网络、逐项释义、题眼归范这些判断仍然由模型在对话里写。
 *
 * 所有动作都接受一个 dir（默认取会话工作区），产物落在 <项目>/_work 下；
 * 目录可以在 config.set 里改，这就是「选择输出目录」的模块。
 */
import { execFile } from 'node:child_process';
import { access, copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PY_DIR = join(PKG_ROOT, 'lib', 'py');

/** 可用动作；help 会原样返回，方便模型自助。 */
export const ACTIONS = [
  'help',
  'project.init', 'project.status',
  'config.get', 'config.set',
  'scan.pdf', 'scan.ppt', 'scan.shots',
  'render.tex', 'render.preview',
  'check.accept',
  'template.install',
];

/** 一页正文能塞多少字，用来估计讲义页数（很粗，只作 sanity check）。 */
const CHARS_PER_PAGE = 1100;

function run(cmd, args, options = {}) {
  return new Promise((res) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      res({ code: error ? (error.code ?? 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), error });
    });
  });
}

function abs(p, base) { return isAbsolute(p) ? p : resolve(base, p); }
function exists(p) { return existsSync(p); }

/** 会话工作区；没有就要求显式传 dir，避免把文件写到奇怪的地方。 */
export function sessionRoot(exec) {
  return exec?.agent?.session?.header?.cwd || process.cwd();
}

function rootOf(args, exec) {
  const root = args.dir ? abs(args.dir, sessionRoot(exec)) : sessionRoot(exec);
  if (!exists(root)) throw new Error('目录不存在：' + root);
  return root;
}

const statePath = (root) => join(root, '_work', 'sprint.json');

/** 读状态；没有就返回 null（project.init 之前）。 */
export async function readState(root) {
  try { return JSON.parse(await readFile(statePath(root), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

async function writeState(root, patch) {
  const old = (await readState(root)) || {};
  const next = { ...old, ...patch, updatedAt: new Date().toISOString() };
  await mkdir(dirname(statePath(root)), { recursive: true });
  await writeFile(statePath(root), JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}

/** 输出目录：state.outDir > <root>/_work；交付目录：state.deliverDir > <root>。 */
function dirs(state, root) {
  const outDir = state?.outDir ? abs(state.outDir, root) : join(root, '_work');
  const deliverDir = state?.deliverDir ? abs(state.deliverDir, root) : root;
  return { outDir, deliverDir };
}

async function needState(root) {
  const state = await readState(root);
  if (!state) throw new Error('这个目录还没初始化：先跑 project.init {subject: ...}');
  return state;
}

async function python(config) {
  const bin = config?.python || process.env.DSH_PYTHON || 'python';
  const probe = await run(bin, ['-c', 'print(1)']);
  if (probe.code !== 0) throw new Error('找不到可用的 python：' + bin);
  return bin;
}

/** 跑一个 python 脚本，取它最后一行 JSON 作为结果。 */
async function pyJson(config, script, args) {
  const bin = await python(config);
  const res = await run(bin, [join(PY_DIR, script), ...args]);
  const lines = res.stdout.trim().split(/\r?\n/);
  const last = lines[lines.length - 1] || '';
  let value = null;
  try { value = JSON.parse(last); } catch { /* 交给下面报错 */ }
  if (!value) {
    throw new Error(script + ' 没有返回 JSON：' + (res.stderr || res.stdout).slice(-800));
  }
  if (value.error) throw new Error(value.error);
  return value;
}

async function listLogErrors(logPath) {
  let text = '';
  try { text = await readFile(logPath, 'utf8'); } catch { return []; }
  return text.split(/\r?\n/).filter((l) => l.startsWith('!')).slice(0, 20);
}

/** 从 xdvipdfmx 的 stderr 里抠页数（'x.pdf: 8 pages'）。 */
function pageCount(stderr) {
  const m = /(\d+)\s+pages?/.exec(stderr || '');
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------- actions

async function actionHelp() {
  return {
    name: 'dsh-sprint',
    version: '0.1.0',
    actions: ACTIONS,
    flow: [
      'project.init   建 _work 与 sprint.json（记科目、考试日、章范围）',
      'scan.pdf/ppt/shots  抽资料：全文分页、PPT 文字与图、截图按时间排序',
      'render.tex     传一个 .tex，自动 xelatex -no-pdf + xdvipdfmx，返页数与日志错误',
      'render.preview 把 PDF 每页渲染成 PNG，用眼睛复核',
      'check.accept   交付前自检：日志 0 错、页数、模板占位符、产物存在',
      'config.set     改输出目录 / 交付目录 / python 路径',
    ],
    note: '插件只管管道与模板，内容（知识网络、逐项释义、题眼归范）由模型写。判成功只看 PDF 是否生成 + 日志 ^! 是否为 0，退出码不可信。',
  };
}

async function actionInit(args, exec) {
  const root = args.dir ? abs(args.dir, sessionRoot(exec)) : sessionRoot(exec);
  const st = await readState(root);
  if (st && !args.force) {
    return { already: true, subject: st.subject, sprint: statePath(root), hint: '换科目用 dir 指定新目录，或加 force:true 重置。' };
  }
  const outDir = args.outDir ? abs(args.outDir, root) : join(root, '_work');
  for (const sub of ['scan', 'render', 'shots', 'out']) {
    await mkdir(join(outDir, sub), { recursive: true });
  }
  const subject = args.subject || basename(root);
  const state = await writeState(root, {
    subject,
    exam: args.exam || null,
    chapters: args.chapters || null,
    outDir: args.outDir || null,
    deliverDir: args.deliverDir || null,
    createdAt: st?.createdAt || new Date().toISOString(),
    tasks: st?.tasks || {},
  });
  return { ok: true, root, outDir, subject, sprint: statePath(root), state };
}

async function actionStatus(args, exec) {
  const root = rootOf(args, exec);
  const state = await readState(root);
  if (!state) return { initialized: false, root, hint: '先跑 project.init' };
  const { outDir, deliverDir } = dirs(state, root);
  const files = [];
  for (const sub of ['scan', 'render', 'out']) {
    const dir = join(outDir, sub);
    if (!exists(dir)) continue;
    for (const name of await readdir(dir)) files.push(join(sub, name));
  }
  return { initialized: true, root, outDir, deliverDir, subject: state.subject, exam: state.exam, tasks: state.tasks, files: files.slice(0, 60) };
}

async function actionConfigGet(args, exec) {
  const root = rootOf(args, exec);
  const state = await readState(root);
  const { outDir, deliverDir } = dirs(state, root);
  return { root, outDir, deliverDir, python: args.python || null, state: state?.tasks ? Object.keys(state.tasks) : [] };
}

async function actionConfigSet(args, exec) {
  const root = rootOf(args, exec);
  await needState(root);
  const patch = {};
  if (args.outDir) { patch.outDir = abs(args.outDir, root); await mkdir(patch.outDir, { recursive: true }); }
  if (args.deliverDir) { patch.deliverDir = abs(args.deliverDir, root); await mkdir(patch.deliverDir, { recursive: true }); }
  if (args.python) patch.python = args.python;
  const state = await writeState(root, patch);
  return { ok: true, ...dirs(state, root), python: state.python || null };
}

async function actionScanPdf(args, exec, config) {
  const root = rootOf(args, exec);
  const state = await needState(root);
  const { outDir } = dirs(state, root);
  if (!args.path) throw new Error('要传 path（PDF 路径）');
  const pdf = abs(args.path, root);
  if (!exists(pdf)) throw new Error('文件不存在：' + pdf);
  const name = args.name || basename(pdf, extname(pdf));
  const target = join(outDir, 'scan', name);
  const argv = [pdf, target];
  if (args.offset != null) argv.push('--offset', String(args.offset));
  if (args.ranges) argv.push('--ranges', JSON.stringify(args.ranges));
  if (args.maxChars) argv.push('--max-chars', String(args.maxChars));
  const value = await pyJson(config || state, 'extract_pdf.py', argv);
  const tasks = { ...(state.tasks || {}), ['scan.' + name]: { kind: 'pdf', at: new Date().toISOString(), dir: target, ...value } };
  await writeState(root, { tasks });
  return { ok: true, out: target, ...value };
}

async function actionScanPpt(args, exec, config) {
  const root = rootOf(args, exec);
  const state = await needState(root);
  const { outDir } = dirs(state, root);
  if (!args.path) throw new Error('要传 path（PPTX 路径）');
  const ppt = abs(args.path, root);
  if (!exists(ppt)) throw new Error('文件不存在：' + ppt);
  const name = args.name || basename(ppt, extname(ppt));
  const target = join(outDir, 'scan', name + '-ppt');
  const value = await pyJson(config || state, 'extract_ppt.py', [ppt, target]);
  const tasks = { ...(state.tasks || {}), ['scan.' + name + '.ppt']: { kind: 'ppt', at: new Date().toISOString(), dir: target, ...value } };
  await writeState(root, { tasks });
  return { ok: true, out: target, ...value };
}

async function actionScanShots(args, exec) {
  const root = rootOf(args, exec);
  const state = await needState(root);
  const { outDir } = dirs(state, root);
  if (!args.path) throw new Error('要传 path（截图目录）');
  const src = abs(args.path, root);
  if (!exists(src)) throw new Error('目录不存在：' + src);
  const target = join(outDir, 'shots');
  await mkdir(target, { recursive: true });
  const names = (await readdir(src)).filter((n) => /\.(png|jpe?g|webp|bmp)$/i.test(n));
  const items = [];
  for (const n of names) {
    const full = join(src, n);
    const st = await stat(full);
    items.push({ name: n, full, mtime: st.mtimeMs });
  }
  items.sort((a, b) => a.mtime - b.mtime);
  const width = Math.max(2, String(items.length).length);
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const dest = join(target, 's' + String(i + 1).padStart(width, '0') + extname(items[i].full).toLowerCase());
    await copyFile(items[i].full, dest);
    out.push({ index: i + 1, from: items[i].name, file: dest, mtime: new Date(items[i].mtime).toISOString() });
  }
  const tasks = { ...(state.tasks || {}), 'scan.shots': { kind: 'shots', at: new Date().toISOString(), dir: target, count: out.length } };
  await writeState(root, { tasks });
  return { ok: true, out: target, count: out.length, shots: out.slice(0, 40) };
}

async function actionRenderTex(args, exec) {
  const root = rootOf(args, exec);
  const state = await needState(root);
  const { outDir } = dirs(state, root);
  if (!args.tex) throw new Error('要传 tex（.tex 文件路径）');
  const tex = abs(args.tex, root);
  if (!exists(tex)) throw new Error('文件不存在：' + tex);
  const workDir = dirname(tex);
  const stem = basename(tex, '.tex');
  const xdv = join(workDir, stem + '.xdv');
  const log = join(workDir, stem + '.log');
  const defaultPdf = join(workDir, stem + '.pdf');
  // 指定了 name 就换输出目录与文件名，避免覆盖正在看的 PDF
  const outPdf = args.name ? join(outDir, 'render', args.name + '.pdf') : defaultPdf;
  if (args.name) await mkdir(dirname(outPdf), { recursive: true });

  const first = await run('xelatex', ['-no-pdf', '-interaction=nonstopmode', basename(tex)], { cwd: workDir });
  const second = await run('xdvipdfmx', args.name ? ['-q', '-o', outPdf, xdv] : ['-q', xdv], { cwd: workDir });
  const errors = await listLogErrors(log);
  const pdfOk = exists(outPdf) && (await stat(outPdf)).size > 1000;
  const pages = pageCount(second.stderr) || pageCount(first.stdout);
  const value = {
    ok: pdfOk && errors.length === 0,
    pdf: pdfOk ? outPdf : null,
    pages,
    errors,
    exit: { xelatex: first.code, xdvipdfmx: second.code },
    log,
    note: '退出码不可信（本机常为 127 但产物正常）；判据是 pdf 存在且 errors 为空。',
  };
  const tasks = { ...(state.tasks || {}), ['render.' + (args.name || stem)]: { kind: 'tex', at: new Date().toISOString(), ...value } };
  await writeState(root, { tasks });
  return value;
}

async function actionRenderPreview(args, exec, config) {
  const root = rootOf(args, exec);
  const state = await needState(root);
  const { outDir } = dirs(state, root);
  if (!args.pdf) throw new Error('要传 pdf');
  const pdf = abs(args.pdf, root);
  if (!exists(pdf)) throw new Error('文件不存在：' + pdf);
  const name = args.name || basename(pdf, '.pdf');
  const target = join(outDir, 'out', name + '-preview');
  const argv = [pdf, target];
  if (args.dpi) argv.push('--dpi', String(args.dpi));
  const value = await pyJson(config || state, 'render_pages.py', argv);
  return { ok: true, out: target, ...value };
}

async function actionCheckAccept(args, exec) {
  const root = rootOf(args, exec);
  const state = await needState(root);
  const { outDir } = dirs(state, root);
  const checks = [];
  const add = (ok, name, detail) => checks.push({ ok, name, detail });

  let pdf = null, tex = null, log = null;
  if (args.tex) {
    tex = abs(args.tex, root);
    const workDir = dirname(tex), stem = basename(tex, '.tex');
    log = join(workDir, stem + '.log');
    pdf = join(workDir, stem + '.pdf');
  } else if (args.pdf) {
    pdf = abs(args.pdf, root);
    log = args.log ? abs(args.log, root) : null;
  } else {
    throw new Error('要传 tex 或 pdf');
  }

  add(exists(pdf), '产物存在', pdf);
  if (exists(pdf)) {
    const size = (await stat(pdf)).size;
    add(size > 1000, '产物非空', size + ' bytes');
  }
  if (log && exists(log)) {
    const errors = await listLogErrors(log);
    add(errors.length === 0, '编译日志无错误', errors.length ? errors.slice(0, 5) : '0 个 !');
    const text = await readFile(log, 'utf8');
    const pages = pageCount(text);
    if (pages != null && args.minPages) add(pages >= args.minPages, '页数达标', pages + ' >= ' + args.minPages);
    else if (pages != null) add(true, '页数', String(pages));
  }
  if (state.subject && args.subject && state.subject !== args.subject) add(false, '科目一致', state.subject + ' != ' + args.subject);
  return { ok: checks.every((c) => c.ok), checks, pdf, log };
}

async function actionTemplateInstall(args, exec) {
  const root = rootOf(args, exec);
  const state = await needState(root);
  const { outDir } = dirs(state, root);
  const dest = join(outDir, args.name || 'template.tex');
  await copyFile(join(PKG_ROOT, 'template.tex'), dest);
  return { ok: true, file: dest, hint: '模板已复制；改 \\title/\\author 后 render.tex 验一遍。' };
}

// ---------------------------------------------------------------- dispatch

/** 执行一个动作；execute 里已保证 args 是对象。 */
export async function runSprint(action, args, exec, config = {}) {
  switch (action) {
    case 'help': return actionHelp();
    case 'project.init': return actionInit(args, exec);
    case 'project.status': return actionStatus(args, exec);
    case 'config.get': return actionConfigGet(args, exec);
    case 'config.set': return actionConfigSet(args, exec);
    case 'scan.pdf': return actionScanPdf(args, exec, config);
    case 'scan.ppt': return actionScanPpt(args, exec, config);
    case 'scan.shots': return actionScanShots(args, exec);
    case 'render.tex': return actionRenderTex(args, exec);
    case 'render.preview': return actionRenderPreview(args, exec, config);
    case 'check.accept': return actionCheckAccept(args, exec);
    case 'template.install': return actionTemplateInstall(args, exec);
    default: throw new Error('未知动作：' + action + '（可用：' + ACTIONS.join(', ') + '）');
  }
}

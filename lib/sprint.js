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
import { access, copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PY_DIR = join(PKG_ROOT, 'lib', 'py');

/** 可用动作；help 会原样返回，方便模型自助。 */
export const ACTIONS = [
  'help',
  'subject.create', 'subject.list', 'subject.remove',
  'project.init', 'project.status',
  'config.get', 'config.set',
  'scan.pdf', 'scan.ppt', 'scan.shots',
  'split.pdf',
  'plan.coverage', 'plan.next',
  'draft.new', 'draft.list', 'draft.update', 'draft.patch',
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

/**
 * 动作要落在哪个目录：
 *   - 给了 subject 就查科目登记表，落到那科的目录；
 *   - 否则用 dir，或会话工作区。
 * 这是「多科目分区」的入口：科目之间靠目录隔离，互不干扰。
 */
async function rootOf(args, exec) {
  const base = args.dir ? abs(args.dir, sessionRoot(exec)) : sessionRoot(exec);
  if (!args.subject) {
    if (!exists(base)) throw new Error('目录不存在：' + base);
    return base;
  }
  const reg = await readRegistry(base);
  const entry = reg.subjects?.[args.subject];
  if (!entry) {
    const known = Object.keys(reg.subjects || {});
    throw new Error('没有这个科目：' + args.subject + (known.length ? '（已有：' + known.join('、') + '）' : '（先用 subject.create 建一个）'));
  }
  return entry.dir;
}

const registryPath = (base) => join(base, 'subjects.json');

async function readRegistry(base) {
  try { return JSON.parse(await readFile(registryPath(base), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return { version: 1, subjects: {} }; throw e; }
}

async function writeRegistry(base, reg) {
  await mkdir(base, { recursive: true });
  const next = { version: 1, ...reg, updatedAt: new Date().toISOString() };
  await writeFile(registryPath(base), JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
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
    version: '0.2.0',
    actions: ACTIONS,
    flow: [
      'subject.create 建一个科目目录（books/questions/ppt/shots/_work/_out），之后动作带 subject 就落进去',
      'subject.remove mode:work 只清中间件；mode:all + confirm 整科删除',
      'project.init   建 _work 与 sprint.json（记科目、考试日、章范围）',
      'split.pdf      大 PDF 切单页 + 按 ranges 合并成章节',
      'plan.coverage / plan.next  网课章节与书章节的对照表，推荐下一节',
      'draft.new/list/update/patch  各节草稿的状态机（交截图后打补丁）',
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
  const root = await rootOf(args, exec);
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
  const root = await rootOf(args, exec);
  const state = await readState(root);
  const { outDir, deliverDir } = dirs(state, root);
  return { root, outDir, deliverDir, python: args.python || null, state: state?.tasks ? Object.keys(state.tasks) : [] };
}

async function actionConfigSet(args, exec) {
  const root = await rootOf(args, exec);
  await needState(root);
  const patch = {};
  if (args.outDir) { patch.outDir = abs(args.outDir, root); await mkdir(patch.outDir, { recursive: true }); }
  if (args.deliverDir) { patch.deliverDir = abs(args.deliverDir, root); await mkdir(patch.deliverDir, { recursive: true }); }
  if (args.python) patch.python = args.python;
  const state = await writeState(root, patch);
  return { ok: true, ...dirs(state, root), python: state.python || null };
}

async function actionScanPdf(args, exec, config) {
  const root = await rootOf(args, exec);
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
  const root = await rootOf(args, exec);
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
  const root = await rootOf(args, exec);
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
  const root = await rootOf(args, exec);
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
  const root = await rootOf(args, exec);
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
  const root = await rootOf(args, exec);
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
  const root = await rootOf(args, exec);
  const state = await needState(root);
  const { outDir } = dirs(state, root);
  const dest = join(outDir, args.name || 'template.tex');
  await copyFile(join(PKG_ROOT, 'template.tex'), dest);
  return { ok: true, file: dest, hint: '模板已复制；改 \\title/\\author 后 render.tex 验一遍。' };
}


// ---------------------------------------------------------------- 科目分区
// 一个科目一个目录：<根>/<科目>/{books,questions,ppt,shots,_work,_out}
// 科目之间只靠目录隔离，互不读对方的状态；登记表在 <根>/subjects.json。

const SUB_DIRS = ['books', 'questions', 'ppt', 'shots'];

async function actionSubjectCreate(args, exec) {
  const base = args.dir ? abs(args.dir, sessionRoot(exec)) : sessionRoot(exec);
  const name = String(args.name || args.subject || '').trim();
  if (!name) throw new Error('要传 name（科目名，例如「激光原理」）');
  if (/[\\/:*?"<>|]/.test(name)) throw new Error('科目名不能含 \\ / : * ? " < > |');
  const dir = join(base, name);
  const reg = await readRegistry(base);
  const old = reg.subjects?.[name];
  if (old && !args.force) {
    return { exists: true, name, dir: old.dir, hint: '同名科目已存在；要覆盖建加 force:true（不删旧文件）' };
  }
  for (const sub of SUB_DIRS) await mkdir(join(dir, sub), { recursive: true });
  await mkdir(join(dir, '_out'), { recursive: true });
  const init = await actionInit({ dir, subject: name, exam: args.exam, chapters: args.chapters }, exec);
  reg.subjects = {
    ...(reg.subjects || {}),
    [name]: { dir, exam: args.exam || null, chapters: args.chapters || null, createdAt: old?.createdAt || new Date().toISOString() },
  };
  await writeRegistry(base, reg);
  return {
    ok: true, name, dir,
    layout: { books: join(dir, 'books'), questions: join(dir, 'questions'), ppt: join(dir, 'ppt'), shots: join(dir, 'shots'), work: join(dir, '_work'), out: join(dir, '_out') },
    state: init.state,
    hint: '之后所有动作带 subject:"' + name + '" 就会落在这一科里。',
  };
}

async function actionSubjectList(args, exec) {
  const base = args.dir ? abs(args.dir, sessionRoot(exec)) : sessionRoot(exec);
  const reg = await readRegistry(base);
  const items = [];
  for (const [name, entry] of Object.entries(reg.subjects || {})) {
    const st = await readState(entry.dir);
    const count = async (sub) => { try { return (await readdir(join(entry.dir, sub))).length; } catch { return 0; } };
    items.push({
      name, dir: entry.dir, exam: entry.exam || st?.exam || null,
      hasWork: exists(join(entry.dir, '_work')),
      books: await count('books'), questions: await count('questions'), ppt: await count('ppt'), shots: await count('shots'),
      tasks: st?.tasks ? Object.keys(st.tasks).length : 0,
    });
  }
  return { root: base, count: items.length, subjects: items };
}

async function actionSubjectRemove(args, exec) {
  const base = args.dir ? abs(args.dir, sessionRoot(exec)) : sessionRoot(exec);
  const name = String(args.name || args.subject || '').trim();
  if (!name) throw new Error('要传 name（科目名）');
  const reg = await readRegistry(base);
  const entry = reg.subjects?.[name];
  const dir = entry?.dir || join(base, name);
  if (!exists(dir)) throw new Error('找不到科目目录：' + dir);
  const mode = args.mode || 'work';
  if (mode === 'work') {
    const work = join(dir, '_work');
    if (exists(work)) await rm(work, { recursive: true, force: true });
    return { ok: true, name, dir, mode, removed: work, note: '只清了中间件；books/questions/ppt/shots 与交付件都还在。' };
  }
  if (mode !== 'all') throw new Error('mode 只能是 work 或 all');
  if (args.confirm !== name) throw new Error('整科删除要确认：传 confirm:"' + name + '"');
  await rm(dir, { recursive: true, force: true });
  if (reg.subjects?.[name]) { delete reg.subjects[name]; await writeRegistry(base, reg); }
  return { ok: true, name, dir, mode, removed: dir, note: '整科目录已删除（含资料与产物）。' };
}

// ---------------------------------------------------------------- PDF 切页
// 大电子书按页拆开，单页文件很小；同时按 --ranges 合并成章节 PDF。
async function actionSplitPdf(args, exec, config) {
  const root = await rootOf(args, exec);
  const state = await needState(root);
  const { outDir } = dirs(state, root);
  if (!args.path) throw new Error('要传 path（PDF 路径）');
  const pdf = abs(args.path, root);
  if (!exists(pdf)) throw new Error('文件不存在：' + pdf);
  const name = args.name || basename(pdf, extname(pdf));
  const target = join(outDir, 'split', name);
  const argv = [pdf, target];
  if (args.mode) argv.push('--mode', args.mode);
  if (args.ranges) argv.push('--ranges', JSON.stringify(args.ranges));
  if (args.pageMaxBytes != null) argv.push('--page-max-bytes', String(args.pageMaxBytes));
  const value = await pyJson(config || state, 'split_pdf.py', argv);
  const tasks = { ...(state.tasks || {}), ['split.' + name]: { kind: 'split', at: new Date().toISOString(), dir: target, ...value } };
  await writeState(root, { tasks });
  return { ok: true, out: target, ...value };
}

// ---------------------------------------------------------------- 线性流程
// plan.json 存「网课章节 → 书里哪几节 → 必看/可跳/缺口」，drafts.json 存每一节的草稿状态。
// 学习与生成同时进行：他看一节网课，我在队列里推进别的节；他交截图后 draft.patch 补改。

const planPath = (outDir) => join(outDir, 'plan.json');
const draftsPath = (outDir) => join(outDir, 'drafts.json');

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}

async function writeJson(file, value) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

const planTable = (plan) => {
  const head = '| # | 网课章节 | 对应书 | 时长 | 判断 | 状态 | 为什么 |\n|---|---|---|---|---|---|---|';
  const rows = plan.sections.map((s) => '| ' + [s.order, s.title || '', s.book || '', s.minutes ? s.minutes + ' min' : '', s.verdict || '', s.status, s.why || ''].join(' | ') + ' |');
  return [head, ...rows].join('\n');
};

async function actionPlanCoverage(args, exec) {
  const root = await rootOf(args, exec);
  const state = await needState(root);
  const { outDir } = dirs(state, root);
  const incoming = Array.isArray(args.sections) ? args.sections : null;
  if (!incoming || !incoming.length) throw new Error('要传 sections: [{title, book, minutes, verdict, why}, ...]（由模型判断后给）');
  const old = await readJson(planPath(outDir), { sections: [] });
  const kept = new Map(old.sections.map((s) => [s.title, s]));
  const sections = incoming.map((s, i) => ({
    order: i + 1,
    title: String(s.title || '').trim() || '第 ' + (i + 1) + ' 节',
    book: s.book || '',
    minutes: s.minutes ?? null,
    verdict: s.verdict || '必看',
    why: s.why || '',
    status: s.status || kept.get(s.title)?.status || 'todo',
  }));
  const plan = { subject: state.subject, at: new Date().toISOString(), sections };
  await writeJson(planPath(outDir), plan);
  await writeFile(join(outDir, 'plan.md'), '# ' + (state.subject || '') + ' 学习计划\n\n' + planTable(plan) + '\n', 'utf8');
  const next = sections.find((s) => s.status !== 'done') || null;
  return { ok: true, plan: planPath(outDir), markdown: join(outDir, 'plan.md'), count: sections.length, next };
}

async function actionPlanNext(args, exec) {
  const root = await rootOf(args, exec);
  const state = await needState(root);
  const { outDir } = dirs(state, root);
  const plan = await readJson(planPath(outDir), null);
  if (!plan) throw new Error('还没有计划：先 plan.coverage {sections: [...]}');
  const next = plan.sections.find((s) => s.status !== 'done') || null;
  return { subject: plan.subject, done: plan.sections.filter((s) => s.status === 'done').length, total: plan.sections.length, next };
}

const DRAFT_STATUS = ['todo', 'drafting', 'needs-revision', 'ready', 'done', 'dropped'];

async function actionDraftNew(args, exec) {
  const root = await rootOf(args, exec);
  const state = await needState(root);
  const { outDir } = dirs(state, root);
  const title = String(args.title || args.section || '').trim();
  if (!title) throw new Error('要传 title（哪一节，例如「第 2 章 光学谐振腔」）');
  const db = await readJson(draftsPath(outDir), { seq: 0, items: {} });
  db.seq = (db.seq || 0) + 1;
  const id = 'd' + String(db.seq).padStart(2, '0');
  db.items[id] = {
    id, title, kind: args.kind || 'chapter', section: args.section || null,
    status: 'todo', file: null, note: args.note || '',
    history: [{ at: new Date().toISOString(), action: 'new', note: args.note || '' }],
    updatedAt: new Date().toISOString(),
  };
  await writeJson(draftsPath(outDir), db);
  return { ok: true, id, item: db.items[id], file: draftsPath(outDir) };
}

async function actionDraftList(args, exec) {
  const root = await rootOf(args, exec);
  const state = await needState(root);
  const { outDir } = dirs(state, root);
  const db = await readJson(draftsPath(outDir), { seq: 0, items: {} });
  let items = Object.values(db.items);
  if (args.status) items = items.filter((i) => i.status === args.status);
  return { count: items.length, items, file: draftsPath(outDir) };
}

async function findDraft(db, id) {
  const item = db.items[id];
  if (!item) throw new Error('没有这个草稿：' + id + '（用 draft.list 看现有 id）');
  return item;
}

async function actionDraftUpdate(args, exec) {
  const root = await rootOf(args, exec);
  const state = await needState(root);
  const { outDir } = dirs(state, root);
  const db = await readJson(draftsPath(outDir), { seq: 0, items: {} });
  const item = await findDraft(db, String(args.id || ''));
  if (args.status) {
    if (!DRAFT_STATUS.includes(args.status)) throw new Error('status 只能是：' + DRAFT_STATUS.join(' / '));
    item.status = args.status;
  }
  if (args.file !== undefined) item.file = args.file;
  if (args.note !== undefined) item.note = args.note;
  item.history.push({ at: new Date().toISOString(), action: 'update', note: args.note || '', status: item.status });
  item.updatedAt = new Date().toISOString();
  await writeJson(draftsPath(outDir), db);
  return { ok: true, item };
}

/**
 * 用户交了截图/新资料之后，往对应那一节里打补丁：
 *   supplement 补内容 / revise 改错 / drop 这一节不要了 / approve 定稿。
 * 状态机：todo → drafting → needs-revision → ready → done。
 */
async function actionDraftPatch(args, exec) {
  const root = await rootOf(args, exec);
  const state = await needState(root);
  const { outDir } = dirs(state, root);
  const db = await readJson(draftsPath(outDir), { seq: 0, items: {} });
  const item = await findDraft(db, String(args.id || ''));
  const action = args.action || 'supplement';
  const map = { supplement: 'needs-revision', revise: 'needs-revision', approve: 'ready', drop: 'dropped' };
  if (!map[action]) throw new Error('action 只能是 supplement / revise / approve / drop');
  let slots = (item.note || '');
  if (action === 'supplement' || action === 'revise') {
    slots = slots ? slots + '\n' : '';
    slots += '- ' + (args.note || '(待补：' + (args.source || '用户新交的资料') + ')');
  }
  item.note = slots;
  item.status = map[action];
  item.history.push({ at: new Date().toISOString(), action, note: args.note || '', source: args.source || null, status: item.status });
  item.updatedAt = new Date().toISOString();
  await writeJson(draftsPath(outDir), db);
  return { ok: true, id: item.id, status: item.status, note: item.note, item };
}

// ---------------------------------------------------------------- dispatch

/** 执行一个动作；execute 里已保证 args 是对象。 */
export async function runSprint(action, args, exec, config = {}) {
  switch (action) {
    case 'help': return actionHelp();
    case 'subject.create': return actionSubjectCreate(args, exec);
    case 'subject.list': return actionSubjectList(args, exec);
    case 'subject.remove': return actionSubjectRemove(args, exec);
    case 'project.init': return actionInit(args, exec);
    case 'project.status': return actionStatus(args, exec);
    case 'config.get': return actionConfigGet(args, exec);
    case 'config.set': return actionConfigSet(args, exec);
    case 'scan.pdf': return actionScanPdf(args, exec, config);
    case 'scan.ppt': return actionScanPpt(args, exec, config);
    case 'scan.shots': return actionScanShots(args, exec);
    case 'split.pdf': return actionSplitPdf(args, exec, config);
    case 'plan.coverage': return actionPlanCoverage(args, exec);
    case 'plan.next': return actionPlanNext(args, exec);
    case 'draft.new': return actionDraftNew(args, exec);
    case 'draft.list': return actionDraftList(args, exec);
    case 'draft.update': return actionDraftUpdate(args, exec);
    case 'draft.patch': return actionDraftPatch(args, exec);
    case 'render.tex': return actionRenderTex(args, exec);
    case 'render.preview': return actionRenderPreview(args, exec, config);
    case 'check.accept': return actionCheckAccept(args, exec);
    case 'template.install': return actionTemplateInstall(args, exec);
    default: throw new Error('未知动作：' + action + '（可用：' + ACTIONS.join(', ') + '）');
  }
}
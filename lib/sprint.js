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
  'subject.create', 'subject.list', 'subject.remove', 'subject.bootstrap',
  'sprint.status',
  'project.init', 'project.status',
  'config.get', 'config.set',
  'scan.pdf', 'scan.ppt', 'scan.shots',
  'page.read', 'page.search', 'page.ocr',
  'split.pdf', 'book.set',
  'plan.coverage', 'plan.next', 'parallel.plan',
  'draft.new', 'draft.list', 'draft.update', 'draft.patch', 'draft.claim', 'draft.release',
  'questions.parse', 'questions.import', 'questions.list', 'questions.update',
  'hint.add', 'hint.list', 'hint.remove',
  'render.tex', 'render.preview',
  'check.accept',
  'template.install',
];

/** 一页正文能塞多少字，用来估计讲义页数（很粗，只作 sanity check）。 */
const CHARS_PER_PAGE = 1100;

function run(cmd, args, options = {}) {
  return new Promise((res) => {
    // PYTHONIOENCODING：Windows 上 python 的 stdout 被重定向时会退回 cp936，
    // 中文 JSON 到 node 这边就成乱码；统一钉成 utf-8。
    execFile(cmd, args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, ...options }, (error, stdout, stderr) => {
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
    version: '0.4.0',
    actions: ACTIONS,
    flow: [
      'subject.create 建一个科目目录（books/questions/ppt/shots/_work/_out），之后动作带 subject 就落进去',
      'subject.bootstrap 一次性收资料：按扩展名把文件夹里的书/题/截图/PPT 归位并抽一遍',
      'subject.remove mode:work 只清中间件；mode:all + confirm 整科删除',
      'sprint.status  一屏看全：计划/草稿/题目/口头提示的进度',
      'project.init   建 _work 与 sprint.json（记科目、考试日、章范围）',
      'split.pdf      大 PDF 切单页 + 按 ranges 合并成章节',
      'plan.coverage / plan.next  网课章节与书章节的对照表，推荐下一节',
      'draft.new/list/update/patch  各节草稿的状态机（交截图后打补丁）',
      'draft.claim/release + parallel.plan  并发推进：先领租约再做，同一节不会被两个执行者同时写',
      'questions.parse/import/list/update  「教材 P160 5.6 5.7」拆成可勾选的题目清单',
      'hint.add/list/remove  老师口头提示，单独成篇 hints.md',
      'book.set  书本 PDF 与「PDF 页 = 书页 + offset」的换算，用来翻到题所在页',
      'scan.pdf/ppt/shots  抽资料：全文分页、PPT 文字与图、截图按时间排序',
      'render.tex     传一个 .tex，自动 xelatex -no-pdf + xdvipdfmx，返页数与日志错误',
      'render.preview 把 PDF 每页渲染成 PNG，用眼睛复核',
      'check.accept   交付前自检：日志 0 错、页数、模板占位符、产物存在',
      'page.ocr       扫描件整本 OCR 成逐页文本（约 6 秒/页），之后 page.read/search 都能用',
      'page.read      读某页原文，formulas:true 再把独立公式行转成 LaTeX',
      'page.search    全文检索：找「误码率」这类词落在哪几页',
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


// ---------------------------------------------------------------- 教师口头提示
// 老师课上强调的话单独成篇：hints.json 存结构，科目根目录的 hints.md 给人看/给别的模型读。
// 提示往往只有一句（「P161 那两题仔细推敲」），所以动作必须轻：一次一句，带标签。

const hintsPath = (root) => join(root, '_work', 'hints.json');
const hintsMdPath = (root) => join(root, 'hints.md');

function hintsTable(hints) {
  if (!hints.length) return '_还没有记录。听到老师强调什么，就用 hint.add 加一条。_';
  const head = '| # | 日期 | 标签 | 原话 |\n|---|---|---|---|';
  const rows = hints.map((h) => '| ' + [h.id, String(h.at).slice(0, 10), h.tag || '—', String(h.text).replace(/\|/g, '\\|')].join(' | ') + ' |');
  return [head, ...rows].join('\n');
}

async function writeHints(root, db) {
  await writeJson(hintsPath(root), db);
  const md = '# 老师口头提示\n\n> 由 hint.add 收集；复习时先扫这张表，它是「老师认为重要」的直接证据。\n\n' + hintsTable(db.items) + '\n';
  await writeFile(hintsMdPath(root), md, 'utf8');
}

async function actionHintAdd(args, exec) {
  const root = await rootOf(args, exec);
  await needState(root);
  const text = String(args.text || args.note || '').trim();
  if (!text) throw new Error('要传 text（老师说的原话，一句一句加）');
  const db = await readJson(hintsPath(root), { seq: 0, items: [] });
  db.seq = (db.seq || 0) + 1;
  const item = { id: 'h' + String(db.seq).padStart(2, '0'), text, tag: args.tag || '', source: args.source || null, at: new Date().toISOString() };
  db.items.push(item);
  await writeHints(root, db);
  return { ok: true, item, file: hintsMdPath(root), count: db.items.length };
}

async function actionHintList(args, exec) {
  const root = await rootOf(args, exec);
  const db = await readJson(hintsPath(root), { seq: 0, items: [] });
  const items = args.tag ? db.items.filter((h) => h.tag === args.tag) : db.items;
  return { count: items.length, items, file: hintsMdPath(root) };
}

async function actionHintRemove(args, exec) {
  const root = await rootOf(args, exec);
  const db = await readJson(hintsPath(root), { seq: 0, items: [] });
  const id = String(args.id || '');
  const before = db.items.length;
  db.items = db.items.filter((h) => h.id !== id);
  if (db.items.length === before) throw new Error('没有这条提示：' + id);
  await writeHints(root, db);
  return { ok: true, id, count: db.items.length };
}

// ---------------------------------------------------------------- 题目清单
// 一种资料是 PDF/docx，另一种只是「教材 P160 的 5.6、5.7」这样一句话。
// questions.parse 把后者拆成可勾选的条目：页码 + 题号，落到 questions.md，才能一节节推进。

const questionsPath = (root) => join(root, '_work', 'questions.json');
const questionsMdPath = (root) => join(root, 'questions.md');
const QSTATUS = ['todo', 'doing', 'done', 'skip'];

/**
 * 从一段作业文本里拆出「哪一页的哪几题」。
 * 页码说法有：教材P160 / 教材：120页 / 教材 P88（教材与 P 之间允许换行）。
 * 题号写在页码下面几行也算（一份作业常写成「教材 P161」换行「5.6」「5.7」）。
 * 但含汉字的行不往下带页码——「附件作业，1-1 1-2」指的是另一个文件，不能算到上一页头上。
 */
export function parseHomework(text) {
  const pageRe = /(?:教材|课本|书)\s*[:：]?\s*[Pp]?\.?\s*(\d{1,3})\s*页?/g;
  const refRe = /(?<!\d)(\d{1,2})\s*[.\-–]\s*(\d{1,2})(?!\d)/g;
  const cjk = /[\u4e00-\u9fff]/;
  const refsIn = (s) => {
    const out = [];
    let r;
    refRe.lastIndex = 0;
    while ((r = refRe.exec(s))) out.push(r[1] + (r[0].includes('-') ? '-' : '.') + r[2]);
    return out;
  };
  const groups = [];
  let active = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const markers = [];
    let m;
    pageRe.lastIndex = 0;
    while ((m = pageRe.exec(line))) markers.push({ page: Number(m[1]), index: m.index, end: pageRe.lastIndex });
    // 「教材」和「P118」分两行写是常见格式：单独一行的 P118 也认。
    const bare = /^\s*[Pp]\.?\s*(\d{1,3})\s*页?\s*[：:，,]?\s*$/.exec(line);
    if (!markers.length && bare) markers.push({ page: Number(bare[1]), index: 0, end: line.length });
    if (markers.length) {
      for (let i = 0; i < markers.length; i++) {
        const from = markers[i].end;
        const to = i + 1 < markers.length ? markers[i + 1].index : line.length;
        active = { page: markers[i].page, refs: [] };
        groups.push(active);
        for (const ref of refsIn(line.slice(from, to))) if (!active.refs.includes(ref)) active.refs.push(ref);
      }
      continue;
    }
    if (!active) continue;
    if (cjk.test(line)) continue;
    for (const ref of refsIn(line)) if (!active.refs.includes(ref)) active.refs.push(ref);
  }
  const merged = [];
  for (const g of groups) {
    if (!g.refs.length) continue;
    const hit = merged.find((x) => x.page === g.page);
    if (!hit) merged.push({ page: g.page, refs: [...g.refs] });
    else for (const r of g.refs) if (!hit.refs.includes(r)) hit.refs.push(r);
  }
  return merged;
}

function questionsTable(db, state) {
  if (!db.items.length) return '_还没有题目。questions.parse 把「教材 P160 的 5.6」这类话拆成条目，questions.import 登记成文件的题。_';
  const offset = state?.bookOffset;
  const head = '| # | 教材页 | 题号 | PDF 页 | 文件 | 状态 | 备注 |\n|---|---|---|---|---|---|---|';
  const rows = db.items.map((q) => '| ' + [
    q.id,
    q.page ?? '—',
    q.ref || '—',
    q.page != null && offset != null ? String(q.page + offset) : '—',
    q.file ? basename(q.file) : '—',
    q.status,
    String(q.note || '').replace(/\|/g, '\\|'),
  ].join(' | ') + ' |');
  return [head, ...rows].join('\n');
}

async function writeQuestions(root, db, state) {
  await writeJson(questionsPath(root), db);
  const md = '# ' + (state?.subject || '') + ' 题目清单\n\n> 带 PDF 页的条目可以直接翻书；状态用来安排「先做哪几题」。\n\n' + questionsTable(db, state) + '\n';
  await writeFile(questionsMdPath(root), md, 'utf8');
}

async function actionQuestionsParse(args, exec) {
  const root = await rootOf(args, exec);
  const state = await needState(root);
  const text = String(args.text || '').trim();
  if (!text) throw new Error('要传 text（作业原文，例如「教材 P160 5.6 5.7」）');
  const groups = parseHomework(text);
  if (args.dryRun) return { ok: true, dryRun: true, groups, count: groups.reduce((n, g) => n + g.refs.length, 0) };
  if (!groups.length) throw new Error('没拆出题号；原文：' + text.slice(0, 120));
  const db = await readJson(questionsPath(root), { seq: 0, items: [] });
  const added = [];
  const skipped = [];
  for (const g of groups) {
    for (const ref of g.refs) {
      const dup = db.items.find((q) => q.page === g.page && q.ref === ref);
      if (dup) { skipped.push(dup.id); continue; }
      db.seq = (db.seq || 0) + 1;
      const item = { id: 'q' + String(db.seq).padStart(2, '0'), page: g.page, ref, file: null, source: args.source || 'text', status: 'todo', note: '', at: new Date().toISOString() };
      db.items.push(item); added.push(item);
    }
  }
  await writeQuestions(root, db, state);
  return { ok: true, added, skipped, count: added.length, total: db.items.length, file: questionsMdPath(root) };
}

async function actionQuestionsImport(args, exec) {
  const root = await rootOf(args, exec);
  const state = await needState(root);
  const db = await readJson(questionsPath(root), { seq: 0, items: [] });
  const items = [];
  const push = (it) => { db.seq = (db.seq || 0) + 1; items.push({ id: 'q' + String(db.seq).padStart(2, '0'), status: 'todo', note: '', at: new Date().toISOString(), ...it }); };
  if (args.path) {
    const file = abs(args.path, root);
    if (!exists(file)) throw new Error('文件不存在：' + file);
    push({ file, title: args.title || basename(file), kind: 'file', page: args.page ?? null, ref: null });
  }
  if (Array.isArray(args.items)) for (const it of args.items) push({ ...it, file: it.file || null });
  if (!items.length) throw new Error('要传 path（题目文件）或 items:[{title/file, page, ref}]');
  db.items.push(...items);
  await writeQuestions(root, db, state);
  return { ok: true, added: items, count: db.items.length, file: questionsMdPath(root) };
}

async function actionQuestionsList(args, exec) {
  const root = await rootOf(args, exec);
  const state = await readState(root);
  const db = await readJson(questionsPath(root), { seq: 0, items: [] });
  let items = db.items;
  if (args.status) items = items.filter((q) => q.status === args.status);
  return { count: items.length, items, file: questionsMdPath(root), offset: state?.bookOffset ?? null };
}

async function actionQuestionsUpdate(args, exec) {
  const root = await rootOf(args, exec);
  const state = await needState(root);
  const db = await readJson(questionsPath(root), { seq: 0, items: [] });
  const item = db.items.find((q) => q.id === String(args.id || ''));
  if (!item) throw new Error('没有这道题：' + args.id);
  if (args.status) {
    if (!QSTATUS.includes(args.status)) throw new Error('status 只能是：' + QSTATUS.join(' / '));
    item.status = args.status;
  }
  if (args.note !== undefined) item.note = args.note;
  if (args.file !== undefined) item.file = args.file;
  item.updatedAt = new Date().toISOString();
  await writeQuestions(root, db, state);
  return { ok: true, item };
}

/** 书本 PDF 与「PDF 页 = 书页 + offset」的对应关系；题目清单靠它换算页码。 */
async function actionBookSet(args, exec) {
  const root = await rootOf(args, exec);
  await needState(root);
  const patch = {};
  if (args.path) {
    const file = abs(args.path, root);
    if (!exists(file)) throw new Error('文件不存在：' + file);
    patch.bookPdf = file;
  }
  if (args.offset != null) patch.bookOffset = Number(args.offset);
  const state = await writeState(root, patch);
  const db = await readJson(questionsPath(root), { seq: 0, items: [] });
  if (db.items.length) await writeQuestions(root, db, state);
  return { ok: true, bookPdf: state.bookPdf || null, bookOffset: state.bookOffset ?? null };
}

// ---------------------------------------------------------------- 并发推进（v2）
// 单个会话里是队列；要并行就得有两个以上执行者同时推进不同小节。
// 这里只提供「谁在做这一节」的事实与锁：claim 拿租约、release 还回去、parallel.plan 列出可领的活。

const LEASE_DEFAULT = 3600;

function leaseAlive(item, now = Date.now()) {
  return Boolean(item.lease && item.lease.until > now);
}

async function actionDraftClaim(args, exec) {
  const root = await rootOf(args, exec);
  await needState(root);
  const { outDir } = dirs(await readState(root), root);
  const db = await readJson(draftsPath(outDir), { seq: 0, items: {} });
  const item = await findDraft(db, String(args.id || ''));
  const owner = String(args.owner || 'main');
  const now = Date.now();
  if (leaseAlive(item) && item.lease.owner !== owner && !args.force) {
    throw new Error('这一节正被 ' + item.lease.owner + ' 占着（到 ' + new Date(item.lease.until).toISOString() + '）；要抢加 force:true');
  }
  const ttl = Number(args.ttlSec || LEASE_DEFAULT);
  item.lease = { owner, until: now + ttl * 1000 };
  if (item.status === 'todo') item.status = 'drafting';
  item.updatedAt = new Date().toISOString();
  item.history.push({ at: new Date().toISOString(), action: 'claim', owner, ttlSec: ttl });
  await writeJson(draftsPath(outDir), db);
  return { ok: true, id: item.id, owner, status: item.status, lease: item.lease };
}

async function actionDraftRelease(args, exec) {
  const root = await rootOf(args, exec);
  await needState(root);
  const { outDir } = dirs(await readState(root), root);
  const db = await readJson(draftsPath(outDir), { seq: 0, items: {} });
  const item = await findDraft(db, String(args.id || ''));
  const owner = args.owner ? String(args.owner) : null;
  if (item.lease && owner && item.lease.owner !== owner) throw new Error('租约不在 ' + owner + ' 手上（现在是 ' + item.lease.owner + '）');
  item.lease = null;
  item.updatedAt = new Date().toISOString();
  item.history.push({ at: new Date().toISOString(), action: 'release', owner });
  await writeJson(draftsPath(outDir), db);
  return { ok: true, id: item.id, released: true };
}

const SECTION_BRIEF = '读对应书页（books/ 或按 bookOffset 换算页码），按「定义 → 公式 → 每一项是什么 → 为什么长这样 → 考场怎么用」写，写完 draft.update 挂文件、review 后 approve。';

async function actionParallelPlan(args, exec) {
  const root = await rootOf(args, exec);
  const state = await needState(root);
  const { outDir } = dirs(state, root);
  const plan = await readJson(planPath(outDir), { sections: [] });
  const db = await readJson(draftsPath(outDir), { seq: 0, items: {} });
  const byTitle = new Map(Object.values(db.items).map((i) => [i.title, i]));
  const now = Date.now();
  const units = [];
  plan.sections.forEach((s) => {
    if (s.status === 'done') return;
    const draft = byTitle.get(s.title) || null;
    const held = draft && leaseAlive(draft, now);
    units.push({
      section: s.title, order: s.order, book: s.book || '', verdict: s.verdict || '',
      draftId: draft?.id || null, draftStatus: draft?.status || null,
      claimable: !held, heldBy: held ? draft.lease.owner : null,
      leaseUntil: held ? new Date(draft.lease.until).toISOString() : null,
      brief: '先 draft.claim 领到这一节，再' + SECTION_BRIEF,
    });
  });
  return {
    subject: state.subject, total: units.length,
    claimable: units.filter((u) => u.claimable).length,
    units,
    note: '每个执行者先 draft.claim {id, owner} 拿租约，做完 draft.update + draft.release；plan 里没建草稿的先 draft.new。',
  };
}

// ---------------------------------------------------------------- 一次收资料（v2）
// 用户把一整个文件夹丢过来（书 + 题目 + 截图 + PPT），bootstrap 按扩展名和文件名归位并登记。

function classifyAsset(name, size) {
  const ext = extname(name).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) return 'shots';
  if (['.pptx', '.ppt'].includes(ext)) return 'ppt';
  if (['.pdf', '.docx', '.doc', '.md', '.txt'].includes(ext)) {
    const bookish = /教材|课本|全书|原理\.pdf$/i.test(name) || (ext === '.pdf' && size > 30 * 1024 * 1024);
    if (ext === '.pdf' && bookish) return 'books';
    return 'questions';
  }
  return 'other';
}

async function actionSubjectBootstrap(args, exec) {
  const base = args.dir ? abs(args.dir, sessionRoot(exec)) : sessionRoot(exec);
  const name = String(args.name || args.subject || '').trim();
  if (!name) throw new Error('要传 name（科目名）');
  const src = args.sourceDir ? abs(args.sourceDir, sessionRoot(exec)) : null;
  if (!src || !exists(src)) throw new Error('要传 sourceDir（资料所在文件夹）');
  const created = await actionSubjectCreate({ dir: base, name, exam: args.exam, chapters: args.chapters, force: args.force }, exec);
  const dir = created.dir;
  const copied = { books: [], questions: [], ppt: [], shots: [], other: [] };
  const walk = async (d, depth = 0) => {
    if (depth > 3) return;
    let entries = [];
    try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) { await walk(full, depth + 1); continue; }
      let size = 0;
      try { size = (await stat(full)).size; } catch { }
      const kind = classifyAsset(e.name, size);
      if (kind === 'other') { copied.other.push(full); continue; }
      const dest = join(dir, kind, e.name);
      if (exists(dest) && !args.overwrite) { copied[kind].push(dest + ' (已存在，跳过)'); continue; }
      await copyFile(full, dest);
      copied[kind].push(dest);
    }
  };
  await walk(src);
  const scan = [];
  for (const f of copied.books) {
    if (!f.endsWith('.pdf') || f.includes('(已存在')) continue;
    try { scan.push(await actionScanPdf({ subject: name, dir: base, path: f }, exec, {})); }
    catch (e) { scan.push({ file: f, error: String(e.message) }); }
  }
  return {
    ok: true, name, dir, exam: args.exam || null,
    copied: Object.fromEntries(Object.entries(copied).map(([k, v]) => [k, v.length])),
    files: copied, scan,
    next: '资料归位了：scan.pdf 看书有没有文字层；questions.parse 拆文本作业；hint.add 记老师口头提示。',
  };
}

// ---------------------------------------------------------------- 总览（v2）
async function actionSprintStatus(args, exec) {
  const root = await rootOf(args, exec);
  const state = await needState(root);
  const { outDir } = dirs(state, root);
  const plan = await readJson(planPath(outDir), { sections: [] });
  const db = await readJson(draftsPath(outDir), { seq: 0, items: {} });
  const qs = await readJson(questionsPath(root), { seq: 0, items: [] });
  const hints = await readJson(hintsPath(root), { seq: 0, items: [] });
  const count = (arr, k) => arr.reduce((m, x) => ({ ...m, [x[k]]: (m[x[k]] || 0) + 1 }), {});
  const drafts = Object.values(db.items);
  return {
    subject: state.subject, dir: root, exam: state.exam || null, bookOffset: state.bookOffset ?? null,
    plan: { total: plan.sections.length, byStatus: count(plan.sections, 'status'), next: plan.sections.find((s) => s.status !== 'done') || null },
    drafts: { total: drafts.length, byStatus: count(drafts, 'status'), claimed: drafts.filter((d) => leaseAlive(d)).map((d) => ({ id: d.id, owner: d.lease.owner, title: d.title })) },
    questions: { total: qs.items.length, byStatus: count(qs.items, 'status') },
    hints: { total: hints.items.length, latest: hints.items.slice(-3).map((h) => h.text) },
    deliverables: { out: outDir },
  };
}

// ---------------------------------------------------------------- 整页读取（v0.4）

/**
 * 要读哪本书：显式传 pdf/path 优先，否则用 book.set 记下的那份。
 * 单独抽出来，是因为 page.* 三个动作都要用同一条判定。
 */
function bookPdfOf(args, state, root) {
  const raw = args.pdf || args.path || state.bookPdf;
  if (!raw) throw new Error('还没有指定要读的书：先 book.set {path}，这次也可以直接传 pdf');
  const file = abs(raw, root);
  if (!exists(file)) throw new Error('PDF 不存在：' + file);
  return file;
}

/** 缓存在 _work/ocr/pNNN.txt，一页一个文件；读不到就现场 OCR 一页。 */
async function actionPageRead(args, exec, config) {
  const root = await rootOf(args, exec);
  const state = await needState(root);
  const { outDir } = dirs(state, root);
  const pdf = bookPdfOf(args, state, root);
  const page = Number(args.page);
  if (!Number.isInteger(page) || page < 1) throw new Error('要传 page（PDF 页码，从 1 开始）');
  const argv = [pdf, join(outDir, 'ocr'), '--page', String(page)];
  if (args.formulas) argv.push('--formulas');
  const value = await pyJson(config || state, 'page_ocr.py', argv);
  const bookPage = state.bookOffset != null ? page - state.bookOffset : null;
  return {
    ok: true, page, bookPage, source: value.source, count: value.count, lines: value.lines,
    hint: value.source === 'cache' ? '这页读过，走缓存' : '第一次读这页，已跑一遍 OCR 并写缓存',
  };
}

/**
 * 全文检索：直接扫 _work/ocr 下的文本，不建索引库。
 * 439 页才 2MB，扫一遍几十毫秒，省掉「索引和正文不同步」这类问题。
 * 打分：整串命中权重最高，再按二元组（中文没有空格，bigram 最省事）累加。
 */
async function actionPageSearch(args, exec) {
  const root = await rootOf(args, exec);
  const state = await needState(root);
  const { outDir } = dirs(state, root);
  const q = String(args.query || '').trim();
  if (!q) throw new Error('要传 query（要找的字词）');
  const cache = join(outDir, 'ocr');
  if (!exists(cache)) throw new Error('还没有 OCR 缓存：先 page.ocr {} 把整本跑一遍');
  const limit = Math.max(1, Math.min(50, Number(args.limit) || 8));
  const grams = [];
  for (let i = 0; i < q.length - 1; i += 1) grams.push(q.slice(i, i + 2));
  const files = (await readdir(cache)).filter((n) => /^p\d+\.txt$/.test(n));
  const ql = q.toLowerCase();
  const hits = [];
  for (const name of files) {
    const text = await readFile(join(cache, name), 'utf8');
    const low = text.toLowerCase();
    let score = 0;
    const whole = low.split(ql).length - 1;
    if (whole) score += 100 + whole * 5;
    for (const g of grams) {
      const c = low.split(g).length - 1;
      if (c) score += Math.min(c, 10);
    }
    if (!score) continue;
    const at = low.indexOf(ql) >= 0 ? low.indexOf(ql) : Math.max(0, low.indexOf(grams[0]));
    const from = Math.max(0, at - 40);
    const snippet = text.slice(from, from + 110).replace(/\n/g, ' ');
    hits.push({ page: Number(name.slice(1, -4)), score, snippet });
  }
  hits.sort((a, b) => b.score - a.score);
  const offset = state.bookOffset ?? null;
  return {
    ok: true,
    query: q,
    total: hits.length,
    limit,
    hits: hits.slice(0, limit).map((h) => ({
      ...h,
      bookPage: offset != null ? h.page - offset : null,
    })),
  };
}
/** 全书跑一遍 OCR，每页一个 pNNN.txt；跑完给索引。慢（约 6.5s/页），适合丢给子 agent。 */
async function actionPageOcr(args, exec, config) {
  const root = await rootOf(args, exec);
  const state = await needState(root);
  const { outDir } = dirs(state, root);
  const pdf = bookPdfOf(args, state, root);
  const cache = join(outDir, 'ocr');
  const argv = [pdf, cache, '--all'];
  if (args.from) argv.push('--from', String(args.from));
  if (args.to) argv.push('--to', String(args.to));
  if (args.dpi) argv.push('--dpi', String(args.dpi));
  const value = await pyJson(config || state, 'page_ocr.py', argv);
  return { ok: true, dir: cache, ...value };
}

// ---------------------------------------------------------------- dispatch

/** 执行一个动作；execute 里已保证 args 是对象。 */
export async function runSprint(action, args, exec, config = {}) {
  switch (action) {
    case 'help': return actionHelp();
    case 'subject.create': return actionSubjectCreate(args, exec);
    case 'subject.list': return actionSubjectList(args, exec);
    case 'subject.remove': return actionSubjectRemove(args, exec);
    case 'subject.bootstrap': return actionSubjectBootstrap(args, exec);
    case 'sprint.status': return actionSprintStatus(args, exec);
    case 'book.set': return actionBookSet(args, exec);
    case 'project.init': return actionInit(args, exec);
    case 'project.status': return actionStatus(args, exec);
    case 'config.get': return actionConfigGet(args, exec);
    case 'config.set': return actionConfigSet(args, exec);
    case 'scan.pdf': return actionScanPdf(args, exec, config);
    case 'scan.ppt': return actionScanPpt(args, exec, config);
    case 'scan.shots': return actionScanShots(args, exec);
    case 'page.ocr': return actionPageOcr(args, exec, config);
    case 'page.read': return actionPageRead(args, exec, config);
    case 'page.search': return actionPageSearch(args, exec);
    case 'split.pdf': return actionSplitPdf(args, exec, config);
    case 'plan.coverage': return actionPlanCoverage(args, exec);
    case 'plan.next': return actionPlanNext(args, exec);
    case 'draft.new': return actionDraftNew(args, exec);
    case 'draft.list': return actionDraftList(args, exec);
    case 'draft.update': return actionDraftUpdate(args, exec);
    case 'draft.patch': return actionDraftPatch(args, exec);
    case 'draft.claim': return actionDraftClaim(args, exec);
    case 'draft.release': return actionDraftRelease(args, exec);
    case 'parallel.plan': return actionParallelPlan(args, exec);
    case 'questions.parse': return actionQuestionsParse(args, exec);
    case 'questions.import': return actionQuestionsImport(args, exec);
    case 'questions.list': return actionQuestionsList(args, exec);
    case 'questions.update': return actionQuestionsUpdate(args, exec);
    case 'hint.add': return actionHintAdd(args, exec);
    case 'hint.list': return actionHintList(args, exec);
    case 'hint.remove': return actionHintRemove(args, exec);
    case 'render.tex': return actionRenderTex(args, exec);
    case 'render.preview': return actionRenderPreview(args, exec, config);
    case 'check.accept': return actionCheckAccept(args, exec);
    case 'template.install': return actionTemplateInstall(args, exec);
    default: throw new Error('未知动作：' + action + '（可用：' + ACTIONS.join(', ') + '）');
  }
}

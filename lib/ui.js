/**
 * dsh-sprint 界面层（宿主端）。
 *
 * 只做三件事：
 *   1. GET  /dsh-sprint/ui      —— 自带一个自包含网页（无构建、无外链、深色配色）
 *   2. GET  /dsh-sprint/data    —— 概览 JSON：project.status + sprint.status + 最近产物
 *   3. POST /dsh-sprint/action  —— 安全动作白名单（建目录、抽资料、编译、自检）
 *
 * 为什么单独成文件：界面是可选能力。无头部署里没有 webServer，`ctx.inject(['webServer'])`
 * 的回调压根不会被调用，插件照常提供工具与命令，不会因为「没有界面」而加载失败。
 *
 * 为什么网页不放进对话里：StudyHub 那套信息架构（科目卡 / 进度 / 交付件）塞进 380px 的抽屉
 * 会挤成一团，所以对话里只放一个入口，真正的页面用 system browser 打开。
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { runSprint } from './sprint.js';

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ROUTE = '/dsh-sprint';
const PAGE_FILE = join(PKG_ROOT, 'lib', 'ui', 'page.html');
const STATE_FILE = join(homedir(), '.dsh-sprint', 'ui.json');

/** 允许网页直接触发的动作：都是「可重跑、失败无害」的管道动作。写内容的动作留给模型。 */
const SAFE = new Set([
  'project.init',
  'scan.pdf', 'scan.ppt', 'scan.shots',
  'render.tex', 'render.preview',
  'check.accept',
]);

let lastDir = null;
try {
  const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  if (typeof raw?.dir === 'string' && raw.dir) lastDir = raw.dir;
} catch { /* 第一次跑，没有记录 */ }

/** 记住最近一次项目目录：对话里跑过 sprint 后，网页与挂件都能直接接着用。 */
export function noteDir(dir) {
  if (typeof dir !== 'string' || !dir.trim()) return;
  const next = resolve(dir.trim());
  if (next === lastDir) return;
  lastDir = next;
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify({ dir: next, at: Date.now() }) + '\n', 'utf8');
  } catch { /* 记不住就只是下次要手填，不影响功能 */ }
}

export function getDir() { return lastDir; }

function safeEntries(dir) {
  try { return readdirSync(dir, { withFileTypes: true }); }
  catch { return []; }
}

/** 交付目录里最近动过的文件（含子目录一层），给「最近产物」用。 */
function recentFiles(dir, limit = 12) {
  const out = [];
  for (const e of safeEntries(dir)) {
    const full = join(dir, e.name);
    try {
      if (e.isFile() && !/^\./.test(e.name)) {
        const st = statSync(full);
        out.push({ name: e.name, path: full, size: st.size, mtime: st.mtimeMs });
      } else if (e.isDirectory() && !/^_/.test(e.name)) {
        for (const c of safeEntries(full)) {
          if (!c.isFile() || /^\./.test(c.name)) continue;
          const st = statSync(join(full, c.name));
          out.push({ name: e.name + '/' + c.name, path: join(full, c.name), size: st.size, mtime: st.mtimeMs });
        }
      }
    } catch { /* 单个文件读不到就跳过 */ }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, limit);
}

/**
 * 汇总一屏要用的数据。单次请求就要拿到全部：网页不做多次往返，
 * 也不会出现「卡片更新了、列表还是旧的」这种半新半旧的状态。
 */
export async function collect(dir, config = {}) {
  const root = dir ? resolve(dir) : lastDir;
  if (!root) {
    return { ok: false, error: '还不知道项目目录。在对话里跑一次 sprint，或者在页面顶部填路径。', lastDir: null };
  }
  if (!existsSync(root)) return { ok: false, dir: root, error: '目录不存在：' + root, lastDir };

  let project = { initialized: false, root };
  try {
    project = await runSprint('project.status', { dir: root }, {}, config);
  } catch (e) {
    return { ok: false, dir: root, error: 'project.status 失败：' + e.message, lastDir };
  }
  const payload = {
    ok: true,
    dir: root,
    lastDir,
    initialized: Boolean(project.initialized),
    subject: project.subject || null,
    exam: project.exam || null,
    outDir: project.outDir || null,
    deliverDir: project.deliverDir || null,
    tasks: project.tasks ? Object.keys(project.tasks).length : 0,
    projectFiles: (project.files || []).slice(0, 20),
    recent: recentFiles(project.deliverDir || root),
  };
  if (!project.initialized) {
    payload.hint = '这个目录还没初始化：点「初始化」建 _work，或者换一个已经跑过 sprint 的目录。';
    return payload;
  }
  try {
    const status = await runSprint('sprint.status', { dir: root }, {}, config);
    payload.subject = status.subject || payload.subject;
    payload.exam = status.exam || payload.exam;
    payload.bookOffset = status.bookOffset ?? null;
    payload.plan = status.plan;
    payload.drafts = status.drafts;
    payload.questions = status.questions;
    payload.hints = status.hints;
    payload.deliverables = status.deliverables;
  } catch (e) {
    payload.statusError = 'sprint.status 失败：' + e.message;
  }
  return payload;
}

export async function act(action, args, dir, config = {}) {
  if (!SAFE.has(action)) return { ok: false, error: '这个动作不给网页直接跑：' + action };
  const root = dir ? resolve(dir) : lastDir;
  if (!root) return { ok: false, error: '还没有项目目录' };
  if (!existsSync(root)) return { ok: false, error: '目录不存在：' + root };
  const started = Date.now();
  try {
    const value = await runSprint(action, { ...(args || {}), dir: root }, {}, config);
    noteDir(root);
    return { ok: true, action, dir: root, ms: Date.now() - started, value };
  } catch (e) {
    return { ok: false, action, dir: root, ms: Date.now() - started, error: e.message };
  }
}

function sendJson(res, code, value) {
  const body = JSON.stringify(value);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function sendText(res, code, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(text);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((res, rej) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { rej(new Error('请求体太大')); req.destroy?.(); return; }
      chunks.push(c);
    });
    req.on('end', () => res(Buffer.concat(chunks).toString('utf8')));
    req.on('error', rej);
  });
}

/** 只认本机回环请求：页面不需要对外暴露，也不该被同网的别人当管理接口用。 */
function isLoopback(req) {
  const a = req?.socket?.remoteAddress || '';
  return a === '' || a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

export function registerUi(ctx, config = {}) {
  let pageHtml = null;
  const page = () => {
    if (pageHtml === null) {
      try { pageHtml = readFileSync(PAGE_FILE, 'utf8'); }
      catch (e) { pageHtml = '<!doctype html><meta charset="utf-8"><p>页面文件缺失：' + PAGE_FILE + '</p><pre>' + String(e) + '</pre>'; }
    }
    return pageHtml;
  };

  ctx.inject(['webServer'], (scoped) => {
    const server = scoped.webServer;
    const route = (path, handler) => scoped.effect(
      () => server.register({ kind: 'exact', path: ROUTE + path, handler }),
      'sprint ui: ' + path,
    );

    route('/ui', async (req, res) => {
      if (!isLoopback(req)) return sendText(res, 403, 'forbidden');
      sendText(res, 200, page(), 'text/html; charset=utf-8');
    });

    route('/data', async (req, res) => {
      if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: 'forbidden' });
      try {
        const url = new URL(req.url || '/', 'http://localhost');
        const dir = url.searchParams.get('dir') || '';
        sendJson(res, 200, await collect(dir, config));
      } catch (e) {
        sendJson(res, 500, { ok: false, error: String(e) });
      }
    });

    route('/action', async (req, res) => {
      if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: 'forbidden' });
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只收 POST' });
      try {
        const body = JSON.parse((await readBody(req)) || '{}');
        sendJson(res, 200, await act(body.action, body.args, body.dir, config));
      } catch (e) {
        sendJson(res, 400, { ok: false, error: '请求解析失败：' + e.message });
      }
    });

    ctx?.logger?.info?.('sprint: ui at ' + ROUTE + '/ui');
  });
}

export { ROUTE };

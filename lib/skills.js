/** 把仓库里的 skills/ 注册进宿主的技能目录（宿主没有 registry 就跳过）。 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SHIPPED = ['exam-sprint'];
const dirOf = (name) => fileURLToPath(new URL('../skills/' + name + '/', import.meta.url));

/** 解析 frontmatter：--- 之间的单行 key: value，后面是正文。 */
export function parseSkill(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(String(text ?? ''));
  if (!m) throw new Error('SKILL.md 缺少 frontmatter');
  const data = Object.fromEntries(m[1].split(/\r?\n/).map((line) => /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)).filter(Boolean)
    .map(([, k, v]) => [k, v.trim().replace(/^(["'])(.*)\1$/, '$2')]));
  if (!data.name || !data.description) throw new Error('SKILL.md 需要 name 与 description');
  return { name: data.name, description: data.description, content: m[2].trim() };
}

export function shippedSkills() {
  return SHIPPED.map((name) => {
    const dir = dirOf(name), path = dir + 'SKILL.md';
    const skill = parseSkill(readFileSync(path, 'utf8'));
    return { ...skill, source: 'bundled', path, resourceBase: { kind: 'directory', path: dir }, invocation: { modelInvocable: true, userInvocable: true } };
  });
}

export function registerSkills(ctx) {
  if (typeof ctx?.skills?.register !== 'function') return [];
  try { return shippedSkills().map((s) => ctx.skills.register(s)); }
  catch (e) { ctx.logger?.warn?.('dsh-sprint skills 未注册：' + e.message); return []; }
}

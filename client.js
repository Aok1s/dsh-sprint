/**
 * dsh-sprint — 浏览器端：输入框左边的「速成」挂件 + 小抽屉。
 *
 * 为什么这么薄：真正的界面在 /dsh-sprint/ui（独立网页，信息架构随便摊开）。
 * 对话里的挂件只解决一件事——不用离开聊天就能扫一眼进度、跳过去开整页。
 *
 * 数据全部来自宿主 /dsh-sprint/data，抽屉自己不留副本，所以同一份数据
 * 在对话、网页两边永远一致。
 */
window.__ModuleLoader__.load({
  id: 'dsh-sprint',
  factory(require) {
    const reactModule = require('react');
    const React = reactModule !== null && typeof reactModule === 'object' && typeof reactModule.createElement === 'function'
      ? reactModule
      : reactModule?.default;
    const h = React.createElement;

    const CSS_ID = 'dsh-sprint-ui-style';
    const BASE = '/dsh-sprint';
    const LABEL = '速成';

    const CSS = [
      '.dsh-sprint-chip { box-sizing: border-box; display: inline-flex; align-items: center; gap: 5px; height: 24px; max-width: 160px; padding: 0 8px; border: 1px solid transparent; border-radius: var(--dsw-radius-md, 6px); background: transparent; color: var(--dsw-alias-label-secondary); font-family: var(--dsw-font-family); font-size: var(--dsw-font-xs-13, 13px); line-height: 1; white-space: nowrap; cursor: pointer; }',
      '.dsh-sprint-chip:hover { background: var(--dsw-alias-bg-secondary, rgba(127,127,127,.12)); color: var(--dsw-alias-label-primary); }',
      '.dsh-sprint-chip[data-open="1"] { color: var(--dsw-alias-brand-primary, #4f8cff); background: var(--dsw-alias-bg-secondary, rgba(79,140,255,.14)); }',
      '.dsh-sprint-chip .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; opacity: .85; }',
      '.dsh-sprint-panel { position: fixed; right: 18px; bottom: 96px; z-index: 60; width: 340px; max-height: min(70vh, 520px); overflow: auto; box-sizing: border-box; padding: 14px 14px 12px; border: 1px solid var(--dsw-alias-line, #2c313a); border-radius: 12px; background: var(--dsw-alias-bg-elevated, #1b1e24); color: var(--dsw-alias-label-primary, #e6e8ec); font-family: var(--dsw-font-family); font-size: 13px; line-height: 1.6; box-shadow: 0 12px 32px rgba(0,0,0,.35); }',
      '.dsh-sprint-panel h4 { margin: 0 0 8px; font-size: 14px; font-weight: 600; display: flex; align-items: center; gap: 8px; }',
      '.dsh-sprint-panel .sub { color: var(--dsw-alias-label-secondary, #8b93a1); font-size: 12px; }',
      '.dsh-sprint-panel .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 10px 0; }',
      '.dsh-sprint-panel .box { border: 1px solid var(--dsw-alias-line, #2c313a); border-radius: 8px; padding: 6px 9px; }',
      '.dsh-sprint-panel .box .k { color: var(--dsw-alias-label-secondary, #8b93a1); font-size: 11px; }',
      '.dsh-sprint-panel .box .v { font-size: 16px; font-weight: 600; }',
      '.dsh-sprint-panel .box .v small { font-size: 11px; font-weight: 400; opacity: .7; }',
      '.dsh-sprint-panel .file { color: var(--dsw-alias-label-secondary, #8b93a1); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.dsh-sprint-panel .row { display: flex; gap: 8px; margin-top: 12px; }',
      '.dsh-sprint-panel button { flex: 1; font-family: inherit; font-size: 12px; padding: 6px 8px; border-radius: 7px; border: 1px solid var(--dsw-alias-line, #2c313a); background: transparent; color: inherit; cursor: pointer; }',
      '.dsh-sprint-panel button:hover { border-color: var(--dsw-alias-brand-primary, #4f8cff); }',
      '.dsh-sprint-panel button.primary { background: var(--dsw-alias-brand-primary, #4f8cff); border-color: transparent; color: #fff; }',
      '.dsh-sprint-panel .warn { color: var(--dsw-alias-status-warn, #d29922); font-size: 12px; }',
    ].join('\n');

    function ensureStyle() {
      if (typeof document === 'undefined') return;
      if (document.getElementById(CSS_ID) !== null) return;
      const style = document.createElement('style');
      style.id = CSS_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    function getJson(path) {
      return fetch(BASE + path, { headers: { accept: 'application/json' } }).then(function (r) { return r.json(); });
    }

    function Chip() {
      const [open, setOpen] = React.useState(false);
      return h(React.Fragment, null,
        h('button', {
          type: 'button',
          className: 'dsh-sprint-chip',
          'data-open': open ? '1' : '0',
          title: '速成工作台：计划、草稿、题目与交付件',
          onClick: function () { setOpen(function (v) { return !v; }); },
        }, h('span', { className: 'dot' }), LABEL),
        open ? h(Panel, { onClose: function () { setOpen(false); } }) : null,
      );
    }

    function Panel(props) {
      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState(false);

      const load = React.useCallback(function () {
        setBusy(true);
        getJson('/data').then(function (d) {
          setData(d);
          setError(d && d.ok ? null : (d && d.error) || '读取失败');
        }).catch(function (e) { setError(String(e)); })
          .then(function () { setBusy(false); });
      }, []);

      React.useEffect(function () { load(); }, [load]);

      const plan = (data && data.plan) || { total: 0, byStatus: {} };
      const done = (plan.byStatus && plan.byStatus.done) || 0;
      const drafts = (data && data.drafts) || { total: 0 };
      const qs = (data && data.questions) || { total: 0 };
      const hints = (data && data.hints) || { total: 0 };
      const next = plan.next;
      const recent = (data && data.recent) || [];

      return h('div', { className: 'dsh-sprint-panel' },
        h('h4', null,
          data && data.subject ? data.subject : '速成工作台',
          h('span', { className: 'sub' }, busy ? '读取中…' : (data && data.exam ? ('考试 ' + data.exam) : '')),
        ),
        error ? h('div', { className: 'warn' }, error) : null,
        data && data.ok ? h('div', null,
          h('div', { className: 'sub' }, data.initialized ? '已初始化 · ' + (data.dir || '') : '未初始化 · ' + (data.dir || '')),
          h('div', { className: 'grid' },
            box('计划', done + '/' + plan.total),
            box('草稿', drafts.total + ' 份'),
            box('题目', qs.total + ' 道'),
            box('提示', hints.total + ' 条'),
          ),
          h('div', { className: 'sub' }, '待办'),
          h('div', null, next ? (next.title || next.id || '下一节') : h('span', { className: 'sub' }, plan.total ? '计划都做完了' : '还没有计划')),
          recent.length ? h('div', { style: { marginTop: '10px' } },
            h('div', { className: 'sub' }, '最近产物'),
            recent.slice(0, 4).map(function (f) {
              return h('div', { className: 'file', key: f.path, title: f.path }, '· ' + f.name);
            }),
          ) : null,
        ) : null,
        h('div', { className: 'row' },
          h('button', { type: 'button', onClick: load, disabled: busy }, '刷新'),
          h('button', {
            type: 'button',
            className: 'primary',
            onClick: function () {
              const url = BASE + '/ui' + (data && data.dir ? '?dir=' + encodeURIComponent(data.dir) : '');
              window.open(url, '_blank', 'noopener');
            },
          }, '打开完整页面'),
        ),
      );
    }

    function box(k, v) {
      return h('div', { className: 'box' },
        h('div', { className: 'k' }, k),
        h('div', { className: 'v' }, v));
    }

    /** @param ctx - the browser-side Cordis context. */
    function apply(ctx) {
      try {
        ensureStyle();
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register(
          { name: 'conversation.input.left', id: 'sprint-chip', order: 42, label: LABEL },
          Chip,
        ));
        console.info('[sprint] composer chip registered');
      } catch (error) {
        console.error('[sprint] apply failed:', error);
      }
    }

    return { apply, inject: ['slots'] };
  },
});

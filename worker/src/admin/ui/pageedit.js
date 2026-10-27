// worker/src/admin/ui/pageedit.js
// Edit page script and styles, served as /admin/pageedit.js and /admin/pageedit.css into the
// live page that /admin/page?p= shows (admin/pageedit.js). Plain browser JavaScript.
// Blocks whose text matches exactly one editable block of the page's .njk file (and appear
// once on the page) get a dashed outline and become editable; other text blocks are greyed
// ("Ask Kryten"). Enter does nothing, paste is plain text, the bar's Link button adds,
// changes or removes a link. Save shows each change (before / after), then sends the
// changed blocks, re-serialised as text plus simple inline tags, to /admin/api/page-save.

export const PAGEEDIT_VERSION = '2';

function editor() {
  const data = JSON.parse(document.getElementById('lenches-edit-data').textContent);
  const root = document.querySelector('[data-src]') || document.body;
  const TAGS = 'p,h1,h2,h3,h4,h5,h6,li,td,th,dt,dd,figcaption';
  const norm = (s) => String(s).replace(/[\s ]+/g, ' ').trim();
  const ALLOWED = {
    a: ['href', 'class', 'title', 'rel', 'target', 'aria-label'], strong: ['class'], em: ['class'], b: [], i: [], br: [],
    span: ['class', 'title', 'lang'], abbr: ['title', 'class'], small: ['class'], sup: [], sub: [], code: [], time: ['datetime', 'class'],
  };
  const escText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/ /g, '&nbsp;');
  const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

  // Text plus allowed inline tags (and their allowed attributes); anything else keeps its text only.
  function ser(node) {
    let out = '';
    node.childNodes.forEach((n) => {
      if (n.nodeType === 3) { out += escText(n.data); return; }
      if (n.nodeType !== 1) return;
      const t = n.tagName.toLowerCase();
      if (!(t in ALLOWED)) { out += ser(n); return; }
      if (t === 'br') { out += '<br>'; return; }
      const inner = ser(n);
      if (!inner || (t === 'a' && !n.getAttribute('href'))) { out += inner; return; }
      const attrs = ALLOWED[t].filter((a) => n.hasAttribute(a)).map((a) => ` ${a}="${escAttr(n.getAttribute(a))}"`).join('');
      out += `<${t}${attrs}>${inner}</${t}>`;
    });
    return out;
  }
  const serBlock = (el) => ser(el).replace(/(<br>\s*)+$/, '');

  const bySource = new Map();
  data.blocks.forEach((b) => {
    const k = `${b.tag}\n${b.text}`;
    bySource.set(k, (bySource.get(k) || []).concat([b]));
  });
  const leaves = [...root.querySelectorAll(TAGS)].filter((el) => !el.querySelector(`${TAGS},ul,ol,div,table,form`) && !el.closest('form'));
  const keyOf = (el) => `${el.tagName.toLowerCase()}\n${norm(el.textContent)}`;
  const onPage = new Map();
  leaves.forEach((el) => onPage.set(keyOf(el), (onPage.get(keyOf(el)) || 0) + 1));

  const edits = [];
  leaves.forEach((el) => {
    if (!norm(el.textContent)) return;
    const k = keyOf(el);
    const s = bySource.get(k);
    if (s && s.length === 1 && onPage.get(k) === 1) {
      el.contentEditable = 'true';
      el.spellcheck = true;
      el.classList.add('le-edit');
      edits.push({ el, block: s[0], orig: serBlock(el) });
    } else {
      el.classList.add('le-fixed');
      el.title = 'This text comes from a data file or the page template: ask Kryten to change it';
    }
  });

  /* ---- bar ---- */
  const h = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const bar = h('div', 'le-bar');
  bar.setAttribute('role', 'toolbar');
  const title = h('span', 'le-title', `✎ Editing: ${norm(document.title).replace(/\s*[|–—-]\s*The Lenches.*$/i, '')}`);
  const count = h('span', 'le-count', '');
  const msg = h('span', 'le-msg', '');
  msg.setAttribute('role', 'status');
  const linkBtn = h('button', 'le-btn', '🔗 Link');
  const cancelBtn = h('button', 'le-btn', 'Cancel');
  const saveBtn = h('button', 'le-btn le-primary', 'Save');
  [linkBtn, cancelBtn, saveBtn].forEach((b) => { b.type = 'button'; });
  linkBtn.disabled = true;
  saveBtn.disabled = true;
  bar.append(title, count, msg, linkBtn, cancelBtn, saveBtn);
  document.body.prepend(bar);
  document.body.classList.add('le-on');
  if (!edits.length) msg.textContent = 'Nothing on this page can be edited here: ask Kryten.';

  let saved = false;
  const changed = () => edits.filter((e) => serBlock(e.el) !== e.orig);
  function refresh() {
    const n = changed().length;
    edits.forEach((e) => e.el.classList.toggle('le-changed', serBlock(e.el) !== e.orig));
    count.textContent = n ? `${n} change${n === 1 ? '' : 's'}` : '';
    saveBtn.disabled = !n || saved;
  }

  /* ---- editing behaviour ---- */
  document.addEventListener('click', (e) => {
    if (e.target.closest('.le-bar, .le-dlg')) return;
    if (e.target.closest('a, button, summary, label')) e.preventDefault();
  }, true);
  document.addEventListener('submit', (e) => e.preventDefault(), true);
  edits.forEach(({ el }) => {
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
    el.addEventListener('paste', (e) => {
      e.preventDefault();
      const text = norm((e.clipboardData || window.clipboardData).getData('text/plain') || '');
      document.execCommand('insertText', false, text);
    });
    el.addEventListener('drop', (e) => e.preventDefault());
    el.addEventListener('input', refresh);
  });

  const editAt = (node) => {
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    const host = el && el.closest('.le-edit');
    return host && !saved ? host : null;
  };
  let range = null;
  document.addEventListener('selectionchange', () => {
    const sel = document.getSelection();
    if (sel && sel.rangeCount && editAt(sel.anchorNode)) {
      range = sel.getRangeAt(0).cloneRange();
      linkBtn.disabled = false;
    } else if (!(document.activeElement && document.activeElement === linkBtn)) {
      linkBtn.disabled = true;
    }
  });
  linkBtn.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection
  linkBtn.addEventListener('click', () => {
    if (!range || !editAt(range.startContainer)) return;
    const node = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    const a = node.closest('a');
    const current = a ? a.getAttribute('href') : '';
    if (!a && range.collapsed) { msg.textContent = 'Select the words to link first.'; return; }
    const url = window.prompt('Link address (https://…, mailto:…, tel:… or /page/). Leave empty to remove the link.', current || 'https://');
    if (url === null) return;
    const u = url.trim();
    const sel = document.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    if (!u || u === 'https://') {
      if (a) a.replaceWith(...a.childNodes);
    } else if (!/^(https?:\/\/\S+|mailto:\S+|tel:[+\d\s]+|\/\S*|#\S*)$/i.test(u)) {
      msg.textContent = 'Links must start https://, mailto:, tel: or /';
      return;
    } else if (a) {
      a.setAttribute('href', u);
    } else {
      document.execCommand('createLink', false, u);
    }
    msg.textContent = '';
    refresh();
  });

  /* ---- cancel and save ---- */
  window.addEventListener('beforeunload', (e) => {
    if (!saved && changed().length) { e.preventDefault(); e.returnValue = ''; }
  });
  cancelBtn.addEventListener('click', () => {
    if (!saved && changed().length && !window.confirm('Discard your changes?')) return;
    saved = true;
    window.location.href = data.live;
  });

  function confirmSave(list) {
    return new Promise((resolve) => {
      const dlg = h('dialog', 'le-dlg');
      dlg.append(h('h2', '', `Save ${list.length} change${list.length === 1 ? '' : 's'} to this page?`));
      list.forEach((c) => {
        const before = c.block.text;
        const after = norm(c.el.textContent);
        const box = h('div', 'le-diff');
        box.append(h('p', 'le-old', `− ${before}`), h('p', 'le-new', `+ ${after}${before === after ? ' (link changed)' : ''}`));
        dlg.append(box);
      });
      const row = h('div', 'le-row');
      const back = h('button', 'le-btn', 'Back');
      const go = h('button', 'le-btn le-primary', 'Save and publish');
      back.type = 'button';
      go.type = 'button';
      row.append(back, go);
      dlg.append(row);
      document.body.append(dlg);
      const done = (v) => { dlg.close(); dlg.remove(); resolve(v); };
      back.addEventListener('click', () => done(false));
      go.addEventListener('click', () => done(true));
      dlg.addEventListener('cancel', () => done(false));
      dlg.showModal();
    });
  }

  saveBtn.addEventListener('click', async () => {
    const list = changed();
    if (!list.length || !(await confirmSave(list))) return;
    saveBtn.disabled = true;
    msg.textContent = 'Saving…';
    let res;
    try {
      const r = await fetch(data.api, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': data.csrf },
        body: JSON.stringify({ path: data.path, changes: list.map((c) => ({ old: c.block.raw, new: serBlock(c.el) })) }),
      });
      res = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
    } catch (e) {
      res = { ok: false, error: 'No connection. Nothing has changed.' };
    }
    if (!res.ok) {
      msg.textContent = res.error || 'Not saved.';
      refresh();
      return;
    }
    saved = true;
    edits.forEach(({ el }) => { el.contentEditable = 'false'; el.classList.remove('le-edit'); });
    linkBtn.disabled = true;
    msg.textContent = '';
    count.textContent = '';
    const done = h('span', 'le-msg', `${res.message || 'Saved.'} `);
    const view = h('a', 'le-view', 'View page');
    view.href = data.live;
    done.append(view);
    msg.replaceWith(done);
    cancelBtn.textContent = 'Close';
  });
  refresh();
}

// Wrangler bundles with keep-names, which puts __name(fn, "name") calls inside editor();
// in the browser that helper doesn't exist, so a stand-in comes first (28 Oct: without it
// the editor never started). ui-pageedit.check.mjs is run bundled the same way.
export const PAGEEDIT_JS = `var __name = function (f) { return f; };\n(${editor.toString()})();\n`;

export const PAGEEDIT_CSS = `
.le-bar{position:fixed;top:0;left:0;right:0;z-index:10000;display:flex;flex-wrap:wrap;align-items:center;gap:.4rem .6rem;padding:.55rem 1rem;background:#2E3D26;color:#fff;font:500 15px/1.4 system-ui,-apple-system,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.25)}
.le-title{font-weight:600;margin-right:auto}
.le-count{background:#FFF3B0;color:#2E2A1F;border-radius:999px;padding:0 .6rem}
.le-count:empty,.le-msg:empty{display:none}
.le-msg{flex-basis:100%;order:9;color:#FFE7C2}
.le-view{color:#fff;font-weight:600}
.le-btn{font:inherit;min-height:40px;padding:.3rem .9rem;border-radius:8px;border:1px solid rgba(255,255,255,.6);background:transparent;color:inherit;cursor:pointer}
.le-btn:disabled{opacity:.45;cursor:default}
.le-primary{background:#C0703A;border-color:#C0703A;color:#fff}
body.le-on{padding-top:64px!important}
@media (max-width:600px){body.le-on{padding-top:108px!important}}
.le-edit{outline:1px dashed #C0703A;outline-offset:3px;border-radius:2px;cursor:text}
.le-edit:focus{outline:2px solid #C0703A;background:#fff}
.le-changed,.le-changed:focus{background:#FFF3B0}
.le-fixed{background:rgba(120,110,90,.13);border-radius:2px;cursor:help}
.le-dlg{max-width:min(40rem,calc(100vw - 2rem));border:0;border-radius:12px;padding:1.2rem 1.4rem;font:15px/1.5 system-ui,-apple-system,sans-serif;color:#2E2A1F;background:#fff}
.le-dlg::backdrop{background:rgba(0,0,0,.45)}
.le-dlg h2{font-size:1.15rem;margin:0 0 .8rem}
.le-diff{border-top:1px solid #DCCFAE;padding:.5rem 0}
.le-diff p{margin:.2rem 0;white-space:pre-wrap;overflow-wrap:anywhere}
.le-old{color:#8A2D1D;text-decoration:line-through}
.le-new{color:#2E5A1C}
.le-row{display:flex;justify-content:flex-end;gap:.6rem;margin-top:1rem}
.le-dlg .le-btn{border-color:#5B5240;color:#2E2A1F}
.le-dlg .le-primary{color:#fff;border-color:#C0703A}
`;

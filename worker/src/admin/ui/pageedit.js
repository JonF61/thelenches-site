// worker/src/admin/ui/pageedit.js
// Edit page script and styles, served as /admin/pageedit.js and /admin/pageedit.css into the
// live page that /admin/page?p= shows (admin/pageedit.js). Plain browser JavaScript.
// Blocks whose text matches exactly one editable block of the page's .njk file (and appear
// once on the page) get a dashed outline and become editable; other text blocks are greyed
// ("Ask Kryten"). Enter does nothing, paste is plain text, the bar's Link button adds,
// changes or removes a link. Save shows each change (before / after), then sends the
// changed blocks, re-serialised as text plus simple inline tags, to /admin/api/page-save.
// Listing entries (4 Nov, "edit everything"; admin/entryedit.js): elements inside a
// [data-entry][data-label] card that carry data-field get a blue dotted outline and, on hover, the
// entry's label ("Event: …"); a click opens an edit box under the entry with its current wording
// and links (read from main or the Pending row), and Save and publish sends them to
// /admin/api/entry-save, then shows Saving → Building → Live ✓. The same script runs in the
// Newsletter draft's editor (/admin/draft-edit, data.mode "draft"), where only entries are editable.

export const PAGEEDIT_VERSION = '5';

function editor() {
  const data = JSON.parse(document.getElementById('lenches-edit-data').textContent);
  const draft = data.mode === 'draft';
  const root = draft ? document.body : (document.querySelector('[data-src]') || document.body);
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
  // Entry fields have their own edit box (below), so they are never page-template blocks.
  const inEntry = (el) => !!(el.closest('[data-field]') && el.closest('[data-entry][data-label]'));
  const leaves = draft ? [] : [...root.querySelectorAll(TAGS)].filter((el) => !el.querySelector(`${TAGS},ul,ol,div,table,form`) && !el.closest('form') && !inEntry(el));
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
  const cards = [...document.querySelectorAll('[data-entry][data-label]')];
  if (draft) {
    // The draft frame: a plain banner (the frame is as tall as the issue, so nothing is fixed).
    document.addEventListener('click', (e) => {
      if (e.target.closest('.le-entry-form')) return;
      if (e.target.closest('a, button, summary, label')) e.preventDefault();
    }, true);
    const banner = h('div', 'le-banner', cards.length
      ? '✎ Click an outlined entry to change its wording or links. Saving changes the website too.'
      : 'Nothing in this draft can be edited here yet: Refresh the draft and try again.');
    document.body.prepend(banner);
    entries();
    return;
  }
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
  if (!edits.length && !cards.length) msg.textContent = 'Nothing on this page can be edited here: ask Kryten.';

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
    if (e.target.closest('.le-bar, .le-dlg, .le-entry-form')) return;
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
    const done = h('span', 'le-msg', '');
    done.setAttribute('role', 'status');
    msg.replaceWith(done);
    cancelBtn.textContent = 'Close';
    res.check = norm(list[0].el.textContent); // the wording the live page must show
    watchBuild(done, res);
  });
  entries();

  // After a save: "Saved ✓ · Building the site… (0:42)", then "Live ✓ – View page", from the
  // commit's build.yml run (/admin/api/build-status), checked every 10 seconds for 15 minutes.
  function watchBuild(el, res) {
    const t0 = Date.now();
    let state = 'building';
    let phase = '';
    let link = '';
    const clock = () => {
      const s = Math.floor((Date.now() - t0) / 1000);
      return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    };
    const show = () => {
      el.textContent = '';
      if (state === 'live') {
        const view = h('a', 'le-view', 'View page');
        // A fresh copy, not the one the browser or the Pages cache still holds.
        view.href = `${data.live}?v=${String(res.sha || Date.now()).slice(0, 7)}`;
        el.append('Live ✓ – ', view);
      } else if (state === 'failed') {
        el.append('⚠ Build failed – Kryten can see why. ');
        if (link) {
          const a = h('a', 'le-view', 'Open on GitHub');
          a.href = link;
          a.target = '_blank';
          a.rel = 'noopener';
          el.append(a);
        }
      } else {
        el.append(`Saved ✓ · ${phase === 'publishing' ? 'Built; waiting for the page to update…' : 'Building the site…'} (${clock()})`);
      }
    };
    const timer = setInterval(() => { if (state === 'building') show(); }, 1000);
    const check = async () => {
      if (!res.sha || Date.now() - t0 > 15 * 60000) {
        if (state === 'building') { state = 'failed'; show(); }
        clearInterval(timer);
        return;
      }
      try {
        const q = new URLSearchParams({ sha: res.sha, at: res.at || '', p: data.page, text: (res.check || '').slice(0, 200) });
        const r = await fetch(`${data.statusApi}?${q}`);
        const j = await r.json();
        if (j.ok && j.state) { state = j.state; link = j.url || link; phase = j.phase || ''; }
      } catch (e) { /* try again next time */ }
      show();
      if (state === 'building') setTimeout(check, 10000);
      else clearInterval(timer);
    };
    show();
    setTimeout(check, 5000);
  }
  refresh();

  /* ---- listing entries (both modes) ---- */
  function entries() {
    const fit = () => {
      try { if (window.frameElement) window.frameElement.style.height = `${document.documentElement.scrollHeight + 4}px`; } catch (e) { /* not framed */ }
    };
    const tag = h('div', 'le-tag');
    tag.hidden = true;
    document.body.append(tag);
    const showTag = (card) => {
      const r = card.getBoundingClientRect();
      tag.textContent = `${card.getAttribute('data-label')} · click to edit`;
      tag.style.left = `${Math.max(4, r.left + window.scrollX)}px`;
      tag.style.top = `${Math.max(0, r.top + window.scrollY - 24)}px`;
      tag.hidden = false;
    };
    const fieldsOf = (el) => (el.getAttribute('data-field') || '').split(/\s+/).filter(Boolean);
    const busy = new Set();
    cards.forEach((card) => {
      card.classList.add('le-entry-card');
      const els = [...card.querySelectorAll('[data-field]')].concat(card.hasAttribute('data-field') ? [card] : []);
      els.forEach((el) => {
        if (el.closest('[data-entry][data-label]') !== card) return;
        el.classList.add('le-entry');
        el.tabIndex = 0;
        el.setAttribute('role', 'button');
        el.title = `${card.getAttribute('data-label')}: click to edit`;
        el.addEventListener('keydown', (e) => { if (e.target === el && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(card, el); } });
      });
      card.addEventListener('mouseover', () => showTag(card));
      card.addEventListener('focusin', () => showTag(card));
      card.addEventListener('mouseleave', () => { tag.hidden = true; });
    });
    document.addEventListener('click', (e) => {
      const el = e.target.closest('.le-entry');
      if (!el || e.target.closest('.le-entry-form')) return;
      e.preventDefault();
      e.stopPropagation();
      open(el.closest('[data-entry][data-label]'), el);
    }, true);

    function place(card, form) {
      if (card.tagName === 'TABLE' || card.tagName === 'TR' || card.hasAttribute('data-field')) card.after(form);
      else card.append(form);
    }

    async function open(card, el) {
      const key = card.getAttribute('data-entry');
      const prev = document.querySelector(`.le-entry-form[data-for="${CSS.escape(key)}"]`);
      if (prev) { prev.remove(); }
      const want = fieldsOf(el);
      const form = h('div', 'le-entry-form');
      form.setAttribute('data-for', key);
      form.setAttribute('role', 'group');
      form.setAttribute('aria-label', `Edit ${card.getAttribute('data-label')}`);
      const head = h('div', 'le-ef-head', card.getAttribute('data-label'));
      const body = h('div', 'le-ef-body', 'Loading…');
      const status = h('div', 'le-ef-msg', '');
      status.setAttribute('role', 'status');
      form.append(head, body, status);
      place(card, form);
      fit();
      form.scrollIntoView({ block: 'nearest' });
      if (busy.has(key)) {
        body.textContent = 'A change to this entry is still being saved: wait until it shows Live ✓, then edit it again.';
        body.append(' ', closeBtn(form));
        return;
      }
      let info;
      try {
        const r = await fetch(`${data.entryApi}?key=${encodeURIComponent(key)}`);
        info = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
      } catch (e) {
        info = { ok: false, error: 'No connection.' };
      }
      body.textContent = '';
      if (!info.ok) { body.append(info.error || 'Could not load this entry.', ' ', closeBtn(form)); fit(); return; }
      if (info.official) { body.append('This is an official statement: it stays in its own words. Ask Kryten.', ' ', closeBtn(form)); fit(); return; }
      const shown = info.fields.filter((f) => want.includes(f.field));
      const inputs = [];
      shown.forEach((f) => {
        const row = h('label', 'le-ef-row');
        row.append(h('span', 'le-ef-name', f.name));
        if (f.type === 'link') {
          const cur = f.value ? JSON.parse(f.value) : { text: '', url: '' };
          const words = h('input', 'le-ef-in');
          words.value = cur.text;
          words.placeholder = 'Words readers click';
          words.setAttribute('aria-label', `${f.name}: words`);
          const url = h('input', 'le-ef-in');
          url.value = cur.url;
          url.placeholder = 'https://…, mailto:…, tel:… or /page/';
          url.setAttribute('aria-label', `${f.name}: address`);
          row.append(words, url, h('span', 'le-ef-hint', 'Leave both empty to take the link off.'));
          inputs.push({ f, get: () => ((words.value.trim() || url.value.trim()) ? JSON.stringify({ text: words.value.trim(), url: url.value.trim() }) : '') });
        } else {
          const box = h(f.multiline ? 'textarea' : 'input', 'le-ef-in');
          box.value = f.value;
          if (f.multiline) box.rows = Math.min(14, Math.max(4, Math.ceil(f.value.length / 70) + f.value.split('\n').length));
          if (f.multiline) row.append(box, h('span', 'le-ef-hint', 'A blank line starts a new paragraph.'));
          else row.append(box, f.required ? '' : h('span', 'le-ef-hint', 'Leave empty to take it off.'));
          inputs.push({ f, get: () => box.value });
        }
        body.append(row);
      });
      if (!shown.length) body.append('Nothing here can be changed in this box: ask Kryten.');
      const btns = h('div', 'le-ef-btns');
      const save = h('button', 'le-btn le-primary', 'Save and publish');
      save.type = 'button';
      btns.append(closeBtn(form, 'Cancel'), save);
      body.append(btns);
      fit();
      const first = body.querySelector('.le-ef-in');
      if (first) first.focus({ preventScroll: true });
      const norm2 = (v) => String(v).replace(/\r\n?/g, '\n');
      const current = () => inputs.map((x) => ({ field: x.f.field, name: x.f.name, old: x.f.value, new: norm2(x.get()), type: x.f.type })).filter((c) => c.new.trim() !== c.old.trim() || (c.type === 'link' && c.new !== c.old));
      save.addEventListener('click', () => {
        const list = current();
        if (!list.length) { status.textContent = 'Nothing has changed.'; return; }
        // Before / after, then Publish (no modal: in the draft frame it could sit off screen).
        body.hidden = true;
        const sure = h('div', 'le-ef-body');
        const show = (c, v) => (c.type === 'link' ? (v ? `${JSON.parse(v).text} (${JSON.parse(v).url})` : '(no link)') : (v || '(empty)'));
        list.forEach((c) => {
          const box = h('div', 'le-diff');
          box.append(h('p', 'le-ef-name', c.name), h('p', 'le-old', `− ${show(c, c.old)}`), h('p', 'le-new', `+ ${show(c, c.new)}`));
          sure.append(box);
        });
        const row = h('div', 'le-ef-btns');
        const back = h('button', 'le-btn', 'Back');
        const go = h('button', 'le-btn le-primary', 'Publish');
        back.type = 'button';
        go.type = 'button';
        row.append(back, go);
        sure.append(row);
        form.insertBefore(sure, status);
        fit();
        back.addEventListener('click', () => { sure.remove(); body.hidden = false; fit(); });
        go.addEventListener('click', async () => {
          go.disabled = true;
          back.disabled = true;
          status.textContent = 'Saving…';
          let res;
          try {
            const r = await fetch(data.entrySaveApi, {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'x-csrf-token': data.csrf },
              body: JSON.stringify({ key, changes: list.map((c) => ({ field: c.field, old: c.old, new: c.new })) }),
            });
            res = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
          } catch (e) {
            res = { ok: false, error: 'No connection. Nothing has changed.' };
          }
          if (!res.ok) { status.textContent = res.error || 'Not saved.'; go.disabled = false; back.disabled = false; return; }
          sure.remove();
          body.remove();
          if (!res.count) { status.textContent = res.message || 'No changes to save.'; form.append(closeBtn(form, 'Close')); fit(); return; }
          busy.add(key);
          card.classList.add('le-saved');
          // Show the new wording straight away where one element holds one plain field.
          list.forEach((c) => {
            if (c.type !== 'text') return;
            const one = [...card.querySelectorAll('[data-field]')].concat([card]).filter((x) => x.getAttribute && x.getAttribute('data-field') === c.field);
            if (one.length === 1 && !one[0].querySelector('a, [data-field]')) one[0].textContent = c.new.replace(/\s+/g, ' ');
          });
          if (res.rebuild) {
            form.append(h('div', 'le-ef-note', 'The newsletter is already built, so it will be rebuilt with this change: Test send it again before Send to all.'));
          }
          form.append(closeBtn(form, 'Close'));
          fit();
          watchEntry(status, res, () => busy.delete(key));
        });
      });
    }

    function closeBtn(form, text) {
      const b = h('button', 'le-btn', text || 'Close');
      b.type = 'button';
      b.addEventListener('click', () => { form.remove(); fit(); });
      return b;
    }

    // "Saved ✓ · Saving the change… (0:12)", "Building the site…", then "Live ✓ – View page".
    function watchEntry(el, res, done) {
      const t0 = Date.now();
      let state = 'building';
      let phase = 'saving';
      let link = '';
      const clock = () => {
        const sec = Math.floor((Date.now() - t0) / 1000);
        return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
      };
      const words = { saving: 'Saving the change…', building: 'Building the site…', publishing: 'Built; waiting for the page to update…' };
      const show = () => {
        el.textContent = '';
        if (state === 'live') {
          const view = h('a', 'le-view', 'View page');
          view.href = `${new URL(res.page || '/', data.site || 'https://thelenches.org.uk').href}?v=${res.id.slice(2, 9)}`;
          view.target = '_blank';
          view.rel = 'noopener';
          el.append('Live ✓ – ', view);
        } else if (state === 'failed') {
          el.append('⚠ Not saved: it may have changed since you opened it, or the run failed. Reload and try again, or ask Kryten. ');
          if (link) {
            const a = h('a', 'le-view', 'Open on GitHub');
            a.href = link;
            a.target = '_blank';
            a.rel = 'noopener';
            el.append(a);
          }
        } else {
          el.append(`Saved ✓ · ${words[phase] || words.building} (${clock()})`);
        }
        fit();
      };
      const timer = setInterval(() => { if (state === 'building') show(); }, 1000);
      const check = async () => {
        if (Date.now() - t0 > 15 * 60000) {
          if (state === 'building') { state = 'failed'; show(); }
          clearInterval(timer);
          done();
          return;
        }
        try {
          const q = new URLSearchParams({ id: res.id, at: res.at || '', p: res.page || '', text: (res.check || '').slice(0, 200) });
          const r = await fetch(`${data.entryStatusApi}?${q}`);
          const j = await r.json();
          if (j.ok && j.state) { state = j.state; link = j.url || link; phase = j.phase || (state === 'building' ? 'building' : ''); }
        } catch (e) { /* try again next time */ }
        show();
        if (state === 'building') setTimeout(check, 10000);
        else { clearInterval(timer); done(); }
      };
      show();
      setTimeout(check, 5000);
    }
  }
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
.le-entry{outline:1px dotted #2F6DB5;outline-offset:2px;border-radius:2px;cursor:pointer}
.le-entry:hover,.le-entry:focus{outline:2px solid #2F6DB5;background:rgba(47,109,181,.07)}
.le-saved .le-entry{outline-color:#2E7D32}
.le-tag{position:absolute;z-index:9999;pointer-events:none;max-width:min(30rem,calc(100vw - 1rem));overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:1px 8px;border-radius:4px;background:#2F6DB5;color:#fff;font:600 12px/20px system-ui,-apple-system,sans-serif}
.le-entry-form{display:block;margin:.6rem 0;padding:.8rem 1rem;border:2px solid #2F6DB5;border-radius:10px;background:#F4F8FD;color:#1F2A37;font:15px/1.45 system-ui,-apple-system,sans-serif;text-align:left;clear:both}
.le-ef-head{font-weight:700;color:#1F4E8C;margin-bottom:.5rem}
.le-ef-row{display:flex;flex-direction:column;gap:.25rem;margin:0 0 .7rem}
.le-ef-name{font-weight:600;font-size:13px;margin:0}
.le-ef-in{font:15px/1.45 system-ui,-apple-system,sans-serif;width:100%;box-sizing:border-box;padding:.45rem .55rem;border:1px solid #8AA4C8;border-radius:6px;background:#fff;color:#1F2A37}
textarea.le-ef-in{resize:vertical}
.le-ef-hint{font-size:12px;color:#5B6B80}
.le-ef-btns{display:flex;justify-content:flex-end;gap:.6rem;flex-wrap:wrap;margin-top:.4rem}
.le-entry-form .le-btn{border-color:#5B6B80;color:#1F2A37;background:#fff}
.le-entry-form .le-primary{background:#C0703A;border-color:#C0703A;color:#fff}
.le-ef-msg{margin-top:.3rem;font-weight:600;color:#1F4E8C}
.le-ef-msg:empty{display:none}
.le-ef-msg .le-view{color:#1F4E8C}
.le-ef-note{margin:.4rem 0;padding:.4rem .6rem;border-radius:6px;background:#FFF3B0;color:#2E2A1F;font-size:14px}
.le-entry-form .le-diff p{margin:.2rem 0;white-space:pre-wrap;overflow-wrap:anywhere}
.le-banner{margin:0;padding:.6rem 1rem;background:#2F6DB5;color:#fff;font:600 14px/1.4 system-ui,-apple-system,sans-serif;text-align:center}
.le-dlg .le-btn{border-color:#5B5240;color:#2E2A1F}
.le-dlg .le-primary{color:#fff;border-color:#C0703A}
`;

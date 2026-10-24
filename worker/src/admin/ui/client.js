// worker/src/admin/ui/client.js
// Panel script, served as /admin/app.js. Plain browser JavaScript, no framework. All text
// from the Sheet or email goes in as text nodes (never innerHTML), so nothing in an item
// can inject markup. Every write sends the value the page loaded (stale-write check).
// Written without backticks or dollar-brace so it can live inside String.raw below.

// Bump when the script or stylesheet changes, so browsers fetch the new one.
export const UI_VERSION = '2';

export const CLIENT_JS = String.raw`
(function () {
  'use strict';

  var S = { data: null, csrf: '', view: 'queue', filter: 'all', sel: {}, done: {}, imgs: {} };
  var wideQ = window.matchMedia('(min-width: 900px)');
  var wide = function () { return wideQ.matches; };
  var VIEWS = [['queue', 'Queue'], ['replies', 'Replies'], ['owed', 'Owed'], ['photos', 'Photos'], ['health', 'Health']];
  var FLAG_LABELS = {
    own_wording: 'Asked for own wording', too_early: 'Too early', after_deadline: 'After deadline',
    flyer_limit: 'Flyer limit', newsletter_limit: 'Newsletter limit', people_in_image: 'People in image',
    classified: 'Classified ad', political_commercial: 'Political or commercial', anonymous: 'Anonymous'
  };
  var PHOTO_CONSENT = ['identifiable', 'children', 'unknown'];

  /* ------------------------------------------------------------ helpers -- */

  function h(tag, attrs) {
    var el = document.createElement(tag);
    var a = attrs || {};
    Object.keys(a).forEach(function (k) {
      var v = a[k];
      if (v === null || v === undefined || v === false) return;
      if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = Boolean(v);
      else el.setAttribute(k, v === true ? '' : String(v));
    });
    for (var i = 2; i < arguments.length; i += 1) add(el, arguments[i]);
    return el;
  }
  function add(el, c) {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { add(el, x); }); return; }
    el.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
  }
  var str = function (v) { return String(v === undefined || v === null ? '' : v).trim(); };
  var truthy = function (v) { return /^(true|yes|y|1)$/i.test(str(v)); };
  var lower = function (v) { return str(v).toLowerCase(); };

  var toastTimer = null;
  function toast(msg, bad) {
    var old = document.querySelector('.toast');
    if (old) old.remove();
    var t = h('div', { class: bad ? 'toast bad' : 'toast', role: 'status' }, msg);
    document.body.appendChild(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.remove(); }, bad ? 9000 : 5000);
  }

  async function api(path, body) {
    var init = { credentials: 'same-origin' };
    if (body) {
      init.method = 'POST';
      init.headers = { 'content-type': 'application/json', 'x-csrf-token': S.csrf };
      init.body = JSON.stringify(body);
    }
    var r = await fetch(path, init);
    var j = {};
    try { j = await r.json(); } catch (e) { j = { error: 'HTTP ' + r.status }; }
    if (r.status === 403 && body) j.error = j.error || 'Signed out: reload the page';
    return { status: r.status, ok: r.ok, json: j };
  }

  function sheetLink(tab, row) {
    var d = S.data;
    if (!d || !d.sheetId || !row) return null;
    var gid = d.gids && d.gids[tab];
    var url = 'https://docs.google.com/spreadsheets/d/' + d.sheetId + '/edit' +
      (gid !== undefined ? '#gid=' + gid + '&range=A' + row : '');
    return h('a', { class: 'btn link', href: url, target: '_blank', rel: 'noopener' }, 'Sheet row');
  }

  function when(s) {
    var v = str(s);
    if (!v) return '';
    var d = new Date(/^\d{4}-\d{2}-\d{2}T/.test(v) ? v : v.replace(' ', 'T'));
    if (isNaN(d)) return v;
    return d.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  function day(s) {
    var v = str(s);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    return new Date(v + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  }

  // Same rule as the server (sheet.js isTypoFix): official text takes typo fixes only.
  function words(s) { return String(s || '').split(/\s+/).filter(Boolean); }
  function wordsChanged(a, b) {
    var x = words(a); var y = words(b);
    if (x.length * y.length > 400000) return Math.max(x.length, y.length);
    var prev = new Array(y.length + 1).fill(0);
    for (var i = 1; i <= x.length; i += 1) {
      var cur = new Array(y.length + 1).fill(0);
      for (var j = 1; j <= y.length; j += 1) {
        cur[j] = x[i - 1] === y[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
      }
      prev = cur;
    }
    var common = prev[y.length];
    return (x.length - common) + (y.length - common);
  }
  function isTypoFix(a, b) { return wordsChanged(a, b) <= 2 * Math.max(3, Math.ceil(words(a).length * 0.05)); }

  /* --------------------------------------------------------------- load -- */

  async function load(quiet) {
    try {
      if (!S.csrf) {
        var s = await api('/admin/api/session');
        if (!s.ok) throw new Error(s.json.error || 'Not signed in');
        S.csrf = s.json.csrf;
      }
      var r = await api('/admin/api/state');
      if (!r.ok) throw new Error(r.json.error || 'Could not load');
      S.data = r.json;
      S.done = {};
      render();
      if (!quiet) toast('Up to date');
    } catch (e) {
      if (!S.data) document.getElementById('app').replaceChildren(h('p', { class: 'loading' }, 'Could not load: ' + e.message));
      else toast('Could not reload: ' + e.message, true);
    }
  }

  async function edit(tab, key, field, expected, value) {
    var r = await api('/admin/api/edit', { tab: tab, key: key, field: field, expected: expected, value: value });
    if (r.ok) return { ok: true, value: r.json.value };
    return { ok: false, status: r.status, error: r.json.error || ('HTTP ' + r.status), current: r.json.current };
  }

  async function act(kind, id, action, extra, doneText) {
    var body = Object.assign({ kind: kind, id: id, action: action }, extra || {});
    var r = await api('/admin/api/action', body);
    if (!r.ok) {
      toast(r.json.error || ('HTTP ' + r.status), true);
      if (r.status === 409) load(true);
      return false;
    }
    S.done[kind + ':' + id] = doneText || 'Done';
    toast(r.json.message || 'Done');
    closeOverlay();
    render();
    return true;
  }

  /* ------------------------------------------------------------- layout -- */

  function render() {
    var d = S.data;
    var app = h('div', { class: 'app' }, top(d), nav(d), h('div', { class: 'main' }, body(d)));
    document.getElementById('app').replaceChildren(app);
  }

  function errorNote(t, what) {
    return t && t.error ? h('div', { class: 'note bad' }, what + ' could not be read: ' + t.error) : null;
  }

  function top(d) {
    var hol = d.holiday || {};
    var holSwitch = h('button', {
      class: 'switch', role: 'switch', 'aria-checked': hol.on ? 'true' : 'false',
      'aria-label': 'Holiday mode', disabled: hol.error ? true : null, onclick: toggleHoliday
    });
    var nl = d.newsletter;
    var nlChip = h('div', { class: 'chip' }, h('b', null, 'Newsletter'),
      nl && !nl.error ? [str(nl.issue_date || nl.issue_id), ' · ', str(nl.status) || 'no state',
        nl.sent_at ? ' · sent ' + when(nl.sent_at) : '', sheetLink('Issues', nl._row)]
        : (nl && nl.error ? 'not readable' : 'none yet'));
    var hl = Array.isArray(d.health) ? d.health[0] : null;
    var hs = hl ? str(hl.status).toUpperCase() : '';
    var dog = d.watchdog || {};
    return h('header', { class: 'top' },
      h('h1', null, 'Lenches admin'),
      h('div', { class: 'strip' },
        h('div', { class: 'chip' }, h('b', null, 'Holiday mode'), holSwitch, hol.error ? 'not readable' : (hol.on ? 'ON' : 'off')),
        nlChip,
        h('div', { class: 'chip' }, h('span', { class: 'dot ' + (hs === 'OK' ? 'ok' : hs === 'FIXED' ? 'warn' : 'bad') }),
          h('b', null, 'Diagnostic'), hl ? hs + ' · ' + when(hl.date) : 'no runs'),
        h('div', { class: 'chip' }, h('span', { class: 'dot ' + (dog.error ? 'warn' : dog.open ? 'bad' : 'ok') }),
          h('b', null, 'Watchdog'), dog.error ? 'not readable' : dog.open ? 'alert since ' + when(dog.since) : 'clear'),
        h('button', { class: 'btn', onclick: function () { load(); } }, 'Reload')));
  }

  async function toggleHoliday() {
    var hol = S.data.holiday;
    var turnOn = !hol.on;
    var msg = turnOn
      ? 'Turn holiday mode ON?\n\nWhile it is on, nobody is choosing: the newsletter can send itself on Thursday and replies that normally wait for you can go out automatically.'
      : 'Turn holiday mode OFF?\n\nSends and replies wait for your approval again.';
    if (!window.confirm(msg)) return;
    var r = await edit('Settings', '', 'holiday_mode', hol.value, turnOn ? 'TRUE' : 'FALSE');
    if (r.ok) toast('Holiday mode is now ' + (turnOn ? 'ON' : 'off'));
    else toast(r.status === 409 ? 'Holiday mode was changed in the Sheet (now "' + r.current + '"). Nothing changed; reloaded.' : r.error, true);
    load(true);
  }

  function counts(d) {
    var n = function (t, kind, key) {
      if (!t || t.error) return '!';
      return t.rows.filter(function (r) { return !S.done[kind + ':' + r[key]]; }).length;
    };
    return {
      queue: n(d.pending, 'pending', 'id'), replies: n(d.replies, 'reply', 'reply_id'),
      owed: Array.isArray(d.owed) ? d.owed.filter(function (o) { return !S.done['reply:' + o.holding.reply_id]; }).length : '!',
      photos: n(d.photos, 'photo', 'drive_id'), health: null
    };
  }

  function nav(d) {
    var c = counts(d);
    return h('nav', { class: 'side', 'aria-label': 'Sections' }, VIEWS.map(function (v) {
      return h('button', {
        'aria-current': S.view === v[0] ? 'page' : null,
        onclick: function () { S.view = v[0]; closeOverlay(); render(); window.scrollTo(0, 0); }
      }, v[1], c[v[0]] === null ? null : h('span', { class: 'n' }, String(c[v[0]])));
    }));
  }

  function body(d) {
    if (S.view === 'replies') return split(repliesList(d), 'reply');
    if (S.view === 'owed') return [h('div', { class: 'list wide' }, owedList(d))];
    if (S.view === 'photos') return split(photosList(d), 'photo');
    if (S.view === 'health') return [h('div', { class: 'list wide' }, healthView(d))];
    return split(queueList(d), 'pending');
  }

  // Desktop: list and detail side by side. Phone: the list's cards are complete on their own.
  function split(list, kind) {
    var detail = h('div', { class: 'detail' });
    if (wide() && list.selected) detail.appendChild(list.selected());
    else if (wide()) detail.appendChild(h('p', { class: 'empty' }, 'Nothing selected.'));
    return [h('div', { class: 'list' }, list.els), detail];
  }

  // A list entry: on desktop a compact, clickable summary; on phone the full card.
  function entry(kind, id, compact, full) {
    var selected = S.sel[kind] === id;
    if (!wide()) return full();
    return h('div', {
      class: 'card' + (selected ? ' sel' : ''), tabindex: '0', role: 'button', 'aria-pressed': selected ? 'true' : 'false',
      onclick: function () { S.sel[kind] = id; render(); },
      onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); S.sel[kind] = id; render(); } }
    }, compact());
  }

  function pickSelected(kind, rows, key) {
    if (!rows.length) return null;
    var hit = rows.find(function (r) { return r[key] === S.sel[kind]; });
    if (!hit) { hit = rows[0]; S.sel[kind] = hit[key]; }
    return hit;
  }

  /* -------------------------------------------------------------- overlay -- */

  function overlay(title, content) {
    closeOverlay();
    var o = h('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'bar' }, h('h2', null, title), h('button', { class: 'btn', onclick: closeOverlay }, 'Close')),
      content);
    document.body.appendChild(o);
    document.body.style.overflow = 'hidden';
    var first = o.querySelector('input,textarea,select');
    if (first) first.focus();
  }
  function closeOverlay() {
    var o = document.querySelector('.overlay');
    if (o) o.remove();
    document.body.style.overflow = '';
  }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeOverlay(); });

  /* ---------------------------------------------------------------- queue -- */

  function isFlagged(r) { return Boolean(str(r.policy_flags)) || truthy(r.people_in_image) || truthy(r.political_commercial); }

  function queueList(d) {
    var t = d.pending;
    var els = [];
    var bar = h('div', { class: 'toolbar' },
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Filter' }, [['all', 'All'], ['urgent', 'Urgent'], ['flagged', 'Flagged']].map(function (f) {
        return h('button', { 'aria-pressed': S.filter === f[0] ? 'true' : 'false', onclick: function () { S.filter = f[0]; render(); } }, f[1]);
      })));
    els.push(bar);
    if (t.error) { els.push(errorNote(t, 'Pending')); return { els: els }; }
    if (t.headers.indexOf('people_ok') < 0) els.push(h('div', { class: 'note warn' }, 'Pending has no people_ok column: items whose image shows people cannot be approved here.'));
    var rows = t.rows.filter(function (r) { return !S.done['pending:' + r.id]; })
      .filter(function (r) { return S.filter === 'urgent' ? truthy(r.urgent) : S.filter === 'flagged' ? isFlagged(r) : true; })
      .slice().sort(function (a, b) { return (truthy(b.urgent) ? 1 : 0) - (truthy(a.urgent) ? 1 : 0) || a._row - b._row; });
    if (!rows.length) els.push(h('p', { class: 'empty' }, t.rows.length ? 'Nothing matches this filter.' : 'Nothing waiting. 🎉'));
    rows.forEach(function (r) {
      els.push(entry('pending', r.id, function () { return itemSummary(r); }, function () { return itemCard(r, false); }));
    });
    var sel = wide() ? pickSelected('pending', rows, 'id') : null;
    return { els: els, selected: sel ? function () { return itemCard(sel, true); } : null };
  }

  function itemBadges(r) {
    var b = [];
    if (truthy(r.urgent)) b.push(h('span', { class: 'badge bad' }, 'Urgent'));
    b.push(h('span', { class: 'badge' }, lower(r.category) === 'event' ? 'Event' : 'Notice'));
    if (str(r.road)) b.push(h('span', { class: 'badge' }, 'Road'));
    if (r._official) b.push(h('span', { class: 'badge info' }, 'Official, own words'));
    if (truthy(r.people_in_image)) b.push(h('span', { class: 'badge bad' }, truthy(r.people_ok) ? 'People: OK given' : 'People in image'));
    str(r.policy_flags).split(',').map(str).filter(Boolean).forEach(function (f) {
      if (f === 'people_in_image') return;
      b.push(h('span', { class: 'badge warn' }, FLAG_LABELS[f] || f.replace(/_/g, ' ')));
    });
    if (truthy(r.possible_repeat)) b.push(h('span', { class: 'badge warn' }, 'Possible repeat'));
    if (str(r.missing)) b.push(h('span', { class: 'badge warn' }, 'Missing: ' + str(r.missing).replace(/,/g, ', ')));
    return h('div', { class: 'badges' }, b);
  }

  function itemMeta(r) {
    var dates = str(r.event_date) ? day(r.event_date) + (str(r.end_date) ? ' to ' + day(r.end_date) : '')
      : (str(r.end_date) ? 'until ' + day(r.end_date) : '');
    return h('div', { class: 'meta' }, [str(r.village), dates + (str(r.event_time) ? ', ' + str(r.event_time) : ''),
      'from ' + (str(r.source) || 'email')].filter(Boolean).join(' · '));
  }

  function itemText(r) { return r._official && str(r.own_text) ? r.own_text : r.summary; }

  function itemSummary(r) {
    return [h('h2', null, str(r.title) || '(no title)'), itemMeta(r), itemBadges(r), h('div', { class: 'text' }, str(itemText(r)))];
  }

  function needsTick(r) { return truthy(r.people_in_image) && !truthy(r.people_ok); }

  function itemCard(r, inDetail) {
    var c = h('div', { class: 'card' });
    add(c, [h('h2', null, str(r.title) || '(no title)'), itemMeta(r), itemBadges(r)]);
    if (r._offers) {
      add(c, h('div', { class: 'two' },
        h('div', null, h('h3', null, r._official ? 'Their words (official)' : 'Their wording'), h('div', { class: 'text' }, str(r.own_text))),
        h('div', null, h('h3', null, 'Our rewrite'), h('div', { class: 'text' }, str(r.summary)))));
    } else {
      add(c, h('div', { class: 'text' }, str(r.summary)));
    }
    var extra = [];
    if (str(r.cost)) extra.push('Cost: ' + str(r.cost));
    if (str(r.contact)) extra.push('Contact: ' + str(r.contact));
    if (str(r.link_url)) extra.push('Link: ' + (str(r.link_text) ? str(r.link_text) + ' – ' : '') + str(r.link_url));
    if (extra.length) add(c, h('div', { class: 'meta' }, extra.join(' · ')));
    add(c, images(r));
    if (truthy(r.people_in_image)) add(c, peopleTick('Pending', r.id, r, 'The image shows people or children. Tick only if they are happy to appear.'));
    add(c, h('label', { class: 'f', for: 'cat-' + r.id }, 'Category'));
    add(c, categorySelect(r));
    add(c, itemActions(r, inDetail));
    if (inDetail) add(c, [h('h3', null, 'Edit'), itemForm(r)]);
    return c;
  }

  function images(r) {
    var box = h('div', { class: 'imgs' });
    var m = str(r.message_id);
    if (!m || m.indexOf('rss:') === 0 || !/^[A-Za-z0-9]{6,40}$/.test(m)) return box;
    var fill = function (list) {
      box.replaceChildren();
      if (!list.length) return;
      list.forEach(function (p) {
        var src = '/admin/img/mail/' + m + '/' + p.partId;
        var isMain = p.partId === str(r.image_part_id);
        box.appendChild(h('a', { href: src, target: '_blank', rel: 'noopener', class: isMain ? 'main-img' : null,
          title: (isMain ? 'Image used for this item: ' : '') + (p.filename || 'image') },
        h('img', { src: src, alt: (isMain ? 'Used: ' : '') + (p.filename || 'image from the email'), loading: 'lazy' })));
      });
    };
    if (S.imgs[m]) fill(S.imgs[m]);
    else if (str(r.image_part_id) || truthy(r.people_in_image)) {
      box.appendChild(h('span', { class: 'meta' }, 'Loading images…'));
      api('/admin/api/mail-images?m=' + encodeURIComponent(m)).then(function (res) {
        S.imgs[m] = res.ok ? res.json.images : [];
        fill(S.imgs[m]);
        if (!res.ok) box.appendChild(h('span', { class: 'meta' }, 'Images could not be loaded.'));
      });
    }
    return box;
  }

  function peopleTick(tab, key, row, text) {
    var id = 'ppl-' + tab + '-' + key;
    return h('label', { class: 'tick', for: id },
      h('input', { type: 'checkbox', id: id, checked: truthy(row.people_ok), onchange: async function (e) {
        var box = e.target;
        box.disabled = true;
        var want = box.checked ? 'yes' : '';
        var r = await edit(tab, key, 'people_ok', str(row.people_ok) === '' ? '' : row.people_ok, want);
        if (r.ok) { row.people_ok = r.value; toast(want ? 'People OK recorded' : 'People OK removed'); }
        else {
          toast(r.status === 409 && r.current !== undefined ? 'Changed in the Sheet (now "' + r.current + '"). Not saved.' : r.error, true);
          if (r.current !== undefined) row.people_ok = r.current;
        }
        render();
      } }),
      h('span', null, 'People OK. ' + text));
  }

  function categorySelect(r) {
    return h('select', { class: 'f', id: 'cat-' + r.id, onchange: async function (e) {
      var sel = e.target;
      var r2 = await edit('Pending', r.id, 'category', r.category, sel.value);
      if (r2.ok) { r.category = r2.value; toast('Category saved'); }
      else { toast(r2.status === 409 ? 'Changed in the Sheet (now "' + r2.current + '"). Not saved.' : r2.error, true); if (r2.current !== undefined) r.category = r2.current; }
      render();
    } }, ['event', 'notice'].map(function (v) {
      return h('option', { value: v, selected: lower(r.category) === v ? true : null }, v === 'event' ? 'Event' : 'Notice');
    }));
  }

  function itemActions(r, inDetail) {
    var blocked = needsTick(r);
    var why = blocked ? 'Tick "People OK" first' : null;
    var approve = function (action, label, primary) {
      return h('button', { class: 'btn' + (primary ? ' primary' : ''), disabled: blocked, title: why, onclick: function () {
        act('pending', r.id, action, null, 'Approved');
      } }, label);
    };
    var a = [];
    if (r._offers) { a.push(approve('approve_own', 'Approve their wording', true)); a.push(approve('approve_rewrite', 'Approve rewrite', false)); }
    else a.push(approve('approve', 'Approve', true));
    if (!inDetail) a.push(h('button', { class: 'btn', onclick: function () { overlay('Edit item', itemForm(r)); } }, 'Edit'));
    a.push(h('button', { class: 'btn danger', onclick: function () {
      if (window.confirm('Reject "' + str(r.title) + '"?')) act('pending', r.id, 'reject', null, 'Rejected');
    } }, 'Reject'));
    if (r._trust) {
      a.push(h('button', { class: 'btn', disabled: blocked, title: why, onclick: function () {
        if (window.confirm('Trust ' + r._trust + ' and approve this item?\n\nFuture items from it publish without asking, except anything with people in images, political or commercial content, official notices, anonymous or out-of-scope mail, classified ads or low confidence. Its other waiting items are not approved. To undo, delete its row in the Trusted tab.')) {
          act('pending', r.id, 'trust', null, 'Trusted');
        }
      } }, 'Trust this source'));
    }
    if (str(r.gmail_link)) a.push(h('a', { class: 'btn link', href: str(r.gmail_link), target: '_blank', rel: 'noopener' }, 'Original email'));
    a.push(sheetLink('Pending', r._row));
    return h('div', { class: 'actions' }, a);
  }

  function itemForm(r) {
    var headers = S.data.pending.headers;
    var fields = [];
    var f = function (name, label, kind) {
      if (headers.indexOf(name) < 0) return;
      var id = 'f-' + name + '-' + r.id;
      var input = kind === 'area'
        ? h('textarea', { class: 'f', id: id, rows: 8 }, str(r[name]))
        : h('input', { class: 'f', id: id, type: kind || 'text', value: str(r[name]) });
      fields.push({ name: name, input: input });
      return [h('label', { class: 'f', for: id }, label), input];
    };
    var form = h('form', { onsubmit: function (e) { e.preventDefault(); saveItem(r, fields, msg); } });
    if (r._official) add(form, h('div', { class: 'note warn' }, 'Official, own words: fix obvious typos and broken links only. Bigger changes are refused.'));
    add(form, f('title', 'Title'));
    if (r._offers) { add(form, f('own_text', r._official ? 'Their words' : 'Their wording', 'area')); add(form, f('summary', 'Our rewrite', 'area')); }
    else add(form, f('summary', 'Text', 'area'));
    add(form, f('event_date', 'Date', 'date'));
    add(form, f('end_date', 'End date (several days)', 'date'));
    add(form, f('village', 'Village'));
    var msg = h('div', { 'aria-live': 'polite' });
    add(form, msg);
    add(form, h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'submit' }, 'Save edits')));
    return form;
  }

  async function saveItem(r, fields, msg) {
    msg.replaceChildren();
    var changed = fields.filter(function (x) { return x.input.value.trim() !== str(r[x.name]); });
    if (!changed.length) { toast('No changes to save'); return; }
    if (r._official) {
      var big = changed.filter(function (x) { return ['title', 'summary', 'own_text'].indexOf(x.name) >= 0 && !isTypoFix(str(r[x.name]), x.input.value); });
      if (big.length) { msg.appendChild(h('div', { class: 'note bad' }, 'That is more than a typo fix (' + big.map(function (x) { return x.name; }).join(', ') + '). Official statements are published in their own words.')); return; }
    }
    for (var i = 0; i < changed.length; i += 1) {
      var x = changed[i];
      var res = await edit('Pending', r.id, x.name, r[x.name], x.input.value);
      if (!res.ok) {
        if (res.status === 409 && res.current !== undefined) {
          msg.appendChild(h('div', { class: 'note bad' }, res.error + '. "' + x.name + '" now reads:', h('div', { class: 'text' }, res.current), 'Your edit to it was not saved; edits listed before it were.'));
          r[x.name] = res.current;
        } else msg.appendChild(h('div', { class: 'note bad' }, x.name + ': ' + res.error));
        return;
      }
      r[x.name] = res.value;
    }
    toast('Saved');
    closeOverlay();
    render();
  }

  /* -------------------------------------------------------------- replies -- */

  function repliesList(d) {
    var t = d.replies;
    var els = [];
    if (t.error) return { els: [errorNote(t, 'Replies')] };
    var rows = t.rows.filter(function (r) { return !S.done['reply:' + r.reply_id]; });
    if (!rows.length) els.push(h('p', { class: 'empty' }, 'No drafts waiting.'));
    rows.forEach(function (r) {
      els.push(entry('reply', r.reply_id, function () { return replySummary(r); }, function () { return replyCard(r); }));
    });
    var owed = owedList(d, true);
    if (owed.length) els.push(h('h2', { class: 'section' }, 'Still owed a reply'), owed);
    var sel = wide() ? pickSelected('reply', rows, 'reply_id') : null;
    return { els: els, selected: sel ? function () { return replyCard(sel); } : null };
  }

  function replyHead(r) {
    var b = [h('span', { class: 'badge' }, str(r.type) || 'reply')];
    if (str(r.hold_reason)) b.push(h('span', { class: 'badge warn' }, str(r.hold_reason)));
    if (str(r.class)) b.push(h('span', { class: 'badge' }, str(r.class)));
    return [h('h2', null, str(r.subject) || '(no subject)'),
      h('div', { class: 'meta' }, 'To ' + str(r.to) + (r.created_at ? ' · drafted ' + when(r.created_at) : '')),
      h('div', { class: 'badges' }, b)];
  }
  function replySummary(r) { return [replyHead(r), h('div', { class: 'text' }, str(r.body))]; }

  function replyCard(r) {
    var c = h('div', { class: 'card' }, replyHead(r), h('div', { class: 'text' }, str(r.body)));
    if (str(r.notes)) add(c, h('div', { class: 'meta' }, 'Notes: ' + str(r.notes)));
    add(c, h('div', { class: 'actions' },
      h('button', { class: 'btn primary', onclick: function () {
        if (window.confirm('Send this reply to ' + str(r.to) + ' as it stands?')) act('reply', r.reply_id, 'approve', null, 'Sent');
      } }, 'Approve'),
      h('button', { class: 'btn', onclick: function () { overlay('Edit reply', replyEditForm(r)); } }, 'Edit'),
      h('button', { class: 'btn', onclick: function () { overlay('Redraft reply', redraftForm(r)); } }, 'Redraft'),
      h('button', { class: 'btn danger', onclick: function () { overlay('Reject reply', rejectForm(r)); } }, 'Reject'),
      h('button', { class: 'btn', onclick: function () {
        if (window.confirm('Close this email, no reply needed? Nothing is sent to them.')) act('reply', r.reply_id, 'close', null, 'Closed');
      } }, 'Close'),
      sheetLink('Replies', r._row)));
    return c;
  }

  function replyEditForm(r) {
    var text = h('textarea', { class: 'f', id: 'rb', rows: 16, maxlength: 3000 }, str(r.body));
    var why = h('input', { class: 'f', id: 'rw', maxlength: 300 });
    return h('form', { onsubmit: function (e) {
      e.preventDefault();
      if (text.value.trim().length < 10) { toast('The reply is empty', true); return; }
      act('reply', r.reply_id, 'edit', { body: text.value, reason: why.value }, 'Sent (edited)');
    } },
    h('p', { class: 'meta' }, 'To ' + str(r.to) + '. It is sent exactly as it stands.'),
    h('label', { class: 'f', for: 'rb' }, 'Reply'), text,
    h('label', { class: 'f', for: 'rw' }, 'Why did you change it? (optional, kept in the Reply feedback tab, never sent)'), why,
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'submit' }, 'Send edited reply')));
  }

  function redraftForm(r) {
    var text = h('textarea', { class: 'f', id: 'rr', rows: 5, maxlength: 500, required: true });
    return h('form', { onsubmit: function (e) {
      e.preventDefault();
      if (text.value.trim().length < 3) { toast('Say what Holly should change', true); return; }
      act('reply', r.reply_id, 'redraft', { reason: text.value }, 'Redraft requested');
    } },
    h('label', { class: 'f', for: 'rr' }, 'What should Holly change? (required; kept in the Reply feedback tab, never sent)'), text,
    h('p', { class: 'meta' }, 'Holly writes a new draft from their email, the old draft and this. The new draft appears here and in a fresh email card.'),
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'submit' }, 'Redraft')));
  }

  function rejectForm(r) {
    var why = h('input', { class: 'f', id: 'rj', maxlength: 300 });
    return h('form', { onsubmit: function (e) { e.preventDefault(); act('reply', r.reply_id, 'reject', { reason: why.value }, 'Rejected'); } },
      h('p', null, 'Nothing is sent to ' + str(r.to) + '.'),
      h('label', { class: 'f', for: 'rj' }, 'Why? (optional, kept in the Reply feedback tab, never sent)'), why,
      h('div', { class: 'actions' }, h('button', { class: 'btn danger', type: 'submit' }, 'Reject reply')));
  }

  /* ----------------------------------------------------------------- owed -- */

  function owedList(d, embedded) {
    if (!Array.isArray(d.owed)) return embedded ? [] : [errorNote(d.owed, 'Replies')];
    var list = d.owed.filter(function (o) { return !S.done['reply:' + o.holding.reply_id]; });
    if (!list.length) return embedded ? [] : [h('p', { class: 'empty' }, 'Nobody is still owed a reply.')];
    var els = embedded ? [] : [h('p', { class: 'meta' }, 'Emails that had a holding reply over 48 hours ago and no real reply since.')];
    list.forEach(function (o) {
      var hd = o.holding;
      var dr = o.draft;
      els.push(h('div', { class: 'card' },
        h('h2', null, str(hd.subject) || '(no subject)'),
        h('div', { class: 'meta' }, 'From ' + str(hd.to) + ' · holding reply sent ' + when(hd.sent_at)),
        h('div', { class: 'badges' }, dr
          ? h('span', { class: dr.status === 'awaiting' ? 'badge warn' : 'badge' }, dr.status === 'awaiting' ? 'Draft waiting for you' : 'Last draft: ' + str(dr.status))
          : h('span', { class: 'badge' }, 'No draft')),
        h('div', { class: 'actions' },
          dr && dr.status === 'awaiting' ? h('button', { class: 'btn primary', onclick: function () {
            S.view = 'replies'; S.sel.reply = dr.reply_id; render(); window.scrollTo(0, 0);
          } }, 'Open draft') : null,
          h('button', { class: 'btn', onclick: function () {
            if (window.confirm('Close this email, no reply needed? Nothing is sent; any draft still waiting is closed.')) act('reply', hd.reply_id, 'close', null, 'Closed');
          } }, 'Close, no reply needed'),
          sheetLink('Replies', hd._row))));
    });
    return els;
  }

  /* --------------------------------------------------------------- photos -- */

  function consent(r) { return PHOTO_CONSENT.indexOf(lower(r.people)) >= 0; }

  function photosList(d) {
    var t = d.photos;
    if (t.error) return { els: [errorNote(t, 'Photos')] };
    var rows = t.rows.filter(function (r) { return !S.done['photo:' + r.drive_id]; });
    var els = [h('p', { class: 'meta' }, 'Approved photos are published by the daily photos run (early morning).')];
    if (!rows.length) els.push(h('p', { class: 'empty' }, 'No photos waiting.'));
    rows.forEach(function (r) {
      els.push(entry('photo', r.drive_id, function () { return photoSummary(r); }, function () { return photoCard(r); }));
    });
    var sel = wide() ? pickSelected('photo', rows, 'drive_id') : null;
    return { els: els, selected: sel ? function () { return photoCard(sel); } : null };
  }

  function photoBadges(r) {
    var b = [];
    if (r._organiser) b.push(h('span', { class: 'badge info' }, "Organiser's image"));
    if (consent(r)) b.push(h('span', { class: 'badge bad' }, (lower(r.people) === 'children' ? 'Children' : lower(r.people) === 'unknown' ? 'People: not checked' : 'Identifiable people') + (truthy(r.people_ok) ? ' · OK given' : '')));
    if (str(r.duplicate_of)) b.push(h('span', { class: 'badge warn' }, 'Possible duplicate'));
    return h('div', { class: 'badges' }, b);
  }

  function photoSummary(r) {
    return [h('h2', null, str(r.filename)), h('div', { class: 'meta' }, [str(r.village), str(r.subject)].filter(Boolean).join(' · ')), photoBadges(r)];
  }

  function photoCard(r) {
    var src = '/admin/img/drive/' + encodeURIComponent(r.drive_id);
    var c = h('div', { class: 'card photo' },
      h('a', { href: src + '?size=1600', target: '_blank', rel: 'noopener' }, h('img', { src: src + '?size=600', alt: str(r.alt_text) || str(r.filename), loading: 'lazy' })),
      photoSummary(r));
    if (r._organiser) add(c, h('div', { class: 'meta' }, 'For: ' + str(r._organiser.event) + (str(r._organiser.source_page) ? ' · from ' + str(r._organiser.source_page) : '')));
    if (str(r.description)) add(c, h('div', { class: 'text' }, str(r.description)));
    if (str(r.alt_text)) add(c, h('div', { class: 'meta' }, 'Alt text: ' + str(r.alt_text)));
    if (str(r.credit)) add(c, h('div', { class: 'meta' }, 'Credit: ' + str(r.credit)));
    if (consent(r)) add(c, peopleTick('Photos', r.drive_id, r, 'Tick only if everyone shown is happy to appear (for children, their parents).'));
    var tid = 'tg-' + r.drive_id;
    var target = h('input', { class: 'f', id: tid, value: str(r.target), placeholder: 'e.g. home, church-lench' });
    add(c, h('label', { class: 'f', for: tid }, 'Target (where it is used)'));
    add(c, h('form', { class: 'toolbar', onsubmit: async function (e) {
      e.preventDefault();
      var res = await edit('Photos', r.drive_id, 'target', r.target, target.value);
      if (res.ok) { r.target = res.value; toast('Target saved'); }
      else { toast(res.status === 409 ? 'Changed in the Sheet (now "' + res.current + '"). Not saved.' : res.error, true); if (res.current !== undefined) r.target = res.current; }
      render();
    } }, h('div', { class: 'spacer' }, target), h('button', { class: 'btn', type: 'submit' }, 'Save')));
    var blocked = consent(r) && !truthy(r.people_ok);
    add(c, h('div', { class: 'actions' },
      h('button', { class: 'btn primary', disabled: blocked, title: blocked ? 'Tick "People OK" first' : null, onclick: function () {
        act('photo', r.drive_id, 'approve', { expected: r.status }, 'Approved');
      } }, 'Approve'),
      h('button', { class: 'btn danger', onclick: function () {
        if (window.confirm('Reject ' + str(r.filename) + '? It will not be published.')) act('photo', r.drive_id, 'reject', { expected: r.status }, 'Rejected');
      } }, 'Reject'),
      h('button', { class: 'btn', onclick: function () { overlay('Rename or move', fileForm(r)); } }, 'Rename or move'),
      str(r.duplicate_of) ? h('button', { class: 'btn', onclick: function () { overlay('Possible duplicates', copiesView(r)); } }, 'Compare copies') : null,
      str(r.drive_link) ? h('a', { class: 'btn link', href: str(r.drive_link), target: '_blank', rel: 'noopener' }, 'Open in Drive') : null,
      sheetLink('Photos', r._row)));
    return c;
  }

  /* ---------------------------------------------------------- photo files -- */

  function fileOp(body) { return api('/admin/api/photo-file', body); }
  function bad(res) { return res.json.error || ('HTTP ' + res.status); }

  // Rename, change of folder and new folder, from the file's live Drive state.
  function fileForm(r) {
    var box = h('div', null, h('p', { class: 'meta' }, 'Loading from Drive…'));
    var show = async function () {
      var res = await api('/admin/api/photo-file?id=' + encodeURIComponent(r.drive_id));
      if (!res.ok) { box.replaceChildren(h('div', { class: 'note bad' }, 'Could not load: ' + bad(res))); return; }
      box.replaceChildren.apply(box, fileParts(r, res.json.file, res.json.folders, show));
    };
    show();
    return box;
  }

  function splitExt(name) {
    var m = String(name).match(/^(.+?)(\.[A-Za-z0-9]{1,5})$/);
    return m ? { stem: m[1], ext: m[2] } : { stem: String(name), ext: '' };
  }

  function folderSelect(id, folders, current) {
    return h('select', { class: 'f', id: id }, folders.map(function (f) {
      return h('option', { value: f.id, selected: f.id === current ? true : null }, f.path);
    }));
  }

  function fileParts(r, file, folders, again) {
    var out = [];
    out.push(h('div', { class: 'card' },
      h('h2', null, file.name),
      h('div', { class: 'meta' }, 'In ' + file.folder),
      file.published ? h('div', { class: 'badges' }, h('span', { class: 'badge info' }, 'On the website')) : null));
    if (file.toDelete) {
      out.push(h('div', { class: 'note warn' }, 'This file is in To delete. Move it out in Drive to use it again.'));
      return out;
    }

    var parts = splitExt(file.name);
    var nid = 'fn-' + r.drive_id;
    var nameIn = h('input', { class: 'f', id: nid, value: parts.stem, maxlength: 120 });
    out.push(h('h3', null, 'Rename'));
    out.push(h('form', { onsubmit: async function (e) {
      e.preventDefault();
      var res = await fileOp({ op: 'rename', id: r.drive_id, expected: file.name, name: nameIn.value });
      if (res.ok) { r.filename = res.json.name; toast('Renamed to ' + res.json.name); again(); render(); }
      else { toast(res.status === 409 && res.json.current ? 'Renamed in Drive since you loaded it (now "' + res.json.current + '"). Not changed.' : bad(res), true); if (res.status === 409) again(); }
    } },
    h('label', { class: 'f', for: nid }, 'New name' + (parts.ext ? ' (' + parts.ext + ' is kept)' : '')),
    h('div', { class: 'toolbar' }, h('div', { class: 'spacer' }, nameIn), h('button', { class: 'btn', type: 'submit' }, 'Rename')),
    h('p', { class: 'meta' }, file.published
      ? 'It stays at the same web address: the site keeps the name it was first published under.'
      : 'Characters such as / \\ : * ? " < > | are dropped.')));

    var mid = 'fm-' + r.drive_id;
    var dest = folderSelect(mid, folders, file.folderId);
    out.push(h('h3', null, 'Move to another folder'));
    out.push(h('form', { onsubmit: async function (e) {
      e.preventDefault();
      if (dest.value === file.folderId) { toast('It is already in that folder'); return; }
      var to = folders.find(function (f) { return f.id === dest.value; });
      if (file.published && !window.confirm('This photo is on the website. Its village and subject follow its folder; in a Rejected folder or a folder starting with _ it comes off the site on the next photos run.\n\nMove it to ' + to.path + '?')) return;
      var res = await fileOp({ op: 'move', id: r.drive_id, expectedParent: file.folderId, to: dest.value });
      if (res.ok) { toast('Moved to ' + res.json.folder + '. The Photos tab follows on the next photos run.'); again(); }
      else { toast(res.status === 409 && res.json.currentPath ? 'Moved in Drive since you loaded it (now in ' + res.json.currentPath + '). Not changed.' : bad(res), true); if (res.status === 409) again(); }
    } },
    h('label', { class: 'f', for: mid }, 'Folder'),
    h('div', { class: 'toolbar' }, h('div', { class: 'spacer' }, dest), h('button', { class: 'btn', type: 'submit' }, 'Move')),
    h('p', { class: 'meta' }, 'Village and subject come from the folder: Village (or General) / Subject.')));

    var pid = 'fp-' + r.drive_id;
    var fid = 'fnew-' + r.drive_id;
    var parent = folderSelect(pid, folders, file.folderId);
    var fname = h('input', { class: 'f', id: fid, maxlength: 60 });
    out.push(h('h3', null, 'New folder'));
    out.push(h('form', { onsubmit: async function (e) {
      e.preventDefault();
      var res = await fileOp({ op: 'folder', parent: parent.value, name: fname.value });
      if (res.ok) { toast('Folder made: ' + res.json.path); again(); }
      else toast(bad(res), true);
    } },
    h('label', { class: 'f', for: pid }, 'Inside'), parent,
    h('label', { class: 'f', for: fid }, 'Name'),
    h('div', { class: 'toolbar' }, h('div', { class: 'spacer' }, fname), h('button', { class: 'btn', type: 'submit' }, 'Make folder'))));
    return out;
  }

  function bytes(n) {
    if (!n) return '';
    return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB';
  }

  // Every copy in the group side by side, with Keep this one / Move to To delete.
  function copiesView(r) {
    var box = h('div', null, h('p', { class: 'meta' }, 'Loading copies…'));
    var show = async function () {
      var res = await api('/admin/api/photo-group?id=' + encodeURIComponent(r.drive_id));
      if (!res.ok) { box.replaceChildren(h('div', { class: 'note bad' }, 'Could not load: ' + bad(res))); return; }
      var list = res.json.members;
      var els = [h('p', { class: 'meta' }, list.length > 1
        ? 'Copies that look the same (same picture, perhaps resized). "To delete" is a folder in Lenches Photos: nothing is binned, you empty it yourself in Drive.'
        : 'No other copy found: the copy it was flagged against may have been removed or edited since.')];
      els.push(h('div', { class: 'copies' }, list.map(function (m) { return copyCard(m, list, show); })));
      box.replaceChildren.apply(box, els);
    };
    show();
    return box;
  }

  function copyCard(m, list, again) {
    var src = '/admin/img/drive/' + encodeURIComponent(m.drive_id);
    var facts = [
      m.missing ? (m.refused || 'Not found in Drive') : 'In ' + m.folder,
      m.width && m.height ? m.width + ' × ' + m.height : '',
      bytes(m.size),
      m.created ? 'Added ' + when(m.created) : ''
    ].filter(Boolean);
    var live = !m.missing && !m.toDelete;
    var c = h('div', { class: 'card' },
      live ? h('a', { href: src + '?size=1600', target: '_blank', rel: 'noopener' }, h('img', { src: src + '?size=400', alt: m.name || m.filename, loading: 'lazy' })) : null,
      h('h3', null, m.name || m.filename),
      h('div', { class: 'meta' }, facts.join(' · ')),
      h('div', { class: 'badges' },
        h('span', { class: 'badge' }, 'Status: ' + (m.status || 'new')),
        m.published ? h('span', { class: 'badge bad' }, 'On the website') : h('span', { class: 'badge' }, 'Not published'),
        m.toDelete ? h('span', { class: 'badge warn' }, 'In To delete') : null));
    if (live) {
      add(c, h('div', { class: 'actions' },
        h('button', { class: 'btn primary', onclick: function () { keepOne(m, list, again); } }, 'Keep this one'),
        h('button', { class: 'btn danger', onclick: async function () {
          if (!window.confirm('Move ' + (m.name || m.filename) + ' to To delete and mark it rejected?')) return;
          if (await discard(m)) again();
        } }, 'Move to To delete')));
    }
    return c;
  }

  // One copy to To delete. A copy on the website needs a second, explicit yes.
  async function discard(m) {
    var name = m.name || m.filename;
    var body = { op: 'discard', id: m.drive_id, expected: m.status, expectedParent: m.folderId };
    if (m.published) {
      if (!window.confirm(name + ' is ON THE WEBSITE. Moving it takes it off the site on the next photos run, and any page that names it loses the picture.\n\nTake it down and move it to To delete?')) return false;
      body.confirmPublished = true;
    }
    var res = await fileOp(body);
    if (res.ok) { S.done['photo:' + m.drive_id] = 'Rejected'; toast(res.json.message); return true; }
    toast(name + ': ' + bad(res), true);
    return false;
  }

  async function keepOne(keep, list, again) {
    var others = list.filter(function (m) { return m.drive_id !== keep.drive_id && !m.missing && !m.toDelete; });
    if (!others.length) { toast('No other copies to move'); return; }
    if (!window.confirm('Keep ' + (keep.name || keep.filename) + ' and move these to To delete (marked rejected)?\n\n' +
      others.map(function (m) { return '• ' + (m.name || m.filename) + ' (' + m.folder + ')' + (m.published ? ' – ON THE WEBSITE' : ''); }).join('\n'))) return;
    for (var i = 0; i < others.length; i += 1) await discard(others[i]);
    again();
    render();
  }

  /* --------------------------------------------------------------- health -- */

  function healthView(d) {
    var els = [];
    var dog = d.watchdog || {};
    els.push(h('div', { class: 'card' }, h('h2', null, 'Watchdog'),
      dog.error ? h('div', { class: 'note bad' }, 'Could not check: ' + dog.error)
        : dog.open ? [h('div', { class: 'note bad' }, 'Alert open since ' + when(dog.since)), h('ul', null, (dog.problems || []).map(function (p) { return h('li', null, p); }))]
          : h('p', null, 'No open alert' + (dog.cleared ? '; last one cleared ' + when(dog.cleared) : '') + '. It checks every 3 hours.')));
    if (!Array.isArray(d.health)) { els.push(errorNote(d.health, 'Health')); return els; }
    var t = h('table', { class: 'h' }, h('thead', null, h('tr', null, h('th', null, 'Run'), h('th', null, 'Status'), h('th', null, 'Summary and problems'))),
      h('tbody', null, d.health.map(function (r) {
        return h('tr', null, h('td', null, when(r.date)), h('td', null, str(r.status)),
          h('td', null, str(r.summary), str(r.problems) ? h('div', { class: 'meta' }, str(r.problems).split(' | ').join('; ')) : null));
      })));
    els.push(h('div', { class: 'card' }, h('h2', null, 'Daily diagnostic (latest 7)'), t, h('div', { class: 'actions' }, sheetLink('Health', 1))));
    return els;
  }

  wideQ.addEventListener('change', function () { if (S.data) render(); });
  load(true);
})();
`;

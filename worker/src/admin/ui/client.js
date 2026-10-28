// worker/src/admin/ui/client.js
// Panel script, served as /admin/app.js. Plain browser JavaScript, no framework. All text
// from the Sheet or email goes in as text nodes (never innerHTML), so nothing in an item
// can inject markup. Every write sends the value the page loaded (stale-write check).
// Photos: a collapsible folder tree built from the live Drive folders, tick boxes, drag and
// drop onto folders (desktop), Move to… (phone), each move stale-checked, with Undo.
// To delete (last in the Photos menu): what is in it, where from and when, Restore; Reject,
// drag, Move to… and "Move to To delete" all move a photo there, always after a confirm.
// Suggested images: on a Queue card for an event with no image, the run's suggestions (own
// photo, organiser's site, library) with Choose and "None of these" (stale-checked writes).
// Past events: organisers' images whose event is over. After any action the middle list
// keeps its scroll, selection and open folders (render reuses unchanged cards).
// Contacts: a list (search; status, village and organisation filters; newest contact first)
// and a page per contact; each field saves on its own, stale-checked.
// Outreach (26 Oct): who is due a nudge (seasonal, gone quiet, leads; /admin/api/outreach),
// with Draft nudge (Holly drafts; the card comes by email), Snooze 3 months, Never nudge,
// and Clear for those held back (next_nudge writes through /admin/api/contact).
// Organisations (27 Oct): every organisation the site lists and where its yearly check is
// (/admin/api/orgs), with Draft check / Draft chaser (/admin/api/orgcheck), and Done, Snooze
// 3 months, Never and Clear (next_check writes through /admin/api/orgnext).
// Summary (28 Oct): first in the menu and the page the panel opens on; one short section per
// screen, written by code from /admin/api/state and /admin/api/summary, each linking to its screen.
// Newsletter draft (28 Oct): the next issue as it would be built now (or as built, once it is),
// framed from /admin/draft, with Refresh (runs newsletter-draft.yml); the top bar's Newsletter chip
// opens it (it replaced the Feedback chip).
// Written without backticks or dollar-brace so it can live inside String.raw below.

// Bump when the script or stylesheet changes, so browsers fetch the new one.
export const UI_VERSION = '42';

export const CLIENT_JS = String.raw`
(function () {
  'use strict';

  var S = { data: null, csrf: '', view: 'summary', filter: 'all', sel: {}, done: {}, imgs: {}, pf: '', files: {}, open: {},
    picked: {}, ff: '', openF: {}, drag: null, busy: false, order: {}, shown: '' };
  var wideQ = window.matchMedia('(min-width: 900px)');
  var wide = function () { return wideQ.matches; };
  var VIEWS = [['summary', 'Summary'], ['draft', 'Newsletter draft'], ['queue', 'Submissions'], ['replies', 'Replies'], ['owed', 'Owed'], ['feedback', 'Feedback'], ['lessons', 'Holly lessons'], ['contacts', 'Contacts'], ['photos', 'Photos'], ['activity', 'Activity']];
  // Health has no menu entry (28 Oct): the top bar's Diagnostic and Watchdog open it, as does Summary's Site health.
  // A reminder of what each page holds, shown at its top (wording agreed with Jon 26 Oct).
  var INTROS = {
    draft: 'The next newsletter as it would be built now from what is approved. It updates after each approval and every 3 hours. Once the issue is built on Thursday, this shows it exactly as built.',
    summary: 'What needs you now, and what is coming up, in one place. Tap a heading to open its page.',
    queue: 'Events and notices sent in by email or picked up from feeds, waiting for you to approve or reject. Approved items go on the website and into Thursday\'s newsletter.',
    replies: 'Holly\'s draft emails waiting for you to Approve, Edit, Redraft or Reject. Below them: emails still owed a reply, and everything already sent.',
    owed: 'Emails that got an automatic holding reply over 2 days ago but no real answer yet. Redraft one, reply yourself, or close it.',
    feedback: 'Comments and corrections from readers via the website\'s feedback form, to approve, reject or postpone, with Holly\'s replies to them.',
    lessons: 'Rules Holly follows in every draft. Approve or reject the weekly suggestions, edit or delete any lesson, or add your own (yours count as approved).',
    contacts: 'Everyone who sends in, or could send in, news and events, with their profile, contributions and status. Outreach shows who is due a friendly nudge; Organisations, the yearly check of each organisation\'s entry on the site.',
    photos: 'Photos in the Lenches Photos folders in Google Drive. Approve or reject new ones, rename them, or move them between folders.',
    health: 'The daily diagnostic, the watchdog and the Google account the panel uses. Look here if something seems wrong.',
    activity: 'What the website\'s automatic jobs on GitHub are doing: checking email, publishing, building the site, sending. Newest first; tap a name to open it on GitHub.'
  };
  function intro(view) { return h('p', { class: 'meta intro' }, INTROS[view]); }
  var FLAG_LABELS = {
    own_wording: 'Asked for own wording', too_early: 'Too early', after_deadline: 'After deadline',
    flyer_limit: 'Flyer limit', newsletter_limit: 'Newsletter limit', people_in_image: 'Children in photo',
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
      S.files = {};
      S.contacts = null;
      S.outreach = null;
      S.orgs = null;
      S.summary = null;
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

  // Redraw after any change. The middle list keeps its place: unchanged cards are the very
  // same elements (same row, same content), only changed ones are rebuilt, and the scroll
  // position (pinned to the first card in view), the detail's and the menu's scroll come
  // back as they were. A different view or folder starts at the top.
  function render() {
    var d = S.data;
    var view = S.view + '|' + S.pf + '|' + (wide() ? 'w' : 'n');
    var same = S.shown === view;
    var keep = same ? saveScroll() : null;
    var app = h('div', { class: 'app' }, top(d), nav(d), h('div', { class: 'main' }, body(d)));
    var oldList = document.querySelector('.main > .list');
    var newList = app.querySelector('.main > .list');
    if (same && oldList && newList) reuseCards(oldList, newList);
    document.getElementById('app').replaceChildren(app);
    S.shown = view;
    if (keep) restoreScroll(keep);
  }

  function cardsIn(list) { return Array.prototype.filter.call(list.children, function (x) { return x.getAttribute('data-key'); }); }

  function reuseCards(oldList, newList) {
    var old = Object.create(null);
    cardsIn(oldList).forEach(function (x) { old[x.getAttribute('data-key')] = x; });
    cardsIn(newList).forEach(function (x) {
      var o = old[x.getAttribute('data-key')];
      if (o && o._row && o._row === x._row && o._sig === x._sig) newList.replaceChild(o, x);
    });
  }

  function saveScroll() {
    var list = document.querySelector('.main > .list');
    var detail = document.querySelector('.main > .detail');
    var side = document.querySelector('nav.side');
    var k = { list: list ? list.scrollTop : 0, detail: detail ? detail.scrollTop : 0, side: side ? side.scrollTop : 0, win: window.scrollY, anchor: '', off: 0 };
    if (!list) return k;
    // Pinned to the first card in view, so a card added or gone above doesn't shift it.
    var top = wide() ? list.getBoundingClientRect().top : 0;
    var first = cardsIn(list).find(function (x) { return x.getBoundingClientRect().bottom > top + 1; });
    if (first) { k.anchor = first.getAttribute('data-key'); k.off = first.getBoundingClientRect().top - top; }
    return k;
  }

  function restoreScroll(k) {
    var list = document.querySelector('.main > .list');
    var detail = document.querySelector('.main > .detail');
    var side = document.querySelector('nav.side');
    if (side) side.scrollTop = k.side;
    if (detail) detail.scrollTop = k.detail;
    if (list) list.scrollTop = k.list;
    window.scrollTo(0, k.win);
    if (!list || !k.anchor) return;
    var a = cardsIn(list).find(function (x) { return x.getAttribute('data-key') === k.anchor; });
    if (!a) return;
    var top = wide() ? list.getBoundingClientRect().top : 0;
    var delta = a.getBoundingClientRect().top - top - k.off;
    if (!delta) return;
    if (wide()) list.scrollTop += delta; else window.scrollBy(0, delta);
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
    var dm = draftMetaOf(d);
    var nlChip = h('div', { class: 'chip' }, h('b', null, 'Newsletter'),
      nl && !nl.error ? [str(nl.issue_date || nl.issue_id), ' · ', str(nl.status) || 'no state',
        nl.sent_at ? ' · sent ' + when(nl.sent_at) : '', sheetLink('Issues', nl._row)]
        : (nl && nl.error ? 'not readable' : 'none yet'),
      h('button', { class: 'btn link', title: 'The next newsletter as it would be built now', onclick: go('draft') },
        dm ? 'Draft ' + day(dm.issue_date) + ' · ' + hhmm(dm.as_of) : 'Draft'));
    var hl = Array.isArray(d.health) ? d.health[0] : null;
    var hs = hl ? str(hl.status).toUpperCase() : '';
    var dog = d.watchdog || {};
    return h('header', { class: 'top' },
      h('h1', null, 'Lenches admin'),
      h('div', { class: 'strip' },
        h('div', { class: 'chip' }, h('b', null, 'Holiday mode'), holSwitch, hol.error ? 'not readable' : (hol.on ? 'ON' : 'off')),
        nlChip,
        h('div', { class: 'chip' }, h('span', { class: 'dot ' + (hs === 'OK' || hs === 'CLEARED' ? 'ok' : hs === 'FIXED' ? 'warn' : 'bad') }),
          h('button', { class: 'btn link chip-link', title: 'Open the Health page', onclick: go('health') }, h('b', null, 'Diagnostic')), hl ? hs + ' · ' + when(hl.date) : 'no runs',
          hl && hs !== 'OK' && hs !== 'CLEARED' ? h('button', { class: 'btn link', title: 'Mark this run\'s problems as dealt with', onclick: clearDiagnostic }, 'Clear') : null),
        h('div', { class: 'chip' }, h('span', { class: 'dot ' + (dog.error ? 'warn' : dog.open ? 'bad' : 'ok') }),
          h('button', { class: 'btn link chip-link', title: 'Open the Health page', onclick: go('health') }, h('b', null, 'Watchdog')), dog.error ? 'not readable' : dog.open ? 'alert since ' + when(dog.since) : 'clear'),
        h('button', { class: 'btn', onclick: function () { load(); } }, 'Reload')));
  }

  // Marks the latest diagnostic run's problems as dealt with (Health status CLEARED).
  async function clearDiagnostic() {
    var hl = S.data.health[0];
    var list = str(hl.problems) ? '\n\n' + str(hl.problems).split(' | ').join('\n') : '';
    if (!window.confirm('Clear the diagnostic flag?' + list + '\n\nThis marks these problems as dealt with. The next daily check runs as usual and flags anything still wrong.')) return;
    var r = await edit('Health', hl.date, 'status', hl.status, 'CLEARED');
    if (r.ok) toast('Diagnostic flag cleared');
    else toast(r.status === 409 ? 'The Health row changed in the Sheet. Nothing changed; reloaded.' : r.error, true);
    load(true);
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
      photos: d.photos && !d.photos.error ? d.photos.rows.filter(function (r) { return r._waiting && !S.done['photo:' + r.drive_id]; }).length : '!',
      feedback: d.feedback && !d.feedback.error ? fbRows(d, 'waiting').length + fbRows(d, 'reply').length : '!',
      summary: null, draft: null, contacts: null, lessons: null, health: null, activity: null
    };
  }

  function nav(d) {
    var c = counts(d);
    return h('nav', { class: 'side', 'aria-label': 'Sections' }, VIEWS.map(function (v) {
      var b = h('button', {
        'aria-current': S.view === v[0] ? 'page' : null,
        onclick: function () { S.view = v[0]; closeOverlay(); render(); window.scrollTo(0, 0); }
      }, v[1], c[v[0]] === null ? null : h('span', { class: v[0] === 'feedback' && c.feedback > 0 ? 'n attn' : 'n',
        title: v[0] === 'feedback' && c.feedback > 0 ? 'Needs your attention' : null }, String(c[v[0]])));
      // Photos: its Drive folders listed below it on desktop (a dropdown on phones).
      return v[0] === 'photos' && S.view === 'photos' && wide() ? [b, folderTree(d, {})] : b;
    }));
  }

  function body(d) {
    var top = intro(S.view);
    var withIntro = function (list) { list.els = [top].concat(list.els); return list; };
    if (S.view === 'replies') return split(withIntro(repliesList(d)), 'reply');
    if (S.view === 'owed') return [h('div', { class: 'list wide' }, top, owedList(d))];
    if (S.view === 'photos') return split(withIntro(photosList(d)), 'photo');
    if (S.view === 'health') return [h('div', { class: 'list wide' }, top, healthView(d))];
    if (S.view === 'feedback') return [h('div', { class: 'list wide' }, top, feedbackView(d))];
    if (S.view === 'contacts') return [h('div', { class: 'list wide' }, top, contactsView())];
    if (S.view === 'lessons') return [h('div', { class: 'list wide' }, top, lessonsView())];
    if (S.view === 'activity') return [h('div', { class: 'list wide' }, top, activityView())];
    if (S.view === 'draft') return [h('div', { class: 'list wide' }, top, draftView(d))];
    if (S.view === 'summary') return [h('div', { class: 'list wide' }, top, summaryView(d))];
    return split(withIntro(queueList(d)), 'pending');
  }

  // Desktop: list and detail side by side. Phone: the list's cards are complete on their own.
  function split(list, kind) {
    var detail = h('div', { class: 'detail' });
    if (wide() && list.selected) detail.appendChild(list.selected());
    else if (wide()) detail.appendChild(h('p', { class: 'empty' }, 'Nothing selected.'));
    return [h('div', { class: 'list' }, list.els), detail];
  }

  // A list entry: on desktop a compact, clickable summary; on phone the full card.
  // row: the row object it shows; with sig (its content) it lets render() keep an
  // unchanged card as it is.
  function entry(kind, id, compact, full, row) {
    var selected = S.sel[kind] === id;
    var el = wide() ? card() : full();
    el.setAttribute('data-key', kind + ':' + id);
    el._row = row || null;
    el._sig = sigOf(kind, id, row);
    return el;
    function card() { return h('div', {
      class: 'card' + (selected ? ' sel' : ''), tabindex: '0', role: 'button', 'aria-pressed': selected ? 'true' : 'false',
      onclick: function () { S.sel[kind] = id; render(); },
      onkeydown: function (e) {
        if (e.target !== e.currentTarget) return; // a tick box inside the card handles its own keys
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); S.sel[kind] = id; render(); }
      }
    }, compact()); }
  }

  function sigOf(kind, id, row) {
    var x = row ? Object.assign({}, row) : {};
    delete x._row;
    return JSON.stringify([x, S.sel[kind] === id, Boolean(S.picked[id]), S.done[kind + ':' + id] || '', Boolean(S.open[id]),
      Boolean(S.files[id]), binOf(id) ? 1 : 0]);
  }

  // The selected item, or (if it has gone from the list) the next one down, else the one
  // above, else the first.
  function pickSelected(kind, rows, key) {
    var ids = rows.map(function (r) { return r[key]; });
    var before = S.order[kind] || [];
    S.order[kind] = ids;
    if (!rows.length) return null;
    var i = ids.indexOf(S.sel[kind]);
    if (i < 0) {
      var j = before.indexOf(S.sel[kind]);
      var pick = '';
      if (j >= 0) {
        for (var a = j + 1; a < before.length && !pick; a += 1) if (ids.indexOf(before[a]) >= 0) pick = before[a];
        for (var b = j - 1; b >= 0 && !pick; b -= 1) if (ids.indexOf(before[b]) >= 0) pick = before[b];
      }
      i = pick ? ids.indexOf(pick) : 0;
      S.sel[kind] = ids[i];
    }
    return rows[i];
  }

  /* -------------------------------------------------------------- overlay -- */

  function overlay(title, content) {
    closeOverlay();
    var o = h('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'bar' }, h('h2', null, title), h('button', { class: 'btn', onclick: closeOverlay }, 'Close')),
      content);
    document.body.appendChild(o);
    document.body.style.overflow = 'hidden';
    var first = o.querySelector('input:not([data-nofocus]),textarea,select');
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
    var sel = wide() ? pickSelected('pending', rows, 'id') : null;
    rows.forEach(function (r) {
      els.push(entry('pending', r.id, function () { return itemSummary(r); }, function () { return itemCard(r, false); }, r));
    });
    return { els: els, selected: sel ? function () { return itemCard(sel, true); } : null };
  }

  function itemBadges(r) {
    var b = [];
    if (truthy(r.urgent)) b.push(h('span', { class: 'badge bad' }, 'Urgent'));
    b.push(h('span', { class: 'badge' }, lower(r.category) === 'event' ? 'Event' : 'Notice'));
    if (str(r.road)) b.push(h('span', { class: 'badge' }, 'Road'));
    if (r._official) b.push(h('span', { class: 'badge info' }, 'Official, own words'));
    if (truthy(r.people_in_image)) b.push(h('span', { class: 'badge bad' }, truthy(r.people_ok) ? 'Children: OK given' : 'Children in photo'));
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

  // The item's own image shows people, or the suggested image chosen for it may.
  function needsTick(r) {
    var chosen = (r._suggest || []).filter(function (s) { return s.id === str(r.image_choice); })[0];
    return (truthy(r.people_in_image) || Boolean(chosen && flaggedPeople(chosen))) && !truthy(r.people_ok);
  }

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
    if (truthy(r.people_in_image)) add(c, peopleTick('Pending', r.id, r, 'The photo may show children. Tick only if their parents are happy for it to appear.'));
    add(c, suggestStrip(r));
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
    // An item with its own image shows just that one, not every image in the email
    // (27 Oct: seven events from one email each showed all nine, signature logos included).
    var fill = function (all) {
      box.replaceChildren();
      var mine = all.filter(function (p) { return p.partId === str(r.image_part_id); });
      var list = mine.length ? mine : all;
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

  var SUGGEST_LABELS = { own: 'Own photo', organiser: 'Organiser\'s site', library: 'Library' };
  var flaggedPeople = function (s) { return s.people === 'unknown'; };

  function suggestStrip(r) {
    var list = r._suggest;
    if (!list) return null;
    var choice = str(r.image_choice);
    var canChoose = S.data.pending.headers.indexOf('image_choice') >= 0;
    var box = h('section', { class: 'suggest', 'aria-label': 'Suggested images' }, h('h3', null, 'Suggested images'));
    if (!list.length) { add(box, h('p', { class: 'meta' }, 'None found for this event.')); return box; }
    if (!canChoose) add(box, h('div', { class: 'note warn' }, 'Add an image_choice column at the end of Pending to choose here.'));
    var choose = function (sid) {
      return async function () {
        if (S.busy) return;
        S.busy = true;
        var res = await api('/admin/api/suggest', { id: r.id, sid: sid, expected: choice });
        S.busy = false;
        if (res.ok) { r.image_choice = res.json.value; toast(res.json.message || 'Saved'); }
        else {
          if (res.json.current !== undefined) r.image_choice = res.json.current;
          toast(res.status === 409 && res.json.current !== undefined ? 'Changed in the Sheet since you loaded the page. Not saved.' : (res.json.error || 'Not saved'), true);
        }
        render();
      };
    };
    var anyFlag = false;
    var tiles = list.map(function (s) {
      var chosen = choice === s.id;
      var flag = flaggedPeople(s);
      if (flag) anyFlag = true;
      var blocked = flag && !truthy(r.people_ok);
      var label = SUGGEST_LABELS[s.source] || s.source;
      var links = [];
      if (s.source === 'library') {
        links.push(/pixabay\.com/i.test(str(s.page))
          ? h('a', { href: 'https://pixabay.com', target: '_blank', rel: 'noopener noreferrer' }, 'Images from Pixabay')
          : h('a', { href: 'https://www.pexels.com', target: '_blank', rel: 'noopener noreferrer' }, 'Photos provided by Pexels'));
      }
      if (/^https:\/\//i.test(str(s.page))) links.push(h('a', { href: str(s.page), target: '_blank', rel: 'noopener noreferrer' }, s.source === 'library' ? 'Photo page' : 'Source page'));
      return h('figure', { class: 'sg' + (chosen ? ' chosen' : '') },
        h('span', { class: 'sg-src' }, label),
        /^data:image\/jpeg;base64,/.test(str(s.thumb))
          ? h('img', { src: str(s.thumb), alt: str(s.alt) || ('Suggested image: ' + label) })
          : h('div', { class: 'sg-none' }, 'No preview'),
        h('figcaption', null,
          str(s.caption) ? h('div', { class: 'sg-credit' }, str(s.caption)) : null,
          flag ? h('span', { class: 'badge bad' }, 'May show people') : null,
          links.length ? h('div', { class: 'sg-links' }, links) : null),
        h('button', { class: 'btn' + (chosen ? ' primary' : ''), disabled: chosen || blocked || !canChoose,
          title: blocked ? 'Tick "People OK" first' : null, 'aria-pressed': chosen ? 'true' : 'false', onclick: choose(s.id) },
        chosen ? 'Chosen' : 'Choose'));
    });
    add(box, h('div', { class: 'sg-list' }, tiles));
    if (anyFlag && !truthy(r.people_in_image)) add(box, peopleTick('Pending', r.id, r, 'A suggested image may show people. Tick only if that is all right to publish.'));
    add(box, h('div', { class: 'actions' },
      h('button', { class: 'btn', disabled: choice === 'none' || !canChoose, 'aria-pressed': choice === 'none' ? 'true' : 'false', onclick: choose('none') },
        choice === 'none' ? 'No image chosen' : 'None of these')));
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
    var sel = wide() ? pickSelected('reply', rows, 'reply_id') : null;
    rows.forEach(function (r) {
      els.push(entry('reply', r.reply_id, function () { return replySummary(r); }, function () { return replyCard(r); }, r));
    });
    var owed = owedList(d, true);
    if (owed.length) els.push(h('h2', { class: 'section' }, 'Still owed a reply'), owed);
    els.push(sentSection(d.sent || [], 'sentR', 'Sent'));
    return { els: els, selected: sel ? function () { return replyCard(sel); } : null };
  }

  // Sent history (Replies screen: every reply and outreach email; Outreach view: nudges only),
  // newest first, folded until opened. Each row opens to the text as it went.
  function sentSection(rows, key, title) {
    var open = !!S[key];
    var els = [h('h2', { class: 'section' }, title + ' (' + rows.length + ')'),
      h('button', { class: 'btn link', onclick: function () { S[key] = !S[key]; render(); } }, open ? 'Hide sent' : 'Show sent')];
    if (!open) return h('div', { class: 'sent' }, els);
    if (!rows.length) return h('div', { class: 'sent' }, els, h('p', { class: 'empty' }, 'Nothing sent yet.'));
    var q = h('input', { class: 'f', type: 'search', placeholder: 'Search sent', value: S[key + 'Q'] || '', 'aria-label': 'Search sent',
      oninput: function () { S[key + 'Q'] = q.value; draw(); } });
    var box = h('div');
    var draw = function () {
      var words = lower(q.value).split(/\s+/).filter(Boolean);
      var hits = rows.filter(function (r) {
        var hay = lower([r.name, r.to, r.subject, r.body, r.type].join(' '));
        return words.every(function (w) { return hay.indexOf(w) >= 0; });
      });
      box.replaceChildren.apply(box, hits.length ? hits.map(function (r) {
        return h('details', { class: 'card' },
          h('summary', null, h('b', null, str(r.subject) || '(no subject)'),
            h('div', { class: 'meta' }, ['To ' + (str(r.name) ? str(r.name) + ' (' + str(r.to) + ')' : str(r.to)), 'sent ' + when(r.sent_at), str(r.type)].filter(Boolean).join(' · '))),
          h('div', { class: 'text' }, str(r.body)));
      }) : [h('p', { class: 'empty' }, 'Nothing matches.')]);
    };
    draw();
    return h('div', { class: 'sent' }, els, q, box);
  }

  function replyHead(r) {
    var b = [h('span', { class: 'badge' }, str(r.type) || 'reply')];
    if (str(r.hold_reason)) b.push(h('span', { class: 'badge warn' }, str(r.hold_reason)));
    if (str(r.class)) b.push(h('span', { class: 'badge' }, str(r.class)));
    return [h('h2', null, str(r.subject) || '(no subject)'),
      h('div', { class: 'meta' }, 'To ' + str(r.to) + (r.created_at ? ' · drafted ' + when(r.created_at) : '')),
      h('div', { class: 'badges' }, b)];
  }
  // Their email (the one this draft answers), loaded from Gmail once and kept in S.mail.
  // Outreach drafts answer nothing: they say so instead.
  function theirMail(r) {
    var m = str(r.message_id);
    var box = h('div', { class: 'their' });
    if (!/^[A-Za-z0-9]{6,40}$/.test(m)) {
      add(box, [h('div', { class: 'meta' }, str(r.type) === 'outreach' ? 'Outreach: Holly\'s own first email to ' + str(r.to) + ', not a reply.' : 'No email to show.'),
        str(r.notes) ? h('div', { class: 'meta' }, str(r.notes)) : null]);
      return box;
    }
    var fill = function (t) {
      box.replaceChildren();
      if (!t || t.error) { add(box, h('div', { class: 'meta' }, 'Their email could not be loaded.')); return; }
      add(box, [h('div', { class: 'meta' }, ['From ' + (str(t.from) || str(r.to)), str(t.date)].filter(Boolean).join(' · ')),
        h('div', { class: 'text' }, str(t.text) || '(no text)'),
        // Their signature block and the earlier emails quoted below it, folded.
        str(t.more) ? h('details', { class: 'their-more' }, h('summary', null, 'Show the rest (signature and earlier emails)'),
          h('div', { class: 'text' }, str(t.more))) : null]);
    };
    S.mail = S.mail || {};
    if (S.mail[m]) fill(S.mail[m]);
    else {
      add(box, h('span', { class: 'meta' }, 'Loading their email…'));
      api('/admin/api/mail-text?m=' + encodeURIComponent(m)).then(function (res) {
        S.mail[m] = res.ok ? res.json : { error: true };
        fill(S.mail[m]);
      });
    }
    return box;
  }
  // Desktop list: their email (left); the draft to review is in the right-hand panel.
  function replySummary(r) {
    return [h('h2', null, str(r.subject) || '(no subject)'), h('div', { class: 'badges' }, h('span', { class: 'badge' }, str(r.type) || 'reply')),
      h('h3', { class: 'their-h' }, str(r.type) === 'outreach' ? 'Why' : 'Their email'), theirMail(r)];
  }

  function replyCard(r) {
    var c = h('div', { class: 'card' }, replyHead(r));
    // Phone: no side panel, so their email sits above the draft, folded.
    if (!wide()) add(c, h('details', { class: 'their-fold' }, h('summary', null, str(r.type) === 'outreach' ? 'Why this email' : 'Their email'), theirMail(r)));
    // Your own thread: Holly drafted nothing; reply in Gmail, then Done (a skip).
    if (str(r.type) === 'own') {
      add(c, [h('div', { class: 'note' }, 'Your own thread: you wrote to them yourself, so Holly hasn\'t drafted anything. Reply in Gmail, then tap Done.'),
        h('div', { class: 'actions' },
          /^[A-Za-z0-9]{6,40}$/.test(str(r.message_id)) ? h('a', { class: 'btn primary', href: 'https://mail.google.com/mail/u/0/#all/' + str(r.message_id), target: '_blank', rel: 'noopener' }, 'Reply in Gmail') : null,
          h('button', { class: 'btn', onclick: function () { act('reply', r.reply_id, 'reject', null, 'Done'); } }, 'Done'),
          sheetLink('Replies', r._row))]);
      return c;
    }
    add(c, [h('h3', { class: 'their-h' }, 'Holly\'s reply'), h('div', { class: 'text' }, str(r.body))]);
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

  // Where a published photo is on the site (_pages from the state, pages in a copies
  // group): one link per page, to the live page in a new tab. null = not known.
  function onSite(pages) {
    if (!Array.isArray(pages)) return h('div', { class: 'onsite meta' }, 'On the website (pages unknown)');
    var ok = pages.filter(function (p) { return /^https:[/][/]/.test(str(p.url)); });
    if (!ok.length) return h('div', { class: 'onsite meta' }, 'On the website (not used on any page)');
    var links = [];
    ok.forEach(function (p, i) {
      if (i) links.push(' · ');
      links.push(h('a', { href: p.url, target: '_blank', rel: 'noopener', onclick: function (e) { e.stopPropagation(); } }, str(p.label)));
    });
    return h('div', { class: 'onsite meta' }, 'On the website: ', links);
  }

  // Yes or no in a box over the page (over an overlay too), with the photo's page links
  // (or, for several photos, list: nodes naming each with its links).
  function ask(message, pages, yes, list) {
    return new Promise(function (resolve) {
      var box;
      var esc = function (e) { if (e.key === 'Escape') { e.stopPropagation(); done(false); } };
      var done = function (v) { box.remove(); document.removeEventListener('keydown', esc, true); resolve(v); };
      var no = h('button', { class: 'btn', onclick: function () { done(false); } }, 'Cancel');
      box = h('div', { class: 'ask', role: 'alertdialog', 'aria-modal': 'true' },
        h('div', { class: 'box' }, h('p', { class: 'msg' }, message), list || onSite(pages),
          h('div', { class: 'actions' }, h('button', { class: 'btn danger', onclick: function () { done(true); } }, yes), no)));
      document.addEventListener('keydown', esc, true);
      document.body.appendChild(box);
      no.focus();
    });
  }

  // The Photos menu: S.pf '' = waiting for a decision; PAST = organisers' images whose
  // event is over; BIN = the To delete folder; else a folder path under Lenches Photos
  // ("Rous Lench / Churches"), matched against the Photos tab's path, subfolders included.
  // A photo whose file is in To delete shows only there (the run leaves its path as it was).
  var PAST = ':past';
  var BIN = ':bin';
  function inFolder(r, path) { var p = str(r.path); return p === path || p.indexOf(path + ' / ') === 0; }
  function photoFolders(d) { return Array.isArray(d.photoFolders) ? d.photoFolders : []; }
  function binFiles(d) { return Array.isArray(d && d.toDelete) ? d.toDelete : []; }
  function binOf(id) { return binFiles(S.data).find(function (b) { return b.id === id; }) || null; }
  function isRejectedFolder(f) { return f.names.some(function (n) { return lower(n) === 'rejected'; }); }
  // An organiser's image whose event's last day (end date, else date) is before today (UK).
  function pastEvent(d, r) { var e = r._organiser && str(r._organiser.end); return Boolean(e && str(d.today) && e < str(d.today)); }
  function liveRows(d) { return d.photos.rows.filter(function (r) { return !binOf(r.drive_id); }); }
  function photoRows(d) {
    var rows = liveRows(d);
    if (!S.pf) return rows.filter(function (r) { return r._waiting && !S.done['photo:' + r.drive_id]; });
    if (S.pf === PAST) {
      return rows.filter(function (r) { return pastEvent(d, r); }).slice().sort(function (a, b) {
        return str(a._organiser.end).localeCompare(str(b._organiser.end)) || str(a.filename).localeCompare(str(b.filename));
      });
    }
    return rows.filter(function (r) { return inFolder(r, S.pf); }).slice().sort(function (a, b) {
      return str(a.path).localeCompare(str(b.path)) || str(a.filename).localeCompare(str(b.filename));
    });
  }
  function pickFolder(path, key) {
    S.pf = path; S.sel.photo = null; S.picked = {};
    render(); window.scrollTo(0, 0);
    if (key) { var el = findKey(document.querySelector('nav .tree'), key); if (el) el.focus(); }
  }

  /* ------------------------------------------------------ photo folders -- */

  // The Photos folder menu (desktop sidebar) and the Move to… list come only from the live
  // Drive folders in the state (photoFolders), never from names in code, so a folder made
  // in Drive appears after Reload. Which folders are open is kept in this browser; if that
  // can't be read, all start collapsed.
  var OPEN_KEY = 'lenches-admin-open-folders';
  function loadOpen() {
    try {
      var v = JSON.parse(window.localStorage.getItem(OPEN_KEY) || '[]');
      var o = {};
      if (Array.isArray(v)) v.forEach(function (id) { if (typeof id === 'string') o[id] = true; });
      return o;
    } catch (e) { return {}; }
  }
  function saveOpen() {
    try { window.localStorage.setItem(OPEN_KEY, JSON.stringify(Object.keys(S.openF))); } catch (e) { /* kept for this visit only */ }
  }
  S.openF = loadOpen();

  // { root, list, byId, kids (parent id -> folders), byPath (path -> id; '' if two share it) }
  function folderModel(d) {
    var root = str(d.photosRoot);
    var list = photoFolders(d).map(function (f) {
      return { id: f.id, parent: f.parent, names: f.names, path: f.names.join(' / '), name: f.names[f.names.length - 1], level: f.names.length };
    });
    var byId = Object.create(null);
    var byPath = Object.create(null);
    var kids = Object.create(null);
    list.forEach(function (f) { byId[f.id] = f; byPath[f.path] = f.path in byPath ? '' : f.id; });
    list.forEach(function (f) {
      if (!byId[f.parent]) f.parent = (f.level > 1 && byPath[f.names.slice(0, -1).join(' / ')]) || root;
      (kids[f.parent] = kids[f.parent] || []).push(f);
    });
    return { root: root, list: list, byId: byId, byPath: byPath, kids: kids };
  }
  // The Drive folder a photo is in, from its Photos-tab path ('' = not known: reload).
  function folderIdOf(m, r) { var p = str(r.path); return p ? (m.byPath[p] || '') : m.root; }
  function findKey(tree, key) {
    if (!tree) return null;
    return Array.prototype.find.call(tree.querySelectorAll('[role="treeitem"]'), function (x) { return x.getAttribute('data-key') === key; }) || null;
  }

  var hoverTimer = null;
  var hoverKey = '';
  function clearHover() { clearTimeout(hoverTimer); hoverTimer = null; hoverKey = ''; }

  // The folder tree. opts.move = the photos being moved (the Move to… list, any width,
  // large buttons; picking a folder calls opts.onPick); none = the sidebar menu, where
  // picking shows the folder and (desktop) every folder is a drop target.
  // Keyboard: Up/Down, Home/End, Right opens (or goes to the first subfolder), Left
  // closes (or goes to the parent), Enter or Space picks.
  function folderTree(d, opts) {
    var m = folderModel(d);
    var t = d.photos;
    var rows = t.error ? [] : liveRows(d);
    var count = function (path) { return t.error ? '' : rows.filter(function (r) { return inFolder(r, path); }).length; };
    var waiting = t.error ? '' : rows.filter(function (r) { return r._waiting && !S.done['photo:' + r.drive_id]; }).length;
    var past = t.error ? '' : rows.filter(function (r) { return pastEvent(d, r); }).length;
    var binN = d.toDelete && d.toDelete.error ? '!' : binFiles(d).length;
    var focusKey = '';
    var tree = h('div', { class: 'tree', role: 'tree', 'aria-label': opts.move ? 'Folders to move to' : 'Photo folders', onkeydown: keys });
    var filter = h('input', {
      class: 'f ffilter', type: 'search', placeholder: 'Filter folders', 'aria-label': 'Filter folders', value: S.ff, 'data-nofocus': true,
      oninput: function () { S.ff = filter.value; draw(); },
      onkeydown: function (e) { if (e.key === 'ArrowDown') { e.preventDefault(); var x = tree.querySelector('[role="treeitem"]'); if (x) x.focus(); } }
    });
    var tools = h('div', { class: 'ftools' }, filter, h('div', { class: 'fbtns' },
      h('button', { class: 'btn link', type: 'button', onclick: function () {
        m.list.forEach(function (f) { if (m.kids[f.id]) S.openF[f.id] = true; });
        saveOpen(); draw();
      } }, 'Expand all'),
      h('button', { class: 'btn link', type: 'button', onclick: function () { S.openF = {}; saveOpen(); draw(); } }, 'Collapse all')));

    // Folders shown: all under open folders; with a filter, those whose path matches and
    // the folders above them (opened).
    function visible() {
      var q = lower(S.ff);
      var hit = Object.create(null);
      if (q) {
        m.list.forEach(function (f) {
          if (lower(f.path).indexOf(q) < 0) return;
          for (var x = f; x; x = m.byId[x.parent]) hit[x.id] = true;
        });
      }
      var out = [];
      var walk = function (parent) {
        (m.kids[parent] || []).forEach(function (f) {
          if (q && !hit[f.id]) return;
          out.push(f);
          if (q || S.openF[f.id]) walk(f.id);
        });
      };
      walk(m.root);
      return out;
    }

    // Already in this folder: every photo being moved (or dragged) is in it.
    var allIn = function (list, f) { return list.every(function (r) { return str(r.path) === f.path; }); };

    // The menu's own entries (no folder): Waiting, Past events, To delete.
    var SPECIAL = { waiting: ['', 'Waiting for a decision'], past: [PAST, "Organisers' images whose event is over"], bin: [BIN, 'Files waiting for you to empty in Drive'] };
    function item(key, f, label, n) {
      var level = f ? f.level : 1;
      var hasKids = Boolean(f && m.kids[f.id]);
      var open = hasKids && Boolean(S.ff || S.openF[f.id]);
      var here = Boolean(opts.move && f && allIn(opts.move, f));
      var rej = Boolean(f && isRejectedFolder(f));
      var sp = SPECIAL[key];
      var el = h('div', {
        role: 'treeitem', 'data-key': key, 'aria-level': String(level), tabindex: '-1',
        'aria-expanded': hasKids ? String(open) : null,
        'aria-current': !opts.move && S.pf === (f ? f.path : sp ? sp[0] : null) ? 'page' : null,
        'aria-disabled': here || (opts.move && rej) ? 'true' : null,
        class: 'fi' + (f && level === 1 ? ' top' : '') + (key === 'bin' ? ' bin' : ''),
        title: f ? f.path + (rej ? ' (rejected photos go to To delete now)' : '') : sp[1],
        style: 'padding-left:' + (4 + (level - 1) * 14) + 'px',
        onclick: function () { activate(key); }
      },
      h('span', { class: 'tw', 'aria-hidden': 'true', onclick: hasKids ? function (e) { e.stopPropagation(); toggle(key); } : null }, hasKids ? (open ? '▾' : '▸') : ''),
      h('span', { class: 'nm' }, label),
      here ? h('span', { class: 'here' }, 'already here') : null,
      n === '' ? null : h('span', { class: 'n' }, String(n)));
      if ((f || key === 'bin') && !opts.move && wide()) dropTarget(el, f, key);
      return el;
    }

    function draw() {
      clearHover();
      var els = opts.move ? [] : [item('waiting', null, 'Waiting', waiting), item('past', null, 'Past events', past)];
      visible().forEach(function (f) { els.push(item(f.id, f, f.name, count(f.path))); });
      if (!els.length) els.push(h('p', { class: 'meta' }, S.ff ? 'No folder matches.' : 'No folders.'));
      if (!S.ff || lower('To delete').indexOf(lower(S.ff)) >= 0) els.push(item('bin', null, 'To delete', opts.move ? '' : binN));
      tree.replaceChildren.apply(tree, els);
      var cur = findKey(tree, focusKey) || tree.querySelector('[aria-current]') || tree.querySelector('[role="treeitem"]');
      if (cur) cur.tabIndex = 0;
    }

    function toggle(key) {
      if (S.openF[key]) delete S.openF[key]; else S.openF[key] = true;
      saveOpen();
      focusKey = key;
      draw();
      var el = findKey(tree, key);
      if (el) el.focus();
    }

    function activate(key) {
      if (key === 'bin' && opts.move) { opts.onPick(null); return; }
      if (SPECIAL[key]) { pickFolder(SPECIAL[key][0], key); return; }
      var f = m.byId[key];
      if (!f) return;
      if (!opts.move) { pickFolder(f.path, key); return; }
      if (allIn(opts.move, f)) { toast('Already in ' + f.path); return; }
      if (isRejectedFolder(f)) { toast('Rejected photos go to To delete now: pick To delete (last in the list)', true); return; }
      opts.onPick(f);
    }

    function keys(e) {
      var items = Array.prototype.slice.call(tree.querySelectorAll('[role="treeitem"]'));
      var i = items.indexOf(document.activeElement);
      if (i < 0) return;
      var el = items[i];
      var key = el.getAttribute('data-key');
      var exp = el.getAttribute('aria-expanded');
      var go = function (j) {
        if (j < 0 || j >= items.length) return;
        items.forEach(function (x) { x.tabIndex = -1; });
        items[j].tabIndex = 0;
        items[j].focus();
        focusKey = items[j].getAttribute('data-key');
      };
      if (e.key === 'ArrowDown') go(i + 1);
      else if (e.key === 'ArrowUp') go(i - 1);
      else if (e.key === 'Home') go(0);
      else if (e.key === 'End') go(items.length - 1);
      else if (e.key === 'ArrowRight') {
        if (exp === 'false') toggle(key);
        else if (exp === 'true') go(i + 1);
      } else if (e.key === 'ArrowLeft') {
        if (exp === 'true' && !S.ff) toggle(key);
        else {
          var lv = Number(el.getAttribute('aria-level'));
          for (var j = i - 1; j >= 0; j -= 1) if (Number(items[j].getAttribute('aria-level')) < lv) { go(j); break; }
        }
      } else if (e.key === 'Enter' || e.key === ' ') activate(key);
      else return;
      e.preventDefault();
    }

    // Desktop: drop photos on a folder. Not on the folder they are all already in (To
    // delete is never listed; it keeps its own Compare copies flow). A closed folder
    // opens after a second's hover, so its subfolders can be reached.
    // To delete takes any photo (always with a confirm); a Rejected folder takes none.
    function dropTarget(el, f, key) {
      var over = function (e) {
        if (!S.drag) return;
        if (!f) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; el.classList.add('drop'); return; }
        if (isRejectedFolder(f)) { el.classList.add('nodrop'); e.dataTransfer.dropEffect = 'none'; return; }
        if (m.kids[f.id] && !S.openF[f.id] && !S.ff && hoverKey !== key) {
          clearHover();
          hoverKey = key;
          hoverTimer = setTimeout(function () { S.openF[f.id] = true; saveOpen(); draw(); }, 1000);
        }
        if (allIn(S.drag, f)) { el.classList.add('nodrop'); e.dataTransfer.dropEffect = 'none'; return; }
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        el.classList.add('drop');
      };
      el.addEventListener('dragenter', over);
      el.addEventListener('dragover', over);
      el.addEventListener('dragleave', function (e) {
        // Moving onto the name or count inside it is not leaving it.
        var b = el.getBoundingClientRect();
        if (e.clientX > b.left && e.clientX < b.right && e.clientY > b.top && e.clientY < b.bottom) return;
        el.classList.remove('drop', 'nodrop');
        if (hoverKey === key) clearHover();
      });
      el.addEventListener('drop', function (e) {
        e.preventDefault();
        el.classList.remove('drop', 'nodrop');
        clearHover();
        var list = S.drag;
        S.drag = null;
        if (list && !f) binRows(list);
        else if (list && !isRejectedFolder(f) && !allIn(list, f)) moveRows(list, f);
      });
    }

    draw();
    return h('div', { class: opts.move ? 'folders move-tree' : 'folders' }, tools, tree);
  }

  /* ------------------------------------------------- moving photos about -- */

  function pickedRows() {
    var t = S.data.photos;
    return t.error ? [] : t.rows.filter(function (r) { return S.picked[r.drive_id]; });
  }
  function nPhotos(n) { return n === 1 ? '1 photo' : n + ' photos'; }
  function relPath(folder) { return str(folder).replace(/^Lenches Photos( \/ )?/, ''); }
  function moveError(res) {
    return res.status === 409 && res.json.currentPath ? 'moved in Drive since you loaded the page (now in ' + res.json.currentPath + ')' : bad(res);
  }

  // Tick box on a photo in the list: picks it for a multi-photo drag or Move to….
  function pickBox(r) {
    return h('label', { class: 'pick', title: 'Select', onclick: function (e) { e.stopPropagation(); } },
      h('input', { type: 'checkbox', checked: S.picked[r.drive_id], 'aria-label': 'Select ' + str(r.filename), onchange: function (e) {
        if (e.target.checked) S.picked[r.drive_id] = true; else delete S.picked[r.drive_id];
        fillPickBar(document.getElementById('pickbar'));
      } }));
  }

  // The multi-select bar above the list (hidden while nothing is ticked).
  function fillPickBar(bar) {
    if (!bar) return;
    var picked = pickedRows();
    bar.hidden = !picked.length;
    if (!picked.length) { bar.replaceChildren(); return; }
    var view = S.viewRows || [];
    bar.replaceChildren.apply(bar, [
      h('b', null, picked.length + ' selected'),
      wide() ? h('span', { class: 'meta' }, 'Drag one onto a folder to move them all') : null,
      h('span', { class: 'spacer' }),
      view.length > picked.length ? h('button', { class: 'btn link', onclick: function () {
        view.forEach(function (r) { S.picked[r.drive_id] = true; }); render();
      } }, 'Select all ' + view.length) : null,
      h('button', { class: 'btn primary', onclick: function () { moveTo(pickedRows()); } }, 'Move to…'),
      h('button', { class: 'btn', onclick: function () { S.picked = {}; render(); } }, 'Clear')].filter(Boolean));
  }

  // Desktop: a list entry can be dragged onto a folder; if it is ticked, every ticked photo goes.
  function dragSource(el, r) {
    el.draggable = true;
    el.addEventListener('dragstart', function (e) {
      var list = S.picked[r.drive_id] ? pickedRows() : [r];
      S.drag = list;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', list.map(function (x) { return str(x.filename); }).join('\n'));
      var ghost = h('div', { class: 'ghost' }, list.length === 1 ? str(r.filename) : nPhotos(list.length));
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, 12, 12);
      setTimeout(function () { ghost.remove(); }, 0);
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', function () {
      S.drag = null;
      clearHover();
      el.classList.remove('dragging');
      document.querySelectorAll('.tree .drop, .tree .nodrop').forEach(function (x) { x.classList.remove('drop', 'nodrop'); });
    });
  }

  // Phone (and the multi-select bar): the same folders as large buttons, full screen.
  function moveTo(list) {
    if (!list.length) return;
    var names = list.map(function (r) { return str(r.filename); });
    overlay('Move to…', h('div', null,
      h('p', { class: 'meta' }, list.length === 1 ? 'Moving ' + names[0] + '. Pick a folder.'
        : 'Moving ' + nPhotos(list.length) + ': ' + names.slice(0, 5).join(', ') + (names.length > 5 ? ' and ' + (names.length - 5) + ' more' : '') + '. Pick a folder.'),
      folderTree(S.data, { move: list, onPick: function (f) { closeOverlay(); if (f) moveRows(list, f); else binRows(list); } })));
  }

  // A published photo changes its village/subject on the site: confirm first, naming each
  // one with its page links.
  function confirmPublished(list, pub, dest) {
    var off = dest.names.some(function (n) { return lower(n) === 'rejected' || str(n).charAt(0) === '_'; });
    var one = list.length === 1;
    var msg = (one ? str(pub[0].filename) + ' is ON THE WEBSITE.'
      : pub.length + ' of these ' + list.length + ' photos ' + (pub.length === 1 ? 'is' : 'are') + ' ON THE WEBSITE.') +
      '\n\nMoving to ' + dest.path + ': this changes ' + (pub.length === 1 ? 'its' : 'their') + ' village/subject on the website.' +
      (off ? ' In a Rejected folder or a folder starting with _ ' + (pub.length === 1 ? 'it comes' : 'they come') + ' off the site on the next daily photos run, and pages using ' + (pub.length === 1 ? 'it lose the picture.' : 'them lose the pictures.') : '') +
      '\n\nYou can Undo straight after.\n\n' + (one ? 'Move it?' : 'Move all ' + list.length + '?');
    var names = pub.map(function (r) { return h('div', { class: 'pubrow' }, h('b', null, str(r.filename)), onSite(r._pages)); });
    return ask(msg, null, 'Move', h('div', { class: 'publist' }, names));
  }

  // Move photos one by one with the stale-checked move (each carries the folder the page
  // loaded). One failure doesn't stop the rest; failures are listed. Then Undo for 8 seconds.
  async function moveRows(list, dest) {
    if (S.busy) { toast('Wait for the last move to finish', true); return; }
    var m = folderModel(S.data);
    var todo = list.filter(function (r) { return str(r.path) !== dest.path; });
    if (!todo.length) { toast('Already in ' + dest.path); return; }
    var pub = todo.filter(function (r) { return str(r.published_at); });
    if (pub.length && !(await confirmPublished(todo, pub, dest))) return;
    S.busy = true;
    var moved = [];
    var failed = [];
    try {
      for (var i = 0; i < todo.length; i += 1) {
        var r = todo[i];
        if (todo.length > 1) toast('Moving ' + (i + 1) + ' of ' + todo.length + '…');
        var from = folderIdOf(m, r);
        if (!from) { failed.push({ r: r, error: 'its folder is not in the list (press Reload)' }); continue; }
        var res = await fileOp({ op: 'move', id: r.drive_id, expectedParent: from, to: dest.id });
        if (res.ok) {
          moved.push({ r: r, from: from });
          r.path = relPath(res.json.folder);
          delete S.files[r.drive_id];
          delete S.picked[r.drive_id];
        } else failed.push({ r: r, error: moveError(res) });
      }
    } finally { S.busy = false; }
    render();
    var text = moved.length
      ? 'Moved ' + (moved.length === 1 ? moved[0].r.filename : nPhotos(moved.length)) + ' to ' + dest.path + '. Village and subject follow on the next photos run.'
      : 'Nothing moved.';
    undoBox(text, failed, moved.length ? function () { undoMoves(moved, dest); } : null);
  }

  async function undoMoves(moved, dest) {
    if (S.busy) { toast('Wait for the last move to finish', true); return; }
    S.busy = true;
    var back = 0;
    var failed = [];
    try {
      for (var i = 0; i < moved.length; i += 1) {
        var x = moved[i];
        var res = await fileOp({ op: 'move', id: x.r.drive_id, expectedParent: dest.id, to: x.from });
        if (res.ok) { x.r.path = relPath(res.json.folder); delete S.files[x.r.drive_id]; back += 1; }
        else failed.push({ r: x.r, error: moveError(res) });
      }
    } finally { S.busy = false; }
    render();
    undoBox(back ? 'Moved ' + nPhotos(back) + ' back.' : 'Nothing moved back.', failed, null);
  }

  // The result of a move, bottom of the screen: Undo for 8 seconds. Failures stay listed
  // until closed.
  var undoTimer = null;
  function undoBox(text, failed, onUndo) {
    var old = document.querySelector('.undo');
    if (old) old.remove();
    var t = document.querySelector('.toast');
    if (t) t.remove();
    clearTimeout(undoTimer);
    var box;
    var close = function () { clearTimeout(undoTimer); box.remove(); };
    var undo = onUndo ? h('button', { class: 'btn primary', onclick: function () { close(); onUndo(); } }, 'Undo') : null;
    box = h('div', { class: 'undo' + (failed.length ? ' bad' : ''), role: 'status' },
      h('div', { class: 'msg' }, text,
        failed.length ? [h('div', null, 'Not moved (' + failed.length + '):'),
          h('ul', null, failed.map(function (x) { return h('li', null, str(x.r.filename) + ': ' + x.error); }))] : null),
      h('div', { class: 'actions' }, undo, h('button', { class: 'btn', onclick: close }, 'Close')));
    document.body.appendChild(box);
    undoTimer = setTimeout(function () {
      if (!failed.length) box.remove();
      else if (undo) undo.remove();
    }, 8000);
  }

  /* ------------------------------------------------------------ To delete -- */

  function rowOf(id) { var t = S.data.photos; return t.error ? null : t.rows.find(function (r) { return r.drive_id === id; }) || null; }
  function nowIso() { return new Date().toISOString().replace(/[.][0-9]+Z$/, 'Z'); }

  // After a move into To delete: the file shows there at once (as the Worker records it).
  function binned(r, from, binId) {
    var list = binFiles(S.data);
    if (!Array.isArray(S.data.toDelete)) S.data.toDelete = list;
    if (!binOf(r.drive_id)) {
      list.unshift({ id: r.drive_id, name: str(r.filename), folderId: binId, inside: '', from: { id: from, path: str(r.path), source: 'recorded' },
        movedAt: nowIso(), movedBy: 'panel', prevStatus: str(r.status) || 'new' });
    }
    r.status = 'rejected';
    r._waiting = false;
    delete S.picked[r.drive_id];
    delete S.files[r.drive_id];
  }

  // What a move to To delete does to a photo on the website (the daily photos run's rule).
  var BIN_SITE = 'Moving it to To delete takes it off the site on the next daily photos run (early morning): its picture files are removed, the site is rebuilt and pages using it lose the picture. Until that run nothing changes on the site. Restore (or Undo) puts it back where it was; if the run has already taken it down, the next run after the restore puts it back at the same web address.';

  // Into To delete, always with a confirm; marked rejected. reject = the Reject button.
  // Each move is stale-checked (status and folder the page loaded); one failure doesn't stop
  // the rest. Then Undo (Restore) for 8 seconds.
  async function binRows(list, reject) {
    if (S.busy) { toast('Wait for the last move to finish', true); return; }
    var m = folderModel(S.data);
    var todo = list.filter(function (r) { return !binOf(r.drive_id); });
    if (!todo.length) { toast('Already in To delete'); return; }
    var pub = todo.filter(function (r) { return str(r.published_at); });
    var one = todo.length === 1;
    var what = one ? str(todo[0].filename) : nPhotos(todo.length);
    var msg = (reject ? 'Reject ' + what + '? ' : 'Move ' + what + ' to To delete? ') +
      (one ? 'It goes' : 'They go') + ' into the To delete folder in Lenches Photos and ' + (one ? 'is' : 'are') + ' marked rejected. Nothing is deleted: you empty To delete yourself in Drive.';
    if (pub.length) {
      msg += '\n\n' + (one ? 'It is' : pub.length + ' of them ' + (pub.length === 1 ? 'is' : 'are')) + ' ON THE WEBSITE. ' + BIN_SITE;
    }
    var yes = await ask(msg, null, reject ? 'Reject' : 'Move to To delete',
      pub.length ? h('div', { class: 'publist' }, pub.map(function (r) { return h('div', { class: 'pubrow' }, h('b', null, str(r.filename)), onSite(r._pages)); })) : h('div'));
    if (!yes) return;
    S.busy = true;
    var moved = [];
    var failed = [];
    try {
      for (var i = 0; i < todo.length; i += 1) {
        var r = todo[i];
        if (todo.length > 1) toast('Moving ' + (i + 1) + ' of ' + todo.length + '…');
        var from = folderIdOf(m, r);
        if (!from) { failed.push({ r: r, error: 'its folder is not in the list (press Reload)' }); continue; }
        var res = await fileOp({ op: 'discard', id: r.drive_id, expected: r.status === undefined ? '' : r.status, expectedParent: from, confirmPublished: Boolean(str(r.published_at)) });
        if (res.ok) { binned(r, from, res.json.folderId); moved.push(r); }
        else failed.push({ r: r, error: moveError(res) });
      }
    } finally { S.busy = false; }
    render();
    var text = moved.length ? (reject ? 'Rejected ' : 'Moved ') + (moved.length === 1 ? moved[0].filename : nPhotos(moved.length)) + (reject ? ': moved to To delete.' : ' to To delete.') +
      (moved.some(function (r) { return str(r.published_at); }) ? ' The daily photos run takes it off the site.' : '') : 'Nothing moved.';
    undoBox(text, failed, moved.length ? function () { restoreFiles(moved.map(function (r) { return binOf(r.drive_id); }).filter(Boolean)); } : null);
  }

  // Back out of To delete to where each came from (Restore, or Undo of a move in).
  async function restoreFiles(list) {
    if (S.busy) { toast('Wait for the last move to finish', true); return; }
    S.busy = true;
    var back = [];
    var failed = [];
    try {
      for (var i = 0; i < list.length; i += 1) {
        var b = list[i];
        var res = await fileOp({ op: 'restore', id: b.id, expectedParent: b.folderId });
        var r = rowOf(b.id);
        if (res.ok) {
          S.data.toDelete = binFiles(S.data).filter(function (x) { return x.id !== b.id; });
          if (r) {
            r.path = relPath(res.json.folder);
            r.status = res.json.status;
            r._waiting = ['', 'new'].indexOf(lower(r.status)) >= 0;
            delete S.files[r.drive_id];
          }
          back.push(res.json.message);
        } else failed.push({ r: { filename: b.name }, error: moveError(res) });
      }
    } finally { S.busy = false; }
    render();
    undoBox(back.length === 1 ? back[0] : back.length ? 'Restored ' + nPhotos(back.length) + '.' : 'Nothing restored.', failed, null);
  }

  function binView(d) {
    var els = [];
    if (!wide()) els.push(folderPicker(d));
    els.push(h('p', { class: 'meta' }, 'Files in the To delete folder in ', photosLink('Lenches Photos'),
      '. The panel never deletes anything: empty it yourself in Drive when you are sure. Restore puts a file back where it came from.'));
    if (d.toDelete && d.toDelete.error) { els.push(errorNote(d.toDelete, 'To delete')); return { els: els }; }
    els.push(h('div', { class: 'toolbar' }, h('button', { class: 'btn', onclick: tidyView }, 'One-off tidy: old Rejected folders…')));
    var list = binFiles(d);
    if (!list.length) els.push(h('p', { class: 'empty' }, 'To delete is empty.'));
    var sel = wide() ? pickSelected('bin', list, 'id') : null;
    list.forEach(function (b) {
      els.push(entry('bin', b.id, function () { return binSummary(b); }, function () { return binCard(b); }, b));
    });
    return { els: els, selected: sel ? function () { return binCard(sel); } : null };
  }

  function binFacts(b) {
    var r = rowOf(b.id);
    var from = b.from && !b.from.error
      ? 'From: ' + (b.from.path || 'Lenches Photos (top level)') + (b.from.source === 'sheet' ? ' (from the Photos tab)' : '')
      : 'From: not known' + (b.from && b.from.error ? ' (' + b.from.error + ')' : '');
    var moved = b.movedAt ? 'Moved ' + (b.movedBy === 'run' ? 'on or before ' + day(b.movedAt) + ' (noticed by the photos run)' : when(b.movedAt)) : 'Moved: when not known (moved in Drive)';
    return { r: r, lines: [from, moved, b.inside ? 'In To delete / ' + b.inside : ''].filter(Boolean) };
  }

  function binWarning(b, r) {
    if (r && str(r.published_at)) {
      return h('div', { class: 'note bad' }, 'Still ON THE WEBSITE: the next daily photos run takes it off, and pages using it lose the picture. Restore it before then and nothing changes.', onSite(r._pages));
    }
    if (lower(b.prevStatus) === 'approved') {
      return h('div', { class: 'note warn' }, 'It was approved before the move. Restore sets it back to approved, and the next photos run puts it back on the site at the same web address.');
    }
    return null;
  }

  function binSummary(b) {
    var f = binFacts(b);
    return [h('h2', null, str(b.name)), f.lines.map(function (l) { return h('div', { class: 'meta' }, l); }),
      f.r && str(f.r.published_at) ? h('div', { class: 'badges' }, h('span', { class: 'badge bad' }, 'On the website')) : null];
  }

  function binCard(b) {
    var f = binFacts(b);
    var src = '/admin/img/drive/' + encodeURIComponent(b.id);
    var why = !f.r ? 'No Photos row for this file: move it in Drive' : b.from && b.from.error ? b.from.error : '';
    return h('div', { class: 'card photo bin' },
      h('a', { href: src + '?size=1600', target: '_blank', rel: 'noopener' }, h('img', { src: src + '?size=600', alt: str(b.name), loading: 'lazy' })),
      h('h2', null, str(b.name)),
      f.lines.map(function (l) { return h('div', { class: 'meta' }, l); }),
      binWarning(b, f.r),
      why ? h('div', { class: 'note warn' }, 'Restore is not possible here: ' + why) : null,
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', disabled: why ? true : null, title: why || null, onclick: function () { restoreFiles([b]); } }, 'Restore'),
        f.r && str(f.r.drive_link) ? h('a', { class: 'btn link', href: str(f.r.drive_link), target: '_blank', rel: 'noopener' }, 'Open in Drive') : null,
        f.r ? sheetLink('Photos', f.r._row) : null));
  }

  // The one-off tidy: everything still in a Rejected folder, or marked rejected outside To
  // delete, listed first; nothing moves until you say yes. Safe to run again (it then finds
  // nothing, or only what was rejected the old way since).
  function tidyView() {
    var box = h('div', null, h('p', { class: 'meta' }, 'Looking in Lenches Photos…'));
    overlay('One-off tidy', box);
    api('/admin/api/photo-tidy').then(function (res) {
      if (!res.ok) { box.replaceChildren(h('div', { class: 'note bad' }, 'Could not list: ' + bad(res))); return; }
      var list = res.json.files;
      if (!list.length) { box.replaceChildren(h('p', null, 'Nothing to tidy: no file is in a Rejected folder, and every rejected photo is already in To delete.')); return; }
      var movable = list.filter(function (f) { return f.hasRow; });
      box.replaceChildren(
        h('p', null, list.length + ' file' + (list.length === 1 ? '' : 's') + ' found. Nothing has moved yet. Check the list, then move ' + (movable.length === list.length ? 'them' : 'the ' + movable.length + ' with a Photos row') + ' into To delete.'),
        h('table', { class: 'h' }, h('thead', null, h('tr', null, h('th', null, 'File'), h('th', null, 'Where'), h('th', null, 'Why'))),
          h('tbody', null, list.map(function (f) {
            return h('tr', null, h('td', null, str(f.name), f.published ? h('div', { class: 'badge bad' }, 'On the website') : null),
              h('td', null, f.path || 'Lenches Photos (top level)'),
              h('td', null, f.reason + (f.hasRow ? '' : ' · no Photos row: move it in Drive')));
          }))),
        h('div', { class: 'actions' }, movable.length ? h('button', { class: 'btn danger', onclick: function () { tidyMove(movable, box); } }, 'Move these ' + movable.length + ' to To delete') : null));
    });
  }

  async function tidyMove(list, box) {
    var pub = list.filter(function (f) { return f.published; });
    if (!(await ask('Move ' + nPhotos(list.length) + ' into To delete and mark ' + (list.length === 1 ? 'it' : 'them') + ' rejected? Nothing is deleted.' +
      (pub.length ? '\n\n' + pub.length + ' of them ' + (pub.length === 1 ? 'is' : 'are') + ' ON THE WEBSITE. ' + BIN_SITE : ''), null, 'Move to To delete', h('div')))) return;
    var done = 0;
    var failed = [];
    for (var i = 0; i < list.length; i += 1) {
      var f = list[i];
      box.replaceChildren(h('p', { class: 'meta' }, 'Moving ' + (i + 1) + ' of ' + list.length + '…'));
      var res = await fileOp({ op: 'discard', id: f.id, expected: f.status, expectedParent: f.folderId, confirmPublished: f.published });
      if (res.ok) done += 1; else failed.push(str(f.name) + ': ' + moveError(res));
    }
    box.replaceChildren(h('p', null, 'Moved ' + nPhotos(done) + ' to To delete.'), failed.length ? h('ul', null, failed.map(function (x) { return h('li', null, x); })) : null,
      h('p', { class: 'meta' }, 'Reloading…'));
    await load(true);
  }

  // Phone: a dropdown above the list.
  function folderPicker(d) {
    return h('select', { class: 'f', 'aria-label': 'Photo folder', onchange: function (e) { pickFolder(e.target.value); } },
      h('option', { value: '', selected: S.pf === '' ? true : null }, 'Waiting for a decision'),
      h('option', { value: PAST, selected: S.pf === PAST ? true : null }, 'Past events'),
      photoFolders(d).map(function (f) {
        var p = f.names.join(' / ');
        return h('option', { value: p, selected: S.pf === p ? true : null }, p);
      }),
      h('option', { value: BIN, selected: S.pf === BIN ? true : null }, 'To delete'));
  }

  function photosList(d) {
    var t = d.photos;
    if (t.error) return { els: [errorNote(t, 'Photos')] };
    if (S.pf === BIN) return binView(d);
    var rows = photoRows(d);
    var els = [];
    if (!wide()) els.push(folderPicker(d));
    if (d.photoFolders && d.photoFolders.error) els.push(errorNote(d.photoFolders, 'Drive folders'));
    els.push(h('p', { class: 'meta' }, S.pf === PAST
      ? "Organisers' images (from the Image fetch tab) whose event ended before today. Nothing moves by itself: move them to To delete here when you are ready."
      : S.pf
        ? 'Every photo in ' + S.pf + ', whatever its status. A move shows here at once, or after the next photos run if made in Drive.'
        : 'Approved photos are published by the daily photos run (early morning).'));
    if (S.pf === PAST && rows.length) {
      els.push(h('div', { class: 'toolbar' }, h('button', { class: 'btn danger', onclick: function () { binRows(photoRows(S.data)); } },
        'Move all ' + rows.length + ' shown to To delete')));
    }
    if (!rows.length) els.push(h('p', { class: 'empty' }, S.pf === PAST ? 'No past events with organisers\' images.' : S.pf ? 'No photos in this folder.' : 'No photos waiting.'));
    S.viewRows = rows;
    var bar = h('div', { class: 'pickbar', id: 'pickbar', role: 'region', 'aria-label': 'Selected photos' });
    fillPickBar(bar);
    els.push(bar);
    var sel = wide() ? pickSelected('photo', rows, 'drive_id') : null;
    rows.forEach(function (r) {
      var el = entry('photo', r.drive_id, function () { return [pickBox(r), photoSummary(r)]; }, function () { return photoCard(r, false); }, r);
      if (wide()) dragSource(el, r);
      els.push(el);
    });
    return { els: els, selected: sel ? function () { return photoCard(sel, true); } : null };
  }

  function photoBadges(r) {
    var b = [];
    var st = lower(r.status);
    if (!r._waiting) b.push(h('span', { class: st === 'approved' ? 'badge info' : 'badge' }, st ? st.charAt(0).toUpperCase() + st.slice(1) : 'New'));
    if (str(r.published_at)) b.push(h('span', { class: 'badge info' }, 'On the website'));
    if (r._organiser) b.push(h('span', { class: 'badge info' }, "Organiser's image"));
    if (consent(r)) b.push(h('span', { class: 'badge bad' }, (lower(r.people) === 'children' ? 'Children' : lower(r.people) === 'unknown' ? 'People: not checked' : 'Identifiable people') + (truthy(r.people_ok) ? ' · OK given' : '')));
    if (str(r.duplicate_of)) b.push(h('span', { class: 'badge warn' }, 'Possible duplicate'));
    return h('div', { class: 'badges' }, b);
  }

  function photoSummary(r) {
    return [h('h2', { class: 'fname', title: str(r.filename) }, str(r.filename)), h('div', { class: 'meta' }, [str(r.village), str(r.subject)].filter(Boolean).join(' · ')), photoBadges(r),
      str(r.published_at) ? onSite(r._pages) : null];
  }

  function photoCard(r, inDetail) {
    var src = '/admin/img/drive/' + encodeURIComponent(r.drive_id);
    var c = h('div', { class: 'card photo' }, inDetail ? null : pickBox(r),
      h('a', { href: src + '?size=1600', target: '_blank', rel: 'noopener' }, h('img', { src: src + '?size=600', alt: str(r.alt_text) || str(r.filename), loading: 'lazy' })),
      photoSummary(r));
    if (str(r.path)) add(c, h('div', { class: 'meta' }, 'In Lenches Photos / ' + str(r.path)));
    if (r._organiser) add(c, h('div', { class: 'meta' }, 'For: ' + str(r._organiser.event) + (str(r._organiser.source_page) ? ' · from ' + str(r._organiser.source_page) : '') +
      (pastEvent(S.data, r) ? ' · event over (' + day(r._organiser.end) + ')' : '')));
    if (str(r.credit)) add(c, h('div', { class: 'meta' }, 'Credit: ' + str(r.credit)));
    add(c, photoText(r));
    if (consent(r)) add(c, peopleTick('Photos', r.drive_id, r, 'Tick only if everyone shown is happy to appear (for children, their parents).'));
    var tid = 'tg-' + r.drive_id;
    var target = h('input', { class: 'f', id: tid, value: str(r.target), placeholder: 'e.g. home, church-lench' });
    add(c, h('form', { class: 'small', onsubmit: async function (e) {
      e.preventDefault();
      var res = await edit('Photos', r.drive_id, 'target', r.target, target.value);
      if (res.ok) { r.target = res.value; toast('Target saved'); }
      else { toast(res.status === 409 ? 'Changed in the Sheet (now "' + res.current + '"). Not saved.' : res.error, true); if (res.current !== undefined) r.target = res.current; }
      render();
    } }, h('label', { class: 'f', for: tid }, 'Target (where it is used)'),
    h('div', { class: 'toolbar' }, h('div', { class: 'spacer' }, target), h('button', { class: 'btn', type: 'submit' }, 'Save'))));
    var blocked = consent(r) && !truthy(r.people_ok);
    var decide = function (action, value, text) {
      act('photo', r.drive_id, action, { expected: r.status }, text).then(function (ok) {
        if (ok) { r.status = value; r._waiting = false; render(); }
      });
    };
    // Reject = into To delete, marked rejected (the same move as Move to To delete).
    add(c, h('div', { class: 'actions' },
      h('button', { class: 'btn primary', disabled: blocked, title: blocked ? 'Tick "People OK" first' : null, onclick: function () {
        decide('approve', 'approved', 'Approved');
      } }, 'Approve'),
      h('button', { class: 'btn danger', onclick: function () { binRows([r], true); } }, 'Reject'),
      h('button', { class: 'btn', onclick: function () { binRows([r]); } }, 'Move to To delete'),
      str(r.duplicate_of) ? h('button', { class: 'btn', onclick: function () { overlay('Possible duplicates', copiesView(r)); } }, 'Compare copies') : null,
      wide() ? null : h('button', { class: 'btn', onclick: function () { moveTo([r]); } }, 'Move to…'),
      str(r.drive_link) ? h('a', { class: 'btn link', href: str(r.drive_link), target: '_blank', rel: 'noopener' }, 'Open in Drive') : null,
      sheetLink('Photos', r._row)));
    add(c, fileBox(r, inDetail));
    return c;
  }

  // The run's drafts, editable: the description (a note for the editor) and the alt text
  // (read out on the website). Each field is stale-checked on its own.
  function photoText(r) {
    var did = 'de-' + r.drive_id;
    var aid = 'al-' + r.drive_id;
    var desc = h('textarea', { class: 'f', id: did, rows: 3, maxlength: 300 }, str(r.description));
    var alt = h('input', { class: 'f', id: aid, maxlength: 125, value: str(r.alt_text) });
    return h('form', { class: 'small', onsubmit: async function (e) {
      e.preventDefault();
      var changed = [['description', desc], ['alt_text', alt]].filter(function (x) { return x[1].value.trim() !== str(r[x[0]]); });
      if (!changed.length) { toast('No changes to save'); return; }
      for (var i = 0; i < changed.length; i += 1) {
        var name = changed[i][0];
        var res = await edit('Photos', r.drive_id, name, r[name] === undefined ? '' : r[name], changed[i][1].value);
        if (!res.ok) {
          toast(res.status === 409 && res.current !== undefined ? name + ' was changed in the Sheet (now "' + res.current + '"). Not saved.' : name + ': ' + res.error, true);
          if (res.current !== undefined) r[name] = res.current;
          render();
          return;
        }
        r[name] = res.value;
      }
      toast('Saved');
      render();
    } },
    h('label', { class: 'f', for: did }, 'Description (a note for you, not shown on the site)'), desc,
    h('label', { class: 'f', for: aid }, 'Alt text (read out on the website to people using screen readers; up to 125 characters)'), alt,
    h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'submit' }, 'Save text')));
  }

  /* ---------------------------------------------------------- photo files -- */

  function fileOp(body) { return api('/admin/api/photo-file', body); }
  function bad(res) { return res.json.error || ('HTTP ' + res.status); }

  // Rename, move and new folder, in the card itself. The file's live Drive name and folder
  // load when the section opens (open already in the desktop detail) and are kept in
  // S.files until a change, so the stale checks use Drive's own values.
  function fileBox(r, inDetail) {
    var id = r.drive_id;
    var inner = h('div', null);
    var started = false;
    var fill = async function () {
      started = true;
      if (!S.files[id]) {
        inner.replaceChildren(h('p', { class: 'meta' }, 'Loading from Drive…'));
        var res = await api('/admin/api/photo-file?id=' + encodeURIComponent(id));
        if (!res.ok) { inner.replaceChildren(h('div', { class: 'note bad' }, 'Could not load: ' + bad(res))); return; }
        S.files[id] = res.json;
      }
      inner.replaceChildren.apply(inner, fileParts(r, S.files[id].file, S.files[id].folders));
    };
    var det = h('details', { class: 'filebox', open: inDetail || S.open[id] ? true : null, ontoggle: function () {
      if (!inDetail) S.open[id] = det.open;
      if (det.open && !started) fill();
    } }, h('summary', null, 'Rename or move'), inner);
    if (det.open) fill();
    return det;
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

  // Folders are made in Google Drive itself, never by the panel, so they belong to Jon.
  function photosLink(text) {
    var id = str(S.data && S.data.photosRoot);
    return id ? h('a', { href: 'https://drive.google.com/drive/folders/' + encodeURIComponent(id), target: '_blank', rel: 'noopener' }, text) : text;
  }
  function newFolderNote() {
    return h('p', { class: 'meta' }, 'Need a new folder? Make it in Google Drive so it belongs to you: open ',
      photosLink('Lenches Photos'), ', go into the village (or General) folder, click New, then New folder. Press Reload here and it appears in the list.');
  }

  // After any change: drop the cached Drive state and redraw (the section reloads).
  function changed(r) { delete S.files[r.drive_id]; render(); }

  function fileParts(r, file, folders) {
    var out = [h('p', { class: 'meta' }, file.name + ' · in ' + file.folder)];
    if (file.toDelete) {
      out.push(h('div', { class: 'note warn' }, 'This file is in To delete. To use it again, Restore it from To delete (last in the Photos menu).'));
      return out;
    }

    var parts = splitExt(file.name);
    var nid = 'fn-' + r.drive_id;
    // "Will be saved as": the name after the clash check (core-N if the name is in use
    // anywhere under Lenches Photos), fetched as you type; checked again on Save.
    var willBe = h('p', { class: 'meta', 'aria-live': 'polite' });
    var shown = '';
    var seq = 0;
    var timer = null;
    var preview = function () {
      clearTimeout(timer);
      shown = '';
      willBe.textContent = '';
      if (!nameIn.value.trim() || nameIn.value.trim() === parts.stem) return;
      var mine = ++seq;
      timer = setTimeout(async function () {
        var res = await api('/admin/api/photo-name?id=' + encodeURIComponent(r.drive_id) + '&name=' + encodeURIComponent(nameIn.value));
        if (mine !== seq) return;
        if (!res.ok) { willBe.textContent = bad(res); return; }
        shown = res.json.name;
        willBe.textContent = 'Will be saved as ' + shown + (res.json.numbered ? ' (' + res.json.wanted + ' is already in use)' : '');
      }, 400);
    };
    // Pre-filled only with the photos run's suggestion for a name that doesn't describe
    // the picture (Photos tab suggested_name; '-' = the name is fine); else empty.
    var sugg = str(r.suggested_name).trim();
    if (sugg === '-' || str(r.filename) !== file.name || sugg.toLowerCase() === parts.stem.toLowerCase()) sugg = '';
    var nameIn = h('input', { class: 'f', id: nid, value: sugg, maxlength: 120, placeholder: 'Type a new name', oninput: preview });
    if (sugg) preview();
    out.push(h('form', { onsubmit: async function (e) {
      e.preventDefault();
      seq += 1;
      clearTimeout(timer);
      if (!nameIn.value.trim()) { toast('Type a new name first', true); return; }
      var res = await fileOp({ op: 'rename', id: r.drive_id, expected: file.name, name: nameIn.value });
      if (res.ok) {
        r.filename = res.json.name;
        r.suggested_name = '-';
        toast('Renamed to ' + res.json.name + (shown && shown !== res.json.name ? ' (' + shown + ' was taken meanwhile)'
          : !shown && res.json.numbered ? ' (' + res.json.wanted + ' is already in use)' : ''));
        changed(r);
      }
      else { toast(res.status === 409 && res.json.current ? 'Renamed in Drive since you loaded it (now "' + res.json.current + '"). Not changed.' : bad(res), true); if (res.status === 409) changed(r); }
    } },
    h('label', { class: 'f', for: nid }, 'New name' + (parts.ext ? ' (' + parts.ext + ' is kept)' : '')),
    h('div', { class: 'toolbar' }, h('div', { class: 'spacer' }, nameIn), h('button', { class: 'btn', type: 'submit' }, 'Rename')),
    sugg ? h('p', { class: 'meta' }, 'Suggested from the picture, as the current name doesn\'t describe it. Check or change it, then press Rename.') : null,
    willBe,
    h('p', { class: 'meta' }, file.published
      ? 'It stays at the same web address: the site keeps the name it was first published under.'
      : 'Characters such as / \\ : * ? " < > | are dropped.')));

    var mid = 'fm-' + r.drive_id;
    var dest = folderSelect(mid, folders, file.folderId);
    out.push(h('form', { onsubmit: async function (e) {
      e.preventDefault();
      if (dest.value === file.folderId) { toast('It is already in that folder'); return; }
      var to = folders.find(function (f) { return f.id === dest.value; });
      if (file.published && !(await ask(file.name + ' is ON THE WEBSITE.\n\nMoving it to ' + to.path + ' changes the village and subject it is shown under on the site. In a Rejected folder or a folder starting with _ it comes off the site on the next daily photos run, and pages using it lose the picture. To undo, move it back: before that run nothing changes; after it, if it came off the site, also click Approve and the next run puts it back at the same web address.\n\nMove it?', r._pages, 'Move'))) return;
      var res = await fileOp({ op: 'move', id: r.drive_id, expectedParent: file.folderId, to: dest.value });
      if (res.ok) {
        r.path = res.json.folder.replace(/^Lenches Photos( \/ )?/, '');
        toast('Moved to ' + res.json.folder + '. Village and subject in the Photos tab follow on the next photos run.');
        changed(r);
      } else { toast(res.status === 409 && res.json.currentPath ? 'Moved in Drive since you loaded it (now in ' + res.json.currentPath + '). Not changed.' : bad(res), true); if (res.status === 409) changed(r); }
    } },
    h('label', { class: 'f', for: mid }, 'Move to folder (village or General, then subject)'),
    h('div', { class: 'toolbar' }, h('div', { class: 'spacer' }, dest), h('button', { class: 'btn', type: 'submit' }, 'Move'))));

    out.push(newFolderNote());
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
        ? ['Copies that look the same (same picture, perhaps resized). "To delete" is a folder directly in ', photosLink('Lenches Photos'),
          ': nothing is binned, you empty it yourself in Drive. If it is not there yet, make it in Drive first (New, then New folder, named To delete).']
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
        m.toDelete ? h('span', { class: 'badge warn' }, 'In To delete') : null),
      m.published ? onSite(m.pages) : null);
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
      if (!(await ask(name + ' is ON THE WEBSITE. Moving it takes it off the site on the next photos run, and any page that names it loses the picture.\n\nTake it down and move it to To delete?', m.pages, 'Take down and move'))) return false;
      body.confirmPublished = true;
    }
    var res = await fileOp(body);
    if (res.ok) {
      var r = rowOf(m.drive_id);
      if (r) binned(r, m.folderId, res.json.folderId);
      toast(res.json.message);
      return true;
    }
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

  /* ------------------------------------------------------------- feedback -- */

  // Reader feedback (Feedback tab). _state comes from the server (admin/feedback.js):
  // waiting, postponed, approved (awaiting build), reply (a reply draft waiting).
  var FB_TYPES = { update: 'Suggested update', correction: 'Correction', other: 'Other feedback' };

  function fbRows(d, state) {
    if (!d.feedback || d.feedback.error) return [];
    return d.feedback.rows.filter(function (r) { return r._state === state && !S.done['feedback:' + r.id]; });
  }
  // Highest rating first (not rated yet last), then oldest first.
  function fbOrder(a, b) {
    var ra = Number(a.rating) || 0;
    var rb = Number(b.rating) || 0;
    return rb - ra || str(a.received).localeCompare(str(b.received));
  }
  function when2(s) { return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(str(s)) ? when(s) : str(s); }
  function postponedTo(r) { var m = lower(r.status).match(/^postponed until (\d{4}-\d{2}-\d{2})$/); return m ? m[1] : ''; }

  function feedbackView(d) {
    var t = d.feedback;
    if (!t || t.error) return [errorNote(t || { error: 'not loaded' }, 'Feedback')];
    var els = [h('p', { class: 'meta' }, 'From the "Suggest an update" form on every page. Claude rates suggestions and corrections at the next ingestion run (every two hours).')];
    var section = function (title, rows, empty) {
      els.push(h('h2', { class: 'section' }, title + ' (' + rows.length + ')'));
      if (!rows.length && empty) els.push(h('p', { class: 'empty' }, empty));
      rows.forEach(function (r) { els.push(fbCard(r)); });
    };
    section('Waiting', fbRows(d, 'waiting').sort(fbOrder), 'Nothing waiting.');
    var replies = fbRows(d, 'reply').sort(function (a, b) { return Number(fbTheyReplied(b)) - Number(fbTheyReplied(a)); });
    if (replies.length) section('Reply drafts', replies);
    section('Approved, awaiting build', fbRows(d, 'approved'), 'Nothing approved and waiting.');
    var later = fbRows(d, 'postponed').sort(function (a, b) { return postponedTo(a).localeCompare(postponedTo(b)); });
    if (later.length) {
      els.push(h('h2', { class: 'section' }, 'Postponed (' + later.length + ')'),
        h('button', { class: 'btn link', onclick: function () { S.fbLater = !S.fbLater; render(); } }, S.fbLater ? 'Hide postponed' : 'Show postponed'));
      if (S.fbLater) later.forEach(function (r) { els.push(fbCard(r)); });
    }
    var done = fbRows(d, 'done').sort(function (a, b) { return fbLast(b).localeCompare(fbLast(a)); });
    if (done.length) {
      els.push(h('h2', { class: 'section' }, 'History (' + done.length + ')'),
        h('button', { class: 'btn link', onclick: function () { S.fbHist = !S.fbHist; render(); } }, S.fbHist ? 'Hide history' : 'Show history'));
      if (S.fbHist) {
        var q = h('input', { class: 'f', type: 'search', placeholder: 'Search history', value: S.fbQ || '', 'aria-label': 'Search history',
          oninput: function () { S.fbQ = q.value; draw(); } });
        var box = h('div');
        var draw = function () {
          var words = lower(S.fbQ).split(/\s+/).filter(Boolean);
          var hits = done.filter(function (r) {
            var hay = lower([r.page_title, r.page_url, r.message, r.notes, r.conversation, r.reply_draft, r.status, r.type].join(' '));
            return words.every(function (w) { return hay.indexOf(w) >= 0; });
          });
          box.replaceChildren.apply(box, hits.length ? hits.map(fbCard) : [h('p', { class: 'empty' }, 'Nothing matches.')]);
        };
        draw();
        els.push(q, box);
      }
    }
    return els;
  }

  // Latest date on a row, for History's newest-first order.
  function fbLast(r) {
    return [r.received, r.decided, r.implemented, str(r.reply_sent).replace(/^skipped /, '')].map(str).sort().pop() || '';
  }
  // The conversation cell as [{ when, who, text }], oldest first.
  function fbConversation(r) {
    var c = str(r.conversation);
    if (!c) return [];
    return c.split(/\n\n(?=\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] [A-Za-z]+:\n)/).map(function (block) {
      var m = block.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\] ([A-Za-z]+):\n([\s\S]*)$/);
      return m ? { when: m[1], who: m[2], text: m[3] } : { when: '', who: '', text: block };
    });
  }
  function fbTheyReplied(r) {
    var c = fbConversation(r);
    return r._state === 'reply' && c.length > 0 && c[c.length - 1].who === 'Reader';
  }

  function fbCard(r) {
    var b = [h('span', { class: 'badge' + (r.type === 'correction' ? ' warn' : '') }, FB_TYPES[r.type] || str(r.type) || 'Feedback')];
    if (str(r.rating)) b.push(h('span', { class: 'badge ' + (Number(r.rating) >= 4 ? 'ok' : Number(r.rating) <= 2 ? 'bad' : 'info') }, 'Rating ' + str(r.rating) + '/5'));
    else if (r.type !== 'other') b.push(h('span', { class: 'badge' }, 'Not rated yet'));
    if (postponedTo(r)) b.push(h('span', { class: 'badge' }, 'Postponed until ' + day(postponedTo(r))));
    if (r._state === 'reply' || r._state === 'done') b.push(h('span', { class: 'badge ' + (lower(r.status) === 'rejected' ? 'bad' : 'ok') }, lower(r.status) === 'rejected' ? 'Rejected' : lower(r.status) === 'implemented' ? 'Implemented' : str(r.status)));
    if (fbTheyReplied(r)) b.push(h('span', { class: 'badge warn' }, 'They replied'));
    if (str(r.email)) b.push(h('span', { class: 'badge info' }, 'Email given'));
    var page = /^https:[/][/]/.test(str(r.page_url))
      ? h('a', { href: r.page_url, target: '_blank', rel: 'noopener' }, str(r.page_title) || str(r.page_url)) : str(r.page_title) || 'page unknown';
    var c = h('div', { class: 'card' },
      h('h2', null, page),
      h('div', { class: 'meta' }, 'Received ' + when(r.received) + (str(r.email) ? ' · ' + str(r.email) : '')),
      h('div', { class: 'badges' }, b),
      h('div', { class: 'fbtext' }, str(r.message)));
    if (str(r.commentary)) add(c, h('div', { class: 'meta' }, h('b', null, 'Claude: '), str(r.commentary)));
    if (str(r.notes)) add(c, h('div', { class: 'fbnotes' }, h('b', null, 'Notes'), h('div', { class: 'fbtext' }, str(r.notes))));
    if (r._state === 'done') {
      var dates = [str(r.decided) ? 'Decided ' + when2(r.decided) : '', str(r.implemented) ? 'implemented ' + when2(r.implemented) : '',
        /^skipped /.test(str(r.reply_sent)) ? 'no reply sent' : str(r.reply_sent) ? 'reply sent ' + when2(r.reply_sent) : ''].filter(Boolean).join(' · ');
      if (dates) add(c, h('div', { class: 'meta' }, dates));
    }
    var conv = fbConversation(r);
    if (conv.length) {
      add(c, h('div', { class: 'fbnotes' }, h('b', null, 'Conversation'), conv.map(function (m) {
        return h('div', { class: 'fbmsg' }, h('div', { class: 'meta' }, (m.who === 'Reader' ? 'They wrote' : m.who === 'Holly' ? 'We sent' : m.who) + (m.when ? ' · ' + when2(m.when) : '')),
          h('div', { class: 'fbtext' }, m.text));
      })));
    } else if (r._state === 'done' && str(r.reply_sent) && !/^skipped /.test(str(r.reply_sent)) && str(r.reply_draft)) {
      add(c, h('div', { class: 'fbnotes' }, h('b', null, 'Reply sent'), h('div', { class: 'fbtext' }, str(r.reply_draft))));
    }
    if (r._state === 'reply') {
      add(c, h('div', { class: 'fbdraft' }, h('b', null, str(r.reply_draft) ? (fbTheyReplied(r) ? 'Holly\'s answer to ' : 'Reply draft to ') + str(r.email) : 'Drafting the reply…'),
        str(r.reply_draft) ? h('div', { class: 'fbtext' }, str(r.reply_draft)) : null));
    }
    add(c, h('div', { class: 'actions' }, fbActions(r), sheetLink('Feedback', r._row)));
    return c;
  }

  function fbActions(r) {
    var go = function (action, extra, done) { return act('feedback', r.id, action, extra, done); };
    var note = h('button', { class: 'btn', onclick: function () { overlay('Add note', fbNoteForm(r)); } }, 'Add note');
    if (r._state === 'waiting' || r._state === 'postponed') {
      return [
        h('button', { class: 'btn primary', onclick: function () { go('approve', null, 'Approved'); } }, 'Approve'),
        h('button', { class: 'btn danger', onclick: function () { overlay('Reject', fbRejectForm(r)); } }, 'Reject'),
        h('button', { class: 'btn', onclick: function () { overlay('Postpone', fbPostponeForm(r)); } }, 'Postpone'),
        note];
    }
    if (r._state === 'approved') {
      return [
        h('button', { class: 'btn primary', onclick: function () {
          var msg = str(r.email)
            ? 'Mark implemented?\n\nHolly drafts a reply to ' + str(r.email) + ' saying what changed, from your notes (add a note first if you have not). The draft waits here for Send, Edit or Skip.'
            : 'Mark implemented? No email was given, so no reply is drafted.';
          if (window.confirm(msg)) go('done', null, 'Implemented');
        } }, 'Mark implemented'),
        note];
    }
    if (r._state === 'reply') {
      var ready = Boolean(str(r.reply_draft));
      var conv = fbConversation(r).length > 0;
      return [
        h('button', { class: 'btn primary', disabled: !ready, onclick: function () {
          if (window.confirm('Send this reply to ' + str(r.email) + ' as it stands?')) go('send', null, 'Reply sent');
        } }, 'Send'),
        h('button', { class: 'btn', disabled: !ready, onclick: function () { overlay('Edit reply', fbEditForm(r)); } }, 'Edit'),
        h('button', { class: 'btn danger', onclick: function () {
          if (window.confirm((conv ? 'Close the conversation without replying?' : 'Skip the reply?') + ' Nothing is sent, and their email address is deleted.')) go('skip', null, conv ? 'Closed' : 'Reply skipped');
        } }, conv ? 'Close, no reply' : 'Skip'),
        note];
    }
    return [note];
  }

  function fbRejectForm(r) {
    var why = h('input', { class: 'f', id: 'fbr', maxlength: 300 });
    return h('form', { onsubmit: function (e) { e.preventDefault(); act('feedback', r.id, 'reject', { reason: why.value }, 'Rejected'); } },
      h('p', null, str(r.email)
        ? 'Holly drafts a short reply to ' + str(r.email) + ' saying we won’t be making this change. It waits under Reply drafts for Send, Edit or Skip; nothing is sent until then.'
        : 'No email was given, so no reply is drafted.'),
      str(r.email) ? [h('label', { class: 'f', for: 'fbr' }, 'Why? (optional; Holly uses it for the reply, never sent as written)'), why] : null,
      h('div', { class: 'actions' }, h('button', { class: 'btn danger', type: 'submit' }, 'Reject')));
  }

  function fbPostponeForm(r) {
    var tomorrow = new Date(Date.parse(str(S.data.today) + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
    var date = h('input', { class: 'f', id: 'fbd', type: 'date', min: tomorrow, required: true });
    return h('form', { onsubmit: function (e) {
      e.preventDefault();
      if (!date.value) { toast('Choose a date', true); return; }
      act('feedback', r.id, 'postpone', { date: date.value }, 'Postponed');
    } },
    h('p', { class: 'meta' }, 'Hidden from Waiting until this date, then it comes back.'),
    h('label', { class: 'f', for: 'fbd' }, 'Postpone until'), date,
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'submit' }, 'Postpone')));
  }

  function fbNoteForm(r) {
    var text = h('textarea', { class: 'f', id: 'fbn', rows: 4, maxlength: 500, required: true });
    var busy = false;
    return h('form', { onsubmit: async function (e) {
      e.preventDefault();
      if (busy) return;
      if (text.value.trim().length < 2) { toast('Type a note first', true); return; }
      busy = true;
      var res = await api('/admin/api/feedback-note', { id: r.id, expected: str(r.notes) === '' ? '' : r.notes, note: text.value });
      busy = false;
      if (!res.ok) {
        toast(res.status === 409 ? 'The notes changed in the Sheet since you loaded the page. Nothing saved; reloaded.' : (res.json.error || ('HTTP ' + res.status)), true);
        if (res.status === 409) { closeOverlay(); load(true); }
        return;
      }
      r.notes = res.json.value;
      toast('Note added');
      closeOverlay();
      render();
    } },
    h('p', { class: 'meta' }, 'Added under the notes with today\'s date and time; earlier notes are kept. Holly uses the notes to say what changed when you mark it implemented. Never sent as written.'),
    h('label', { class: 'f', for: 'fbn' }, 'Note'), text,
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'submit' }, 'Add note')));
  }

  function fbEditForm(r) {
    var text = h('textarea', { class: 'f', id: 'fbe', rows: 14, maxlength: 3000 }, str(r.reply_draft));
    return h('form', { onsubmit: function (e) {
      e.preventDefault();
      if (text.value.trim().length < 10) { toast('The reply is empty', true); return; }
      act('feedback', r.id, 'edit', { body: text.value }, 'Reply sent (edited)');
    } },
    h('p', { class: 'meta' }, 'To ' + str(r.email) + ', from website@. It is sent exactly as it stands.'),
    h('label', { class: 'f', for: 'fbe' }, 'Reply'), text,
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'submit' }, 'Send edited reply')));
  }

  /* ------------------------------------------------------------ contacts -- */

  // Contacts tab (scripts/contacts fills it daily; ignore rows never reach the page).
  // Loaded when the screen opens. Each Save is one stale-checked cell write; a profile
  // field also sets profile_source to "manual" so the daily run stops rewriting it.
  var C_FIELDS = [['name', 'Name'], ['organisation', 'Organisation'], ['village', 'Village'], ['role', 'Role'], ['profile', 'Profile']];
  // Same list as admin/contacts.js STATUSES; value -> label and a line for the dropdown.
  var C_STATUSES = [['contributor', 'Contributor', 'sends events, notices or photos'], ['lead', 'Lead', 'a potential contributor'],
    ['collaborator', 'Collaborator', 'helps run the site or newsletter'], ['official', 'Official', 'council, councillor, police'],
    ['organiser', 'Organiser', 'runs a club, group, hall or event'], ['business', 'Business', 'a local business or trade'],
    ['media', 'Media', 'newsletter, Facebook group, press'], ['other', 'Other', '']];
  var C_KNOWN = C_STATUSES.map(function (x) { return x[0]; }).concat(['ignore', '']);
  var C_LIMITS = { name: 120, organisation: 120, village: 60, role: 120, profile: 2000, notes: 5000 };

  async function loadContacts() {
    S.cLoading = true;
    var r = await api('/admin/api/contacts');
    S.cLoading = false;
    S.contacts = r.ok ? r.json : { error: r.json.error || ('HTTP ' + r.status) };
    if (S.view === 'contacts') render();
  }

  function cDay(s) {
    var v = str(s);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    return new Date(v + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function plural(n, one, many) { var k = Number(n) || 0; return k + ' ' + (k === 1 ? one : many); }
  function cBadge(st) {
    var s = lower(st);
    var known = C_STATUSES.find(function (x) { return x[0] === s; });
    return h('span', { class: 'badge ' + (s === 'contributor' || s === 'collaborator' ? 'ok' : s === 'lead' ? 'info' : known || !s ? '' : 'warn') },
      known ? known[1] : str(st) || 'Not set');
  }
  // No email for a year (from today in the UK).
  function cQuiet(r) {
    var last = str(r.last_contact);
    var today = str(S.data && S.data.today);
    return /^\d{4}-\d{2}-\d{2}$/.test(last) && today && (Date.parse(today) - Date.parse(last)) / 864e5 > 365;
  }
  function cFind(email) {
    var t = S.contacts;
    if (!t || t.error) return null;
    return t.rows.find(function (r) { return r.email === email; }) || null;
  }

  function contactsView() {
    var t = S.contacts;
    if (!t) {
      if (!S.cLoading) loadContacts();
      return [h('p', { class: 'loading' }, 'Loading contacts…')];
    }
    if (t.error) return [errorNote(t, 'Contacts'), h('button', { class: 'btn', onclick: function () { S.contacts = null; render(); } }, 'Try again')];
    var open = S.contact ? cFind(S.contact) : null;
    if (open) return contactPage(open);
    S.contact = '';
    var cur = S.cTab === 'outreach' || S.cTab === 'orgs' ? S.cTab : 'list';
    var tab = function (key, label, reset) {
      return h('button', { class: 'btn' + (cur === key ? '' : ' link'), 'aria-pressed': cur === key ? 'true' : 'false',
        onclick: function () { S.cTab = key; if (reset) reset(); render(); } }, label);
    };
    var tabs = h('div', { class: 'actions' },
      tab('list', 'All contacts'),
      tab('outreach', 'Outreach', function () { S.outreach = null; }),
      tab('orgs', 'Organisations', function () { S.orgs = null; }));
    return [tabs].concat(cur === 'outreach' ? outreachView() : cur === 'orgs' ? orgsView() : contactList(t.rows));
  }

  /* ------------------------------------------------------- organisations -- */

  async function loadOrgs() {
    S.gLoading = true;
    var r = await api('/admin/api/orgs');
    S.gLoading = false;
    S.orgs = r.ok ? r.json : { error: r.json.error || ('HTTP ' + r.status) };
    if (S.view === 'contacts') render();
  }

  // One next_check write (stale-checked against what the list loaded), then a fresh list.
  async function gNext(e, value, what) {
    var res = await api('/admin/api/orgnext', { id: e.id, expected: e.next_check, value: value });
    toast(res.ok ? what : (res.json.error || ('HTTP ' + res.status)), !res.ok);
    S.orgs = null;
    render();
  }

  async function gDraft(e, btn) {
    btn.disabled = true;
    var res = await api('/admin/api/orgcheck', { id: e.id });
    toast(res.ok ? res.json.message : (res.json.error || ('HTTP ' + res.status)), !res.ok);
    S.orgs = null;
    render();
  }

  // Other addresses (Org outreach other_emails): saved as typed, stale-checked.
  async function gEmails(e, value, btn) {
    btn.disabled = true;
    var res = await api('/admin/api/orgemails', { id: e.id, expected: e.other_emails, value: value });
    toast(res.ok ? 'Saved: other addresses for ' + e.name : (res.json.error || ('HTTP ' + res.status)), !res.ok);
    btn.disabled = false;
    if (res.ok) { S.orgs = null; render(); }
  }

  function orgEmails(e) {
    var n = e.other_emails ? e.other_emails.split(',').length : 0;
    var box = h('textarea', { class: 'f', rows: '2', 'aria-label': 'Other addresses for ' + e.name, placeholder: 'secretary@example.org, chair@example.org' }, e.other_emails);
    var save = h('button', { class: 'btn', onclick: function () { gEmails(e, box.value, save); } }, 'Save addresses');
    return h('details', { class: 'org-emails' },
      h('summary', null, 'Other addresses' + (n ? ' (' + n + ')' : '')),
      h('p', { class: 'meta' }, 'Anyone who writes for this group from another address, separated by commas. Mail from any of them counts as contact; Holly still writes only to the address above. Contacts whose organisation is "' + e.name + '" count too.'),
      box, h('div', { class: 'actions' }, save));
  }

  function orgRow(e, o) {
    var acts = [];
    if ((e.state === 'due' || e.state === 'chase') && o.count < o.cap) {
      var draft = h('button', { class: 'btn', onclick: function () { gDraft(e, draft); } }, e.state === 'chase' ? 'Draft chaser' : 'Draft check');
      acts.push(draft);
    }
    if (e.state === 'held') {
      if (e.next_check) acts.push(h('button', { class: 'btn link', onclick: function () { gNext(e, '', 'Cleared: ' + e.name); } }, 'Clear'));
    } else if (e.state !== 'noemail' && e.state !== 'draft' && e.state !== 'regular') {
      acts.push(h('button', { class: 'btn link', onclick: function () { gNext(e, addMonths(o.today, 12), 'Done: ' + e.name + ' is next due in a year'); } }, 'Done'));
      if (e.state === 'due') acts.push(h('button', { class: 'btn link', onclick: function () { gNext(e, addMonths(o.today, 3), 'Snoozed for 3 months'); } }, 'Snooze 3 months'));
      acts.push(h('button', { class: 'btn link', onclick: function () {
        if (window.confirm('Never check ' + e.name + '?\n\nThey drop off the organisation lists for good (Clear undoes it). Nothing else changes.')) gNext(e, 'never', 'Never: ' + e.name);
      } }, 'Never'));
    }
    return h('div', { class: 'card crow' },
      h('div', null,
        h('div', { class: 'crow-top' }, h('b', null, e.name), h('span', null, ' · '),
          h('a', { href: e.pageUrl, target: '_blank', rel: 'noopener' }, e.pageName)),
        h('div', { class: 'meta' }, [e.email, e.why].filter(Boolean).join(' · ').replace(/\d{4}-\d{2}-\d{2}/g, cDay)),
        h('div', { class: 'meta' }, e.shown.join(' · ')),
        e.addresses > 1 ? h('div', { class: 'meta' }, (e.addresses - 1) + ' other address' + (e.addresses > 2 ? 'es' : '') + ' count as this group') : null,
        acts.length ? h('div', { class: 'actions' }, acts) : null,
        e.state !== 'noemail' ? orgEmails(e) : null));
  }

  function orgsView() {
    var o = S.orgs;
    if (!o) {
      if (!S.gLoading) loadOrgs();
      return [h('p', { class: 'loading' }, 'Loading organisations…')];
    }
    if (o.error) return [errorNote(o, 'Organisations'), h('button', { class: 'btn', onclick: function () { S.orgs = null; render(); } }, 'Try again')];
    var L = o.lists;
    var section = function (title, hint, list) {
      return h('div', null, h('h2', { class: 'section' }, title + ' (' + list.length + ')'), h('p', { class: 'meta' }, hint),
        list.length ? list.map(function (e) { return orgRow(e, o); }) : h('p', { class: 'empty' }, 'None at the moment.'));
    };
    return [
      h('p', { class: 'meta' }, 'Once a year Holly asks each organisation to check its entry on the site. The draft comes to you by email to Approve, Edit, Redraft or Reject, and never goes by itself. '
        + o.count + ' of ' + o.cap + ' drafts used today. When someone replies, read it in Gmail, update the site if needed, then tap Done.'),
      o.count >= o.cap ? h('div', { class: 'note' }, 'Today\'s ' + o.cap + ' drafts are used: Draft check comes back tomorrow.') : null,
      section('Due a check', 'Not checked yet, or last checked a year ago.', L.due),
      section('Chaser due', 'Checked 3 weeks ago or more with no reply.', L.chase),
      section('Replied', 'They emailed after the check: read it in Gmail, then tap Done.', L.replied),
      section('Draft waiting', 'A check or chaser is waiting for your Approve.', L.draft),
      section('Waiting for a reply', 'Checked or chased in the last 3 weeks.', L.waiting.concat(L.chased)),
      section('No reply', 'Chased 3 weeks ago or more with no reply: taken as all fine until next year.', L.noreply),
      section('In regular contact', 'They emailed us in the last 3 months, so no check is needed (it lapses 3 months after their last email).', L.regular || []),
      section('Done, snoozed or never', 'Held back until the date shown, or for good.', L.held),
      section('No email', 'No address to write to: check these by phone or on their website.', L.noemail)
    ];
  }

  /* ------------------------------------------------------------ outreach -- */

  async function loadOutreach() {
    S.oLoading = true;
    var r = await api('/admin/api/outreach');
    S.oLoading = false;
    S.outreach = r.ok ? r.json : { error: r.json.error || ('HTTP ' + r.status) };
    if (S.view === 'contacts') render();
  }

  function addMonths(day, n) {
    var d = new Date(day + 'T12:00:00Z');
    d.setUTCMonth(d.getUTCMonth() + n);
    return d.toISOString().slice(0, 10);
  }

  // One next_nudge write (stale-checked against what the list loaded), then a fresh list.
  async function oNext(e, value, what) {
    var res = await api('/admin/api/contact', { email: e.email, field: 'next_nudge', expected: e.next_nudge, value: value });
    if (res.ok) {
      var row = cFind(e.email);
      if (row) row.next_nudge = res.json.value;
      toast(what);
    } else {
      toast(cSaveError(res, 'Next nudge'), true);
    }
    S.outreach = null;
    render();
  }

  async function oDraft(e, btn) {
    btn.disabled = true;
    var res = await api('/admin/api/nudge', { email: e.email });
    toast(res.ok ? res.json.message : (res.json.error || ('HTTP ' + res.status)), !res.ok);
    S.outreach = null;
    render();
  }

  function outreachRow(e, o) {
    var title = e.name || e.email;
    var draft = h('button', { class: 'btn', onclick: function () { oDraft(e, draft); } }, 'Draft nudge');
    var acts = e.held
      ? [e.next_nudge ? h('button', { class: 'btn link', onclick: function () { oNext(e, '', 'Cleared: ' + title + ' can be nudged again'); } }, 'Clear') : null]
      : [o.week < o.cap ? draft : null,
        o.hasNextNudge ? h('button', { class: 'btn link', onclick: function () { oNext(e, addMonths(o.today, 3), 'Snoozed for 3 months'); } }, 'Snooze 3 months') : null,
        o.hasNextNudge ? h('button', { class: 'btn link', onclick: function () {
          if (window.confirm('Never nudge ' + title + '?\n\nThey drop off the outreach lists for good (Clear undoes it). Nothing else changes.')) oNext(e, 'never', 'Never nudge: ' + title);
        } }, 'Never nudge') : null];
    return h('div', { class: 'card crow' },
      h('div', null,
        h('div', { class: 'crow-top' }, h('button', { class: 'btn link', onclick: function () { S.contact = e.email; render(); window.scrollTo(0, 0); } }, h('b', null, title)),
          e.organisation ? h('span', null, ' · ' + e.organisation) : null, h('span', { class: 'crow-badges' }, cBadge(e.status))),
        h('div', { class: 'meta' }, [e.why, e.held ? 'held back: ' + e.held : '', e.last_contact && e.kind !== 'quiet' ? 'last email ' + e.last_contact : '']
          .filter(Boolean).join(' · ').replace(/\d{4}-\d{2}-\d{2}/g, cDay)),
        h('div', { class: 'actions' }, acts)));
  }

  function outreachView() {
    var o = S.outreach;
    if (!o) {
      if (!S.oLoading) loadOutreach();
      return [h('p', { class: 'loading' }, 'Loading outreach…')];
    }
    if (o.error) return [errorNote(o, 'Outreach'), h('button', { class: 'btn', onclick: function () { S.outreach = null; render(); } }, 'Try again')];
    var section = function (title, hint, list) {
      return h('div', null, h('h2', { class: 'section' }, title + ' (' + list.length + ')'), h('p', { class: 'meta' }, hint),
        list.length ? list.map(function (e) { return outreachRow(e, o); }) : h('p', { class: 'empty' }, 'Nobody at the moment.'));
    };
    return [
      h('p', { class: 'meta' }, 'Holly drafts the email; it comes to you by email to Approve, Edit, Redraft or Reject, and never goes by itself. '
        + o.week + ' of ' + o.cap + ' drafts used this week.'),
      o.week >= o.cap ? h('div', { class: 'note' }, 'This week\'s ' + o.cap + ' drafts are used: Draft nudge comes back as the week moves on.') : null,
      o.hasNextNudge ? null : h('div', { class: 'note bad' }, 'Snooze and Never nudge need a next_nudge column at the end of the Contacts tab (column P).'),
      section('Seasonal due', 'Sent something around this time last year, nothing yet this year.', o.seasonal),
      section('Gone quiet', 'Contributors, organisers and collaborators with no email for 3 to 12 months.', o.quiet),
      section('Leads to chase', 'Offered or seemed likely to send something, but haven\'t yet.', o.lead),
      section('Held back', 'Snoozed, set to never, a draft waiting, or nudged in the last 4 months.', o.held),
      sentSection(o.sent || [], 'sentO', 'Sent nudges')
    ];
  }

  function contactList(rows) {
    var F = S.cf || (S.cf = { q: '', status: '', village: '', org: '' });
    var opts = function (key) {
      var seen = {};
      rows.forEach(function (r) { var v = str(r[key]); if (v) seen[v] = true; });
      return Object.keys(seen).sort(function (a, b) { return a.localeCompare(b); });
    };
    var sel = function (label, key, list) {
      var id = 'cf-' + key;
      var el = h('select', { class: 'f', id: id, onchange: function () { F[key] = el.value; draw(); } },
        h('option', { value: '' }, 'All'), list.map(function (v) { return h('option', { value: v, selected: F[key] === v ? true : null }, v); }));
      return h('div', { class: 'cfilter' }, h('label', { class: 'f', for: id }, label), el);
    };
    var q = h('input', { class: 'f', type: 'search', placeholder: 'Search name, email, organisation, role, notes…', value: F.q,
      'aria-label': 'Search contacts', oninput: function () { F.q = q.value; draw(); } });
    var statuses = opts('status').map(lower).filter(function (v, i, a) { return a.indexOf(v) === i; });
    var head = h('p', { class: 'meta' });
    var box = h('div', { class: 'clist' });
    var draw = function () {
      var words = lower(F.q).split(/\s+/).filter(Boolean);
      var hits = rows.filter(function (r) {
        if (F.status && lower(r.status) !== F.status) return false;
        if (F.village && str(r.village) !== F.village) return false;
        if (F.org && str(r.organisation) !== F.org) return false;
        var hay = lower([r.name, r.email, r.other_emails, r.organisation, r.village, r.role, r.profile, r.notes, r.contributions, r.status].join(' '));
        return words.every(function (w) { return hay.indexOf(w) >= 0; });
      });
      head.textContent = hits.length === rows.length ? plural(rows.length, 'person', 'people') : hits.length + ' of ' + plural(rows.length, 'person', 'people');
      box.replaceChildren.apply(box, hits.length ? hits.map(contactRow) : [h('p', { class: 'empty' }, rows.length ? 'Nobody matches.' : 'No contacts yet.')]);
    };
    draw();
    return [h('h2', { class: 'section' }, 'Contacts'), head, q,
      h('div', { class: 'cfilters' }, sel('Status', 'status', statuses), sel('Village', 'village', opts('village')), sel('Organisation', 'org', opts('organisation'))),
      box];
  }

  function contactRow(r) {
    var title = str(r.name) || str(r.email);
    var bits = [str(r.role), str(r.village), str(r.last_contact) ? 'last ' + cDay(r.last_contact) : '',
      plural(r.contribution_count, 'item', 'items') + ', ' + plural(r.message_count, 'email', 'emails')].filter(Boolean);
    return h('div', { class: 'card crow' },
      h('button', { class: 'crow-open', onclick: function () { S.contact = r.email; render(); window.scrollTo(0, 0); } },
        h('div', { class: 'crow-top' }, h('b', null, title), str(r.organisation) ? h('span', null, ' · ' + str(r.organisation)) : null,
          h('span', { class: 'crow-badges' }, cQuiet(r) ? h('span', { class: 'badge warn' }, 'Quiet a year') : null, cBadge(r.status))),
        h('div', { class: 'meta' }, bits.join(' · '))),
      h('button', { class: 'btn crow-del', 'aria-label': 'Delete ' + title, onclick: function () { cDelete(r); } }, 'Delete'));
  }

  // Removes the row from the Sheet (logged in Deleted contacts so old mail can't bring them back).
  async function cDelete(r) {
    var title = str(r.name) || str(r.email);
    if (!window.confirm('Delete ' + title + ' from Contacts?\n\nThis removes the row from the Sheet. They are only added again if they write in as a contributor after today. Their newsletter subscription is not affected.')) return;
    var res = await api('/admin/api/contact-delete', { email: r.email, expected: str(r.status) === '' ? '' : r.status });
    if (res.ok) {
      S.contacts.rows = S.contacts.rows.filter(function (x) { return x !== r; });
      if (S.contact === r.email) S.contact = '';
      toast(res.json.message || 'Deleted');
    } else {
      toast(res.status === 409 && res.json.current !== undefined ? title + ' was changed in the Sheet since you loaded the page. Not deleted; reloaded.' : (res.json.error || ('HTTP ' + res.status)), true);
      if (res.status === 409) S.contacts = null;
    }
    render();
  }

  function cSaveError(res, what) {
    return res.status === 409 && res.json.current !== undefined
      ? what + ' was changed in the Sheet since you loaded the page (now "' + res.json.current + '"). Not saved.'
      : what + ': ' + (res.json.error || ('HTTP ' + res.status));
  }

  async function cSave(r, field, value, what) {
    var res = await api('/admin/api/contact', { email: r.email, field: field, expected: str(r[field]) === '' ? '' : r[field], value: value });
    if (res.ok) {
      r[field] = res.json.value;
      if (res.json.profileSource) r.profile_source = res.json.profileSource;
      toast(res.json.message === 'Saved.' ? what + ' saved' : res.json.message);
    } else {
      toast(cSaveError(res, what), true);
      if (res.status === 409 && res.json.current !== undefined) r[field] = res.json.current;
    }
    render();
    return res.ok;
  }

  function cField(r, field, label, hint) {
    var id = 'c-' + field;
    var multi = field === 'profile' || field === 'notes';
    var el = multi ? h('textarea', { class: 'f', id: id, rows: field === 'notes' ? 4 : 5, maxlength: C_LIMITS[field] }, str(r[field]))
      : h('input', { class: 'f', id: id, maxlength: C_LIMITS[field], value: str(r[field]) });
    return h('form', { class: 'cfield', onsubmit: async function (e) {
      e.preventDefault();
      if (el.value.trim() === str(r[field])) { toast('No changes to save'); return; }
      await cSave(r, field, el.value, label);
    } },
    h('label', { class: 'f', for: id }, label, hint ? h('span', { class: 'meta' }, ' ' + hint) : null),
    h('div', { class: 'crow-edit' }, el, h('button', { class: 'btn', type: 'submit' }, 'Save')));
  }

  function cStatus(r) {
    var cur = lower(r.status);
    var mode = C_KNOWN.indexOf(cur) >= 0 ? cur : 'own';
    var pick = h('select', { class: 'f', id: 'c-status', onchange: function () { own.hidden = pick.value !== 'own'; } },
      h('option', { value: '', selected: mode === '' ? true : null }, 'Not set'),
      C_STATUSES.map(function (o) { return h('option', { value: o[0], selected: mode === o[0] ? true : null }, o[1] + (o[2] ? ' — ' + o[2] : '')); }),
      h('option', { value: 'ignore', selected: mode === 'ignore' ? true : null }, 'Ignore — blocked for good (the next run clears them)'),
      h('option', { value: 'own', selected: mode === 'own' ? true : null }, 'A status of your own…'));
    var own = h('input', { class: 'f', id: 'c-status-own', maxlength: 40, placeholder: 'e.g. former committee', 'aria-label': 'Your status',
      value: mode === 'own' ? str(r.status) : '' });
    own.hidden = mode !== 'own';
    return h('form', { class: 'cfield', onsubmit: async function (e) {
      e.preventDefault();
      var want = pick.value === 'own' ? own.value.trim() : pick.value;
      if (pick.value === 'own') {
        if (!want) { toast('Type your status first', true); return; }
        if (C_KNOWN.indexOf(want.toLowerCase()) >= 0) { toast('"' + want + '" is in the list: pick it there', true); return; }
      }
      if (want === str(r.status)) { toast('No changes to save'); return; }
      if (want === 'ignore' && !window.confirm('Mark this contact as ignore?\n\nThe next daily contacts run clears the row down to the email address and status, and they disappear from this list. They are never added again unless you change the status in the Sheet. (To let them back if they contribute later, use Delete instead.)')) return;
      var ok = await cSave(r, 'status', want, 'Status');
      if (ok && want === 'ignore') { S.contacts.rows = S.contacts.rows.filter(function (x) { return x !== r; }); S.contact = ''; render(); }
    } },
    h('label', { class: 'f', for: 'c-status' }, 'Status ', cBadge(r.status), cQuiet(r) ? h('span', { class: 'badge warn' }, 'Quiet a year') : null),
    h('div', { class: 'crow-edit' }, pick, h('button', { class: 'btn', type: 'submit' }, 'Save')), own);
  }

  function contactPage(r) {
    var manual = lower(r.profile_source) !== 'auto';
    var list = str(r.contributions) ? str(r.contributions).split('; ') : [];
    var more = (Number(r.contribution_count) || 0) - list.length;
    return [
      h('button', { class: 'btn link', onclick: function () { S.contact = ''; render(); } }, '‹ Contacts'),
      h('div', { class: 'card' },
        h('h2', null, str(r.name) || str(r.email)),
        h('div', { class: 'meta' }, str(r.email)),
        str(r.other_emails) ? h('div', { class: 'meta' }, 'Also writes from: ' + str(r.other_emails)) : null,
        h('p', { class: 'meta' }, ['First contact ' + (cDay(r.first_contact) || 'unknown'), 'last ' + (cDay(r.last_contact) || 'unknown'),
          plural(r.message_count, 'email', 'emails'), plural(r.contribution_count, 'item', 'items')].join(' · ')),
        h('p', { class: 'meta' }, 'Profile: ', h('b', null, manual ? 'edited by you (' + (str(r.profile_source) || 'blank') + ')' : 'written by Claude (auto)'),
          manual ? ' — the daily run leaves the profile fields alone.' : ' — saving any profile field stops the daily run rewriting them.'),
        C_FIELDS.map(function (f) { return cField(r, f[0], f[1]); }),
        cStatus(r),
        cField(r, 'notes', 'Notes', '(yours; never touched by code)'),
        h('div', { class: 'actions' }, sheetLink('Contacts', r._row),
          h('button', { class: 'btn', onclick: function () { cDelete(r); } }, 'Delete contact'))),
      h('div', { class: 'card' },
        h('h2', null, 'Contributions (' + (Number(r.contribution_count) || 0) + ')'),
        list.length ? h('ul', { class: 'clist-items' }, list.map(function (c) { return h('li', null, c); })) : h('p', { class: 'meta' }, 'Nothing in Pending from this address.'),
        more > 0 ? h('p', { class: 'meta' }, 'and ' + more + ' older.') : null)
    ];
  }

  /* ------------------------------------------------------------- lessons -- */

  // Holly lessons tab (admin/lessons.js): approved ones go into every Holly draft.
  async function loadLessons() {
    S.lLoading = true;
    var r = await api('/admin/api/lessons');
    S.lLoading = false;
    S.lessons = r.ok ? r.json : { error: r.json.error || ('HTTP ' + r.status) };
    if (S.view === 'lessons') render();
  }

  async function lessonPost(body, okText) {
    var res = await api('/admin/api/lesson', body);
    toast(res.ok ? (res.json.message || okText) : (res.status === 409 && res.json.current !== undefined
      ? 'Changed in the Sheet since you loaded the page. Not saved; reloaded.' : (res.json.error || ('HTTP ' + res.status))), !res.ok);
    S.lessons = null;
    render();
    return res.ok;
  }

  function lessonCard(r) {
    var st = lower(r.status);
    var editing = S.lEdit === r.id;
    var c = h('div', { class: 'card' },
      h('div', { class: 'badges' }, h('span', { class: 'badge ' + (st === 'approved' ? 'ok' : st === 'proposed' ? 'info' : '') },
        st === 'approved' ? 'In use' : st === 'proposed' ? 'Suggested' : (str(r.status) || 'Not set'))),
      h('div', { class: 'meta' }, [str(r.id), r.created_at ? 'added ' + when(r.created_at) : '', /^Check:/.test(str(r.notes)) ? '' : str(r.notes)].filter(Boolean).join(' · ')),
      // A clash found by the Monday check (scripts/lessons): edit or delete to settle it.
      /^Check:/.test(str(r.notes)) ? h('div', { class: 'note warn' }, str(r.notes)) : null);
    if (editing) {
      var box = h('textarea', { class: 'f', rows: 3, maxlength: 300, 'aria-label': 'Lesson text' }, str(r.lesson));
      add(c, [box, h('div', { class: 'actions' },
        h('button', { class: 'btn primary', onclick: function () {
          if (box.value.trim() === str(r.lesson)) { S.lEdit = ''; render(); return; }
          S.lEdit = '';
          lessonPost({ op: 'edit', id: r.id, expected: r.lesson, value: box.value }, 'Saved');
        } }, 'Save'),
        h('button', { class: 'btn link', onclick: function () { S.lEdit = ''; render(); } }, 'Cancel'))]);
      return c;
    }
    add(c, [h('div', { class: 'text' }, str(r.lesson)), h('div', { class: 'actions' },
      st === 'proposed' ? h('button', { class: 'btn primary', onclick: function () { lessonPost({ op: 'decide', id: r.id, action: 'approve' }, 'Approved'); } }, 'Approve') : null,
      st === 'proposed' ? h('button', { class: 'btn danger', onclick: function () { lessonPost({ op: 'decide', id: r.id, action: 'reject' }, 'Rejected'); } }, 'Reject') : null,
      h('button', { class: 'btn', onclick: function () { S.lEdit = r.id; render(); } }, 'Edit'),
      h('button', { class: 'btn link', onclick: function () {
        if (window.confirm('Delete this lesson?\n\n"' + str(r.lesson) + '"\n\nHolly stops using it from the next run. This removes the row from the Sheet.')) {
          lessonPost({ op: 'delete', id: r.id, expected: r.lesson }, 'Deleted');
        }
      } }, 'Delete'),
      sheetLink('Holly lessons', r._row))]);
    return c;
  }

  function lessonsView() {
    var t = S.lessons;
    if (!t) {
      if (!S.lLoading) loadLessons();
      return [h('p', { class: 'loading' }, 'Loading lessons…')];
    }
    if (t.error) return [errorNote(t, 'Holly lessons'), h('button', { class: 'btn', onclick: function () { S.lessons = null; render(); } }, 'Try again')];
    var by = function (st) { return t.rows.filter(function (r) { return lower(r.status) === st; }); };
    var other = t.rows.filter(function (r) { return ['approved', 'proposed'].indexOf(lower(r.status)) < 0; });
    var text = h('textarea', { class: 'f', id: 'lesson-new', rows: 2, maxlength: 300, placeholder: 'e.g. Write to council clerks formally and thank them for their help.' });
    var addForm = h('form', { class: 'card', onsubmit: function (e) {
      e.preventDefault();
      if (text.value.trim().length < 10) { toast('Type the lesson first (at least 10 characters)', true); return; }
      lessonPost({ op: 'add', value: text.value }, 'Added');
    } }, h('label', { class: 'f', for: 'lesson-new' }, 'Add a lesson'), text,
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'submit' }, 'Add')));
    var section = function (title, rows, empty) {
      return [h('h2', { class: 'section' }, title + ' (' + rows.length + ')'), rows.length ? rows.map(lessonCard) : h('p', { class: 'empty' }, empty)];
    };
    return [addForm,
      section('Suggested', by('proposed'), 'No suggestions waiting. New ones come each Monday.'),
      section('In use', by('approved'), 'No lessons in use yet.'),
      other.length ? section('Not in use', other, '') : null];
  }

  /* ------------------------------------------------------- newsletter draft -- */

  // The draft's meta: the newest seen (after a Refresh), else the one /api/state brought.
  function draftMetaOf(d) {
    var a = S.draftMeta || null;
    var b = d && d.draft && !d.draft.error ? d.draft : null;
    if (a && b) return str(a.as_of) >= str(b.as_of) ? a : b;
    return a || b;
  }

  // Refresh: runs newsletter-draft.yml, then checks every 15 seconds (up to 6 minutes) for
  // a newer draft and shows it.
  async function refreshDraft() {
    if (S.draftBusy) return;
    var before = str((draftMetaOf(S.data) || {}).as_of);
    var r = await api('/admin/api/draft-refresh', {});
    if (!r.ok) { toast(r.json.error || ('HTTP ' + r.status), true); return; }
    toast(r.json.message || 'Refreshing');
    S.draftBusy = true;
    render();
    var tries = 0;
    var tick = async function () {
      tries += 1;
      var m = await api('/admin/api/draft');
      var meta = m.ok && m.json.meta;
      if (meta && str(meta.as_of) > before) {
        S.draftMeta = meta;
        S.draftBusy = false;
        toast('Draft updated');
        render();
        return;
      }
      if (tries >= 24) { S.draftBusy = false; toast('No new draft yet: see Activity for the Newsletter draft run', true); render(); return; }
      setTimeout(tick, 15000);
    };
    setTimeout(tick, 15000);
  }

  function draftView(d) {
    var m = draftMetaOf(d);
    var els = [];
    if (d.draft && d.draft.error) els.push(errorNote(d.draft, 'The Newsletter draft tab'));
    var counts = m ? [plural(m.events, 'event'), plural(m.notices, 'notice'), m.roads ? plural(m.roads, 'road item') : '', m.elsewhere ? plural(m.elsewhere, 'link') : '']
      .filter(Boolean).join(', ') : '';
    els.push(h('div', { class: 'card draft-bar' },
      h('div', null,
        h('h2', null, m ? 'Draft for ' + day(m.issue_date) : 'No draft yet'),
        m ? h('div', { class: 'meta' }, 'As of ' + when(m.as_of) + ' · ' + plural(m.items, 'item') + (counts ? ' (' + counts + ')' : '') +
          (m.held ? ' · ' + m.held + ' held as late, for next week' : '')) : h('div', { class: 'meta' }, 'Tap Refresh to make the first one.'),
        m ? h('div', { class: 'badges' }, m.mode === 'frozen'
          ? h('span', { class: 'badge ok' }, 'Built: as it will go out' + (m.status ? ' (' + m.status + ')' : ''))
          : h('span', { class: 'badge info' }, 'Live draft: changes as items are approved')) : null),
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', disabled: S.draftBusy ? true : null, onclick: refreshDraft }, S.draftBusy ? 'Refreshing…' : 'Refresh'),
        h('a', { class: 'btn link', href: '/admin/draft', target: '_blank', rel: 'noopener' }, 'Open in new tab'))));
    els.push(h('iframe', { class: 'draft-frame', src: '/admin/draft?v=' + encodeURIComponent(m ? str(m.as_of) : '0'), title: 'Newsletter draft' }));
    return els;
  }

  /* ------------------------------------------------------------- summary -- */

  // /admin/api/summary: the sections not in /api/state (admin/summary.js).
  async function loadSummary() {
    S.sLoading = true;
    var r = await api('/admin/api/summary');
    S.sLoading = false;
    S.summary = r.ok ? r.json : { error: r.json.error || ('HTTP ' + r.status) };
    if (S.view === 'summary') render();
  }

  function go(view, tab) {
    return function () {
      S.view = view;
      if (tab) { S.cTab = tab; S.outreach = null; S.orgs = null; }
      closeOverlay(); render(); window.scrollTo(0, 0);
    };
  }

  var plural = function (n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); };
  function stampMs(s) {
    var v = str(s);
    var t = Date.parse(/T/.test(v) ? v : v.replace(' ', 'T'));
    return isNaN(t) ? NaN : t;
  }
  // "5 min", "3 hours", "2 days" since a Sheet stamp ('' if unreadable).
  function age(s) {
    var t = stampMs(s);
    if (isNaN(t)) return '';
    var m = Math.max(0, (Date.now() - t) / 60000);
    if (m < 60) return plural(Math.round(m), 'min', 'min');
    if (m < 1440) return plural(Math.round(m / 60), 'hour');
    return plural(Math.floor(m / 1440), 'day');
  }
  // "1 day 4 hours", "3 hours 10 min" until an instant ('' once passed).
  function until(iso) {
    var m = Math.floor((Date.parse(iso) - Date.now()) / 60000);
    if (!(m > 0)) return '';
    if (m < 60) return plural(m, 'min', 'min');
    var hrs = Math.floor(m / 60);
    if (hrs < 24) return plural(hrs, 'hour') + (m % 60 ? ' ' + plural(m % 60, 'min', 'min') : '');
    return plural(Math.floor(hrs / 24), 'day') + (hrs % 24 ? ' ' + plural(hrs % 24, 'hour') : '');
  }
  function dayRange(a, b) { return str(b) && str(b) !== str(a) ? day(a) + ' to ' + day(b) : day(a); }

  // One section: a heading that opens its screen (go, a URL, or nothing), then lines,
  // or "Nothing waiting". max: lines shown before "and N more".
  function sumCard(title, open, lines, opts) {
    var o = opts || {};
    var list = (lines || []).filter(Boolean);
    var shown = o.max ? list.slice(0, o.max) : list;
    var head = typeof open === 'function'
      ? h('button', { class: 'sum-h', onclick: open }, title, h('span', { 'aria-hidden': 'true' }, ' →'))
      : open ? h('a', { class: 'sum-h', href: open, target: '_blank', rel: 'noopener' }, title, h('span', { 'aria-hidden': 'true' }, ' ↗'))
        : h('span', { class: 'sum-h' }, title);
    return h('div', { class: 'card sum' }, h('h2', null, head),
      o.top || null,
      list.length ? h('ul', { class: 'sum-l' }, shown.map(function (l) { return h('li', null, l); })) : (o.top ? null : h('p', { class: 'meta' }, o.empty || 'Nothing waiting')),
      list.length > shown.length ? h('p', { class: 'meta' }, 'and ' + (list.length - shown.length) + ' more') : null);
  }
  function line(main, meta, badges) {
    return [h('span', null, main), meta ? h('span', { class: 'meta' }, ' · ' + meta) : null,
      (badges || []).filter(Boolean).map(function (b) { return [' ', h('span', { class: 'badge ' + (b[1] || '') }, b[0])]; })];
  }
  function loadingNote(sm, what) {
    if (!sm) return h('p', { class: 'meta' }, 'Loading…');
    if (sm.error) return errorNote(sm, what);
    return null;
  }

  var ISSUE_STATES = {
    '': ['Not built yet: it builds on Thursday morning', ''], built: ['Built: the preview is on its way', ''],
    tested: ['Preview emailed: waiting for your tap', 'warn'], shadow: ['Shadow copy only', ''],
    sending: ['Sending now', 'info'], sent: ['Sent', 'ok'], failed: ['The build failed: see Activity', 'bad']
  };

  function summaryView(d) {
    var sm = S.summary;
    if (!sm && !S.sLoading) loadSummary();
    var all = sm && !sm.error ? sm : null;
    var els = [];
    var hol = d.holiday || {};
    if (hol.on) {
      els.push(h('div', { class: 'note bad sum-hol' }, h('b', null, 'Holiday mode is ON. '),
        'The newsletter can send itself on Thursday and replies that normally wait for you can go out automatically. ',
        h('button', { class: 'btn', onclick: toggleHoliday }, 'Turn off')));
    }
    if (sm && sm.error) els.push(errorNote(sm, 'Part of the summary'));
    var issue = all && all.issue && !all.issue.error ? all.issue : null;
    var left = issue ? until(issue.deadlineAt) : '';

    // Site health (first, agreed 28 Oct).
    var health = [];
    var dog = d.watchdog || {};
    if (dog.error) health.push(line('Watchdog could not be checked', dog.error, [['Check', 'warn']]));
    else if (dog.open) health.push(line('Watchdog alert since ' + when(dog.since), (dog.problems || []).join('; '), [['Alert', 'bad']]));
    var hl = Array.isArray(d.health) ? d.health[0] : null;
    var hs = hl ? str(hl.status).toUpperCase() : '';
    if (hl && hs !== 'OK' && hs !== 'CLEARED') {
      var probs = str(hl.problems) ? str(hl.problems).split(' | ') : [str(hl.summary) || hs];
      probs.forEach(function (p) { health.push(line('Diagnostic (' + when(hl.date) + '): ' + p, '', [[hs, hs === 'FIXED' ? 'warn' : 'bad']])); });
    }
    if (all && Array.isArray(all.failing)) {
      all.failing.forEach(function (r) {
        health.push([h('a', { href: r.url, target: '_blank', rel: 'noopener' }, str(r.name)), h('span', { class: 'meta' }, ' · last run failed ' + hhmm(r.started)), ' ', h('span', { class: 'badge bad' }, 'Failed')]);
      });
    }
    var hTop = all && all.failing && all.failing.error ? errorNote(all.failing, 'GitHub runs') : (!sm ? loadingNote(sm) : null);
    els.push(sumCard('Site health', go('health'), health, { top: hTop, empty: 'All clear: watchdog, diagnostic' + (all ? ' and automatic jobs' : '') + ' are fine' }));

    // Screens that need action; any with nothing waiting go in one "No action needed" box.
    var clear = [];
    var action = function (name, count, readable, card) {
      if (count === 0 && readable) clear.push(name); else els.push(card);
    };

    // 1. Submissions to approve.
    var pend = d.pending && !d.pending.error ? d.pending.rows.filter(function (r) { return !S.done['pending:' + r.id]; }) : [];
    pend = pend.slice().sort(function (a, b) { return (truthy(b.urgent) ? 1 : 0) - (truthy(a.urgent) ? 1 : 0) || str(a.received).localeCompare(str(b.received)); });
    var dl = null;
    if (issue && pend.length && ['', 'built'].indexOf(issue.status) >= 0) {
      dl = left
        ? (Date.parse(issue.deadlineAt) - Date.now() < 48 * 3600000 ? h('div', { class: 'note warn' }, 'Newsletter deadline (Wednesday 6pm) in ' + left + '.') : null)
        : h('div', { class: 'note warn' }, 'The deadline has passed: items sent in before it still go in ' + day(issue.date) + '\'s issue if you approve them before it is built.');
    }
    action('Submissions', pend.length, !(d.pending && d.pending.error), sumCard('Submissions to approve (' + pend.length + ')', go('queue'), d.pending && d.pending.error ? [] : pend.map(function (r) {
      var rec = str(r.received);
      // Once the deadline has passed: which items still make this week's issue.
      var late = issue && dl && !left && rec ? (rec.replace('T', ' ').slice(0, 16) <= issue.deadline ? ['In time for ' + day(issue.date), 'info'] : ['For next week', '']) : null;
      return line(str(r.title) || '(no title)', [str(r.source) || 'email', age(rec)].filter(Boolean).join(' · '),
        [truthy(r.urgent) ? ['Urgent', 'bad'] : null, /possible spam/i.test(str(r.notes)) ? ['Possible spam', 'warn'] : null, late]);
    }), { max: 6, top: d.pending && d.pending.error ? errorNote(d.pending, 'Pending') : dl, empty: 'Nothing waiting' }));

    // 2. Replies needed.
    var reps = d.replies && !d.replies.error ? d.replies.rows.filter(function (r) { return !S.done['reply:' + r.reply_id]; }) : [];
    reps = reps.slice().sort(function (a, b) { return str(a.created_at).localeCompare(str(b.created_at)); });
    action('Replies', reps.length, !(d.replies && d.replies.error), sumCard('Replies needed (' + reps.length + ')', go('replies'), reps.map(function (r) {
      var t = lower(r.type);
      return line(str(r.to) + ' · ' + (str(r.subject) || '(no subject)'), age(r.created_at) ? 'waiting ' + age(r.created_at) : '',
        [str(r.hold_reason) ? ['Held: ' + str(r.hold_reason), 'warn'] : null, t === 'own' ? ['Your own thread', 'info'] : null, t === 'outreach' ? ['Outreach', 'info'] : null]);
    }), { max: 6, top: errorNote(d.replies, 'Replies') }));

    // 3. Owed.
    var owed = Array.isArray(d.owed) ? d.owed.filter(function (o) { return !S.done['reply:' + o.holding.reply_id]; }) : [];
    action('Owed', owed.length, Array.isArray(d.owed), sumCard('Owed a reply (' + owed.length + ')', go('owed'), owed.map(function (o) {
      return line(str(o.holding.to) + ' · ' + (str(o.holding.subject) || '(no subject)'), age(o.holding.sent_at) ? 'holding reply ' + age(o.holding.sent_at) + ' ago' : '',
        [o.draft && o.draft.status === 'awaiting' ? ['Draft waiting', 'warn'] : null]);
    }), { max: 6, top: Array.isArray(d.owed) ? null : errorNote(d.owed, 'Replies') }));

    // 4. Feedback.
    var fbw = fbRows(d, 'waiting');
    var fbr = fbRows(d, 'reply');
    action('Feedback', fbw.length + fbr.length, !(d.feedback && d.feedback.error), sumCard('Feedback (' + fbw.length + ')', go('feedback'), fbw.map(function (r) {
      var n = Number(r.rating) || 0;
      var msg = str(r.message);
      return line((n ? '★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n) + ' ' : '') + '"' + (msg.length > 80 ? msg.slice(0, 79) + '…' : msg) + '"',
        [str(r.page_title) || str(r.page_url), age(r.received)].filter(Boolean).join(' · '), [str(r.type) ? [str(r.type), ''] : null]);
    }).concat(fbr.length ? [h('span', { class: 'meta' }, plural(fbr.length, 'reply', 'replies') + ' to send')] : []),
    { max: 5, top: d.feedback && d.feedback.error ? errorNote(d.feedback, 'Feedback') : null }));

    // Holly lessons awaiting approval (below Feedback, agreed 28 Oct).
    var ls = all && Array.isArray(all.lessons) ? all.lessons : [];
    if (all) action('Holly lessons', ls.length, !all.lessons.error, sumCard('Holly lessons awaiting approval (' + ls.length + ')', go('lessons'), ls.map(function (l) { return line(str(l.lesson), '', []); }),
      { max: 5, top: all.lessons && all.lessons.error ? errorNote(all.lessons, 'Holly lessons') : null }));
    if (clear.length) els.push(h('div', { class: 'card sum' }, h('p', { class: 'sum-clear' }, h('b', null, 'No action needed on: '), clear.join(' / '))));

    if (!all) {
      els.push(sm && sm.error ? h('button', { class: 'btn', onclick: function () { S.summary = null; render(); } }, 'Try again') : loadingNote(sm));
      return els;
    }

    // 6. Development tasks (devtasks.json, kept by Kryten).
    els.push(sumCard('Development tasks (' + (all.devTasks || []).length + ')', null, (all.devTasks || []).map(function (t) {
      return line(t.task, t.waiting ? 'waiting on ' + t.waiting : '', []);
    }), { empty: 'Nothing outstanding' }));

    // 7. Next newsletter.
    if (all.issue && all.issue.error) els.push(sumCard('Next newsletter', null, [], { top: errorNote(all.issue, 'Issues') }));
    else {
      var st = ISSUE_STATES[issue.status] || [issue.status, ''];
      var nl = [
        line(left ? 'Deadline in ' + left : 'Deadline passed', 'Wednesday 6pm', []),
        line(st[0], issue.sentAt ? when(issue.sentAt) : '', []),
        line(issue.events === null ? 'Events: the site\'s list could not be read' : plural(issue.events, 'event') + ' in its two weeks, ' + plural(issue.fresh, 'new item') + ' approved since the last issue', 'a guide; the build decides', []),
        issue.onThisDay ? line('On this day: ' + issue.onThisDay, '', []) : line('No On this day line for ' + day(issue.date), '', [['Missing', 'warn']])
      ];
      var card = sumCard('Next newsletter: ' + day(issue.date), go('draft'), nl);
      if (st[1]) card.querySelectorAll('li')[1].appendChild(h('span', { class: 'badge ' + st[1] }, issue.status));
      var link = sheetLink('Issues', issue.row);
      if (link) card.appendChild(h('div', { class: 'actions' }, link));
      els.push(card);
    }

    // 8. Coming up this week.
    var cw = all.coming || {};
    els.push(sumCard('Coming up this week', 'https://thelenches.org.uk/events/', cw.error ? [] : (cw.events || []).map(function (e) {
      return [h('span', { class: 'meta' }, dayRange(e.date, e.end) + ' · '), e.url ? h('a', { href: e.url, target: '_blank', rel: 'noopener' }, str(e.title)) : str(e.title)];
    }).concat((cw.roads || []).map(function (r) {
      return [h('span', { class: 'badge warn' }, 'Road'), ' ', h('a', { href: r.url, target: '_blank', rel: 'noopener' }, str(r.title)),
        h('span', { class: 'meta' }, ' · ' + (r.end ? 'until ' + day(r.end) : 'end date not given'))];
    })), { top: cw.error ? errorNote(cw, 'The site\'s coming-up list') : null, empty: 'Nothing in the next 7 days' }));

    // 9. Outreach due.
    var ou = all.outreach || {};
    var og = all.orgs || {};
    var ol = [];
    if (!ou.error && ou.seasonal + ou.quiet + ou.lead) ol.push([h('button', { class: 'btn link', onclick: go('contacts', 'outreach') }, plural(ou.seasonal + ou.quiet + ou.lead, 'contact') + ' due a nudge'),
      h('span', { class: 'meta' }, ' · ' + [ou.seasonal ? ou.seasonal + ' seasonal' : '', ou.quiet ? ou.quiet + ' gone quiet' : '', ou.lead ? plural(ou.lead, 'lead') : ''].filter(Boolean).join(', '))]);
    if (!og.error && og.due + og.chase) ol.push([h('button', { class: 'btn link', onclick: go('contacts', 'orgs') }, plural(og.due, 'organisation') + ' due a check' + (og.chase ? ', ' + plural(og.chase, 'chaser') + ' due' : ''))]);
    els.push(sumCard('Outreach due', go('contacts', 'outreach'), ol, { top: ou.error ? errorNote(ou, 'Contacts') : og.error ? errorNote(og, 'Organisations') : null }));

    // 11. Subscribers (counts only).
    var sb = all.subscribers || {};
    els.push(sumCard('Subscribers', null, sb.error ? [] : [
      line('+' + sb.joined + ' joined, −' + sb.left + ' unsubscribed or blocked', 'since the newsletter of ' + day(sb.since), []),
      line(plural(sb.total, 'subscriber') + ' on the list', '', [])
    ], { top: sb.error ? errorNote(sb, 'Subscribers') : null }));

    // 12. Visitors (Cloudflare Web Analytics, admin/visitors.js).
    var vs = all.visitors || {};
    var vl = [];
    if (!vs.error && !vs.off) {
      vl.push(line(plural(vs.views, 'page view') + ', ' + plural(vs.visits, 'visit'), 'last 7 days', []));
      if ((vs.days || []).length) vl.push(h('span', { class: 'meta' }, 'By day: ' + vs.days.map(function (x) { return day(x.date) + ' ' + x.views; }).join(' · ')));
      (vs.pages || []).forEach(function (p) {
        vl.push([h('a', { href: 'https://thelenches.org.uk' + str(p.path), target: '_blank', rel: 'noopener' }, str(p.path)), h('span', { class: 'meta' }, ' · ' + plural(p.views, 'view'))]);
      });
    }
    els.push(sumCard('Visitors', 'https://dash.cloudflare.com/?to=/:account/web-analytics', vl, {
      top: vs.error ? errorNote(vs, 'Visitor counts') : null,
      empty: vs.off ? 'Not set up: the Worker needs CF_ANALYTICS_TOKEN and CF_ACCOUNT_ID' : 'No visits counted yet'
    }));
    return els;
  }

  /* --------------------------------------------------------------- health -- */

  function healthView(d) {
    var els = [];
    var dog = d.watchdog || {};
    els.push(h('div', { class: 'card' }, h('h2', null, 'Watchdog'),
      dog.error ? h('div', { class: 'note bad' }, 'Could not check: ' + dog.error)
        : dog.open ? [h('div', { class: 'note bad' }, 'Alert open since ' + when(dog.since)), h('ul', null, (dog.problems || []).map(function (p) { return h('li', null, p); }))]
          : h('p', null, 'No open alert' + (dog.cleared ? '; last one cleared ' + when(dog.cleared) : '') + '. It checks every 3 hours.')));
    els.push(h('div', { class: 'card' }, h('h2', null, 'Google account'),
      d.googleAccount ? h('p', null, 'The panel uses ', h('b', null, str(d.googleAccount)))
        : h('div', { class: 'note bad' }, 'GOOGLE_SA_KEY is missing or unreadable')));
    if (!Array.isArray(d.health)) { els.push(errorNote(d.health, 'Health')); return els; }
    var t = h('table', { class: 'h' }, h('thead', null, h('tr', null, h('th', null, 'Run'), h('th', null, 'Status'), h('th', null, 'Summary and problems'))),
      h('tbody', null, d.health.map(function (r) {
        return h('tr', null, h('td', null, when(r.date)), h('td', null, str(r.status)),
          h('td', null, str(r.summary), str(r.problems) ? h('div', { class: 'meta' }, str(r.problems).split(' | ').join('; ')) : null));
      })));
    els.push(h('div', { class: 'card' }, h('h2', null, 'Daily diagnostic (latest 7)'), t, h('div', { class: 'actions' }, sheetLink('Health', 1))));
    return els;
  }

  /* ------------------------------------------------------------- activity -- */

  // GitHub Actions runs (admin/runs.js), read-only; refreshed every 15 seconds while open.
  async function loadRuns() {
    S.rLoading = true;
    var r = await api('/admin/api/runs');
    S.rLoading = false;
    S.runs = r.ok ? r.json : { error: r.json.error || ('HTTP ' + r.status) };
    S.runsAt = Date.now();
    if (S.view === 'activity') render();
  }
  setInterval(function () {
    if (S.view === 'activity' && !document.hidden && !S.rLoading) loadRuns();
  }, 15000);

  function mins(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's';
  }
  function hhmm(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return '';
    var today = new Date().toDateString() === d.toDateString();
    return d.toLocaleString('en-GB', today ? { hour: '2-digit', minute: '2-digit' }
      : { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  function activityView() {
    var t = S.runs;
    if (!t) {
      if (!S.rLoading) loadRuns();
      return [h('p', { class: 'loading' }, 'Loading activity…')];
    }
    if (t.error) return [errorNote(t, 'Activity'), h('button', { class: 'btn', onclick: function () { S.runs = null; render(); } }, 'Try again')];
    var rows = (t.runs || []).map(function (r) {
      var running = r.status !== 'completed';
      var c = r.conclusion;
      var icon = running ? '⟳' : c === 'success' ? '✓' : (c === 'failure' || c === 'timed_out' || c === 'startup_failure') ? '✗' : '–';
      var label = running ? (r.status === 'in_progress' ? 'running' : 'waiting') : c === 'success' ? 'done' : c === 'failure' ? 'failed' : str(c).replace(/_/g, ' ');
      var took = running ? mins(Date.now() - Date.parse(r.started)) : mins(Date.parse(r.updated) - Date.parse(r.started));
      return h('tr', { class: running ? 'run-on' : (icon === '✗' ? 'run-bad' : null) },
        h('td', { class: 'run-i', 'aria-hidden': 'true' }, icon),
        h('td', null, h('a', { href: r.url, target: '_blank', rel: 'noopener' }, str(r.name)),
          h('div', { class: 'meta' }, [str(r.title), str(r.event)].filter(Boolean).join(' · '))),
        h('td', null, label),
        h('td', { class: 'run-t' }, hhmm(r.started), h('div', { class: 'meta' }, took)));
    });
    return [h('div', { class: 'card' },
      h('table', { class: 'h runs' }, h('thead', null, h('tr', null, h('th', null, ''), h('th', null, 'Job'), h('th', null, 'Status'), h('th', null, 'Started'))),
        h('tbody', null, rows.length ? rows : h('tr', null, h('td', { colspan: 4 }, 'No runs yet.')))),
      h('p', { class: 'meta' }, 'The latest ' + rows.length + ' runs · updates every 15 seconds' + (S.runsAt ? ' · checked ' + hhmm(new Date(S.runsAt).toISOString()) : '')))];
  }

  wideQ.addEventListener('change', function () { if (S.data) render(); });
  load(true);
})();
`;

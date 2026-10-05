/**
 * Lenches: import images from past MailerLite newsletters into Drive, with a
 * visual review page (Move to Lenches Photos/<Village>/<Subject>/ or Delete).
 *
 * REFERENCE COPY. The live code is the "mailerlite-images" file (plus the HTML
 * file "review") in the "Lenches backup" Apps Script bound to the Lenches
 * Pipeline Sheet (Extensions > Apps Script). Runs as jon@. Edit there, then
 * update this copy.
 *
 * How it works:
 * - importStep (time trigger, every 5 min until finished) reads every sent
 *   MailerLite campaign, lists its images in the "Image review" tab (status
 *   queued), then downloads each one into Lenches Photos/_MailerLite import/
 *   (the "_" makes the Drive photos Action skip it), drops tiny images and
 *   exact duplicates, and asks Claude for a description and a suggested
 *   village, subject and keep/delete (status review).
 * - The web app (doGet, review.html) shows the review cards. Move puts the
 *   file in Lenches Photos/<Village>/<Subject>/, where the Drive photos Action
 *   picks it up for the normal Photos tab approval. Delete sends it to Drive's
 *   bin (recoverable for 30 days). Both can be undone from the page.
 *
 * Rules: don't sort or rename the Image review tab or its headers.
 *
 * Setup: Project Settings > Script properties: MAILERLITE_API_KEY and
 * ANTHROPIC_API_KEY. Run startImport once (authorise). Deploy > New deployment
 * > Web app, Execute as: Me, Who has access: Only myself.
 */

var MLImages = (function () {
  var SHEET_ID = '1k-9oxqMVfWCb4wIY_RbSiSszarb2d029_UXnKIFdNRI'; // Lenches Pipeline (live)
  var ROOT_ID = '0BwdIG5DOmCgkT2thdWs2LTdIbzQ'; // Lenches Photos
  var STAGING = '_MailerLite import';
  var TAB = 'Image review';
  var HEAD = ['file_id', 'image_url', 'alt', 'campaign', 'sent', 'hash', 'description', 'people', 'kind',
    'village', 'subject', 'suggest_delete', 'reason', 'status', 'decided_at', 'notes'];
  var VILLAGES = ['Church Lench', 'Rous Lench', 'Ab Lench', 'Atch Lench', 'Sheriffs Lench', 'Harvington', 'General'];
  var API = 'https://connect.mailerlite.com/api';
  var MODEL = 'claude-sonnet-5';
  var BUDGET_MS = 4.5 * 60 * 1000;
  var MIN_BYTES = 3000;
  var MAX_DESCRIBE = 3.7 * 1024 * 1024;
  var PAGE = 24;
  var TZ = 'Europe/London';
  var SKIP = /(spacer|pixel|track|\/open\b|\bicons?\b|social|facebook|twitter|instagram|linkedin|youtube|whatsapp|tiktok|mailerlite-logo|badge)/i;
  var EXT = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };
  var props = PropertiesService.getScriptProperties();

  var SYSTEM = 'You sort images taken from past issues of The Lenches newsletter (villages in Worcestershire, England) into photo folders.\n'
    + 'Reply with one JSON object and nothing else:\n'
    + '{"description": "...", "people": "none|distant|identifiable", "children": false, "kind": "photo|screenshot|document|graphic", "village": "...", "subject": "...", "delete": false, "reason": "..."}\n'
    + 'description: one plain sentence in British English saying what the image shows.\n'
    + 'people: "none" if nobody is visible; "distant" if people are too small, blurred or turned away to be recognised; "identifiable" if any face could be recognised. children: true if anyone visible appears to be under 18.\n'
    + 'kind: "document" for flyers, posters or text-heavy images; "graphic" for logos, banners and illustrations; "screenshot" for screens and maps; otherwise "photo".\n'
    + 'village: one of ' + VILLAGES.join(', ') + '. Choose a specific village only if the image, its alt text or the newsletter subject makes it clear; otherwise General.\n'
    + 'subject: a short folder name in title case. Prefer one of the existing subject folders listed below when it fits.\n'
    + 'delete: true for things not worth keeping as photos: logos, icons, social buttons, newsletter banners and headers, sponsor or advertising graphics, clip art, text-only flyers or posters for past events, screenshots and maps. Otherwise false.\n'
    + 'reason: if delete is true, a few words saying why; otherwise an empty string.';

  function text(v) {
    if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
    return String(v === null || v === undefined ? '' : v).trim();
  }

  function clean(s, max) {
    return String(s || '').replace(/[\\/:*?"<>|#%]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
  }

  function titleCase(s) {
    return s.toLowerCase().replace(/(^|[\s-])([a-z])/g, function (m, a, b) { return a + b.toUpperCase(); });
  }

  function hex(bytes) {
    return bytes.map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
  }

  function child(parent, name) {
    var it = parent.getFoldersByName(name);
    return it.hasNext() ? it.next() : parent.createFolder(name);
  }

  function root() { return DriveApp.getFolderById(ROOT_ID); }
  function staging() { return child(root(), STAGING); }

  function sheet() {
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var sh = ss.getSheetByName(TAB);
    if (!sh) {
      sh = ss.insertSheet(TAB);
      sh.getRange(1, 1, sh.getMaxRows(), HEAD.length).setNumberFormat('@');
      sh.getRange(1, 1, 1, HEAD.length).setValues([HEAD]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
    return sh;
  }

  function table() {
    var sh = sheet();
    var v = sh.getDataRange().getValues();
    var h = v[0].map(function (x) { return String(x).trim(); });
    var missing = HEAD.filter(function (n) { return h.indexOf(n) < 0; });
    if (missing.length) throw new Error('Image review is missing headers: ' + missing.join(', '));
    return { sh: sh, v: v, h: h, col: function (n) { return h.indexOf(n); } };
  }

  function blankRow(t, fields) {
    var r = t.h.map(function () { return ''; });
    Object.keys(fields).forEach(function (k) { r[t.col(k)] = fields[k]; });
    return r;
  }

  // Existing village folders and subject folders under Lenches Photos ("_" folders skipped).
  function folders() {
    var villages = VILLAGES.slice(), subjects = {};
    var it = root().getFolders();
    while (it.hasNext()) {
      var v = it.next();
      var vn = v.getName().trim();
      if (vn.charAt(0) === '_') continue;
      if (villages.indexOf(vn) < 0) villages.push(vn);
      var st = v.getFolders();
      while (st.hasNext()) {
        var sn = st.next().getName().trim();
        if (sn.charAt(0) !== '_') subjects[sn] = 1;
      }
    }
    return { villages: villages, subjects: Object.keys(subjects).sort() };
  }

  // ---------- MailerLite ----------

  function ml(url) {
    var key = props.getProperty('MAILERLITE_API_KEY');
    if (!key) throw new Error('Script property MAILERLITE_API_KEY is not set');
    var res = UrlFetchApp.fetch(url.indexOf('http') === 0 ? url : API + url, {
      headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' },
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() !== 200) throw new Error('MailerLite ' + res.getResponseCode() + ' for ' + url);
    return JSON.parse(res.getContentText());
  }

  function campaignHtml(c) {
    var e = c.emails && c.emails[0];
    if (e && e.content) return e.content;
    try {
      var full = ml('/campaigns/' + c.id);
      var fe = full.data && full.data.emails && full.data.emails[0];
      if (fe && fe.content) return fe.content;
      if (fe) e = fe;
    } catch (x) { /* fall back to the preview page */ }
    var p = e && e.preview_url;
    if (!p) return '';
    var res = UrlFetchApp.fetch(p, { muteHttpExceptions: true });
    return res.getResponseCode() === 200 ? res.getContentText() : '';
  }

  function attr(tag, name) {
    var m = tag.match(new RegExp('\\s' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')', 'i'));
    return m ? (m[1] !== undefined ? m[1] : m[2]) : '';
  }

  function imagesIn(html) {
    var out = [], re = /<img\b[^>]*>/gi, m;
    while ((m = re.exec(html))) {
      var src = attr(m[0], 'src').replace(/&amp;/g, '&');
      if (!/^https?:\/\//i.test(src) || SKIP.test(src)) continue;
      var w = parseInt(attr(m[0], 'width'), 10);
      if (w && w < 60) continue;
      out.push({ src: src, alt: attr(m[0], 'alt') });
    }
    return out;
  }

  // Phase 1: list every image in every sent campaign as a queued row. Resumable.
  function collect(deadline) {
    if (props.getProperty('ML_COLLECTED') === 'yes') return true;
    var done = JSON.parse(props.getProperty('ML_DONE') || '[]');
    var t = table();
    var seen = {};
    t.v.slice(1).forEach(function (r) { seen[text(r[t.col('image_url')])] = 1; });
    var url = API + '/campaigns?filter%5Bstatus%5D=sent&limit=100';
    while (url) {
      var page = ml(url);
      var list = page.data || [];
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (done.indexOf(String(c.id)) >= 0) continue;
        if (Date.now() > deadline) return false;
        var sent = String(c.finished_at || c.scheduled_for || c.created_at || '').slice(0, 10);
        var name = clean((c.emails && c.emails[0] && c.emails[0].subject) || c.name || 'Newsletter', 120);
        var add = [];
        imagesIn(campaignHtml(c)).forEach(function (im) {
          if (seen[im.src]) return;
          seen[im.src] = 1;
          add.push(blankRow(t, { image_url: im.src, alt: clean(im.alt, 200), campaign: name, sent: sent, status: 'queued' }));
        });
        if (add.length) t.sh.getRange(t.sh.getLastRow() + 1, 1, add.length, t.h.length).setValues(add);
        done.push(String(c.id));
        props.setProperty('ML_DONE', JSON.stringify(done));
      }
      url = page.links && page.links.next;
    }
    props.setProperty('ML_COLLECTED', 'yes');
    return true;
  }

  // ---------- Claude ----------

  function describe(bytes, type, campaign, sent, alt, subjects) {
    var key = props.getProperty('ANTHROPIC_API_KEY');
    if (!key) throw new Error('Script property ANTHROPIC_API_KEY is not set');
    if (bytes.length > MAX_DESCRIBE || !/^image\/(jpeg|png|gif|webp)$/.test(type)) throw new Error('too large or unsupported type for a suggestion');
    var body = {
      model: MODEL,
      max_tokens: 400,
      system: SYSTEM + '\nExisting subject folders: ' + (subjects.join(', ') || 'none yet'),
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: type === 'image/jpg' ? 'image/jpeg' : type, data: Utilities.base64Encode(bytes) } },
          { type: 'text', text: 'Newsletter subject: ' + campaign + ' (sent ' + sent + '). Alt text in the email: ' + (alt || 'none') },
        ],
      }],
    };
    var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      payload: JSON.stringify(body),
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() !== 200) throw new Error('Claude ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 150));
    var out = (JSON.parse(res.getContentText()).content || [])
      .filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('');
    var s = out.indexOf('{'), e = out.lastIndexOf('}');
    if (s < 0 || e < s) throw new Error('no JSON in reply');
    var d = JSON.parse(out.slice(s, e + 1));
    var people = ['none', 'distant', 'identifiable'].indexOf(d.people) >= 0 ? d.people : 'unknown';
    return {
      description: clean(d.description, 300),
      people: d.children === true ? 'children' : people,
      kind: ['photo', 'screenshot', 'document', 'graphic'].indexOf(d.kind) >= 0 ? d.kind : 'photo',
      village: VILLAGES.indexOf(d.village) >= 0 ? d.village : 'General',
      subject: titleCase(clean(d.subject, 40)) || 'Misc',
      suggest_delete: d['delete'] === true ? 'yes' : '',
      reason: clean(d.reason, 120),
    };
  }

  // Phase 2: download, de-duplicate, save to staging and describe. Resumable.
  function processQueue(deadline) {
    var t = table();
    var col = t.col;
    var hashes = {};
    t.v.slice(1).forEach(function (r) {
      var h = text(r[col('hash')]);
      if (h && text(r[col('file_id')])) hashes[h] = text(r[col('file_id')]);
    });
    var folder = null, subjects = null, left = 0;
    for (var i = 1; i < t.v.length; i++) {
      var r = t.v[i];
      if (text(r[col('status')]) !== 'queued') continue;
      if (Date.now() > deadline) { left++; continue; }
      var put = function (n, v) { r[col(n)] = v; };
      try {
        var res = UrlFetchApp.fetch(text(r[col('image_url')]), { muteHttpExceptions: true });
        if (res.getResponseCode() !== 200) { put('status', 'error'); put('notes', 'download ' + res.getResponseCode()); continue; }
        var blob = res.getBlob();
        var bytes = blob.getBytes();
        var type = String(blob.getContentType() || '').toLowerCase().split(';')[0].trim();
        if (!/^image\//.test(type)) { put('status', 'skipped'); put('notes', 'not an image: ' + type); continue; }
        if (bytes.length < MIN_BYTES) { put('status', 'skipped'); put('notes', 'tiny (' + bytes.length + ' bytes)'); continue; }
        var hash = hex(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, bytes));
        put('hash', hash);
        if (hashes[hash]) { put('status', 'duplicate'); put('notes', 'same as ' + hashes[hash]); continue; }

        if (!folder) folder = staging();
        var campaign = text(r[col('campaign')]), sent = text(r[col('sent')]);
        var name = clean(sent + ' ' + campaign, 90) + ' ' + (i + 1) + '.' + (EXT[type] || 'jpg');
        var file = folder.createFile(blob.setName(name));
        file.setDescription('From the MailerLite newsletter "' + campaign + '" sent ' + sent + '. Original: ' + text(r[col('image_url')]));
        hashes[hash] = file.getId();
        put('file_id', file.getId());
        put('status', 'review');
        try {
          if (!subjects) subjects = folders().subjects;
          var d = describe(bytes, type, campaign, sent, text(r[col('alt')]), subjects);
          Object.keys(d).forEach(function (k) { put(k, d[k]); });
        } catch (e) {
          put('village', 'General');
          put('notes', ('no suggestion: ' + e.message).slice(0, 200));
        }
      } catch (e2) {
        put('status', 'error');
        put('notes', String(e2.message).slice(0, 200));
      } finally {
        t.sh.getRange(i + 1, 1, 1, r.length).setValues([r.map(text)]);
      }
    }
    return left === 0;
  }

  function step() {
    var deadline = Date.now() + BUDGET_MS;
    if (!collect(deadline)) return false;
    return processQueue(deadline);
  }

  // ---------- Review page ----------

  function thumb(id) {
    try {
      var f = DriveApp.getFileById(id);
      var t = f.getThumbnail();
      if (t && t.getBytes().length) return 'data:image/png;base64,' + Utilities.base64Encode(t.getBytes());
      var b = f.getBlob().getBytes();
      return b.length > 400000 ? '' : 'data:' + f.getMimeType() + ';base64,' + Utilities.base64Encode(b);
    } catch (e) { return ''; }
  }

  function page(filter, offset) {
    var t = table();
    var col = t.col;
    var want = filter === 'moved' || filter === 'deleted' ? filter : 'review';
    var counts = { queued: 0, review: 0, moved: 0, deleted: 0 };
    var list = [];
    t.v.slice(1).forEach(function (r) {
      var s = text(r[col('status')]);
      if (s in counts) counts[s]++;
      if (s === want && text(r[col('file_id')])) list.push(r);
    });
    // Suggested deletes first when reviewing, so the junk clears quickly.
    if (want === 'review') {
      list.sort(function (a, b) {
        return (text(b[col('suggest_delete')]) === 'yes') - (text(a[col('suggest_delete')]) === 'yes');
      });
    } else {
      list.reverse();
    }
    var f = folders();
    var items = list.slice(offset || 0, (offset || 0) + PAGE).map(function (r) {
      var id = text(r[col('file_id')]);
      return {
        id: id, thumb: thumb(id),
        description: text(r[col('description')]) || text(r[col('alt')]),
        campaign: text(r[col('campaign')]), sent: text(r[col('sent')]),
        people: text(r[col('people')]), kind: text(r[col('kind')]),
        village: text(r[col('village')]), subject: text(r[col('subject')]),
        suggestDelete: text(r[col('suggest_delete')]) === 'yes', reason: text(r[col('reason')]),
        decided: text(r[col('decided_at')]), notes: text(r[col('notes')]),
      };
    });
    var running = ScriptApp.getProjectTriggers().some(function (tr) { return tr.getHandlerFunction() === 'importStep'; });
    return { items: items, total: list.length, counts: counts, villages: f.villages, subjects: f.subjects, running: running };
  }

  function decide(id, action, village, subject) {
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(15000)) throw new Error('Busy, try again in a moment');
    try {
      var t = table();
      var col = t.col;
      var i = -1;
      for (var k = 1; k < t.v.length; k++) if (text(t.v[k][col('file_id')]) === id) { i = k; break; }
      if (i < 0) throw new Error('Image not found in the Image review tab');
      var r = t.v[i].map(text);
      var status = r[col('status')];
      var file = DriveApp.getFileById(id);
      var stamp = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm');
      var where = '';
      if (action === 'move') {
        if (status !== 'review') throw new Error('Already ' + status);
        var v = clean(village, 40), s = clean(subject, 40);
        if (!v || !s) throw new Error('Choose a village and a subject first');
        if (s === s.toLowerCase()) s = titleCase(s);
        file.moveTo(child(child(root(), v), s));
        r[col('status')] = 'moved'; r[col('village')] = v; r[col('subject')] = s;
        where = v + ' / ' + s;
        r[col('notes')] = 'moved to ' + where;
      } else if (action === 'delete') {
        if (status !== 'review') throw new Error('Already ' + status);
        file.setTrashed(true);
        r[col('status')] = 'deleted';
        r[col('notes')] = 'sent to Drive bin';
      } else if (action === 'undo') {
        if (status === 'deleted') file.setTrashed(false);
        else if (status !== 'moved') throw new Error('Nothing to undo');
        file.moveTo(staging());
        r[col('status')] = 'review';
        r[col('notes')] = 'undone ' + stamp;
      } else {
        throw new Error('Unknown action');
      }
      r[col('decided_at')] = action === 'undo' ? '' : stamp;
      t.sh.getRange(i + 1, 1, 1, r.length).setValues([r]);
      return { status: r[col('status')], where: where };
    } finally {
      lock.releaseLock();
    }
  }

  return { step: step, page: page, decide: decide };
})();

// ---------- Entry points ----------

function doGet() {
  return HtmlService.createTemplateFromFile('review').evaluate()
    .setTitle('Lenches image review')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function reviewPage(filter, offset) { return MLImages.page(filter, offset); }
function reviewDecide(id, action, village, subject) { return MLImages.decide(id, action, village, subject); }

function reviewStartImport() {
  installImportTrigger_();
  return true;
}

// Run once by hand: installs the trigger and does the first batch straight away.
function startImport() {
  installImportTrigger_();
  importStep();
}

function installImportTrigger_() {
  var has = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'importStep'; });
  if (!has) ScriptApp.newTrigger('importStep').timeBased().everyMinutes(5).create();
}

function importStep() {
  var lock = LockService.getDocumentLock();
  if (!lock || !lock.tryLock(1000)) return; // a run is already going
  try {
    if (MLImages.step()) {
      ScriptApp.getProjectTriggers()
        .filter(function (t) { return t.getHandlerFunction() === 'importStep'; })
        .forEach(function (t) { ScriptApp.deleteTrigger(t); });
      console.log('MailerLite image import finished.');
    }
  } finally {
    lock.releaseLock();
  }
}

// Only if you want to re-read every campaign from scratch (rows already listed are kept).
function resetImportProgress() {
  PropertiesService.getScriptProperties().deleteProperty('ML_DONE');
  PropertiesService.getScriptProperties().deleteProperty('ML_COLLECTED');
}

/**
 * Lenches: save submitted photos to Drive (plan item 9b).
 *
 * REFERENCE COPY. The live code is the "photos" file in the "Lenches backup"
 * Apps Script bound to the Lenches Pipeline Sheet (Extensions > Apps Script).
 * It runs as jon@, so the files it creates are owned by jon@ (a service
 * account has no Drive storage of its own). Edit there, then update this copy.
 *
 * Hourly: for Pending rows with status approved/auto and an image, fetch the
 * image from Gmail and save the original into Lenches Photos/<Village>/<Category>/
 * as "<date> <title>.<ext>", creating folders as needed. Pending column
 * drive_file_id records the result: a Drive file ID, "dup:<id>" (same image
 * already saved), or "error: ..." (clear the cell to retry).
 * The Drive photos Action then picks the files up as new Photos rows.
 *
 * Rules: don't sort Pending rows (results are written by row number); people
 * photos are saved too but still need people_ok before publishing.
 *
 * Setup: add header "drive_file_id" to Pending row 1; run savePhotosToDrive once
 * (authorise); run installPhotoTrigger once.
 */

var LenchesPhotos = (function () {
  var ROOT_ID = '0BwdIG5DOmCgkT2thdWs2LTdIbzQ'; // Lenches Photos
  var MAX_PER_RUN = 20;
  var DUP_BITS = 6; // dHash bits: same picture, resized or recompressed
  var TZ = 'Europe/London';
  var NEED = ['id', 'received', 'from', 'title', 'event_date', 'village', 'category', 'status',
    'message_id', 'image_part_id', 'image_filename', 'image_hash', 'drive_file_id'];
  var CATEGORY_FOLDERS = { event: 'Events', events: 'Events', news: 'News', notice: 'Notices', notices: 'Notices' };
  var VILLAGE_ALIASES = { 'abbots lench': 'Ab Lench', 'the lenches': 'General', 'lenches': 'General' };
  var EXT = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
    'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif', 'image/tiff': 'tif' };

  function text(v) {
    if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
    return String(v === null || v === undefined ? '' : v).trim();
  }

  function titleCase(s) {
    return s.toLowerCase().replace(/(^|[\s-])([a-z])/g, function (m, a, b) { return a + b.toUpperCase(); });
  }

  function clean(s, max) {
    return s.replace(/[\\/:*?"<>|#%]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
  }

  function hamming(a, b) {
    var ok = /^[0-9a-f]{16}$/;
    if (!ok.test(a) || !ok.test(b)) return 64;
    var n = 0;
    for (var i = 0; i < 16; i += 4) {
      var x = parseInt(a.substr(i, 4), 16) ^ parseInt(b.substr(i, 4), 16);
      while (x) { n += x & 1; x >>= 1; }
    }
    return n;
  }

  function child(parent, name) {
    var it = parent.getFoldersByName(name);
    return it.hasNext() ? it.next() : parent.createFolder(name);
  }

  function folderFor(root, village, category) {
    var v = clean(village, 40);
    // Blank, unknown or several villages -> General.
    if (!v || /^(unknown|none|n\/?a)$/i.test(v) || /,|&|\band\b/i.test(v)) v = 'General';
    v = VILLAGE_ALIASES[v.toLowerCase()] || titleCase(v);
    var c = clean(category, 30).toLowerCase();
    var sub = c ? (CATEGORY_FOLDERS[c] || titleCase(c)) : 'Submitted';
    return child(child(root, v), sub);
  }

  function attachment(messageId, filename) {
    var msg = GmailApp.getMessageById(messageId);
    var atts = msg.getAttachments({ includeInlineImages: true, includeAttachments: true })
      .filter(function (a) { return /^image\//i.test(a.getContentType()); });
    var a = null;
    if (filename) a = atts.filter(function (x) { return x.getName() === filename; })[0] || null;
    if (!a && atts.length === 1) a = atts[0];
    if (!a) throw new Error('image "' + (filename || '(no name)') + '" not found among ' + atts.length + ' image(s)');
    return a.copyBlob();
  }

  function run() {
    var sheet = SpreadsheetApp.getActive().getSheetByName('Pending');
    var values = sheet.getDataRange().getValues();
    var head = values[0].map(function (h) { return String(h).trim(); });
    var missing = NEED.filter(function (n) { return head.indexOf(n) < 0; });
    if (missing.length) throw new Error('Pending is missing headers: ' + missing.join(', '));
    var col = function (n) { return head.indexOf(n); };
    var get = function (r, n) { return text(r[col(n)]); };
    var mark = function (rowNum, v) { sheet.getRange(rowNum, col('drive_file_id') + 1).setValue(v); };

    var saved = [];
    values.slice(1).forEach(function (r) {
      var f = get(r, 'drive_file_id');
      var h = get(r, 'image_hash');
      if (f && h && !/^error/i.test(f)) saved.push({ h: h, f: f.replace(/^dup:/, '') });
    });

    var root = DriveApp.getFolderById(ROOT_ID);
    var done = 0, dups = 0, failed = 0;
    for (var i = 1; i < values.length && done < MAX_PER_RUN; i++) {
      var r = values[i];
      var status = get(r, 'status').toLowerCase();
      if (status !== 'approved' && status !== 'auto') continue;
      if (get(r, 'drive_file_id') || !get(r, 'image_part_id') || !get(r, 'message_id')) continue;
      var rowNum = i + 1;

      var hash = get(r, 'image_hash');
      var dup = hash ? saved.filter(function (s) { return hamming(s.h, hash) <= DUP_BITS; })[0] : null;
      if (dup) { mark(rowNum, 'dup:' + dup.f); dups++; continue; }

      done++;
      try {
        var blob = attachment(get(r, 'message_id'), get(r, 'image_filename'));
        var type = String(blob.getContentType() || '').toLowerCase();
        var date = (get(r, 'event_date') || get(r, 'received')).slice(0, 10);
        var name = [date, clean(get(r, 'title'), 80) || 'Submitted photo'].filter(String).join(' ')
          + '.' + (EXT[type] || 'jpg');
        var folder = folderFor(root, get(r, 'village'), get(r, 'category'));
        var file = folder.createFile(blob.setName(name));
        var from = get(r, 'from').replace(/<[^>]*>/g, '').replace(/"/g, '').trim();
        file.setDescription('Submitted photo. Pending ' + get(r, 'id')
          + (from && from.indexOf('@') < 0 ? '; from ' + from : '')
          + '; received ' + get(r, 'received').slice(0, 10) + '.');
        mark(rowNum, file.getId());
        if (hash) saved.push({ h: hash, f: file.getId() });
      } catch (e) {
        failed++;
        mark(rowNum, ('error: ' + e.message).slice(0, 200));
      }
    }
    console.log('Saved ' + (done - failed) + ', duplicates ' + dups + ', failed ' + failed + '.');
    // A thrown error makes Google email the failure (trigger notifications).
    if (failed) throw new Error(failed + ' photo(s) failed: see drive_file_id in Pending');
  }

  return { run: run };
})();

function savePhotosToDrive() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return; // a run is already going
  try {
    LenchesPhotos.run();
  } finally {
    lock.releaseLock();
  }
}

function installPhotoTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'savePhotosToDrive'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('savePhotosToDrive').timeBased().everyHours(1).create();
}

/**
 * image-fetch.gs — reference copy of the "image-fetch" file in the Lenches backup
 * Apps Script project (bound to the Lenches Pipeline Sheet). Copy FROM github.com,
 * paste INTO script.google.com.
 *
 * Saves event images from the web into Lenches Photos/<Village>/<Subject>/ so the
 * Photos job can describe them and, once approved with a target (e.g. event:bonfire),
 * publish them on the site. Runs as jon@ (a service account can't own Drive files).
 *
 * Sheet tab "Image fetch" (created by imageFetchSetup), one row per image:
 *   url          direct link to the image file (required)
 *   village      folder under Lenches Photos; blank = General
 *   subject      sub-folder; blank = Events
 *   filename     name in Drive; blank = taken from the url
 *   credit       who the image belongs to (organiser)
 *   source_page  the page it came from (kept in the Drive description)
 *   status       blank = to do; saved / skipped / error (set by the script; clear to retry)
 *   saved_at, drive_file_id, notes   set by the script
 *
 * imageFetchSetup()      run once: creates the tab and an hourly trigger.
 * imageFetchRun()        does the work (the trigger calls it; also safe to run by hand).
 * All names start with imageFetch so nothing clashes with photos.gs or backup.gs.
 */

var IMAGE_FETCH_TAB = 'Image fetch';
var IMAGE_FETCH_ROOT_ID = '0BwdIG5DOmCgkT2thdWs2LTdIbzQ'; // Lenches Photos
var IMAGE_FETCH_HEADERS = ['url', 'village', 'subject', 'filename', 'credit', 'source_page',
  'status', 'saved_at', 'drive_file_id', 'notes'];
var IMAGE_FETCH_MAX_BYTES = 20 * 1024 * 1024;
var IMAGE_FETCH_MAX_PER_RUN = 20;

function imageFetchSetup() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(IMAGE_FETCH_TAB) || ss.insertSheet(IMAGE_FETCH_TAB);
  if (!String(sh.getRange(1, 1).getValue()).trim()) {
    sh.getRange(1, 1, 1, IMAGE_FETCH_HEADERS.length).setValues([IMAGE_FETCH_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'imageFetchRun') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('imageFetchRun').timeBased().everyHours(1).create();
  return 'Image fetch tab ready; hourly trigger set.';
}

function imageFetchRun() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return 'Another run is in progress.';
  try {
    var sh = SpreadsheetApp.getActive().getSheetByName(IMAGE_FETCH_TAB);
    if (!sh || sh.getLastRow() < 2) return 'Nothing to do.';
    var values = sh.getDataRange().getValues();
    var head = values[0].map(function (h) { return String(h).trim(); });
    var col = {};
    IMAGE_FETCH_HEADERS.forEach(function (h) {
      col[h] = head.indexOf(h);
      if (col[h] < 0) throw new Error('Image fetch tab is missing the "' + h + '" header');
    });
    var root = DriveApp.getFolderById(IMAGE_FETCH_ROOT_ID);
    var done = 0;
    for (var i = 1; i < values.length && done < IMAGE_FETCH_MAX_PER_RUN; i++) {
      var r = values[i];
      var url = String(r[col.url]).trim();
      if (!url || String(r[col.status]).trim()) continue;
      done++;
      var out = imageFetchOne_(root, r, col);
      var rowNum = i + 1;
      sh.getRange(rowNum, col.status + 1).setValue(out.status);
      sh.getRange(rowNum, col.saved_at + 1).setValue(out.status === 'saved'
        ? Utilities.formatDate(new Date(), 'Europe/London', 'yyyy-MM-dd HH:mm') : '');
      sh.getRange(rowNum, col.drive_file_id + 1).setValue(out.id || '');
      sh.getRange(rowNum, col.notes + 1).setValue(out.note || '');
    }
    return done + ' row(s) processed.';
  } finally {
    lock.releaseLock();
  }
}

function imageFetchOne_(root, r, col) {
  var url = String(r[col.url]).trim();
  try {
    if (!/^https:\/\//i.test(url)) return { status: 'error', note: 'url must start with https://' };
    var res = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      followRedirects: true,
      headers: { 'User-Agent': 'LenchesPipeline/1.0 (+https://thelenches.org.uk)' },
    });
    var code = res.getResponseCode();
    if (code !== 200) return { status: 'error', note: 'HTTP ' + code };
    var blob = res.getBlob();
    var type = String(blob.getContentType() || '').toLowerCase();
    if (type.indexOf('image/') !== 0) return { status: 'error', note: 'Not an image (' + type + ')' };
    if (blob.getBytes().length > IMAGE_FETCH_MAX_BYTES) return { status: 'error', note: 'Larger than 20 MB' };

    var name = String(r[col.filename]).trim() || imageFetchNameFromUrl_(url, type);
    blob.setName(name);
    var folder = imageFetchFolder_(root, [
      String(r[col.village]).trim() || 'General',
      String(r[col.subject]).trim() || 'Events',
    ]);
    var existing = folder.getFilesByName(name);
    if (existing.hasNext()) {
      return { status: 'skipped', id: existing.next().getId(), note: 'A file with this name is already there' };
    }
    var file = folder.createFile(blob);
    var credit = String(r[col.credit]).trim();
    var source = String(r[col.source_page]).trim();
    file.setDescription(['Event image fetched from the web.',
      credit ? 'Credit: ' + credit + '.' : '',
      source ? 'Source: ' + source : '',
      'Image: ' + url].filter(String).join(' '));
    return { status: 'saved', id: file.getId(), note: folder.getName() + ' / ' + name };
  } catch (err) {
    return { status: 'error', note: String(err && err.message || err).slice(0, 300) };
  }
}

function imageFetchNameFromUrl_(url, type) {
  var base = decodeURIComponent(url.split('?')[0].split('/').pop() || 'image');
  base = base.replace(/[^\w .()&-]+/g, ' ').replace(/\s+/g, ' ').trim() || 'image';
  if (!/\.(jpe?g|png|gif|webp|hei[cf])$/i.test(base)) {
    var ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' }[type] || '.jpg';
    base += ext;
  }
  return base;
}

// Finds or creates each folder in the path under root.
function imageFetchFolder_(root, path) {
  var folder = root;
  path.forEach(function (seg) {
    var it = folder.getFoldersByName(seg);
    folder = it.hasNext() ? it.next() : folder.createFolder(seg);
  });
  return folder;
}

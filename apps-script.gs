// Budget Tool - Google Apps Script backing store.
// Stores the entire tool state as JSON in cell A1 of a sheet named "_data".
// A2 holds the last-modified ISO timestamp.

var SHEET_NAME = '_data';

function doGet(e) {
  return _ok(_read());
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    if (body.action === 'read')  return _ok(_read());
    if (body.action === 'write') return _ok(_write(body.data));
    if (body.action === 'ping')  return _ok({ ok: true, ts: new Date().toISOString() });
    return _err('unknown action: ' + body.action);
  } catch (err) {
    return _err('parse error: ' + String(err));
  }
}

function _read() {
  var sh = _getSheet();
  var json = sh.getRange('A1').getValue();
  var updated = sh.getRange('A2').getValue();
  if (!json) return { data: null, updated: null };
  try {
    return { data: JSON.parse(json), updated: updated ? String(updated) : null };
  } catch (err) {
    return { data: null, updated: updated ? String(updated) : null, error: 'json parse error' };
  }
}

function _write(data) {
  var sh = _getSheet();
  var ts = new Date().toISOString();
  sh.getRange('A1').setValue(JSON.stringify(data));
  sh.getRange('A2').setValue(ts);
  return { ok: true, updated: ts };
}

function _getSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.getRange('A1').setValue('');
    sh.getRange('A2').setValue('');
    sh.getRange('B1').setValue('JSON state - do not edit by hand');
    sh.getRange('B2').setValue('Last updated (ISO 8601 UTC)');
    sh.setColumnWidth(1, 600);
    sh.setColumnWidth(2, 600);
  }
  return sh;
}

function _ok(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function _err(msg) {
  return ContentService.createTextOutput(JSON.stringify({ error: msg }))
    .setMimeType(ContentService.MimeType.JSON);
}

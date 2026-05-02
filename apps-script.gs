/**
 * Budget Tool — Google Apps Script backing store
 *
 * Setup (one-time, ~3 minutes):
 *   1. In Google Sheets, create a NEW Sheet, name it whatever you want
 *      (e.g. "Roth Family Budget").
 *   2. Share the Sheet with your wife (Editor access).
 *   3. From the Sheet menu: Extensions → Apps Script.
 *   4. Replace the default Code.gs with the contents of this file.
 *   5. Click "Deploy" → "New deployment" → gear icon → "Web app".
 *      - Description: "Budget Tool API"
 *      - Execute as: "Me (your email)"
 *      - Who has access: "Anyone"  ← REQUIRED for the webhook to work from
 *        the browser. The URL itself acts as a secret — it's a long, random
 *        string. Don't share the URL anywhere public.
 *   6. Click Deploy. You'll be asked to authorize — say yes.
 *   7. Copy the "Web app URL" Google gives you.
 *   8. In the Budget tool, go to Settings → paste the URL → Test → Save.
 *
 * To re-deploy after edits: Deploy → Manage deployments → edit (pencil) →
 * Version: New version → Deploy. Keep the same URL, just bumps the version.
 *
 * Data model: a single cell A1 in a sheet named "_data" holds the entire
 * tool state as a JSON string. A2 holds an ISO timestamp of last write.
 * This is intentionally simple — single source of truth, atomic writes,
 * easy to inspect or back up by copying the cell.
 */

const SHEET_NAME = '_data';

function doGet(e) {
  return _ok(_read());
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.action === 'read')  return _ok(_read());
    if (body.action === 'write') return _ok(_write(body.data));
    if (body.action === 'ping')  return _ok({ ok: true, ts: new Date().toISOString() });
    return _err('unknown action: ' + body.action);
  } catch (err) {
    return _err('parse error: ' + String(err));
  }
}

function _read() {
  const sh = _getSheet();
  const json = sh.getRange('A1').getValue();
  const updated = sh.getRange('A2').getValue();
  if (!json) return { data: null, updated: null };
  try {
    return { data: JSON.parse(json), updated: updated ? String(updated) : null };
  } catch (err) {
    return { data: null, updated: updated ? String(updated) : null, error: 'json parse error' };
  }
}

function _write(data) {
  const sh = _getSheet();
  const ts = new Date().toISOString();
  sh.getRange('A1').setValue(JSON.stringify(data));
  sh.getRange('A2').setValue(ts);
  return { ok: true, updated: ts };
}

function _getSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.getRange('A1').setValue('');
    sh.getRange('A2').setValue('');
    sh.getRange('B1').setValue('JSON state (do not edit by hand — the budget tool reads/writes here)');
    sh.getRange('B2').setValue('Last updated (ISO 8601 UTC)');
    sh.setColumnWidth(1, 600);
    sh.setColumnWidth(2, 600);
  }
  return sh;
}

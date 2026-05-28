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
    if (body.action === 'read')             return _ok(_read());
    if (body.action === 'write')            return _ok(_write(body.data));
    if (body.action === 'ping')             return _ok({ ok: true, ts: new Date().toISOString() });
    if (body.action === 'subscribePush')    return _ok(_subscribePush(body.subscription, body.deviceLabel));
    if (body.action === 'unsubscribePush')  return _ok(_unsubscribePush(body.endpoint));
    return _err('unknown action: ' + body.action);
  } catch (err) {
    return _err('parse error: ' + String(err));
  }
}

// ── Push subscription storage (lives inside the same JSON state) ──
function _subscribePush(sub, label) {
  if (!sub || !sub.endpoint) return { ok: false, error: 'bad subscription' };
  var st = _readData();
  st.push = st.push || { subscriptions: [], firedKeys: [] };
  // upsert by endpoint
  var i = -1;
  for (var k = 0; k < st.push.subscriptions.length; k++) {
    if (st.push.subscriptions[k].endpoint === sub.endpoint) { i = k; break; }
  }
  var entry = { endpoint: sub.endpoint, keys: sub.keys, label: label || '', addedAt: new Date().toISOString() };
  if (i >= 0) st.push.subscriptions[i] = entry;
  else        st.push.subscriptions.push(entry);
  _writeData(st);
  return { ok: true, count: st.push.subscriptions.length };
}
function _unsubscribePush(endpoint) {
  var st = _readData();
  if (!st.push || !st.push.subscriptions) return { ok: true };
  st.push.subscriptions = st.push.subscriptions.filter(function (s) { return s.endpoint !== endpoint; });
  _writeData(st);
  return { ok: true };
}

// ── Cron entrypoint: install a 1-minute time-driven trigger that calls
//    sendDuePushes(). It walks today's to-dos + calendar events,
//    computes each reminder's fire time (matching the client logic),
//    and pings the Cloudflare push worker for everything due in the
//    last 90 seconds that hasn't already fired.                     ──
function sendDuePushes() {
  var st = _readData();
  if (!st || !st.push) return;
  if (!st.push.subscriptions || !st.push.subscriptions.length) return;
  if (!st.pushConfig || !st.pushConfig.workerUrl) return;
  var now = new Date();
  var due = [];
  // To-dos
  (st.todos || []).forEach(function (t) {
    if (t.done || !t.dueDate || !t.remind || t.remind === 'none') return;
    var fire = _todoFireDate(t); if (!fire) return;
    if (now >= fire && (now.getTime() - fire.getTime()) < 90 * 1000) {
      due.push({ key: 't:' + t.id + ':' + t.dueDate + ':' + t.remind,
                 title: 'To-Do', body: (t.text || 'To-do') + ' · due ' + _fmtMDY(t.dueDate) + (t.dueTime ? (' ' + t.dueTime) : '') });
    }
  });
  // Calendar events
  ((st.calendar && st.calendar.events) || []).forEach(function (e) {
    if (e.remindMins === null || e.remindMins === undefined || !e.time) return;
    if (!_eventOccursOn(e, now)) return;
    var hm = (e.time || '0:0').split(':'); var hh = parseInt(hm[0],10)||0; var mm = parseInt(hm[1],10)||0;
    var evt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
    var fire = new Date(evt.getTime() - (e.remindMins || 0) * 60000);
    if (now >= fire && (now.getTime() - fire.getTime()) < 90 * 1000) {
      due.push({ key: 'c:' + e.id + ':' + _isoDate(now), title: 'Reminder', body: e.title + (e.time ? (' at ' + e.time) : '') });
    }
  });
  if (!due.length) return;
  st.push.firedKeys = st.push.firedKeys || [];
  var fired = {}; st.push.firedKeys.forEach(function (k) { fired[k] = 1; });
  due = due.filter(function (d) { return !fired[d.key]; });
  if (!due.length) return;
  // Send each due reminder to each subscription via the Cloudflare worker.
  due.forEach(function (d) {
    st.push.subscriptions.forEach(function (sub) {
      var ok = _postToWorker(st.pushConfig.workerUrl + '/send', { subscription: { endpoint: sub.endpoint, keys: sub.keys }, payload: { title: d.title, body: d.body, url: '/' } });
      if (ok && ok.status === 410) _unsubscribePush(sub.endpoint);
    });
    fired[d.key] = 1;
  });
  st.push.firedKeys = Object.keys(fired).slice(-500);   // keep last 500
  _writeData(st);
}
function _postToWorker(url, body) {
  try {
    var res = UrlFetchApp.fetch(url, {
      method: 'post', muteHttpExceptions: true,
      contentType: 'application/json', payload: JSON.stringify(body),
    });
    return { status: res.getResponseCode(), body: res.getContentText() };
  } catch (e) { return { status: 0, body: String(e) }; }
}

// Lightweight readers / helpers used by the cron path.
function _readData() {
  var sh = _getSheet();
  var raw = sh.getRange('A1').getValue();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}
function _writeData(d) {
  var sh = _getSheet();
  sh.getRange('A1').setValue(JSON.stringify(d));
  sh.getRange('A2').setValue(new Date().toISOString());
}
function _fmtMDY(iso) {
  var p = iso.split('-'); return Number(p[1]) + '/' + Number(p[2]) + '/' + p[0];
}
function _isoDate(d) {
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}
function _todoFireDate(t) {
  var p = t.dueDate.split('-').map(Number);
  var y = p[0], m = p[1]-1, d = p[2];
  var time = t.dueTime || '09:00';
  var th = time.split(':'); var hh = parseInt(th[0],10)||0; var mm = parseInt(th[1],10)||0;
  var due = new Date(y, m, d, hh, mm, 0, 0);
  switch (t.remind) {
    case 'eod-1d':  return new Date(y, m, d-1, 19, 0, 0, 0);
    case 'morning': return new Date(y, m, d,   8, 0, 0, 0);
    case 'attime':  return due;
    case '1h':      return new Date(due.getTime() - 60*60000);
    case '30m':     return new Date(due.getTime() - 30*60000);
    case '2d-19':   return new Date(y, m, d-2, 19, 0, 0, 0);
    case '1w-19':   return new Date(y, m, d-7, 19, 0, 0, 0);
  }
  return null;
}
function _eventOccursOn(ev, dt) {
  var p = ev.date.split('-').map(Number);
  var base = new Date(p[0], p[1]-1, p[2]); base.setHours(0,0,0,0);
  var day = new Date(dt); day.setHours(0,0,0,0);
  if (day < base) return false;
  var rec = ev.recur || 'none';
  if (rec === 'none') {
    if (ev.endDate) {
      var ep = ev.endDate.split('-').map(Number);
      var end = new Date(ep[0], ep[1]-1, ep[2]); end.setHours(0,0,0,0);
      return day >= base && day <= end;
    }
    return +day === +base;
  }
  if (rec === 'daily')    return true;
  if (rec === 'weekly')   return day.getDay() === base.getDay();
  if (rec === 'biweekly') return Math.round((day - base) / 86400000) % 14 === 0;
  if (rec === 'monthly') {
    var dim = new Date(day.getFullYear(), day.getMonth()+1, 0).getDate();
    return day.getDate() === Math.min(base.getDate(), dim);
  }
  if (rec === 'yearly') return day.getDate() === base.getDate() && day.getMonth() === base.getMonth();
  return false;
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

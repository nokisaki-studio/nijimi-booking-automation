/*
 * 水彩教室にじみ 体験予約の自動受付 — Apps Script 版
 *
 * Google スプレッドシートに紐づけた Apps Script のプロジェクトに、
 * このファイル(Code.gs)と、リポジトリの core.js(名前は core.gs にする)の 2 つを入れる。入れ方は README.md。
 * 何をするかは core.js が決め、このファイルは表への読み書き・メールの送信・トリガーだけを受け持つ。
 *
 * 教室・申込はすべて架空。
 */

// ---------- 設定(ここだけ書き換える) ----------

var SETTINGS = {
  staffEmail: '', // 講師に知らせるアドレス。空なら、このスクリプトを動かすアカウントのアドレス
  senderName: '水彩教室 にじみ', // メールの差出人の名前
  dailyHour: 9, // 毎朝の見回り(この時刻から 1 時間のうちのどこかで動く)
  weeklyHour: 8, // 毎週月曜のまとめ(同じく 1 時間のうちのどこか)
  classroom: {}, // core.js の教室の決まりを変えるとき。例: { capacity: 6, address: '…' }
};

var SHEETS = { apps: '申込', enrolled: '在籍人数', holidays: '休講日', weekly: '週報' };
var HANDLERS = ['onSheetEdit', 'dailyRun', 'weeklyRun'];
var TEXT_COLUMNS = ['candidate', 'staffReminded']; // 表計算に日付へ変えられたくない列

function cfg_() {
  return NijimiCore.config(SETTINGS.classroom);
}

function staffEmail_() {
  return SETTINGS.staffEmail || Session.getEffectiveUser().getEmail();
}

// ---------- 最初に 1 回だけ実行する ----------

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone('Asia/Tokyo');

  var apps = sheet_(ss, SHEETS.apps, NijimiCore.COLUMNS.map(function (c) { return c[1]; }));
  apps.setFrozenRows(1);
  TEXT_COLUMNS.forEach(function (key) {
    apps.getRange(2, NijimiCore.columnIndex(key) + 1, apps.getMaxRows() - 1, 1).setNumberFormat('@');
  });

  var enrolled = sheet_(ss, SHEETS.enrolled, ['回', '在籍の人数']);
  if (enrolled.getLastRow() < 2) {
    var rows = [];
    cfg_().classes.forEach(function (c) {
      c.slots.forEach(function (s) { rows.push([NijimiCore.slotLabel(s), 0]); });
    });
    enrolled.getRange(2, 1, rows.length, 2).setValues(rows);
  }

  sheet_(ss, SHEETS.holidays, ['休講日（例：2026-12-29）', 'メモ']);
  var bands = cfg_().classes.map(function (c) { return c.key; });
  sheet_(ss, SHEETS.weekly, ['まとめた日時', '期間', '申込'].concat(bands, ['見学', '確定', '確定までの平均（時間）', '未確定']));

  // トリガー: 前に作ったものを消してから作り直す(何度実行しても 3 つだけ)
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (HANDLERS.indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('onSheetEdit').forSpreadsheet(ss).onEdit().create();
  ScriptApp.newTrigger('dailyRun').timeBased().atHour(SETTINGS.dailyHour).everyDays(1).create();
  ScriptApp.newTrigger('weeklyRun').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(SETTINGS.weeklyHour).create();
}

function sheet_(ss, name, header) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sh.getLastRow() === 0) sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
  return sh;
}

// ---------- LP のフォームから届く(Web アプリ) ----------

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var state = readState_(ss);
    var now = new Date();
    var plan = NijimiCore.receive(state, (e && e.parameter) || {}, now, cfg_());
    if (plan.add) appendApp_(ss, plan.add);
    deliver_(ss, plan.mails, now);
    SpreadsheetApp.flush();
    return json_(plan.result);
  } catch (err) {
    console.error('doPost', err);
    return json_({ ok: false, errors: ['受け付けられませんでした。時間をおいて、もう一度お試しください'] });
  } finally {
    lock.releaseLock();
  }
}

// 公開した URL を開いて、動いているか確かめる用
function doGet() {
  return json_({ ok: true, service: SETTINGS.senderName + ' 体験予約の受付' });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---------- 講師が「確定」にチェックを入れたとき(編集のトリガー) ----------

function onSheetEdit(e) {
  if (!e || !e.range) return;
  var sh = e.range.getSheet();
  if (sh.getName() !== SHEETS.apps) return;
  var col = NijimiCore.columnIndex('confirmed') + 1;
  if (e.range.getColumn() > col || e.range.getLastColumn() < col) return;

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
    var ss = sh.getParent();
    var now = new Date();
    // 貼り付けなどで何行もまとめて変わることがあるので、1 行ずつ見る(e.value は 1 マスのときしか来ない)
    for (var r = Math.max(2, e.range.getRow()); r <= e.range.getLastRow(); r++) {
      if (sh.getRange(r, col).getValue() !== true) continue;
      var id = String(sh.getRange(r, 1).getValue() || '');
      if (!id) continue;
      var state = readState_(ss);
      var plan = NijimiCore.confirm(state, id, now, cfg_());
      if (plan.error) {
        var current = findApp_(state, id);
        if (current && current.status === NijimiCore.STATUS.confirmed) continue; // もう確定している
        sh.getRange(r, col).setValue(false);
        writeField_(ss, id, 'mailGuide', '確定できません：' + plan.error);
        continue;
      }
      applyUpdates_(ss, plan.updates);
      deliver_(ss, plan.mails, now);
    }
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
}

// ---------- 毎朝・毎週(時刻のトリガー) ----------

function dailyRun() {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var now = new Date();
    var plan = NijimiCore.daily(readState_(ss), now, cfg_());
    applyUpdates_(ss, plan.updates);
    deliver_(ss, plan.mails, now);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
}

function weeklyRun() {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var now = new Date();
    var plan = NijimiCore.weekly(readState_(ss), now, cfg_());
    var sh = ss.getSheetByName(SHEETS.weekly);
    sh.getRange(sh.getLastRow() + 1, 1, 1, plan.row.length).setValues([plan.row]);
    deliver_(ss, plan.mails, now);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
}

// ---------- 表の読み書き ----------

function readState_(ss) {
  var sh = ss.getSheetByName(SHEETS.apps);
  if (!sh) throw new Error('「' + SHEETS.apps + '」のシートがありません。先に setup を実行してください');
  var last = sh.getLastRow();
  var rows = last > 1 ? sh.getRange(2, 1, last - 1, NijimiCore.COLUMNS.length).getValues() : [];
  var apps = [];
  rows.forEach(function (row) {
    if (row[0] !== '' && row[0] !== null) apps.push(NijimiCore.fromRow(row));
  });

  var enrolled = {};
  var en = ss.getSheetByName(SHEETS.enrolled);
  if (en && en.getLastRow() > 1) {
    en.getRange(2, 1, en.getLastRow() - 1, 2).getValues().forEach(function (r) {
      if (r[0]) enrolled[String(r[0]).trim()] = Number(r[1]) || 0;
    });
  }

  var holidays = [];
  var ho = ss.getSheetByName(SHEETS.holidays);
  if (ho && ho.getLastRow() > 1) {
    ho.getRange(2, 1, ho.getLastRow() - 1, 1).getValues().forEach(function (r) {
      var v = r[0];
      if (v instanceof Date) holidays.push(NijimiCore.dateKey(v));
      else if (v) holidays.push(String(v).trim().replace(/\//g, '-'));
    });
  }

  return { apps: apps, enrolled: enrolled, holidays: holidays, staffEmail: staffEmail_() };
}

function findApp_(state, id) {
  for (var i = 0; i < state.apps.length; i++) if (state.apps[i].id === id) return state.apps[i];
  return null;
}

function appendApp_(ss, app) {
  var sh = ss.getSheetByName(SHEETS.apps);
  var row = sh.getLastRow() + 1;
  sh.getRange(row, 1, 1, NijimiCore.COLUMNS.length).setValues([NijimiCore.toRow(app)]);
  // チェックボックスは行を足すときに 1 つずつ入れる(先に全部の行へ入れると、空の行も「中身あり」になる)
  sh.getRange(row, NijimiCore.columnIndex('confirmed') + 1).insertCheckboxes();
}

function rowOf_(sh, id) {
  var last = sh.getLastRow();
  if (last < 2) return -1;
  var ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) if (String(ids[i][0]) === String(id)) return i + 2;
  return -1;
}

function writeField_(ss, id, key, value) {
  var sh = ss.getSheetByName(SHEETS.apps);
  var row = rowOf_(sh, id);
  if (row > 0) sh.getRange(row, NijimiCore.columnIndex(key) + 1).setValue(value);
}

function applyUpdates_(ss, updates) {
  updates.forEach(function (u) {
    for (var key in u.set) writeField_(ss, u.id, key, u.set[key]);
  });
}

// ---------- メール ----------

function deliver_(ss, list, now) {
  list.forEach(function (m) {
    var res = send_(m.mail);
    if (m.id && m.field) writeField_(ss, m.id, m.field, res.ok ? NijimiCore.sentNote(now) : NijimiCore.failedNote(res.reason));
    if (!res.ok && m.id && m.field) {
      // 申込者に届かなかったときは、講師に知らせる(これも送れなければ記録だけ)
      var app = findApp_(readState_(ss), m.id);
      if (app) send_(NijimiCore.mails.staffMailFailed(app, m.what, res.reason, staffEmail_()));
    }
  });
}

function send_(mail) {
  try {
    if (!mail.to) return { ok: false, reason: '宛先がありません' };
    if (MailApp.getRemainingDailyQuota() < 1) return { ok: false, reason: '今日の送信の上限に達しました' };
    MailApp.sendEmail({ to: mail.to, subject: mail.subject, body: mail.body, name: SETTINGS.senderName, replyTo: staffEmail_() });
    return { ok: true };
  } catch (err) {
    console.error('send_', err);
    return { ok: false, reason: String((err && err.message) || err).slice(0, 120) };
  }
}

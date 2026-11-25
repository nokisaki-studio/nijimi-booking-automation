// gas/Code.gs の流れのテスト。Google のサービスは test/fake-gas.js の偽物を使う
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');
const { makeClock, makeGas, loadProject } = require('./fake-gas.js');

const col = (key) => C.columnIndex(key) + 1;

function project(start, opts) {
  const clock = makeClock(start);
  const gas = makeGas(clock, opts);
  const p = loadProject(gas.globals);
  return { clock, gas, p, apps: () => gas.ss.getSheetByName('申込') };
}

function post(p, params) {
  const out = p.doPost({ parameter: params });
  return { mime: out.mime, body: JSON.parse(out.getContent()) };
}

function cellOf(sheet, row, key) {
  return sheet.getRange(row, col(key)).getValue();
}

// 講師がチェックを入れる(本物では、人が編集したときだけトリガーが動く)
function tick(t, rows, value = true) {
  const sh = t.apps();
  const r = sh.getRange(rows[0], col('confirmed'), rows.length, 1);
  r.setValues(rows.map(() => [value]));
  t.p.onSheetEdit({ range: r, value: rows.length === 1 ? String(value).toUpperCase() : undefined });
}

const form = (over = {}) => ({ name: '山田 花子', email: 'hanako@example.com', time: '平日の夜', message: '', ...over });

test('setup: シートとトリガーを作る。何度実行しても増えない', () => {
  const t = project(C.jst(2026, 11, 24, 8, 0));
  t.p.setup();
  t.p.setup();
  const ss = t.gas.ss;
  assert.equal(ss.tz, 'Asia/Tokyo');
  assert.deepEqual([...ss.sheets.keys()], ['申込', '在籍人数', '休講日', '週報']);
  assert.deepEqual(t.apps().getRange(1, 1, 1, C.COLUMNS.length).getValues()[0], C.COLUMNS.map((c) => c[1]));
  assert.equal(t.apps().getLastRow(), 1); // 空の行にチェックボックスを先に入れない
  assert.deepEqual(ss.getSheetByName('在籍人数').getRange(2, 1, 4, 2).getValues(), [['火 10:30', 0], ['木 10:30', 0], ['水 19:00', 0], ['土 10:00', 0]]);
  const tr = t.gas.triggers.map((x) => ({ handler: x.handler, kind: x.kind, hour: x.hour, everyDays: x.everyDays, weekDay: x.weekDay }));
  assert.deepEqual(tr, [
    { handler: 'onSheetEdit', kind: 'onEdit', hour: undefined, everyDays: undefined, weekDay: undefined },
    { handler: 'dailyRun', kind: 'clock', hour: 9, everyDays: 1, weekDay: undefined },
    { handler: 'weeklyRun', kind: 'clock', hour: 8, everyDays: undefined, weekDay: 'MONDAY' },
  ]);
});

test('申込が届く: 1 行足し、受付メールと教室への知らせを送る', () => {
  const t = project(C.jst(2026, 11, 24, 9, 0));
  t.p.setup();
  const res = post(t.p, form({ message: '見学希望です' }));
  assert.equal(res.mime, 'JSON');
  assert.deepEqual(res.body, { ok: true, id: 'N261124-001' });
  const sh = t.apps();
  assert.equal(sh.getLastRow(), 2);
  assert.equal(cellOf(sh, 2, 'status'), '仮予約');
  assert.equal(cellOf(sh, 2, 'candidate'), '2026-11-25 19:00'); // 日付に変えられていない
  assert.equal(cellOf(sh, 2, 'confirmed'), false);
  assert.equal(sh.cell(2, col('confirmed')).checkbox, true);
  assert.equal(cellOf(sh, 2, 'mailReceived'), '送信済み 11/24 09:00');
  assert.deepEqual(t.gas.sent.map((m) => m.to), ['hanako@example.com', 'owner@example.com']);
  assert.equal(t.gas.sent[0].name, '水彩教室 にじみ');
  assert.equal(t.gas.sent[0].replyTo, 'owner@example.com');
  assert.equal(t.gas.log.locks, t.gas.log.released);
});

test('申込が届く: 式のような名前は、式にならずに文字として入る', () => {
  const t = project(C.jst(2026, 11, 24, 9, 0));
  t.p.setup();
  post(t.p, form({ name: '=HYPERLINK("http://evil.example","x")', message: '+81 90' }));
  const sh = t.apps();
  assert.deepEqual(sh.formulas(), []);
  assert.equal(cellOf(sh, 2, 'name'), '=HYPERLINK("http://evil.example","x")');
  assert.equal(cellOf(sh, 2, 'message'), '+81 90');
});

test('申込が届く: 誤りのある入力は表に足さず、理由を返す。ボットは記録だけ', () => {
  const t = project(C.jst(2026, 11, 24, 9, 0));
  t.p.setup();
  const bad = post(t.p, form({ email: 'hanako@' }));
  assert.equal(bad.body.ok, false);
  assert.deepEqual(bad.body.errors, ['メールアドレスを正しく入力してください']);
  assert.equal(t.apps().getLastRow(), 1);
  const bot = post(t.p, form({ website: 'http://spam.example' }));
  assert.equal(bot.body.ok, true);
  assert.equal(cellOf(t.apps(), 2, 'status'), '除外');
  assert.equal(t.gas.sent.length, 0);
});

test('申込が届く: setup の前に届いても、エラーで止まらずに返事をする', () => {
  const t = project(C.jst(2026, 11, 24, 9, 0));
  const res = post(t.p, form());
  assert.equal(res.body.ok, false);
  assert.match(t.gas.log.errors[0], /setup を実行してください/);
  assert.equal(t.gas.log.locks, t.gas.log.released);
});

test('二重送信: 2 件目は「重複」で、申込者には 2 通目を送らない', () => {
  const t = project(C.jst(2026, 11, 24, 9, 0));
  t.p.setup();
  post(t.p, form());
  const res = post(t.p, form({ email: 'Hanako@Example.com' }));
  assert.equal(res.body.duplicate, true);
  assert.equal(cellOf(t.apps(), 3, 'status'), '重複');
  assert.deepEqual(t.gas.sent.map((m) => m.to), ['hanako@example.com', 'owner@example.com', 'owner@example.com']);
});

test('確定: チェックを入れると案内メール。もう一度入れても送らない', () => {
  const t = project(C.jst(2026, 11, 24, 9, 0));
  t.p.setup();
  post(t.p, form());
  t.clock.set(C.jst(2026, 11, 24, 13, 0));
  tick(t, [2]);
  const sh = t.apps();
  assert.equal(cellOf(sh, 2, 'status'), '確定');
  assert.ok(cellOf(sh, 2, 'confirmedAt') instanceof Date);
  assert.equal(cellOf(sh, 2, 'mailGuide'), '送信済み 11/24 13:00');
  const guide = t.gas.sent.at(-1);
  assert.equal(guide.to, 'hanako@example.com');
  assert.match(guide.body, /11月25日（水）19:00〜20:30/);
  const before = t.gas.sent.length;
  tick(t, [2]);
  assert.equal(t.gas.sent.length, before);
});

test('確定: 候補が空のときはチェックを外し、理由を書く', () => {
  const t = project(C.jst(2026, 11, 24, 9, 0));
  t.p.setup();
  t.gas.ss.getSheetByName('在籍人数').getRange(5, 2).setValue(5); // 土曜は満席
  post(t.p, form({ time: '土曜の朝' }));
  tick(t, [2]);
  const sh = t.apps();
  assert.equal(cellOf(sh, 2, 'status'), '仮予約');
  assert.equal(cellOf(sh, 2, 'confirmed'), false);
  assert.match(cellOf(sh, 2, 'mailGuide'), /^確定できません：候補の回が空です/);
  // 講師が日時を書いてから入れ直すと、確定できる
  sh.getRange(2, col('candidate')).setValue('2026-12-26 10:00');
  tick(t, [2]);
  assert.equal(cellOf(sh, 2, 'status'), '確定');
  assert.match(t.gas.sent.at(-1).body, /12月26日（土）10:00〜11:30/);
});

test('確定: 貼り付けで何行もまとめてチェックされても、1 行ずつ確定する', () => {
  const t = project(C.jst(2026, 11, 24, 9, 0));
  t.p.setup();
  post(t.p, form());
  post(t.p, form({ email: 'b@example.com', time: '平日の昼' }));
  tick(t, [2, 3]);
  assert.equal(cellOf(t.apps(), 2, 'status'), '確定');
  assert.equal(cellOf(t.apps(), 3, 'status'), '確定');
  // ほかの列の編集では何もしない
  const before = t.gas.sent.length;
  const r = t.apps().getRange(2, col('message'));
  r.setValue('メモ');
  t.p.onSheetEdit({ range: r, value: 'メモ' });
  assert.equal(t.gas.sent.length, before);
});

test('毎朝: 1 日たっても確定していない申込を催促し、明日の方に前日のお知らせ', () => {
  const t = project(C.jst(2026, 11, 24, 9, 0));
  t.p.setup();
  post(t.p, form()); // 11/25 19:00 の候補、このあと確定しない
  post(t.p, form({ email: 'b@example.com', time: '平日の昼' })); // 11/26 10:30
  tick(t, [3]);
  t.clock.set(C.jst(2026, 11, 25, 9, 20));
  const before = t.gas.sent.length;
  t.p.dailyRun();
  const morning = t.gas.sent.slice(before);
  assert.deepEqual(morning.map((m) => m.subject), ['確定していない申込が 1 件あります', '【水彩教室 にじみ】明日の体験レッスンのお知らせ']);
  assert.equal(morning[1].to, 'b@example.com');
  assert.equal(cellOf(t.apps(), 2, 'staffReminded'), '2026-11-25');
  assert.equal(cellOf(t.apps(), 3, 'mailDayBefore'), '送信済み 11/25 09:20');
  // 同じ日にもう一度動いても、何も送らない
  t.p.dailyRun();
  assert.equal(t.gas.sent.length, before + 2);
});

test('毎週: 週報のシートに 1 行足し、まとめを送る', () => {
  const t = project(C.jst(2026, 11, 17, 10, 0)); // 火曜
  t.p.setup();
  post(t.p, form({ message: '見学希望' }));
  t.clock.set(C.jst(2026, 11, 18, 12, 0));
  tick(t, [2]);
  t.clock.set(C.jst(2026, 11, 20, 18, 0));
  post(t.p, form({ email: 'b@example.com', time: '土曜の朝' }));
  t.clock.set(C.jst(2026, 11, 23, 8, 30)); // 月曜の朝
  t.p.weeklyRun();
  const wk = t.gas.ss.getSheetByName('週報');
  assert.equal(wk.getLastRow(), 2);
  assert.deepEqual(wk.getRange(2, 2, 1, 9).getValues()[0], ['11/16〜11/22', 2, 0, 1, 1, 1, 1, 26, 1]);
  const m = t.gas.sent.at(-1);
  assert.equal(m.subject, '週のまとめ（11/16〜11/22）申込 2 件');
  assert.equal(m.to, 'owner@example.com');
});

test('休講日: 休講日のシートの日付(表計算が日付に変えたもの)を飛ばす', () => {
  const t = project(C.jst(2026, 11, 24, 9, 0));
  t.p.setup();
  t.gas.ss.getSheetByName('休講日').getRange(2, 1).setValue('2026-11-25');
  post(t.p, form());
  assert.equal(cellOf(t.apps(), 2, 'candidate'), '2026-12-02 19:00');
});

test('メールが送れない: 「未送信」と書き、講師に知らせる。上限に達したときも止まらない', () => {
  const t = project(C.jst(2026, 11, 24, 9, 0), { failFor: ['bounce@example.com'] });
  t.p.setup();
  const res = post(t.p, form({ email: 'bounce@example.com' }));
  assert.equal(res.body.ok, true);
  assert.equal(cellOf(t.apps(), 2, 'mailReceived'), '未送信：Invalid email: bounce@example.com');
  // 受付メールが送れなかった知らせが先、新しい申込の知らせがあと(送る順のまま)
  assert.deepEqual(t.gas.sent.map((m) => m.subject), ['メールを送れませんでした（N261124-001）', '新しい体験の申込（平日の夜）山田 花子 様']);

  t.gas.mail.quota = 0;
  const res2 = post(t.p, form({ email: 'c@example.com' }));
  assert.equal(res2.body.ok, true);
  assert.equal(cellOf(t.apps(), 3, 'mailReceived'), '未送信：今日の送信の上限に達しました');
});

test('単独のプロジェクト: SETTINGS.spreadsheetId の表を使う。書いていなければ理由つきで止まる', () => {
  const clock = makeClock(C.jst(2026, 11, 24, 9, 0));
  const gas = makeGas(clock, { standalone: true, spreadsheetId: 'SHEET-ID' });
  const p = loadProject(gas.globals);
  assert.throws(() => p.setup(), /SETTINGS\.spreadsheetId に表の ID/);
  p.SETTINGS.spreadsheetId = 'SHEET-ID';
  p.setup();
  const res = JSON.parse(p.doPost({ parameter: form() }).getContent());
  assert.deepEqual(res, { ok: true, id: 'N261124-001' });
  assert.equal(gas.ss.getSheetByName('申込').getLastRow(), 2);
  assert.equal(gas.triggers.find((t) => t.handler === 'onSheetEdit').source, gas.ss);
});

test('doGet: 公開した URL で動いているかを返す', () => {
  const t = project(C.jst(2026, 11, 24, 9, 0));
  assert.deepEqual(JSON.parse(t.p.doGet().getContent()), { ok: true, service: '水彩教室 にじみ 体験予約の受付' });
});

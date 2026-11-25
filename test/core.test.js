// core.js のテスト。node --test test/ で動かす(ライブラリなし)
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');

const STAFF = 'staff@example.com';
const state = (apps = [], extra = {}) => ({ apps, enrolled: {}, holidays: [], staffEmail: STAFF, ...extra });
const form = (over = {}) => ({ name: '山田 花子', email: 'hanako@example.com', time: '平日の夜', message: '', ...over });

// 申込を受けて、表に足す(見本と Apps Script がすることの代わり)
function apply(st, raw, now) {
  const r = C.receive(st, raw, now);
  if (r.add) st.apps.push(r.add);
  return r;
}

test('日本時間: 動かす機械の時間帯に関係なく、日本の日付と時刻で数える', () => {
  const late = C.jst(2026, 11, 24, 23, 30); // 日本時間 11/24 23:30 = UTC 14:30
  assert.equal(C.dateKey(late), '2026-11-24');
  assert.equal(C.sessionKey(late), '2026-11-24 23:30');
  const early = C.jst(2026, 11, 25, 0, 10); // 日本時間 11/25 0:10 = UTC 11/24 15:10
  assert.equal(C.dateKey(early), '2026-11-25');
  assert.equal(C.parseSessionKey('2026-12-02 19:00').toISOString(), '2026-12-02T10:00:00.000Z');
  assert.equal(C.parseSessionKey('12/2 19:00'), null);
});

test('入力の確かめ: 正しい申込', () => {
  const r = C.readApplication({ name: '  山田\n花子 ', email: ' Hanako@Example.COM ', time: '土曜の朝', message: '見学希望です' });
  assert.equal(r.ok, true);
  assert.equal(r.app.name, '山田 花子');
  assert.equal(r.app.email, 'hanako@example.com');
  assert.equal(r.app.visit, true);
  assert.equal(r.isBot, false);
});

test('入力の確かめ: 空・形の違うメール・ない時間帯は、理由を返す', () => {
  const r = C.readApplication({ name: '', email: 'hanako@', time: '日曜の夜' });
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, ['お名前を入力してください', 'メールアドレスを正しく入力してください', '時間帯を選んでください']);
  assert.equal(C.readApplication({ name: 'a', email: 'a b@example.com', time: '平日の夜' }).ok, false);
  assert.equal(C.readApplication(undefined).ok, false);
});

test('入力の確かめ: 長すぎる文は切り、制御文字は消す', () => {
  const r = C.readApplication({ name: 'あ'.repeat(80), email: 'a@example.com', time: '平日の夜', message: 'い\u0007'.repeat(400) });
  assert.equal(r.app.name.length, 50);
  assert.equal(r.app.message.length, 400);
  assert.ok(!/\u0007/.test(r.app.message));
});

test('表に書くとき、式として読まれる文字には先頭に \' を付ける', () => {
  assert.equal(C.sheetSafe('=IMPORTXML("http://x","//a")'), '\'=IMPORTXML("http://x","//a")');
  assert.equal(C.sheetSafe('+81 90'), "'+81 90");
  assert.equal(C.sheetSafe('-'), "'-");
  assert.equal(C.sheetSafe('@me'), "'@me");
  assert.equal(C.sheetSafe('山田'), '山田');
  const row = C.toRow({ name: '=1+1', message: '@x', email: 'a@example.com' });
  assert.equal(row[C.columnIndex('name')], "'=1+1");
  assert.equal(row[C.columnIndex('message')], "'@x");
});

test('これから先の回: 申込から 24 時間より後、4 週先まで', () => {
  const now = C.jst(2026, 11, 24, 9, 0); // 火曜の朝
  const keys = C.upcomingSessions('平日の昼', now).map((s) => s.key);
  assert.equal(keys[0], '2026-11-26 10:30'); // 当日 10:30 は 24 時間たっていないので外す
  assert.ok(keys.every((k) => /10:30$/.test(k)));
  // 火・木 × 4 週のうち、当日の火曜(24 時間未満)と 4 週後の火曜 10:30(4 週を 1 時間半過ぎる)を除いた 7 回
  assert.equal(keys.length, 7);
  assert.equal(keys[keys.length - 1], '2026-12-17 10:30');
  const last = C.parseSessionKey(keys[keys.length - 1]);
  assert.ok(last - now <= 28 * 24 * 3600 * 1000);
  assert.deepEqual(C.upcomingSessions('ない時間帯', now), []);
});

test('候補の回: 満席と休講日を飛ばす', () => {
  const now = C.jst(2026, 11, 24, 9, 0);
  const enrolled = { '水 19:00': 4 };
  // 11/25 は在籍 4 + 仮予約 1 で満席、12/2 は休講日 → 12/9
  const st = state([{ id: 'x', status: '仮予約', candidate: '2026-11-25 19:00' }], { enrolled, holidays: ['2026-12-02'] });
  const c = C.pickCandidate('平日の夜', now, st);
  assert.equal(c.key, '2026-12-09 19:00');
  assert.equal(c.seatsLeft, 0); // 在籍 4 + この方 = 5
  // キャンセルした申込は席を取らない
  st.apps[0].status = 'キャンセル';
  assert.equal(C.pickCandidate('平日の夜', now, st).key, '2026-11-25 19:00');
});

test('候補の回: 4 週先まで空きがなければ null、講師には「候補なし」と知らせる', () => {
  const now = C.jst(2026, 11, 24, 9, 0);
  const st = state([], { enrolled: { '土 10:00': 5 } });
  assert.equal(C.pickCandidate('土曜の朝', now, st), null);
  const r = apply(st, form({ time: '土曜の朝' }), now);
  assert.equal(r.add.status, '仮予約');
  assert.equal(r.add.candidate, '');
  assert.match(r.mails[1].mail.body, /候補の回：なし/);
});

test('申込: 受付番号・受付メール・教室への知らせ', () => {
  const now = C.jst(2026, 11, 24, 9, 0);
  const st = state();
  const r = apply(st, form({ message: '見学希望です' }), now);
  assert.deepEqual(r.result, { ok: true, id: 'N261124-001' });
  assert.equal(r.add.status, '仮予約');
  assert.equal(r.add.candidate, '2026-11-25 19:00');
  assert.equal(r.mails.length, 2);
  assert.equal(r.mails[0].mail.to, 'hanako@example.com');
  assert.equal(r.mails[0].field, 'mailReceived');
  assert.match(r.mails[0].mail.body, /見学のご希望も承りました/);
  assert.match(r.mails[0].mail.body, /2日以内に、日にちのご案内/);
  assert.equal(r.mails[1].mail.to, STAFF);
  assert.match(r.mails[1].mail.body, /11月25日（水）19:00〜20:30/);
  // 同じ日の 2 件目は 002、翌日は 001 から
  assert.equal(apply(st, form({ email: 'b@example.com' }), now).result.id, 'N261124-002');
  assert.equal(apply(st, form({ email: 'c@example.com' }), C.jst(2026, 11, 25, 0, 5)).result.id, 'N261125-001');
});

test('申込: 入力に誤りがあれば、表にも足さずメールも送らない', () => {
  const st = state();
  const r = C.receive(st, form({ email: 'no-at-mark' }), C.jst(2026, 11, 24, 9, 0));
  assert.equal(r.result.ok, false);
  assert.equal(r.add, null);
  assert.equal(r.mails.length, 0);
});

test('二重送信: 同じメールの確定前の申込があれば「重複」にし、受付メールは 1 回だけ', () => {
  const now = C.jst(2026, 11, 24, 9, 0);
  const st = state();
  apply(st, form(), now);
  const r = apply(st, form({ email: 'HANAKO@example.com', time: '平日の昼' }), new Date(now.getTime() + 60000));
  assert.equal(r.result.duplicate, true);
  assert.equal(r.result.id, 'N261124-001');
  assert.equal(r.add.status, '重複');
  assert.equal(r.mails.length, 1);
  assert.equal(r.mails[0].mail.to, STAFF);
  assert.equal(r.mails[0].field, null);
  // 重複の行は席を取らない
  assert.equal(C.seatsTaken('2026-11-25 19:00', st.apps, {}), 1);
});

test('ボット: 見えない欄に値があれば「除外」で記録だけし、返信しない', () => {
  const st = state();
  const r = apply(st, form({ website: 'http://spam.example' }), C.jst(2026, 11, 24, 9, 0));
  assert.equal(r.add.status, '除外');
  assert.equal(r.mails.length, 0);
  assert.equal(r.result.ok, true); // ボットには普通の返事をする
});

test('確定: 仮予約で候補があるときだけ、案内メールを出す', () => {
  const now = C.jst(2026, 11, 24, 9, 0);
  const st = state();
  const id = apply(st, form(), now).result.id;
  const later = C.jst(2026, 11, 24, 12, 0);
  const r = C.confirm(st, id, later);
  assert.equal(r.error, null);
  assert.deepEqual(r.updates[0].set.status, '確定');
  assert.equal(r.mails[0].field, 'mailGuide');
  assert.match(r.mails[0].mail.body, /日時：11月25日（水）19:00〜20:30（90分）/);
  Object.assign(st.apps[0], r.updates[0].set);
  // 2 回目のチェックではメールを出さない
  assert.match(C.confirm(st, id, later).error, /仮予約ではない/);
  assert.match(C.confirm(st, 'N000000-999', later).error, /見つかりません/);
});

test('確定: 候補が空・書き方が違うときは理由を返す', () => {
  const st = state([{ id: 'a', status: '仮予約', candidate: '' }, { id: 'b', status: '仮予約', candidate: '12/2 19時' }]);
  assert.match(C.confirm(st, 'a', new Date()).error, /候補の回が空/);
  assert.match(C.confirm(st, 'b', new Date()).error, /書き方が違います/);
});

test('毎朝: 24 時間たっても確定していない申込は 1 日 1 回だけ催促する', () => {
  const t0 = C.jst(2026, 11, 24, 9, 0);
  const st = state();
  apply(st, form(), t0);
  apply(st, form({ email: 'new@example.com' }), C.jst(2026, 11, 24, 20, 0));
  const next = C.jst(2026, 11, 25, 9, 30);
  const r = C.daily(st, next);
  assert.equal(r.mails.length, 1);
  assert.match(r.mails[0].mail.subject, /1 件/); // 20 時の申込はまだ 24 時間たっていない
  assert.match(r.mails[0].mail.body, /受付から 24 時間/);
  for (const u of r.updates) Object.assign(st.apps.find((a) => a.id === u.id), u.set);
  assert.equal(C.daily(st, C.jst(2026, 11, 25, 15, 0)).mails.length, 0); // 同じ日に 2 回目は出さない
  assert.equal(C.daily(st, C.jst(2026, 11, 26, 9, 30)).mails[0].mail.subject, '確定していない申込が 2 件あります');
});

test('毎朝: 明日が体験の方に、前日のお知らせを 1 回だけ', () => {
  const st = state([
    { id: 'a', name: 'A', email: 'a@example.com', status: '確定', candidate: '2026-11-26 10:30', mailDayBefore: '' },
    { id: 'b', name: 'B', email: 'b@example.com', status: '確定', candidate: '2026-11-27 10:30', mailDayBefore: '' },
    { id: 'c', name: 'C', email: 'c@example.com', status: '確定', candidate: '2026-11-26 10:30', mailDayBefore: '送信済み 11/25 09:00' },
    { id: 'd', name: 'D', email: 'd@example.com', status: 'キャンセル', candidate: '2026-11-26 10:30', mailDayBefore: '' },
  ]);
  const r = C.daily(st, C.jst(2026, 11, 25, 9, 0));
  assert.deepEqual(r.mails.map((m) => m.id), ['a']);
  assert.equal(r.mails[0].field, 'mailDayBefore');
  assert.match(r.mails[0].mail.body, /11月26日（木）10:30〜12:00/);
  // 23:30 に動いても「明日」は 11/26
  assert.deepEqual(C.daily(st, C.jst(2026, 11, 25, 23, 30)).mails.map((m) => m.id), ['a']);
});

test('毎週: 先週の月曜 0:00〜日曜 24:00 の申込を数える(境目を含めて)', () => {
  const st = state([
    { id: '1', status: '確定', timeBand: '平日の夜', visit: true, receivedAt: C.jst(2026, 11, 16, 0, 0), confirmedAt: C.jst(2026, 11, 16, 10, 0) },
    { id: '2', status: '仮予約', timeBand: '土曜の朝', visit: false, receivedAt: C.jst(2026, 11, 22, 23, 59) },
    { id: '3', status: '確定', timeBand: '平日の夜', visit: false, receivedAt: C.jst(2026, 11, 20, 12, 0), confirmedAt: C.jst(2026, 11, 21, 8, 0) },
    { id: '4', status: '重複', timeBand: '平日の夜', receivedAt: C.jst(2026, 11, 20, 12, 1) },
    { id: '5', status: '除外', timeBand: '平日の夜', receivedAt: C.jst(2026, 11, 18, 3, 0) },
    { id: '6', status: '仮予約', timeBand: '平日の昼', receivedAt: C.jst(2026, 11, 23, 0, 0) }, // 今週
    { id: '7', status: '確定', timeBand: '平日の昼', receivedAt: C.jst(2026, 11, 15, 23, 59) }, // 先々週
  ]);
  const r = C.weekly(st, C.jst(2026, 11, 23, 8, 15)); // 月曜の朝
  assert.equal(r.summary.periodLabel, '11/16〜11/22');
  assert.equal(r.summary.total, 3);
  assert.deepEqual(r.summary.byBand, { 平日の夜: 2, 土曜の朝: 1 });
  assert.equal(r.summary.visits, 1);
  assert.equal(r.summary.confirmed, 2);
  assert.equal(r.summary.avgHoursToConfirm, 15); // (10 + 20) / 2
  assert.equal(r.summary.pendingNow, 2);
  assert.equal(r.summary.duplicates, 1);
  assert.equal(r.summary.excluded, 1);
  assert.deepEqual(r.row.slice(1), ['11/16〜11/22', 3, 0, 2, 1, 1, 2, 15, 2]);
  assert.match(r.mails[0].mail.body, /平日の昼：0 件/);
  // 月曜以外に動かしても「先週」は同じ
  assert.equal(C.weekly(st, C.jst(2026, 11, 29, 22, 0)).summary.periodLabel, '11/16〜11/22');
});

test('毎週: 申込がない週でも 0 件として出す', () => {
  const r = C.weekly(state(), C.jst(2026, 11, 23, 8, 0));
  assert.equal(r.summary.total, 0);
  assert.equal(r.summary.avgHoursToConfirm, null);
  assert.equal(r.row[r.row.length - 2], '');
});

test('表の行との変換: 行に戻しても同じ中身になる', () => {
  const now = C.jst(2026, 11, 24, 9, 0);
  const st = state();
  const app = apply(st, form({ message: '見学希望' }), now).add;
  assert.equal(C.toRow(app)[C.columnIndex('visit')], '見学');
  assert.equal(C.toRow({ ...app, visit: false })[C.columnIndex('visit')], '');
  const back = C.fromRow(C.toRow(app));
  assert.equal(back.id, app.id);
  assert.equal(back.visit, true);
  assert.equal(back.confirmed, false);
  assert.equal(back.candidate, app.candidate);
  assert.equal(C.fromRow(C.toRow({ ...app, visit: 'TRUE', confirmed: 'TRUE' })).confirmed, true);
  // 表計算が候補の回を日付に変えてしまっても、元の書き方に戻す
  assert.equal(C.fromRow(C.toRow({ ...app, candidate: C.jst(2026, 12, 2, 19, 0) })).candidate, '2026-12-02 19:00');
});

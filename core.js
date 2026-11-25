/*
 * 水彩教室にじみ 体験予約の自動受付 — 処理の中身
 *
 * ブラウザの見本(index.html)・Apps Script(gas/Code.gs)・Node のテストで、同じこのファイルを使う。
 * Google のサービスは呼ばない。何をするかを決めて返すだけで、表への書き込みやメールの送信は呼び出し側が行う。
 * 日時は日本時間(UTC+9。日本には夏時間がない)で数える。動かす機械の時間帯の設定には左右されない。
 *
 * 教室・講師・申込はすべて架空。
 */
var NijimiCore = (function () {
  'use strict';

  var HOUR = 3600 * 1000;
  var DAY = 24 * HOUR;
  var JST_OFFSET = 9 * HOUR;
  var DOW = ['日', '月', '火', '水', '木', '金', '土'];

  // 申込の状態
  var STATUS = {
    pending: '仮予約',
    confirmed: '確定',
    duplicate: '重複',
    excluded: '除外',
    cancelled: 'キャンセル',
  };

  // 教室の決まりごと(にじみの LP に書いてあることに合わせる)
  var DEFAULT_CONFIG = {
    classroom: '水彩教室 にじみ',
    address: '〇〇県〇〇市〇〇町1-2-3 2階（〇〇線〇〇駅から徒歩5分）',
    price: '1,500円（税込・画材込み）',
    capacity: 5, // 1 回の定員(在籍の生徒さんと体験の方を合わせて)
    lookaheadWeeks: 4, // 何週先までの回から候補を探すか
    minLeadHours: 24, // 申込から最短でもこれだけ先の回を候補にする
    remindAfterHours: 24, // 確定していない申込を講師に知らせるまでの時間(LP の「2日以内」を守るため)
    classes: [
      { key: '平日の昼', label: '平日の昼（火・木 10:30〜12:00）', slots: [{ dow: 2, start: '10:30', end: '12:00' }, { dow: 4, start: '10:30', end: '12:00' }] },
      { key: '平日の夜', label: '平日の夜（水 19:00〜20:30）', slots: [{ dow: 3, start: '19:00', end: '20:30' }] },
      { key: '土曜の朝', label: '土曜の朝（土 10:00〜11:30）', slots: [{ dow: 6, start: '10:00', end: '11:30' }] },
    ],
  };

  // 表の列(Apps Script では「申込」のシートの見出し、見本では表の見出しになる)
  var COLUMNS = [
    ['id', '受付番号'],
    ['receivedAt', '受付日時'],
    ['name', 'お名前'],
    ['email', 'メール'],
    ['timeBand', '時間帯'],
    ['message', 'メッセージ'],
    ['visit', '見学'],
    ['status', '状態'],
    ['candidate', '候補の回'],
    ['confirmed', '確定'],
    ['confirmedAt', '確定日時'],
    ['mailReceived', '受付メール'],
    ['mailGuide', '案内メール'],
    ['staffReminded', '催促した日'],
    ['mailDayBefore', '前日のお知らせ'],
  ];

  var EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

  // ---------- 日時(日本時間) ----------

  function parts(date) {
    var t = new Date(date.getTime() + JST_OFFSET);
    return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), dow: t.getUTCDay(), hh: t.getUTCHours(), mm: t.getUTCMinutes() };
  }

  // 日本時間の年月日時分から Date を作る(日のあふれは Date.UTC が繰り上げる)
  function jst(y, m, d, hh, mm) {
    return new Date(Date.UTC(y, m - 1, d, (hh || 0) - 9, mm || 0));
  }

  function pad(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function dateKey(date) {
    var p = parts(date);
    return p.y + '-' + pad(p.m) + '-' + pad(p.d);
  }

  function sessionKey(date) {
    var p = parts(date);
    return dateKey(date) + ' ' + pad(p.hh) + ':' + pad(p.mm);
  }

  function parseSessionKey(key) {
    var m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(String(key || ''));
    return m ? jst(+m[1], +m[2], +m[3], +m[4], +m[5]) : null;
  }

  function startOfDay(date) {
    var p = parts(date);
    return jst(p.y, p.m, p.d, 0, 0);
  }

  function formatDateTime(date) {
    var p = parts(date);
    return p.y + '年' + p.m + '月' + p.d + '日（' + DOW[p.dow] + '）' + pad(p.hh) + ':' + pad(p.mm);
  }

  function formatShort(date) {
    var p = parts(date);
    return p.m + '/' + p.d + ' ' + pad(p.hh) + ':' + pad(p.mm);
  }

  // ---------- 設定 ----------

  function config(overrides) {
    var c = {};
    var k;
    for (k in DEFAULT_CONFIG) c[k] = DEFAULT_CONFIG[k];
    if (overrides) for (k in overrides) if (overrides[k] !== undefined && overrides[k] !== '') c[k] = overrides[k];
    return c;
  }

  function findClass(key, cfg) {
    var list = (cfg || DEFAULT_CONFIG).classes;
    for (var i = 0; i < list.length; i++) if (list[i].key === key) return list[i];
    return null;
  }

  function slotLabel(slot) {
    return DOW[slot.dow] + ' ' + slot.start;
  }

  // 「12月2日（水）19:00〜20:30」
  function formatSession(key, cfg) {
    var start = parseSessionKey(key);
    if (!start) return '';
    var p = parts(start);
    var slot = findSlot(start, cfg);
    return p.m + '月' + p.d + '日（' + DOW[p.dow] + '）' + pad(p.hh) + ':' + pad(p.mm) + (slot ? '〜' + slot.end : '');
  }

  function findSlot(start, cfg) {
    var p = parts(start);
    var hm = pad(p.hh) + ':' + pad(p.mm);
    var list = (cfg || DEFAULT_CONFIG).classes;
    for (var i = 0; i < list.length; i++) {
      for (var j = 0; j < list[i].slots.length; j++) {
        var s = list[i].slots[j];
        if (s.dow === p.dow && s.start === hm) return s;
      }
    }
    return null;
  }

  // ---------- 入力の読み取り ----------

  // 制御文字を消し、前後の空白を取り、長さを切る。1 行の欄は改行も空白にする
  function clean(value, max, multiline) {
    var s = value === null || value === undefined ? '' : String(value);
    s = s.replace(/\r\n?/g, '\n');
    s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
    if (!multiline) s = s.replace(/\s+/g, ' ');
    s = s.trim();
    return s.length > max ? s.slice(0, max) : s;
  }

  // 表計算で式として読まれないように(=・+・-・@ で始まる文字は先頭に ' を付ける)
  function sheetSafe(text) {
    var s = text === null || text === undefined ? '' : String(text);
    return /^[=+\-@]/.test(s) ? "'" + s : s;
  }

  // フォームの値を確かめる。website はボット避けの見えない欄(人は入力しない)
  function readApplication(raw, cfg) {
    raw = raw || {};
    var app = {
      name: clean(raw.name, 50),
      email: clean(raw.email, 254).toLowerCase(),
      timeBand: clean(raw.time, 20),
      message: clean(raw.message, 500, true),
    };
    app.visit = /見学/.test(app.message);
    var errors = [];
    if (!app.name) errors.push('お名前を入力してください');
    if (!EMAIL_RE.test(app.email)) errors.push('メールアドレスを正しく入力してください');
    if (!findClass(app.timeBand, cfg)) errors.push('時間帯を選んでください');
    return { ok: errors.length === 0, errors: errors, isBot: clean(raw.website, 200) !== '', app: app };
  }

  // ---------- 回と空き ----------

  // その時間帯の、これから先の回(申込から minLeadHours 以上あと、lookaheadWeeks 週まで)
  function upcomingSessions(timeBand, now, cfg) {
    cfg = cfg || DEFAULT_CONFIG;
    var cls = findClass(timeBand, cfg);
    if (!cls) return [];
    var from = now.getTime() + cfg.minLeadHours * HOUR;
    var until = now.getTime() + cfg.lookaheadWeeks * 7 * DAY;
    var p = parts(now);
    var list = [];
    for (var i = 0; i <= cfg.lookaheadWeeks * 7 + 1; i++) {
      var day = parts(jst(p.y, p.m, p.d + i, 12, 0));
      for (var j = 0; j < cls.slots.length; j++) {
        var s = cls.slots[j];
        if (s.dow !== day.dow) continue;
        var hm = s.start.split(':');
        var start = jst(day.y, day.m, day.d, +hm[0], +hm[1]);
        if (start.getTime() >= from && start.getTime() <= until) list.push({ key: sessionKey(start), start: start, slot: s });
      }
    }
    list.sort(function (a, b) { return a.start - b.start; });
    return list;
  }

  function holds(app) {
    return app.status === STATUS.pending || app.status === STATUS.confirmed;
  }

  // その回に埋まっている席: 在籍の生徒さん + その回を候補・確定にしている申込
  function seatsTaken(key, apps, enrolled, cfg) {
    var start = parseSessionKey(key);
    var slot = start ? findSlot(start, cfg) : null;
    var n = slot && enrolled ? Number(enrolled[slotLabel(slot)] || 0) : 0;
    for (var i = 0; i < apps.length; i++) if (apps[i].candidate === key && holds(apps[i])) n++;
    return n;
  }

  // 空きがあり、休講日でない、いちばん近い回。なければ null
  function pickCandidate(timeBand, now, state, cfg) {
    cfg = cfg || DEFAULT_CONFIG;
    var holidays = state.holidays || [];
    var sessions = upcomingSessions(timeBand, now, cfg);
    for (var i = 0; i < sessions.length; i++) {
      var s = sessions[i];
      if (holidays.indexOf(s.key.slice(0, 10)) >= 0) continue;
      var taken = seatsTaken(s.key, state.apps, state.enrolled, cfg);
      if (taken < cfg.capacity) return { key: s.key, label: formatSession(s.key, cfg), seatsLeft: cfg.capacity - taken - 1 };
    }
    return null;
  }

  // ---------- メールの文面 ----------

  var FOOTER_AUTO = '（このメールは自動でお送りしています。ご返信いただくと教室に届きます）';

  function signature(cfg) {
    return cfg.classroom + '\n' + cfg.address;
  }

  function bandLabel(timeBand, cfg) {
    var c = findClass(timeBand, cfg);
    return c ? c.label : timeBand;
  }

  var mails = {
    received: function (app, cfg) {
      return {
        to: app.email,
        subject: '【' + cfg.classroom + '】体験レッスンの仮予約を受け付けました',
        body: [
          app.name + ' 様',
          '',
          cfg.classroom + ' です。体験レッスンのお申し込みをありがとうございます。',
          '次の内容で、仮予約を受け付けました。',
          '',
          '受付番号：' + app.id,
          '希望の時間帯：' + bandLabel(app.timeBand, cfg),
          'メッセージ：' + (app.message || 'なし'),
          '',
          app.visit ? '見学のご希望も承りました。当日の流れとあわせてご案内します。\n' : '',
          '2日以内に、日にちのご案内をメールでお送りします。日にちが決まるまでは、仮の予約です。',
          FOOTER_AUTO,
          '',
          signature(cfg),
        ].join('\n').replace(/\n{3,}/g, '\n\n'),
      };
    },

    staffNew: function (app, candidate, cfg, staffEmail) {
      var lines = [
        '新しい体験の申込が届きました。',
        '',
        '受付番号：' + app.id,
        'お名前：' + app.name + ' 様',
        'メール：' + app.email,
        '希望の時間帯：' + bandLabel(app.timeBand, cfg),
        'メッセージ：' + (app.message || 'なし'),
        app.visit ? '※ 見学のご希望があります' : '',
        '',
      ];
      if (candidate) {
        lines.push('候補の回：' + candidate.label + '（この方が入ると残り ' + candidate.seatsLeft + ' 席）');
        lines.push('表の「確定」にチェックを入れると、日にちの案内メールが自動で送られます。');
      } else {
        lines.push('候補の回：なし（' + cfg.lookaheadWeeks + ' 週先まで、この時間帯に空きがありません）');
        lines.push('日にちをメールで相談してください。');
      }
      lines.push('', 'LP では「2日以内に日にちをご案内」とお約束しています。');
      return { to: staffEmail, subject: '新しい体験の申込（' + app.timeBand + '）' + app.name + ' 様', body: lines.join('\n').replace(/\n{3,}/g, '\n\n') };
    },

    staffDuplicate: function (app, existing, cfg, staffEmail) {
      return {
        to: staffEmail,
        subject: '同じ方から申込が重なりました（' + existing.id + '）',
        body: [
          app.name + ' 様（' + app.email + '）から、もう一度申込が届きました。',
          '前の申込 ' + existing.id + '（' + existing.status + '）にまとめ、受付メールは送っていません。',
          '',
          '今回の希望の時間帯：' + bandLabel(app.timeBand, cfg),
          '今回のメッセージ：' + (app.message || 'なし'),
          '',
          '時間帯の変更などのご希望なら、メールで確かめてください。',
        ].join('\n'),
      };
    },

    guide: function (app, cfg) {
      return {
        to: app.email,
        subject: '【' + cfg.classroom + '】体験レッスンの日にちのご案内',
        body: [
          app.name + ' 様',
          '',
          cfg.classroom + ' です。体験レッスンの日にちが決まりましたので、ご案内します。',
          '',
          '日時：' + formatSession(app.candidate, cfg) + '（90分）',
          '場所：' + cfg.address,
          '料金：' + cfg.price + '。当日、教室でお支払いください',
          '持ち物：ありません。道具とエプロンはお貸しします',
          '',
          '日にちの変更やお休みは、前日までにこのメールへご返信ください。',
          '前日に、もう一度お知らせのメールをお送りします。',
          '',
          signature(cfg),
        ].join('\n'),
      };
    },

    staffReminder: function (pending, now, cfg, staffEmail) {
      var lines = ['確定していない体験の申込が ' + pending.length + ' 件あります。', ''];
      for (var i = 0; i < pending.length; i++) {
        var a = pending[i];
        var h = Math.floor((now - a.receivedAt) / HOUR);
        lines.push('・' + a.id + ' ' + a.name + ' 様 ' + a.timeBand + '（受付から ' + h + ' 時間）' + (a.candidate ? ' 候補：' + formatSession(a.candidate, cfg) : ' 候補なし'));
      }
      lines.push('', 'LP では「2日以内に日にちをご案内」とお約束しています。表の「確定」にチェックを入れてください。');
      return { to: staffEmail, subject: '確定していない申込が ' + pending.length + ' 件あります', body: lines.join('\n') };
    },

    dayBefore: function (app, cfg) {
      return {
        to: app.email,
        subject: '【' + cfg.classroom + '】明日の体験レッスンのお知らせ',
        body: [
          app.name + ' 様',
          '',
          '明日は体験レッスンの日です。お会いできるのを楽しみにしています。',
          '',
          '日時：' + formatSession(app.candidate, cfg),
          '場所：' + cfg.address,
          '持ち物：ありません',
          '',
          'ご都合が悪くなったときは、このメールへご返信ください。',
          '',
          signature(cfg),
        ].join('\n'),
      };
    },

    weekly: function (summary, cfg, staffEmail) {
      var lines = [
        '先週（' + summary.periodLabel + '）の体験の申込のまとめです。',
        '',
        '申込：' + summary.total + ' 件',
      ];
      for (var i = 0; i < cfg.classes.length; i++) {
        var k = cfg.classes[i].key;
        lines.push('  ' + k + '：' + (summary.byBand[k] || 0) + ' 件');
      }
      lines.push('見学のご希望：' + summary.visits + ' 件');
      lines.push('確定：' + summary.confirmed + ' 件' + (summary.avgHoursToConfirm === null ? '' : '（受付から確定まで平均 ' + summary.avgHoursToConfirm + ' 時間）'));
      lines.push('まだ確定していない申込（全体）：' + summary.pendingNow + ' 件');
      if (summary.duplicates || summary.excluded) lines.push('重複 ' + summary.duplicates + ' 件・除外 ' + summary.excluded + ' 件は数に入れていません。');
      return { to: staffEmail, subject: '週のまとめ（' + summary.periodLabel + '）申込 ' + summary.total + ' 件', body: lines.join('\n') };
    },

    staffMailFailed: function (app, what, reason, staffEmail) {
      return {
        to: staffEmail,
        subject: 'メールを送れませんでした（' + app.id + '）',
        body: [
          app.name + ' 様（' + app.email + '）への' + what + 'を送れませんでした。',
          '理由：' + reason,
          '',
          'アドレスを確かめて、手で連絡してください。表の該当の欄に「未送信」と書いてあります。',
        ].join('\n'),
      };
    },
  };

  // ---------- 流れ(何をするかを決めて返す) ----------

  function receiptId(apps, now) {
    var p = parts(now);
    var prefix = 'N' + String(p.y).slice(2) + pad(p.m) + pad(p.d) + '-';
    var n = 0;
    for (var i = 0; i < apps.length; i++) if (String(apps[i].id || '').indexOf(prefix) === 0) n++;
    return prefix + ('00' + (n + 1)).slice(-3);
  }

  function findOpen(apps, email) {
    for (var i = apps.length - 1; i >= 0; i--) if (apps[i].email === email && holds(apps[i])) return apps[i];
    return null;
  }

  function blankApp() {
    var a = {};
    for (var i = 0; i < COLUMNS.length; i++) a[COLUMNS[i][0]] = '';
    a.visit = false;
    a.confirmed = false;
    return a;
  }

  // 申込が届いたとき。
  // 返すもの: result(フォームへの返事)、add(表に足す 1 行)、mails(送るメール。field は送れたかを書く欄)
  function receive(state, raw, now, cfg) {
    cfg = cfg || DEFAULT_CONFIG;
    var read = readApplication(raw, cfg);
    var app = blankApp();
    var k;
    for (k in read.app) app[k] = read.app[k];
    app.receivedAt = now;

    if (read.isBot) {
      app.id = receiptId(state.apps, now);
      app.status = STATUS.excluded;
      return { result: { ok: true }, add: app, mails: [] };
    }
    if (!read.ok) return { result: { ok: false, errors: read.errors }, add: null, mails: [] };

    app.id = receiptId(state.apps, now);
    var existing = findOpen(state.apps, app.email);
    if (existing) {
      app.status = STATUS.duplicate;
      app.message = (app.message ? app.message + '\n' : '') + '(' + existing.id + ' と重複）';
      return {
        result: { ok: true, id: existing.id, duplicate: true },
        add: app,
        mails: [{ mail: mails.staffDuplicate(app, existing, cfg, state.staffEmail), id: app.id, field: null, what: '重複の知らせ' }],
      };
    }

    var candidate = pickCandidate(app.timeBand, now, state, cfg);
    app.status = STATUS.pending;
    app.candidate = candidate ? candidate.key : '';
    return {
      result: { ok: true, id: app.id },
      add: app,
      mails: [
        { mail: mails.received(app, cfg), id: app.id, field: 'mailReceived', what: '受付メール' },
        { mail: mails.staffNew(app, candidate, cfg, state.staffEmail), id: app.id, field: null, what: '教室への知らせ' },
      ],
    };
  }

  // 講師が「確定」にチェックを入れたとき
  function confirm(state, id, now, cfg) {
    cfg = cfg || DEFAULT_CONFIG;
    var app = null;
    for (var i = 0; i < state.apps.length; i++) if (state.apps[i].id === id) app = state.apps[i];
    if (!app) return { error: '受付番号 ' + id + ' が見つかりません', updates: [], mails: [] };
    if (app.status !== STATUS.pending) return { error: '仮予約ではないので、確定できません（今の状態：' + (app.status || '空') + ')', updates: [], mails: [] };
    if (!app.candidate) return { error: '候補の回が空です。「候補の回」に日時（例：2026-12-02 19:00）を書いてから確定してください', updates: [], mails: [] };
    if (!parseSessionKey(app.candidate)) return { error: '候補の回の書き方が違います（例：2026-12-02 19:00）', updates: [], mails: [] };
    var next = {};
    for (var k in app) next[k] = app[k];
    next.status = STATUS.confirmed;
    next.confirmed = true;
    next.confirmedAt = now;
    return {
      error: null,
      updates: [{ id: id, set: { status: STATUS.confirmed, confirmed: true, confirmedAt: now } }],
      mails: [{ mail: mails.guide(next, cfg), id: id, field: 'mailGuide', what: '日にちの案内メール' }],
    };
  }

  // 毎朝の見回り: 確定していない申込の催促(1 日 1 回)、明日の参加者への前日のお知らせ(1 回だけ)
  function daily(state, now, cfg) {
    cfg = cfg || DEFAULT_CONFIG;
    var today = dateKey(now);
    var tomorrow = dateKey(new Date(startOfDay(now).getTime() + DAY + HOUR));
    var pending = [];
    var updates = [];
    var out = [];
    for (var i = 0; i < state.apps.length; i++) {
      var a = state.apps[i];
      if (a.status === STATUS.pending && now - a.receivedAt >= cfg.remindAfterHours * HOUR && a.staffReminded !== today) {
        pending.push(a);
        updates.push({ id: a.id, set: { staffReminded: today } });
      }
      if (a.status === STATUS.confirmed && String(a.candidate).slice(0, 10) === tomorrow && !a.mailDayBefore) {
        out.push({ mail: mails.dayBefore(a, cfg), id: a.id, field: 'mailDayBefore', what: '前日のお知らせ' });
      }
    }
    if (pending.length) out.unshift({ mail: mails.staffReminder(pending, now, cfg, state.staffEmail), id: null, field: null, what: '催促' });
    return { updates: updates, mails: out };
  }

  // 毎週月曜: 先週(月曜 0:00〜日曜 24:00)のまとめ
  function weekly(state, now, cfg) {
    cfg = cfg || DEFAULT_CONFIG;
    var today = startOfDay(now);
    var dow = parts(today).dow;
    var thisMonday = new Date(today.getTime() - ((dow + 6) % 7) * DAY);
    var from = new Date(thisMonday.getTime() - 7 * DAY);
    var to = thisMonday;
    var fp = parts(from);
    var tp = parts(new Date(to.getTime() - DAY));
    var s = {
      from: from,
      to: to,
      periodLabel: fp.m + '/' + fp.d + '〜' + tp.m + '/' + tp.d,
      total: 0,
      byBand: {},
      visits: 0,
      confirmed: 0,
      avgHoursToConfirm: null,
      pendingNow: 0,
      duplicates: 0,
      excluded: 0,
    };
    var hours = [];
    for (var i = 0; i < state.apps.length; i++) {
      var a = state.apps[i];
      if (a.status === STATUS.pending) s.pendingNow++;
      var t = a.receivedAt instanceof Date ? a.receivedAt.getTime() : NaN;
      if (!(t >= from.getTime() && t < to.getTime())) continue;
      if (a.status === STATUS.duplicate) { s.duplicates++; continue; }
      if (a.status === STATUS.excluded) { s.excluded++; continue; }
      s.total++;
      s.byBand[a.timeBand] = (s.byBand[a.timeBand] || 0) + 1;
      if (a.visit) s.visits++;
      if (a.status === STATUS.confirmed) {
        s.confirmed++;
        if (a.confirmedAt instanceof Date) hours.push((a.confirmedAt - a.receivedAt) / HOUR);
      }
    }
    if (hours.length) {
      var sum = 0;
      for (var j = 0; j < hours.length; j++) sum += hours[j];
      s.avgHoursToConfirm = Math.round((sum / hours.length) * 10) / 10;
    }
    var row = [now, s.periodLabel, s.total];
    for (var c = 0; c < cfg.classes.length; c++) row.push(s.byBand[cfg.classes[c].key] || 0);
    row.push(s.visits, s.confirmed, s.avgHoursToConfirm === null ? '' : s.avgHoursToConfirm, s.pendingNow);
    return { summary: s, row: row, mails: [{ mail: mails.weekly(s, cfg, state.staffEmail), id: null, field: null, what: '週のまとめ' }] };
  }

  // メールを送ったあと、表に書く言葉
  function sentNote(now) {
    return '送信済み ' + formatShort(now);
  }

  function failedNote(reason) {
    return '未送信：' + reason;
  }

  // ---------- 表の行との変換 ----------

  function toRow(app) {
    var row = [];
    for (var i = 0; i < COLUMNS.length; i++) {
      var key = COLUMNS[i][0];
      var v = app[key];
      if (key === 'name' || key === 'message' || key === 'email') v = sheetSafe(v);
      if (key === 'visit') v = v === true ? '見学' : '';
      row.push(v === undefined || v === null ? '' : v);
    }
    return row;
  }

  function fromRow(row) {
    var app = {};
    for (var i = 0; i < COLUMNS.length; i++) app[COLUMNS[i][0]] = row[i];
    app.visit = app.visit === true || app.visit === 'TRUE' || app.visit === '見学';
    app.confirmed = app.confirmed === true || app.confirmed === 'TRUE';
    app.email = String(app.email || '').toLowerCase();
    app.candidate = app.candidate instanceof Date ? sessionKey(app.candidate) : String(app.candidate || '');
    app.staffReminded = app.staffReminded instanceof Date ? dateKey(app.staffReminded) : String(app.staffReminded || '');
    return app;
  }

  function columnIndex(key) {
    for (var i = 0; i < COLUMNS.length; i++) if (COLUMNS[i][0] === key) return i;
    return -1;
  }

  return {
    STATUS: STATUS,
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    COLUMNS: COLUMNS,
    config: config,
    jst: jst,
    parts: parts,
    dateKey: dateKey,
    sessionKey: sessionKey,
    parseSessionKey: parseSessionKey,
    formatSession: formatSession,
    formatDateTime: formatDateTime,
    formatShort: formatShort,
    slotLabel: slotLabel,
    sheetSafe: sheetSafe,
    readApplication: readApplication,
    upcomingSessions: upcomingSessions,
    seatsTaken: seatsTaken,
    pickCandidate: pickCandidate,
    mails: mails,
    receive: receive,
    confirm: confirm,
    daily: daily,
    weekly: weekly,
    sentNote: sentNote,
    failedNote: failedNote,
    toRow: toRow,
    fromRow: fromRow,
    columnIndex: columnIndex,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = NijimiCore;

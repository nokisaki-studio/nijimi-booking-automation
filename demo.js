// 動く見本: core.js(Apps Script 版と同じ処理)を、ブラウザの中の表と「起きたこと」につなぐ。
// メールは送らない。データは保存しない(再読み込みで最初に戻る)。人の入れた文字は textContent で入れる。
(() => {
  'use strict';
  const C = window.NijimiCore;
  const cfg = C.config();
  const HOUR = 3600 * 1000;
  const STAFF = 'nijimi.staff@example.com';
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');

  // 架空の在籍の人数(「在籍人数」のシート)。平日の夜は混んでいる
  const ENROLLED = { '火 10:30': 3, '木 10:30': 2, '水 19:00': 3, '土 10:00': 4 };
  // 入れ直すときの架空の名前
  const PEOPLE = [
    ['佐藤 みのり', 'minori@example.com', '平日の夜', '見学希望です'],
    ['小林 ゆう', 'yu.kobayashi@example.com', '平日の昼', ''],
    ['高橋 そら', 'sora@example.com', '土曜の朝', '子どもと一緒でも大丈夫ですか？'],
    ['中村 はるか', 'haruka.n@example.com', '平日の夜', ''],
    ['渡辺 けい', 'kei@example.com', '平日の昼', '絵は小学生以来です'],
  ];

  const $ = (sel, root = document) => root.querySelector(sel);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  let state;
  let now;
  let weeklyRows;
  let personIndex = 0;
  let activeTab = '申込';
  let freshId = null;

  // ---------- 時計 ----------

  // 見本の中の「いま」(火曜の午後)。毎回同じ流れになるよう、日時を決めておく
  const START = C.jst(2026, 12, 1, 14, 0);
  const DAILY_HOUR = 9;
  const WEEKLY_HOUR = 8;

  // from より後で、いちばん近い hour:00(dow を渡すとその曜日だけ)
  function nextAt(from, hour, dow) {
    const p = C.parts(from);
    for (let i = 0; i <= 7; i++) {
      const t = C.jst(p.y, p.m, p.d + i, hour, 0);
      if (t > from && (dow === undefined || C.parts(t).dow === dow)) return t;
    }
    return null;
  }

  // now から until まで(until を含む)の、毎朝 9 時台・毎週月曜 8 時台の処理を、時刻の順に動かす
  function runScheduled(until, show) {
    const quiet = [];
    const flushQuiet = () => {
      if (show && quiet.length) addFeed('毎朝 9 時台の見回り', [{ text: `${quiet.join('・')} は、することはありませんでした`, quiet: true }], 'clock', quiet[quiet.length - 1]);
      quiet.length = 0;
    };
    for (;;) {
      const daily = nextAt(now, DAILY_HOUR);
      const weekly = nextAt(now, WEEKLY_HOUR, 1);
      const isWeekly = weekly < daily;
      const next = isWeekly ? weekly : daily;
      if (next > until) break;
      now = next;
      if (isWeekly) {
        const plan = C.weekly(state, now, cfg);
        weeklyRows.push(plan.row);
        deliver(plan.mails, now);
        if (show) {
          flushQuiet();
          addFeed('毎週月曜 8 時台のまとめ', [
            { text: `「週報」のシートに 1 行足しました（${plan.summary.periodLabel}・申込 ${plan.summary.total} 件）` },
            ...plan.mails.map(mailItem),
          ], 'clock');
          activeTab = '週報';
        }
      } else {
        const plan = C.daily(state, now, cfg);
        applyUpdates(plan.updates);
        deliver(plan.mails, now);
        if (!show) continue;
        if (plan.mails.length) {
          flushQuiet();
          addFeed('毎朝 9 時台の見回り', plan.mails.map(mailItem), 'clock');
        } else quiet.push(dayLabel(now));
      }
    }
    flushQuiet();
    now = until;
  }

  // ---------- 状態 ----------

  // 先に入っている申込(すべて架空)。届いた時刻と、講師が確定した時刻だけを決め、
  // あとは同じ処理で再生する(あいだの毎朝・毎週の処理も動かす。作り話の行は置かない)
  const SEEDS = [
    { at: C.jst(2026, 11, 29, 10, 0), raw: { name: '鈴木 あき', email: 'aki@example.com', time: '平日の昼', message: '' } },
    { at: C.jst(2026, 11, 29, 15, 0), confirm: 'aki@example.com' },
    { at: C.jst(2026, 11, 30, 11, 0), raw: { name: '渡辺 けい', email: 'kei@example.com', time: '土曜の朝', message: '絵は小学生以来です' } },
    { at: C.jst(2026, 11, 30, 13, 0), raw: { name: '田中 ひなた', email: 'hinata@example.com', time: '平日の夜', message: '見学希望です' } },
    { at: C.jst(2026, 11, 30, 18, 0), confirm: 'hinata@example.com' },
    { at: C.jst(2026, 11, 30, 20, 0), raw: { name: '伊藤 さく', email: 'saku@example.com', time: '平日の昼', message: '' } },
    { at: C.jst(2026, 12, 1, 11, 0), confirm: 'saku@example.com' },
  ];

  function reset() {
    weeklyRows = [];
    freshId = null;
    activeTab = '申込';
    state = {
      apps: [],
      enrolled: { ...ENROLLED },
      holidays: ['2026-12-12'], // 講師の展示会(架空)
      staffEmail: STAFF,
    };
    now = new Date(SEEDS[0].at.getTime() - HOUR);
    for (const ev of SEEDS) {
      runScheduled(ev.at, false);
      if (ev.raw) applyReceive(C.receive(state, ev.raw, now, cfg), now);
      else {
        const app = state.apps.find((a) => a.email === ev.confirm);
        const c = C.confirm(state, app.id, now, cfg);
        applyUpdates(c.updates);
        deliver(c.mails, now);
      }
    }
    runScheduled(START, false);

    $('[data-feed]').replaceChildren();
    $('[data-feed-older-list]').replaceChildren();
    updateOlder();
    $('[data-feed-empty]').hidden = false;
    fillPerson(0);
    render();
  }

  function find(id) {
    return state.apps.find((a) => a.id === id);
  }

  function applyReceive(plan, at) {
    if (plan.add) state.apps.push(plan.add);
    return deliver(plan.mails, at);
  }

  function applyUpdates(updates) {
    for (const u of updates) Object.assign(find(u.id), u.set);
  }

  // 本物ではここで MailApp.sendEmail を呼ぶ。見本では送らず、送れたものとして記録する
  function deliver(list, at) {
    for (const m of list) if (m.id && m.field) find(m.id)[m.field] = C.sentNote(at);
    return list;
  }

  // ---------- 動き ----------

  function submit(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const raw = Object.fromEntries(new FormData(form));
    const plan = C.receive(state, raw, now, cfg);
    showErrors(form, plan.result.ok ? [] : plan.result.errors);
    if (!plan.result.ok) {
      const first = form.querySelector('[aria-invalid="true"]');
      if (first) first.focus();
      return;
    }
    applyReceive(plan, now);
    const items = [];
    if (plan.add.status === C.STATUS.excluded) {
      items.push({ text: '見えない欄に値があったので、ボットとして記録だけしました（返信はしません）' });
    } else if (plan.result.duplicate) {
      items.push({ text: `同じメールアドレスの申込（${plan.result.id}）が残っているので、${plan.add.id} を「重複」にしました。受付メールは送りません` });
    } else {
      items.push({ text: `表に 1 行足しました（${plan.add.id}）` });
      const cand = plan.add.candidate;
      items.push({
        text: cand
          ? `候補の回を選びました：${C.formatSession(cand, cfg)}（この方が入って残り ${cfg.capacity - C.seatsTaken(cand, state.apps, state.enrolled, cfg)} 席）`
          : `候補の回がありません（${cfg.lookaheadWeeks} 週先まで満席か休講日）。講師が日にちを相談します`,
        warn: !cand,
      });
    }
    for (const m of plan.mails) items.push(mailItem(m));
    freshId = plan.add.id;
    activeTab = '申込';
    addFeed('申込が届いたとき', items, 'auto');
    render();
  }

  function confirmRow(id, box) {
    const plan = C.confirm(state, id, now, cfg);
    if (plan.error) {
      box.checked = false;
      addFeed('講師が「確定」にチェックを入れたとき', [{ text: '確定できません：' + plan.error, warn: true }], 'human');
      return;
    }
    applyUpdates(plan.updates);
    deliver(plan.mails, now);
    const app = find(id);
    addFeed('講師が「確定」にチェックを入れたとき', [
      { text: `${id} を「確定」にしました（${C.formatSession(app.candidate, cfg)}）` },
      ...plan.mails.map(mailItem),
    ], 'human');
    render();
    const again = document.querySelector(`.grid input[data-id="${id}"]`);
    if (again) again.focus();
  }

  function advance(kind) {
    const until = kind === 'morning' ? nextAt(now, DAILY_HOUR) : nextAt(now, WEEKLY_HOUR, 1);
    runScheduled(until, true);
    render();
  }

  function dayLabel(d) {
    const p = C.parts(d);
    return `${p.m}/${p.d}`;
  }

  // ---------- 表示: 起きたこと ----------

  function mailItem(m) {
    const toStaff = m.mail.to === STAFF;
    const who = toStaff ? '講師' : (find(m.id) || {}).name + ' 様';
    const verb = {
      受付メール: '受付メールを送りました',
      教室への知らせ: '教室に知らせました',
      重複の知らせ: '教室に知らせました',
      日にちの案内メール: '日にちの案内メールを送りました',
      催促: '確定していない申込を、講師に知らせました',
      前日のお知らせ: '前日のお知らせを送りました',
      週のまとめ: '週のまとめを講師に送りました',
    }[m.what] || m.what + 'を送りました';
    return { text: `${verb} → ${who}`, mail: m.mail };
  }

  function addFeed(trigger, items, kind, label) {
    const li = el('li', 'feed__entry feed__entry--' + kind);
    const head = el('p', 'feed__head');
    head.append(el('time', 'feed__time', label || C.formatShort(now)), el('span', 'feed__trigger', trigger));
    li.append(head);
    const ul = el('ul', 'feed__items');
    items.forEach((it, i) => {
      const item = el('li', 'feed__item' + (it.warn ? ' is-warn' : '') + (it.quiet ? ' is-quiet' : ''));
      item.style.setProperty('--i', i);
      item.append(tick(it.warn), el('span', 'feed__text', it.text));
      if (it.mail) {
        const d = el('details', 'mail');
        const s = el('summary', 'mail__open', '文面を見る');
        const pre = el('pre', 'mail__body');
        pre.textContent = `宛先：${it.mail.to}\n件名：${it.mail.subject}\n\n${it.mail.body}`;
        d.append(s, pre);
        item.append(d);
      }
      ul.append(item);
    });
    li.append(ul);
    const feed = $('[data-feed]');
    feed.prepend(li);
    $('[data-feed-empty]').hidden = true;
    if (!reduce.matches) li.classList.add('is-new');
    const older = $('[data-feed-older-list]');
    while (feed.children.length > 2) {
      const last = feed.lastElementChild;
      last.classList.remove('is-new');
      older.prepend(last);
    }
    updateOlder();
  }

  function updateOlder() {
    const n = $('[data-feed-older-list]').children.length;
    $('[data-feed-older]').hidden = n === 0;
    $('[data-feed-older-count]').textContent = String(n);
  }

  function tick(warn) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.setAttribute('class', 'feed__mark');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', warn ? 'M10 4v7M10 14.5v1' : 'M4.5 10.5l3.5 3.5 7.5-8');
    svg.append(path);
    return svg;
  }

  // ---------- 表示: 表 ----------

  const VIEW = [
    ['id', '受付番号・日時'],
    ['name', 'お名前'],
    ['timeBand', '時間帯'],
    ['status', '状態'],
    ['candidate', '候補の回'],
    ['confirmed', '確定'],
    ['mails', 'メール'],
  ];
  // スマホでは、講師がする「確定」を左寄りに出す(横に動かさなくても見えるように)
  const narrow = matchMedia('(max-width: 719px)');
  const NARROW_ORDER = ['id', 'name', 'status', 'confirmed', 'candidate', 'timeBand', 'mails'];
  const view = () => (narrow.matches ? NARROW_ORDER.map((k) => VIEW.find(([key]) => key === k)) : VIEW);

  function renderSheet() {
    const body = $('[data-sheet-body]');
    const table = el('table', 'grid');
    const thead = el('thead');
    const hr = el('tr');
    hr.append(el('th', 'grid__n', ''));
    if (activeTab === '申込') {
      for (const [key, label] of view()) {
        const th = el('th', key === 'confirmed' ? 'is-human' : '', label);
        th.scope = 'col';
        hr.append(th);
      }
      thead.append(hr);
      table.append(thead);
      const tb = el('tbody');
      state.apps.forEach((a, i) => tb.append(appRow(a, i + 2)));
      table.append(tb);
    } else {
      const { head, rows } = otherSheet(activeTab);
      for (const h of head) {
        const th = el('th', '', h);
        th.scope = 'col';
        hr.append(th);
      }
      thead.append(hr);
      table.append(thead);
      const tb = el('tbody');
      if (!rows.length) {
        const tr = el('tr');
        tr.append(el('td', 'grid__n', '2'));
        const td = el('td', 'grid__empty', activeTab === '週報' ? '月曜の朝に、先週のまとめが 1 行ずつ入ります（「次の月曜 8:00 へ」で動きます）' : '');
        td.colSpan = head.length;
        tr.append(td);
        tb.append(tr);
      }
      rows.forEach((r, i) => {
        const tr = el('tr');
        tr.append(el('td', 'grid__n', String(i + 2)));
        r.forEach((v) => tr.append(el('td', typeof v === 'number' ? 'is-num' : '', v === '' ? '—' : String(v))));
        tb.append(tr);
      });
      table.append(tb);
    }
    body.replaceChildren(table);
    body.scrollLeft = 0;
    renderTabs();
  }

  function appRow(a, n) {
    const tr = el('tr');
    if (a.id === freshId && !reduce.matches) tr.classList.add('is-fresh');
    tr.append(el('td', 'grid__n', String(n)));
    for (const [key] of view()) {
      const td = el('td');
      if (key === 'id') {
        td.className = 'is-num';
        td.append(el('span', 'grid__id', a.id), el('span', 'grid__sub', C.formatShort(a.receivedAt)));
      }
      else if (key === 'status') { td.append(el('span', 'chip chip--' + statusClass(a.status), a.status)); }
      else if (key === 'candidate') { td.textContent = a.candidate ? shortSession(a.candidate) : (a.status === C.STATUS.pending ? '候補なし' : '—'); }
      else if (key === 'confirmed') {
        td.className = 'is-human';
        if (a.status === C.STATUS.pending || a.status === C.STATUS.confirmed) {
          const box = el('input');
          box.type = 'checkbox';
          const done = a.status === C.STATUS.confirmed;
          box.checked = done;
          box.dataset.id = a.id;
          box.setAttribute('aria-label', `${a.id} ${a.name} 様を確定する`);
          if (done) {
            box.setAttribute('aria-disabled', 'true');
            box.addEventListener('click', (e) => e.preventDefault()); // 確定したものは外さない
          } else box.addEventListener('change', () => { if (box.checked) confirmRow(a.id, box); });
          td.append(box);
        } else td.textContent = '—';
      } else if (key === 'mails') {
        const done = [['mailReceived', '受付'], ['mailGuide', '案内'], ['mailDayBefore', '前日']].filter(([k]) => String(a[k]).startsWith('送信済み'));
        td.textContent = done.length ? done.map(([, l]) => l).join('・') : '—';
        td.title = '送ったメール';
      } else td.textContent = a[key] || '—';
      tr.append(td);
    }
    return tr;
  }

  // 「12/2（水）19:00」
  function shortSession(key) {
    const p = C.parts(C.parseSessionKey(key));
    return `${p.m}/${p.d}（${'日月火水木金土'[p.dow]}）${key.slice(11)}`;
  }

  function statusClass(s) {
    return { 仮予約: 'pending', 確定: 'done', 重複: 'muted', 除外: 'muted', キャンセル: 'muted' }[s] || 'muted';
  }

  function otherSheet(name) {
    if (name === '在籍人数') return { head: ['回', '在籍の人数'], rows: Object.entries(state.enrolled) };
    if (name === '休講日') return { head: ['休講日', 'メモ'], rows: state.holidays.map((d) => [d, '講師の展示会']) };
    const bands = cfg.classes.map((c) => c.key);
    return {
      head: ['まとめた日時', '期間', '申込', ...bands, '見学', '確定', '平均（時間）', '未確定'],
      rows: weeklyRows.map((r) => [C.formatShort(r[0]), ...r.slice(1)]),
    };
  }

  function renderTabs() {
    const box = $('[data-sheet-tabs]');
    box.replaceChildren(...['申込', '在籍人数', '休講日', '週報'].map((name) => {
      const b = el('button', 'sheet__tab', name);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(name === activeTab));
      b.tabIndex = name === activeTab ? 0 : -1;
      b.addEventListener('click', () => { activeTab = name; freshId = null; renderSheet(); box.querySelector('[aria-selected="true"]').focus(); });
      return b;
    }));
    box.onkeydown = (e) => {
      const names = ['申込', '在籍人数', '休講日', '週報'];
      const d = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
      if (!d) return;
      e.preventDefault();
      activeTab = names[(names.indexOf(activeTab) + d + names.length) % names.length];
      freshId = null;
      renderSheet();
      box.querySelector('[aria-selected="true"]').focus();
    };
  }

  // ---------- 表示: フォームと時計 ----------

  function showErrors(form, errors) {
    const map = { お名前: ['name', 'f-name-err'], メール: ['email', 'f-mail-err'], 時間帯: ['time', 'f-time-err'] };
    for (const [, [field, errId]] of Object.entries(map)) {
      const msg = errors.find((e) => e.includes(field === 'name' ? 'お名前' : field === 'email' ? 'メール' : '時間帯'));
      const p = document.getElementById(errId);
      p.hidden = !msg;
      p.textContent = msg || '';
      form.querySelectorAll(`[name="${field}"]`).forEach((input) => input.setAttribute('aria-invalid', String(!!msg)));
    }
  }

  function fillPerson(i) {
    personIndex = i % PEOPLE.length;
    const [name, email, time, message] = PEOPLE[personIndex];
    const form = $('[data-form]');
    const f = form.elements; // form.name はフォーム自身の名前なので、elements から取る
    f.namedItem('name').value = name;
    f.namedItem('email').value = email;
    form.querySelector(`[name="time"][value="${time}"]`).checked = true;
    f.namedItem('message').value = message;
    f.namedItem('website').value = '';
    showErrors(form, []);
  }

  function render() {
    $('[data-sheet]').dataset.tab = activeTab;
    const t = $('[data-now]');
    t.textContent = C.formatDateTime(now);
    t.dateTime = now.toISOString();
    renderSheet();
  }

  // ---------- つなぐ ----------

  $('[data-form]').addEventListener('submit', submit);
  $('[data-another]').addEventListener('click', () => fillPerson(personIndex + 1));
  document.querySelectorAll('[data-advance]').forEach((b) => b.addEventListener('click', () => advance(b.dataset.advance)));
  $('[data-reset]').addEventListener('click', reset);
  narrow.addEventListener('change', () => renderSheet());
  reset();
})();

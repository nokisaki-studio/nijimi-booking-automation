// Apps Script の Google のサービスを、テスト用の小さな偽物に置き換える。
// Code.gs が使う分だけを、本物の決まりに近い形でまねる:
//  - 表計算は「2026-12-02 19:00」のような文字を日付に変える(書式が書式なしテキスト '@' のときは変えない)
//  - '=' で始まる文字は式になる(先頭に ' があれば、' を除いた文字として入る)
//  - チェックボックスの FALSE も「中身あり」なので、getLastRow() に数えられる
const fs = require('node:fs');
const path = require('node:path');

function makeClock(start) {
  const clock = { now: start.getTime() };
  class FakeDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(clock.now);
      else super(...args);
    }
    static now() {
      return clock.now;
    }
  }
  clock.Date = FakeDate;
  clock.set = (d) => { clock.now = d.getTime(); };
  return clock;
}

function makeGas(clock, opts = {}) {
  const sent = [];
  const triggers = [];
  const log = { locks: 0, released: 0, errors: [] };
  const mail = { quota: opts.quota ?? 100, failFor: new Set(opts.failFor || []) };
  const DATETIME = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?$/;

  function convert(v, format) {
    if (typeof v !== 'string') return { value: v };
    if (v.startsWith("'")) return { value: v.slice(1) };
    if (v.startsWith('=')) return { value: v, formula: true };
    if (format === '@') return { value: v };
    const m = DATETIME.exec(v);
    if (m) return { value: new clock.Date(Date.UTC(+m[1], +m[2] - 1, +m[3], (+m[4] || 0) - 9, +m[5] || 0)) };
    return { value: v };
  }

  class Sheet {
    constructor(ss, name) {
      this.ss = ss;
      this.name = name;
      this.cells = new Map(); // "r,c" -> { value, formula, checkbox, format }
      this.colFormat = new Map();
      this.frozen = 0;
    }
    getName() { return this.name; }
    getParent() { return this.ss; }
    getMaxRows() { return 1000; }
    setFrozenRows(n) { this.frozen = n; }
    cell(r, c) {
      const k = r + ',' + c;
      if (!this.cells.has(k)) this.cells.set(k, { value: '' });
      return this.cells.get(k);
    }
    getLastRow() {
      let last = 0;
      for (const [k, cell] of this.cells) {
        if (cell.value !== '' && cell.value !== undefined && cell.value !== null) last = Math.max(last, +k.split(',')[0]);
      }
      return last;
    }
    getRange(row, col, numRows = 1, numCols = 1) {
      if (row < 1 || col < 1 || numRows < 1 || numCols < 1) throw new Error(`範囲が正しくありません: ${row},${col},${numRows},${numCols}`);
      return new Range(this, row, col, numRows, numCols);
    }
    formulas() {
      return [...this.cells.values()].filter((c) => c.formula).map((c) => c.value);
    }
  }

  class Range {
    constructor(sheet, row, col, numRows, numCols) {
      Object.assign(this, { sheet, row, col, numRows, numCols });
    }
    getSheet() { return this.sheet; }
    getRow() { return this.row; }
    getColumn() { return this.col; }
    getLastRow() { return this.row + this.numRows - 1; }
    getLastColumn() { return this.col + this.numCols - 1; }
    getNumRows() { return this.numRows; }
    getValues() {
      const out = [];
      for (let r = 0; r < this.numRows; r++) {
        const line = [];
        for (let c = 0; c < this.numCols; c++) line.push(this.sheet.cell(this.row + r, this.col + c).value);
        out.push(line);
      }
      return out;
    }
    getValue() { return this.sheet.cell(this.row, this.col).value; }
    setValues(values) {
      if (values.length !== this.numRows || values.some((l) => l.length !== this.numCols)) {
        throw new Error(`値の数と範囲の大きさが合いません: 範囲 ${this.numRows}x${this.numCols}`);
      }
      values.forEach((line, r) => line.forEach((v, c) => this.write(this.row + r, this.col + c, v)));
      return this;
    }
    setValue(v) { this.write(this.row, this.col, v); return this; }
    write(r, c, v) {
      const cell = this.sheet.cell(r, c);
      const format = this.sheet.colFormat.get(c);
      const conv = convert(v, format);
      cell.value = conv.value;
      cell.formula = !!conv.formula;
    }
    setNumberFormat(f) {
      for (let c = this.col; c <= this.getLastColumn(); c++) this.sheet.colFormat.set(c, f);
      return this;
    }
    insertCheckboxes() {
      for (let r = this.row; r <= this.getLastRow(); r++) {
        for (let c = this.col; c <= this.getLastColumn(); c++) {
          const cell = this.sheet.cell(r, c);
          cell.checkbox = true;
          if (cell.value !== true) cell.value = false;
        }
      }
      return this;
    }
    setFontWeight() { return this; }
  }

  const ss = {
    sheets: new Map(),
    tz: null,
    getSheetByName(name) { return this.sheets.get(name) || null; },
    insertSheet(name) {
      const sh = new Sheet(this, name);
      this.sheets.set(name, sh);
      return sh;
    },
    setSpreadsheetTimeZone(tz) { this.tz = tz; },
  };

  function triggerBuilder(handler) {
    const t = { handler, id: 't' + (triggers.length + 1) + Math.random().toString(36).slice(2, 6) };
    const done = () => { triggers.push(t); return { getHandlerFunction: () => handler, getUniqueId: () => t.id }; };
    return {
      forSpreadsheet(s) {
        t.source = s;
        return { onEdit() { t.kind = 'onEdit'; return { create: done }; } };
      },
      timeBased() {
        t.kind = 'clock';
        const b = {
          atHour(h) { t.hour = h; return b; },
          everyDays(n) { t.everyDays = n; return b; },
          onWeekDay(d) { t.weekDay = d; return b; },
          create: done,
        };
        return b;
      },
    };
  }

  const globals = {
    SpreadsheetApp: {
      // 単独のプロジェクトでは、紐づいた表がない(opts.standalone)
      getActiveSpreadsheet: () => (opts.standalone ? null : ss),
      openById(id) {
        if (id !== opts.spreadsheetId) throw new Error('表が見つかりません: ' + id);
        return ss;
      },
      flush() {},
    },
    ScriptApp: {
      WeekDay: { MONDAY: 'MONDAY' },
      newTrigger: triggerBuilder,
      getProjectTriggers: () => triggers.map((t) => ({ getHandlerFunction: () => t.handler, _t: t })),
      deleteTrigger(tr) {
        const i = triggers.indexOf(tr._t);
        if (i >= 0) triggers.splice(i, 1);
      },
    },
    MailApp: {
      getRemainingDailyQuota: () => mail.quota,
      sendEmail(msg) {
        if (typeof msg !== 'object' || !msg.to || !msg.subject || typeof msg.body !== 'string') throw new Error('sendEmail の引数が正しくありません');
        if (mail.failFor.has(msg.to)) throw new Error('Invalid email: ' + msg.to);
        mail.quota--;
        sent.push({ ...msg, at: new Date(clock.now) });
      },
    },
    LockService: {
      getScriptLock: () => {
        let held = false;
        return {
          waitLock() { held = true; log.locks++; },
          tryLock() { held = true; log.locks++; return true; },
          releaseLock() { if (held) log.released++; held = false; },
          hasLock: () => held,
        };
      },
    },
    ContentService: {
      MimeType: { JSON: 'JSON' },
      createTextOutput(s) {
        const out = { content: s, mime: null, setMimeType(m) { out.mime = m; return out; }, getContent: () => s };
        return out;
      },
    },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'owner@example.com' }) },
    console: { log() {}, error(...a) { log.errors.push(a.map(String).join(' ')); } },
    Date: clock.Date,
  };

  return { globals, ss, sent, triggers, log, mail };
}

// core.js と gas/Code.gs を、偽物のサービスの上で読み込む(Apps Script と同じく、2 つのファイルは同じ場所の変数を共有する)
function loadProject(globals) {
  const root = path.join(__dirname, '..');
  const src = fs.readFileSync(path.join(root, 'core.js'), 'utf8') + '\n' + fs.readFileSync(path.join(root, 'gas', 'Code.gs'), 'utf8');
  const names = Object.keys(globals);
  const exportsList = ['setup', 'doPost', 'doGet', 'onSheetEdit', 'dailyRun', 'weeklyRun', 'NijimiCore', 'SETTINGS', 'SHEETS'];
  // module を隠して、core.js が Node のつもりで書き出さないようにする
  const fn = new Function(...names, 'module', `${src}\nreturn { ${exportsList.join(', ')} };`);
  return fn(...names.map((n) => globals[n]), undefined);
}

module.exports = { makeClock, makeGas, loadProject };

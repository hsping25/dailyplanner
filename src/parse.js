// 한국어 문장 → 구조화된 일정/할 일 파서. (정규식 전용, LLM/API 사용 안 함)
// 못 알아들으면 {kind:"unparsed"}를 돌려주고, 프론트가 "다시 말해 주세요"를 띄운다.
// parseText(text, history) 시그니처는 유지 — 나중에 다른 방식으로 갈아끼우기 쉽게.

const pad = n => String(n).padStart(2, "0");
const DAY = ["일", "월", "화", "수", "목", "금", "토"];
const WEEKDAY = { 월: "MO", 화: "TU", 수: "WE", 목: "TH", 금: "FR", 토: "SA", 일: "SU" };

const fmtDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// 하루 경계는 새벽 4시. "오늘/내일" 등 상대 날짜는 벽시계가 아니라 이 논리적 하루 기준.
// 예: 7/15 새벽 1시는 아직 논리적 7/14 → "내일"은 7/15.
const DAY_BOUNDARY = 4;
const midnight = now => {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (now.getHours() < DAY_BOUNDARY) d.setDate(d.getDate() - 1);
  return d;
};

const DUR_RE = /(?:(\d+)\s*시간\s*(반)?|(\d+)\s*분)\s*동안/;

// ───────── 전처리: 한글 숫자·특수어를 숫자/표준형으로 ─────────
// "세 시" → "3시", "자정" → "오전 0시", "정오" → "오후 12시"
const HOUR_WORDS = [
  ["열두", 12], ["열한", 11], ["열", 10], ["아홉", 9], ["여덟", 8], ["일곱", 7],
  ["여섯", 6], ["다섯", 5], ["네", 4], ["세", 3], ["두", 2], ["한", 1],
];
function preprocess(s) {
  let out = s.replace(/자정/g, "오전 0시").replace(/정오/g, "오후 12시");
  for (const [word, n] of HOUR_WORDS) {
    out = out.replace(new RegExp(word + "\\s*시", "g"), n + "시");
  }
  // "반시간" 같은 오인식 방지는 생략 (드묾)
  return out;
}

// ───────── 날짜 파싱 ─────────
// 반환: { date: Date(그날 00:00), span: 매칭문자열 } | null
function parseDate(text, now) {
  const today = midnight(now);
  let m;

  // 2026-07-16, 2026/7/16, 2026.7.16
  if (m = text.match(/(\d{4})\s*[.\-/]\s*(\d{1,2})\s*[.\-/]\s*(\d{1,2})/)) {
    return { date: new Date(+m[1], +m[2] - 1, +m[3]), span: m[0] };
  }
  // N월 N일
  if (m = text.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/)) {
    const d = new Date(now.getFullYear(), +m[1] - 1, +m[2]);
    if (d < today) d.setFullYear(d.getFullYear() + 1); // 이미 지난 날이면 내년
    return { date: d, span: m[0] };
  }
  // 이번달/다음달/담달 N일
  if (m = text.match(/(이번\s*달|다음\s*달|담달)\s*(\d{1,2})\s*일/)) {
    const off = /다음|담/.test(m[1]) ? 1 : 0;
    return { date: new Date(now.getFullYear(), now.getMonth() + off, +m[2]), span: m[0] };
  }
  // 7/16, 7-16, 7.16  (콜론은 시간이므로 제외)
  if (m = text.match(/(?<![\d:])(\d{1,2})\s*[.\-/]\s*(\d{1,2})(?![\d:])/)) {
    const mo = +m[1], dd = +m[2];
    if (mo >= 1 && mo <= 12 && dd >= 1 && dd <= 31) {
      const d = new Date(now.getFullYear(), mo - 1, dd);
      if (d < today) d.setFullYear(d.getFullYear() + 1);
      return { date: d, span: m[0] };
    }
  }
  // 오늘/내일/모레/글피/낼(모레)
  if (m = text.match(/오늘|낼모레|내일모레|모레|글피|내일|낼/)) {
    const map = { "오늘": 0, "내일": 1, "낼": 1, "모레": 2, "내일모레": 2, "낼모레": 2, "글피": 3 };
    const d = midnight(now); d.setDate(d.getDate() + map[m[0]]);
    return { date: d, span: m[0] };
  }
  // N일 뒤/후/안에/내(로)/있다가/이따/지나서
  if (m = text.match(/(\d{1,2})\s*일\s*(뒤|후|안에?|내로?|있다가|이따가?|지나서)/)) {
    const d = midnight(now); d.setDate(d.getDate() + +m[1]);
    return { date: d, span: m[0] };
  }
  // (다음주|담주|이번주|저번주|지난주)? + 요일
  if (m = text.match(/(다음\s*주|담주|이번\s*주|저번\s*주|지난\s*주)?\s*([월화수목금토일])\s*요일/)) {
    const target = DAY.indexOf(m[2]);
    const d = midnight(now);          // 논리적 오늘
    const logDow = d.getDay();
    const mb = x => (x + 6) % 7;
    const diff = mb(target) - mb(logDow);
    const mod = m[1] || "";
    if (/다음|담/.test(mod)) d.setDate(d.getDate() + diff + 7);
    else if (/이번/.test(mod)) d.setDate(d.getDate() + diff);
    else if (/저번|지난/.test(mod)) d.setDate(d.getDate() + diff - 7);
    else { let dd = (target - logDow + 7) % 7; if (dd === 0) dd = 7; d.setDate(d.getDate() + dd); }
    return { date: d, span: m[0] };
  }
  // 바로 "N일" (이달 그 날짜; 지났으면 다음달)
  if (m = text.match(/(?<![\d])(\d{1,2})\s*일(?!\s*(?:뒤|후|동안|간|째))/)) {
    const dd = +m[1];
    if (dd >= 1 && dd <= 31) {
      const d = new Date(now.getFullYear(), now.getMonth(), dd);
      if (d < today) d.setMonth(d.getMonth() + 1);
      return { date: d, span: m[0] };
    }
  }
  return null;
}

// ───────── 시간 파싱 ─────────
// 반환: { h, min, span, ambiguous } | null.  ambiguous면 오전/오후 되물음.
function resolveHour(h, marker) {
  if (h >= 13 && h <= 23) return h;
  if (/밤/.test(marker)) { if (h === 12) return 0; if (h <= 5) return h; return h + 12; }
  if (/오후|저녁|낮/.test(marker)) return h === 12 ? 12 : h + 12;
  if (/점심/.test(marker)) return h <= 3 ? h + 12 : h;
  if (/오전|아침|새벽/.test(marker)) return h === 12 ? 0 : h;
  return null; // 단서 없음
}
const MARK = "오전|오후|아침|점심|저녁|밤|새벽|낮";
function parseTime(text) {
  let m;
  // HH:MM 콜론 — 정확한 24시간(마커 있으면 반영)
  if (m = text.match(new RegExp(`(${MARK})?\\s*(\\d{1,2})\\s*:\\s*(\\d{2})`))) {
    let h = +m[2]; const min = +m[3];
    if (m[1]) { const r = resolveHour(h, m[1]); if (r != null) h = r; }
    return { h: ((h % 24) + 24) % 24, min: Math.min(min, 59), span: m[0], ambiguous: false };
  }
  // N시 (반|N분|정각)? + 마커
  if (m = text.match(new RegExp(`(${MARK})?\\s*(\\d{1,2})\\s*시\\s*(?:(반)|(\\d{1,2})\\s*분|정각)?`))) {
    const h0 = +m[2];
    const min = m[3] === "반" ? 30 : (m[4] ? +m[4] : 0);
    const r = resolveHour(h0, m[1] || "");
    if (r == null) return { h: h0, min, span: m[0], ambiguous: true };
    return { h: r, min, span: m[0], ambiguous: false };
  }
  return null;
}

// ───────── 반복 파싱 ─────────
function extractDays(cluster) {
  const chars = cluster.replace(/요일/g, " ").match(/[월화수목금토일]/g);
  if (!chars) return null;
  const seen = new Set(), out = [];
  for (const c of chars) { const b = WEEKDAY[c]; if (b && !seen.has(b)) { seen.add(b); out.push(b); } }
  return out.length ? out.join(",") : null;
}
function parseRecur(t) {
  let m;
  if (m = t.match(/매일(?:마다)?/)) return { rrule: "FREQ=DAILY", span: m[0] };
  if (m = t.match(/평일(?:마다)?/)) return { rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", span: m[0] };
  if (m = t.match(/주말(?:마다)?/)) return { rrule: "FREQ=WEEKLY;BYDAY=SA,SU", span: m[0] };
  if (m = t.match(/매\s*(?:달|월)\s*(\d{1,2})\s*일(?:마다)?/))
    return { rrule: `FREQ=MONTHLY;BYMONTHDAY=${Number(m[1])}`, span: m[0] };
  m = t.match(/(매주|격주)\s*((?:[월화수목금토일]\s*(?:요일)?\s*[,·]?\s*)+)(?:마다)?/);
  if (m) {
    const days = extractDays(m[2]);
    if (days) return { rrule: `FREQ=WEEKLY;BYDAY=${days}${m[1] === "격주" ? ";INTERVAL=2" : ""}`, span: m[0] };
  }
  m = t.match(/((?:[월화수목금토일]\s*(?:요일)?\s*[,·]?\s*)+)마다/);
  if (m) {
    const days = extractDays(m[1]);
    if (days) return { rrule: `FREQ=WEEKLY;BYDAY=${days}`, span: m[0] };
  }
  return null;
}

// ───────── 시간 범위 ("2시부터 4시까지", "오후 2시~4시", "14:00-16:00") ─────────
const TIMEUNIT = `\\d{1,2}\\s*(?::\\s*\\d{2}|시(?:\\s*(?:반|\\d{1,2}\\s*분|정각))?)`;
function parseTimeRange(text) {
  const re = new RegExp(
    `((?:${MARK})?\\s*${TIMEUNIT})\\s*(?:부터|에서|~|–|—|-)\\s*((?:${MARK})?\\s*${TIMEUNIT})\\s*(?:까지)?`);
  const m = text.match(re);
  if (!m) return null;
  const t1 = parseTime(m[1]), t2 = parseTime(m[2]);
  if (!t1 || !t2) return null;
  if (t1.ambiguous) {
    const mm = t1.min ? ` ${t1.min}분` : "";
    return { question: `시작이 오전 ${t1.h}시${mm}인가요, 오후 ${t1.h}시${mm}인가요?` };
  }
  const end = { h: t2.h, min: t2.min };
  if (t2.ambiguous && end.h <= t1.h) { end.h += 12; if (end.h > 23) end.h -= 24; } // 시작 이후로 추정
  return { start: { h: t1.h, min: t1.min }, end, span: m[0] };
}

// 제목 정리: 시각/날짜를 걷어낸 뒤 남는 조사·부사 토큰 제거
function cleanText(s) {
  return s
    .replace(/(^|\s)(에|에서|부터|까지|안에|마감|쯤|경|즈음|정도|날|때|이나|나)(?=\s|$)/g, "$1")
    .replace(/\s+/g, " ").trim();
}
const hasWord = s => /[가-힣a-zA-Z]/.test(s);
const isoLocal = d => `${fmtDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

// 시작 Date 계산 (하루 경계 새벽 4시 반영)
function makeStart(dm, now, h, min, rrule) {
  const monthly = rrule && rrule.match(/BYMONTHDAY=(\d+)/);
  const baseDate = monthly
    ? new Date(now.getFullYear(), now.getMonth(), Number(monthly[1]))
    : midnight(now);
  const start = new Date(dm ? dm.date : baseDate);
  start.setHours(h, min, 0, 0);
  if (dm && h < 4) start.setDate(start.getDate() + 1);            // 새벽/자정은 그 논리적 하루의 다음 달력날짜
  else if (!dm && !rrule && start < now) start.setDate(start.getDate() + 1); // 오늘 지난 시각이면 내일
  return start;
}

// ───────── 한 문장 파싱 ─────────
// 시각 있음 → 일정 / "동안"·범위 → 기간 / 시각 없음 → 할 일(날짜 있으면 마감).
// 반환: 아이템 배열([{event}] / [{task}] / [{question}]) 또는 null(못 알아들음)
function parseSentence(raw, now) {
  const t0 = raw.trim();
  if (!t0 || t0.length > 60) return null;
  const t = preprocess(t0);

  const rec = parseRecur(t);
  const rrule = rec ? rec.rrule : null;
  const rest = rec ? t.replace(rec.span, " ") : t;

  // (0) "종일"/"하루종일" → 종일 일정. start/end는 그 논리적 하루(04:00~다음날 03:59).
  if (/하루\s*종일|온종일|종일/.test(rest)) {
    const dm = rrule ? null : parseDate(rest, now);
    const D = dm ? dm.date : midnight(now);
    let title = rest.replace(/하루\s*종일|온종일|종일/g, " ");
    if (dm) title = title.replace(dm.span, " ");
    title = cleanText(title);
    if (!hasWord(title)) return null;
    const start = new Date(D); start.setHours(4, 0, 0, 0);
    const end = new Date(D); end.setDate(end.getDate() + 1); end.setHours(3, 59, 0, 0);
    const ev = { kind: "event", allday: true, title, start: isoLocal(start), end: isoLocal(end) };
    if (rrule) ev.rrule = rrule;
    return [ev];
  }

  // (A) 시간 범위 → 일정(시작~종료)
  const range = parseTimeRange(rest);
  if (range) {
    if (range.question) return [{ kind: "question", ask: range.question }];
    const dm = rrule ? null : parseDate(rest, now);
    let title = rest;
    if (dm) title = title.replace(dm.span, " ");
    title = cleanText(title.replace(range.span, " "));
    if (!hasWord(title)) return null;
    const start = makeStart(dm, now, range.start.h, range.start.min, rrule);
    const end = new Date(start); end.setHours(range.end.h, range.end.min, 0, 0);
    if (end <= start) end.setDate(end.getDate() + 1); // 자정 넘김
    const ev = { kind: "event", title, start: isoLocal(start), end: isoLocal(end) };
    if (rrule) ev.rrule = rrule;
    return [ev];
  }

  // (B) 단일 시각 → 일정
  const tm = parseTime(rest);
  if (tm && tm.ambiguous) {
    const mm = tm.min ? ` ${tm.min}분` : "";
    return [{ kind: "question", ask: `오전 ${tm.h}시${mm}인가요, 오후 ${tm.h}시${mm}인가요?` }];
  }
  if (tm) {
    const dm = rrule ? null : parseDate(rest, now);
    const durM = rest.match(DUR_RE);
    let dur = 60;
    if (durM) { dur = durM[3] ? +durM[3] : (+durM[1] * 60 + (durM[2] ? 30 : 0)); if (!dur) dur = 60; }
    let title = rest;
    if (dm) title = title.replace(dm.span, " ");
    if (durM) title = title.replace(durM[0], " ");
    title = cleanText(title.replace(tm.span, " "));
    if (!hasWord(title)) return null;
    const start = makeStart(dm, now, tm.h, tm.min, rrule);
    const end = new Date(start.getTime() + dur * 60000);
    const ev = { kind: "event", title, start: isoLocal(start), end: isoLocal(end) };
    if (rrule) ev.rrule = rrule;
    return [ev];
  }

  // (C) 시각 없음 → 할 일. 날짜(까지/마감/안에 등)가 있으면 그 날이 마감.
  if (rrule) return null; // 반복 + 시각없음(반복 할일)은 미지원 → 재입력
  const dm = parseDate(rest, now);
  let title = rest;
  if (dm) title = title.replace(dm.span, " ");
  title = cleanText(title);
  if (!hasWord(title)) return null;
  return [{ kind: "task", title, due: dm ? fmtDate(dm.date) : null }];
}

// 여러 개(그리고/줄바꿈으로 구분)를 각각 파싱해 합친다.
function splitParts(text) {
  return text.split(/\s*그리고\s*|\n+/).map(s => s.trim()).filter(Boolean);
}
function parseAll(text, now) {
  const parts = splitParts(text);
  const items = [];
  for (const p of parts) {
    const r = parseSentence(p, now);
    if (!r) return [{ kind: "unparsed" }];
    if (r.some(x => x.kind === "question")) return r;
    items.push(...r);
  }
  return items.length ? items : [{ kind: "unparsed" }];
}

/**
 * 문장(과 되묻기 대화 내역)을 일정/할 일/질문/재입력요청 배열로 파싱한다.
 * history: [{role:"user"|"assistant", text}] — 오전/오후 되묻기 흐름 유지용.
 */
export async function parseText(text, history = [], now = new Date()) {
  if (history.length > 0) {
    // 되물음에 시간대만 답한 경우 → 원래 문장의 "N시" 앞에 그 시간대를 끼워 재해석
    const m = text.trim().match(/^(오전|오후|아침|점심|저녁|밤|새벽|낮)(?:이요|요|입니다|input)?[.!]?$/);
    const orig = history.find(h => h.role === "user")?.text;
    if (m && orig) {
      const merged = preprocess(orig).replace(
        new RegExp(`(?:${MARK})?\\s*(\\d{1,2}\\s*시)`),
        `${m[1]} $1`);
      const r = parseAll(merged, now);
      if (!r.some(x => x.kind === "unparsed" || x.kind === "question")) return r;
    }
    return [{ kind: "unparsed" }];
  }
  return parseAll(text, now);
}

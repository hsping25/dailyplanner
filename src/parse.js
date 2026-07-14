// 한국어 문장 → 구조화된 일정/할 일 파서. (정규식 전용, LLM/API 사용 안 함)
// 못 알아들으면 {kind:"unparsed"}를 돌려주고, 프론트가 "다시 말해 주세요"를 띄운다.
// parseText(text, history) 시그니처는 유지 — 나중에 다른 방식으로 갈아끼우기 쉽게.

const pad = n => String(n).padStart(2, "0");
const DAY = ["일", "월", "화", "수", "목", "금", "토"];
const WEEKDAY = { 월: "MO", 화: "TU", 수: "WE", 목: "TH", 금: "FR", 토: "SA", 일: "SU" };

function fmtDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ───────── 표현별 정규식 ─────────

const DATE_RE = /(오늘|내일|모레|(\d{1,2})\s*월\s*(\d{1,2})\s*일|(다음\s*주|담주|이번\s*주)?\s*([월화수목금토일])요일)/;
const TIME_RE = /(오전|오후|아침|점심|저녁|밤|새벽)?\s*(\d{1,2})\s*시(?:\s*(반|(\d{1,2})\s*분))?/;
const DUR_RE = /(?:(\d+)\s*시간\s*(반)?|(\d+)\s*분)\s*동안/;
const DUE_RE = /(오늘|내일|모레|(\d{1,2})\s*월\s*(\d{1,2})\s*일|(다음\s*주|담주|이번\s*주)?\s*([월화수목금토일])요일)\s*까지/;

function resolveDate(m, now) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const token = m[1];
  if (token === "오늘") return d;
  if (token === "내일") { d.setDate(d.getDate() + 1); return d; }
  if (token === "모레") { d.setDate(d.getDate() + 2); return d; }
  if (m[2]) { // N월 N일
    const r = new Date(now.getFullYear(), Number(m[2]) - 1, Number(m[3]));
    if (r < d) r.setFullYear(r.getFullYear() + 1); // 이미 지난 날짜면 내년
    return r;
  }
  // 요일
  const target = DAY.indexOf(m[5]);
  const mondayBased = x => (x + 6) % 7;
  const diffInWeek = mondayBased(target) - mondayBased(d.getDay());
  if (/다음\s*주|담주/.test(m[4] ?? "")) { d.setDate(d.getDate() + diffInWeek + 7); return d; }
  if (/이번\s*주/.test(m[4] ?? "")) { d.setDate(d.getDate() + diffInWeek); return d; }
  let diff = (target - d.getDay() + 7) % 7;
  if (diff === 0) diff = 7; // 수식어 없으면 "돌아오는 그 요일"
  d.setDate(d.getDate() + diff);
  return d;
}

function resolveTime(m) {
  const h = Number(m[2]);
  const min = m[3] === "반" ? 30 : (m[4] ? Number(m[4]) : 0);
  const marker = m[1];
  if (h >= 13 && h <= 23) return { h, min };            // 24시간제로 말한 경우
  if (/오후|저녁|밤/.test(marker ?? "")) return { h: h === 12 ? 12 : h + 12, min };
  if (/점심/.test(marker ?? "")) return { h: h <= 3 ? h + 12 : h, min };
  if (/오전|아침|새벽/.test(marker ?? "")) return { h: h === 12 ? 0 : h, min };
  return null; // 단서 없음 → 애매
}

// 반복 표현 감지 → RRULE 문자열과 걷어낼 구간(span)
function extractDays(cluster) {
  const chars = cluster.replace(/요일/g, " ").match(/[월화수목금토일]/g);
  if (!chars) return null;
  const seen = new Set(), out = [];
  for (const c of chars) {
    const b = WEEKDAY[c];
    if (b && !seen.has(b)) { seen.add(b); out.push(b); }
  }
  return out.length ? out.join(",") : null;
}

function parseRecur(t) {
  let m;
  if (m = t.match(/매일(?:마다)?/)) return { rrule: "FREQ=DAILY", span: m[0] };
  if (m = t.match(/평일(?:마다)?/)) return { rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", span: m[0] };
  if (m = t.match(/주말(?:마다)?/)) return { rrule: "FREQ=WEEKLY;BYDAY=SA,SU", span: m[0] };
  if (m = t.match(/매\s*(?:달|월)\s*(\d{1,2})\s*일(?:마다)?/))
    return { rrule: `FREQ=MONTHLY;BYMONTHDAY=${Number(m[1])}`, span: m[0] };
  // 매주/격주 + 요일들
  m = t.match(/(매주|격주)\s*((?:[월화수목금토일]\s*(?:요일)?\s*[,·]?\s*)+)(?:마다)?/);
  if (m) {
    const days = extractDays(m[2]);
    if (days) return { rrule: `FREQ=WEEKLY;BYDAY=${days}${m[1] === "격주" ? ";INTERVAL=2" : ""}`, span: m[0] };
  }
  // 요일들 + 마다
  m = t.match(/((?:[월화수목금토일]\s*(?:요일)?\s*[,·]?\s*)+)마다/);
  if (m) {
    const days = extractDays(m[1]);
    if (days) return { rrule: `FREQ=WEEKLY;BYDAY=${days}`, span: m[0] };
  }
  return null;
}

// ───────── 한 문장 파싱 ─────────
// 반환: 아이템 배열([{event}] / [{task}] / [{question}]) 또는 null(못 알아들음)
function parseSentence(text, now) {
  const t = text.trim();
  if (!t || t.length > 40) return null;

  // 1) "~까지" → 할 일
  if (/까지/.test(t)) {
    const dueM = t.match(DUE_RE);
    if (!dueM || TIME_RE.test(t.replace(dueM[0], ""))) return null;
    const title = t.replace(dueM[0], " ").replace(/\s+/g, " ").trim();
    if (!title || /까지/.test(title) || DATE_RE.test(title)) return null;
    return [{ kind: "task", title, due: fmtDate(resolveDate(dueM, now)) }];
  }

  // 2) 반복 감지 후 걷어내기
  const rec = parseRecur(t);
  const rrule = rec ? rec.rrule : null;
  const rest = rec ? t.replace(rec.span, " ") : t;

  // 3) 시간은 필수 (일정은 반드시 시각이 있어야)
  const timeM = rest.match(TIME_RE);
  if (!timeM) return null;

  const dateM = rrule ? null : rest.match(DATE_RE);

  // "~동안" 기간 (없으면 1시간)
  const durM = rest.match(DUR_RE);
  let durationMin = 60;
  if (durM) {
    durationMin = durM[3] ? Number(durM[3]) : Number(durM[1]) * 60 + (durM[2] ? 30 : 0);
    if (!durationMin) return null;
  }

  // 제목 = 나머지에서 날짜/시간/기간 표현 제거
  let title = rest;
  if (dateM) title = title.replace(dateM[0], " ");
  if (durM) title = title.replace(durM[0], " ");
  title = title.replace(timeM[0], " ")
    .replace(/(^|\s)(부터|에)(\s|$)/g, " ")
    .replace(/\s+/g, " ").trim();
  if (!title || TIME_RE.test(title) || DATE_RE.test(title)) return null;

  // 시간 확정 (애매하면 되묻기)
  const time = resolveTime(timeM);
  if (!time) {
    const h = Number(timeM[2]);
    const min = timeM[3] === "반" ? 30 : (timeM[4] ? Number(timeM[4]) : 0);
    const mm = min ? ` ${min}분` : "";
    return [{ kind: "question", ask: `오전 ${h}시${mm}인가요, 오후 ${h}시${mm}인가요?` }];
  }

  // 시작일 계산
  let baseDate;
  const monthly = rrule && rrule.match(/BYMONTHDAY=(\d+)/);
  if (monthly) baseDate = new Date(now.getFullYear(), now.getMonth(), Number(monthly[1]));
  else baseDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const start = new Date(dateM ? resolveDate(dateM, now) : baseDate);
  start.setHours(time.h, time.min, 0, 0);
  if (!dateM && !rrule && start < now) start.setDate(start.getDate() + 1); // 오늘 이미 지난 시각이면 내일
  const end = new Date(start.getTime() + durationMin * 60000);
  const iso = d => `${fmtDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

  const ev = { kind: "event", title, start: iso(start), end: iso(end) };
  if (rrule) ev.rrule = rrule;
  return [ev];
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
    if (!r) return [{ kind: "unparsed" }];          // 하나라도 못 풀면 전체 재입력
    if (r.some(x => x.kind === "question")) return r; // 애매하면 그 질문부터
    items.push(...r);
  }
  return items.length ? items : [{ kind: "unparsed" }];
}

/**
 * 문장(과 되묻기 대화 내역)을 일정/할 일/질문/재입력요청 배열로 파싱한다.
 * history: [{role:"user"|"assistant", text}] — 오전/오후 되묻기 흐름 유지용.
 */
export async function parseText(text, history = []) {
  const now = new Date();
  if (history.length > 0) {
    // 되물음에 "오전/오후"로만 답한 경우 → 원래 문장에 끼워 재해석
    const m = text.trim().match(/^(오전|오후)(?:이요|요|입니다)?[.!]?$/);
    const orig = history.find(h => h.role === "user")?.text;
    if (m && orig) {
      const merged = orig.replace(TIME_RE, s =>
        `${m[1]} ${s.replace(/^(오전|오후|아침|점심|저녁|밤|새벽)\s*/, "")}`);
      const r = parseAll(merged, now);
      if (!r.some(x => x.kind === "unparsed" || x.kind === "question")) return r;
    }
    return [{ kind: "unparsed" }];
  }
  return parseAll(text, now);
}

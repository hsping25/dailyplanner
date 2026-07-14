import rrulePkg from "rrule";
const { RRule } = rrulePkg;

// 로컬 시각 문자열("YYYY-MM-DDTHH:MM")과 rrule 라이브러리 사이의 변환.
// rrule은 내부적으로 UTC로 계산하므로, 로컬 시각을 UTC인 척 넣고(fakeUtc)
// 결과도 getUTC*로 읽어 로컬 시각으로 되돌린다(fromFakeUtc). 시간대 왜곡이 없다.
const pad = n => String(n).padStart(2, "0");

export function parseLocal(s) {
  const [date, time = "00:00"] = s.split("T");
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  return { y, m, d, hh, mm };
}

export function fmtLocal({ y, m, d, hh, mm }) {
  return `${y}-${pad(m)}-${pad(d)}T${pad(hh)}:${pad(mm)}`;
}

export function fmtDate({ y, m, d }) {
  return `${y}-${pad(m)}-${pad(d)}`;
}

const fakeUtc = ({ y, m, d, hh, mm }) => new Date(Date.UTC(y, m - 1, d, hh, mm));
const fromFakeUtc = dt => ({
  y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(),
  hh: dt.getUTCHours(), mm: dt.getUTCMinutes(),
});

// 로컬 시각 문자열끼리의 분 단위 차이 (일정 길이 계산용)
function minutesBetween(a, b) {
  return (fakeUtc(parseLocal(b)) - fakeUtc(parseLocal(a))) / 60000;
}

function addMinutes(parts, mins) {
  return fromFakeUtc(new Date(fakeUtc(parts).getTime() + mins * 60000));
}

/**
 * 이벤트(단발 또는 반복)를 [rangeStart, rangeEnd) 로컬 시각 범위로 펼친다.
 * exceptions: 이 이벤트의 예외 행 배열.
 * 반환: [{ eventId, title, start, end, recurring, occurrenceDate }]
 */
export function expandEvent(event, rangeStart, rangeEnd, exceptions = []) {
  const out = [];
  const exByDate = new Map(exceptions.map(x => [x.date, x]));

  const pushOccurrence = (startParts, endParts) => {
    const occDate = fmtDate(startParts);
    const ex = exByDate.get(occDate);
    if (ex?.kind === "skip") return;
    let title = event.title, start = fmtLocal(startParts), end = fmtLocal(endParts);
    if (ex?.kind === "override") {
      if (ex.title) title = ex.title;
      if (ex.start) start = ex.start;
      if (ex.end) end = ex.end;
    }
    if (start < rangeEnd && end > rangeStart) {
      out.push({
        eventId: event.id, title, start, end,
        recurring: !!event.rrule, occurrenceDate: occDate,
      });
    }
  };

  if (!event.rrule) {
    pushOccurrence(parseLocal(event.start), parseLocal(event.end));
    return out;
  }

  const durationMin = minutesBetween(event.start, event.end);
  const opts = RRule.parseString(event.rrule);
  opts.dtstart = fakeUtc(parseLocal(event.start));
  const rule = new RRule(opts);
  // 자정을 넘는 일정도 잡히도록 시작 범위를 하루 넓혀서 조회
  const from = new Date(fakeUtc(parseLocal(rangeStart)).getTime() - 86400000);
  const to = fakeUtc(parseLocal(rangeEnd));
  for (const dt of rule.between(from, to, true)) {
    const startParts = fromFakeUtc(dt);
    pushOccurrence(startParts, addMinutes(startParts, durationMin));
  }
  return out;
}

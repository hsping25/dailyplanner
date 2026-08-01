// "하루" 계산 공용 로직 — 서버와 브리핑 스크립트가 함께 쓴다.
import { all } from "./db.js";
import { expandEvent } from "./recur.js";

export const pad = n => String(n).padStart(2, "0");
export const dateStr = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// 하루의 경계는 오전 4시. "오늘"은 [오늘 04:00, 내일 04:00) 을 뜻한다.
export const DAY_BOUNDARY_HOUR = 4;

export function todayStr() {
  const now = new Date();
  if (now.getHours() < DAY_BOUNDARY_HOUR) now.setDate(now.getDate() - 1);
  return dateStr(now);
}

// 지금 시각을 저장 형식("YYYY-MM-DDTHH:MM")으로
export function nowStamp() {
  const d = new Date();
  return `${dateStr(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// date가 속한 주의 월요일 (주간 목표의 키)
export function weekStart(date) {
  const [y, m, d] = date.split("-").map(Number);
  return shiftDate(date, -((new Date(y, m - 1, d).getDay() + 6) % 7));
}

export function shiftDate(date, days) {
  const [y, m, d] = date.split("-").map(Number);
  return dateStr(new Date(y, m - 1, d + days));
}

export function dayWindow(date) {
  return {
    start: `${date}T${pad(DAY_BOUNDARY_HOUR)}:00`,
    end: `${shiftDate(date, 1)}T${pad(DAY_BOUNDARY_HOUR)}:00`,
  };
}

// 사용자의 이벤트 + 예외 + 완료체크를 한 번에 로드 (여러 날짜 창에 재사용해 DB 조회 절약)
export async function loadEvents(user = "기본") {
  // 세 쿼리는 서로 의존하지 않으므로 동시에 던진다. Postgres(Neon)에선 왕복 하나가 곧 지연이라
  // 순차로 await하면 3배로 기다리게 된다.
  const [events, exceptions, dones] = await Promise.all([
    all('SELECT * FROM events WHERE "user" = ?', [user]),
    all("SELECT * FROM event_exceptions", []),
    all("SELECT event_id, date FROM event_done", []),
  ]);
  const byEvent = new Map();
  for (const x of exceptions) {
    if (!byEvent.has(x.event_id)) byEvent.set(x.event_id, []);
    byEvent.get(x.event_id).push(x);
  }
  const doneByEvent = new Map();
  for (const dn of dones) {
    if (!doneByEvent.has(dn.event_id)) doneByEvent.set(dn.event_id, new Set());
    doneByEvent.get(dn.event_id).add(dn.date);
  }
  return { events, byEvent, doneByEvent };
}

// 로드된 이벤트를 특정 시간창으로 펼친다 (순수 계산, DB 접근 없음)
export function expand(loaded, start, end) {
  const out = [];
  for (const e of loaded.events) {
    out.push(...expandEvent(e, start, end, loaded.byEvent.get(e.id) ?? [], loaded.doneByEvent?.get(e.id) ?? null));
  }
  out.sort((a, b) => a.start.localeCompare(b.start));
  return out;
}

export async function eventsInWindow(start, end, user = "기본") {
  return expand(await loadEvents(user), start, end);
}

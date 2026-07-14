// "하루" 계산 공용 로직 — 서버와 브리핑 스크립트가 함께 쓴다.
import { db } from "./db.js";
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

export function eventsInWindow(start, end, user = "기본") {
  const events = db.prepare("SELECT * FROM events WHERE user = ?").all(user);
  const exceptions = db.prepare("SELECT * FROM event_exceptions").all();
  const byEvent = new Map();
  for (const x of exceptions) {
    if (!byEvent.has(x.event_id)) byEvent.set(x.event_id, []);
    byEvent.get(x.event_id).push(x);
  }
  const out = [];
  for (const e of events) {
    out.push(...expandEvent(e, start, end, byEvent.get(e.id) ?? []));
  }
  out.sort((a, b) => a.start.localeCompare(b.start));
  return out;
}

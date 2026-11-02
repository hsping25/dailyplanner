// 공부 세션 → 출석 → 연속 기록(🔥).
// 시작/완료 시각은 서버 시계(ms)로만 잰다 — 클라이언트가 보낸 시각은 믿지 않는다.
//
// 규칙
// - 유효 세션 = 시작~완료가 10분 이상. 완료는 10분이 지나야 받는다(그 전엔 취소만).
// - 완료할 때 공부한 내용 한 줄(5자 이상).
// - 출석 = 그날 유효 세션 3회, 또는 30분 이상 이어진 유효 세션 1회.
// - 세션의 날짜는 "시작 시각" 기준, 하루 경계는 오전 4시(03:59 시작 → 전날).
// - 진행 중인 세션이 있으면 새로 시작할 수 없다(DB의 부분 유니크 인덱스가 막는다).
// - 시작 후 6시간 안에 완료하지 않으면 미완료(expired).
// - 복구: 출석이 끊긴 다음 날 유효 세션 5회 → 3회는 그날 출석, 2회로 끊긴 날을 메운다. 한 달 1회.
import { get, all, run, insert } from "./db.js";
import { dateStr, shiftDate, todayStr, DAY_BOUNDARY_HOUR } from "./day.js";

export const MIN_MS = 10 * 60_000;        // 유효 세션 하한
export const LONG_MS = 30 * 60_000;       // 이 이상이면 1회로 출석
export const EXPIRE_MS = 6 * 3600_000;    // 이 안에 완료 안 하면 미완료
export const ATTEND_N = 3;                // 출석에 필요한 유효 세션 수
export const RECOVER_N = 5;               // 복구에 필요한 유효 세션 수(출석 3 + 복구 2)
export const NOTE_MIN = 5;                // 공부 내용 최소 글자 수

// 시작 시각(ms)이 속한 "하루" — 새벽 4시 전이면 전날
export function sessionDay(ms) {
  const d = new Date(ms);
  if (d.getHours() < DAY_BOUNDARY_HOUR) d.setDate(d.getDate() - 1);
  return dateStr(d);
}

export const isValidLength = ms => ms >= MIN_MS;
const noteOk = note => typeof note === "string" && [...note.trim()].length >= NOTE_MIN;

// 하루치 유효 세션 요약 {n, longest} → 출석 여부
export const attendedBy = r => !!r && (r.n >= ATTEND_N || r.longest >= LONG_MS);

export class AttendError extends Error {}

// ── 세션 ──

// 진행 중인 세션. 6시간이 지났으면 그 자리에서 미완료로 돌리고 null.
async function openSession(user, now) {
  const s = await get(`SELECT * FROM study_sessions WHERE "user" = ? AND status = 'open'`, [user]);
  if (!s) return null;
  if (now - Number(s.started_ms) >= EXPIRE_MS) {
    await run(`UPDATE study_sessions SET status = 'expired' WHERE id = ?`, [s.id]);
    return null;
  }
  return { ...s, started_ms: Number(s.started_ms) };
}

export async function startSession(user, now = Date.now()) {
  if (await openSession(user, now)) throw new AttendError("이미 진행 중인 세션이 있어요");
  try {
    const id = await insert(
      `INSERT INTO study_sessions ("user", date, started_ms, status) VALUES (?, ?, ?, 'open')`,
      [user, sessionDay(now), now]);
    return { id, date: sessionDay(now), started_ms: now };
  } catch {
    // 동시에 두 번 눌러 둘 다 위 검사를 통과해도 부분 유니크 인덱스가 하나만 받는다
    throw new AttendError("이미 진행 중인 세션이 있어요");
  }
}

export async function finishSession(user, id, note, now = Date.now()) {
  const s = await get(`SELECT * FROM study_sessions WHERE id = ? AND "user" = ?`, [id, user]);
  if (!s || s.status !== "open") throw new AttendError("진행 중인 세션이 아니에요");
  const len = now - Number(s.started_ms);
  if (len >= EXPIRE_MS) {
    await run(`UPDATE study_sessions SET status = 'expired' WHERE id = ?`, [id]);
    throw new AttendError("6시간이 지나 미완료 처리됐어요");
  }
  if (!isValidLength(len)) throw new AttendError("시작하고 10분이 지나야 완료할 수 있어요");
  if (!noteOk(note)) throw new AttendError(`공부한 내용을 ${NOTE_MIN}자 이상 적어 주세요`);
  const r = await run(
    `UPDATE study_sessions SET status = 'done', ended_ms = ?, note = ? WHERE id = ? AND status = 'open'`,
    [now, note.trim(), id]);
  if (!r.changes) throw new AttendError("진행 중인 세션이 아니에요");
  const recovered = await tryRecover(user, s.date);
  return { date: s.date, minutes: Math.floor(len / 60_000), recovered };
}

export async function cancelSession(user, id) {
  const r = await run(
    `UPDATE study_sessions SET status = 'canceled' WHERE id = ? AND "user" = ? AND status = 'open'`, [id, user]);
  if (!r.changes) throw new AttendError("진행 중인 세션이 아니에요");
}

// ── 출석/연속 ──

// date → {n, longest} (유효 세션만). 연속 계산용으로 최근 400일.
async function dailyValid(user, today) {
  const rows = await all(
    `SELECT date, COUNT(*) AS n, MAX(ended_ms - started_ms) AS longest FROM study_sessions
      WHERE "user" = ? AND status = 'done' AND ended_ms - started_ms >= ? AND date >= ? AND date <= ?
      GROUP BY date`,
    [user, MIN_MS, shiftDate(today, -400), today]);
  return new Map(rows.map(r => [r.date, { n: Number(r.n), longest: Number(r.longest) }]));
}

async function recoveredSet(user) {
  const rows = await all(`SELECT date, used_on FROM streak_recover WHERE "user" = ?`, [user]);
  return { dates: new Set(rows.map(r => r.date)), usedOn: rows.map(r => r.used_on) };
}

// 순수 계산: 출석한 날(복구 포함) 집합으로 연속 일수.
// 오늘은 아직 안 끝났으니, 오늘 출석 전이면 어제부터 센다.
export function countStreak(isOn, today) {
  let d = isOn(today) ? today : shiftDate(today, -1);
  let n = 0;
  while (isOn(d)) { n++; d = shiftDate(d, -1); }
  return n;
}

// 오늘(today) 복구할 수 있는 끊긴 날이 있나. 있으면 {missed, prev(끊기기 전 연속)}.
export function recoverTarget(isOn, today, usedOn) {
  const missed = shiftDate(today, -1);
  if (isOn(missed)) return null;                                  // 안 끊겼다
  if (!isOn(shiftDate(missed, -1))) return null;                 // 살릴 연속이 없다
  const prev = countStreak(isOn, shiftDate(missed, -1));
  if (usedOn.some(u => u.slice(0, 7) === today.slice(0, 7))) return null; // 이번 달 이미 씀
  return { missed, prev };
}

async function load(user, today) {
  const [byDate, rec] = await Promise.all([dailyValid(user, today), recoveredSet(user)]);
  const isOn = d => rec.dates.has(d) || attendedBy(byDate.get(d));
  return { byDate, rec, isOn };
}

// 세션 하나를 끝낼 때마다 — 그날이 "끊긴 다음 날"이고 유효 5회를 채웠으면 끊긴 날을 메운다
async function tryRecover(user, date) {
  const { byDate, rec, isOn } = await load(user, date);
  if ((byDate.get(date)?.n ?? 0) < RECOVER_N) return null;
  const t = recoverTarget(isOn, date, rec.usedOn);
  if (!t) return null;
  const r = await run(
    `INSERT INTO streak_recover ("user", date, used_on) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
    [user, t.missed, date]);
  return r.changes ? t.missed : null;
}

export async function streak(user, today = todayStr()) {
  const { isOn } = await load(user, today);
  return countStreak(isOn, today);
}

// 메인 화면용 한 묶음: 오늘 진행(2/3회) + 진행 중 세션 + 연속 + 복구 가능 여부
export async function attendStatus(user, now = Date.now()) {
  const today = sessionDay(now);
  const [{ byDate, rec, isOn }, open] = await Promise.all([load(user, today), openSession(user, now)]);
  const r = byDate.get(today) ?? { n: 0, longest: 0 };
  const attended = attendedBy(r);
  // 출석을 채운 뒤에도 5회까지는 복구할 수 있으니 출석 여부와 상관없이 알려 준다
  const target = recoverTarget(isOn, today, rec.usedOn);
  return {
    date: today,
    count: r.n,
    need: ATTEND_N,
    attended,
    streak: countStreak(isOn, today),
    open: open ? { id: open.id, started_ms: open.started_ms } : null,
    recover: target ? { missed: target.missed, prev: target.prev, need: RECOVER_N } : null,
    serverNow: now,
  };
}

// 밤 알림 문구. 출석을 채웠으면 null(보내지 않음).
export function nightMessage(st) {
  if (st.attended) return null;
  const left = Math.max(1, st.need - st.count);
  if (st.streak > 0) return `📚 오늘 ${left}회만 더 하면 ${st.streak + 1}일째 유지`;
  if (st.recover) {
    const l5 = Math.max(1, st.recover.need - st.count);
    return `📚 오늘 ${l5}회 더 하면 끊긴 연속 기록을 살려 ${st.recover.prev + 2}일째가 돼요 (한 달 1회)`;
  }
  return `📚 오늘 ${left}회 하면 출석 — 새 연속 기록을 시작해요`;
}

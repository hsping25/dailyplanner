// 하루 성적 계산과 "하루 닫기" — 앱과 텔레그램이 같은 로직을 쓴다.
//
// 달성률의 분모(planned)에 들어가는 것:
//   - 그날 일정 회차(종일 포함)
//   - 그날 마감인 할 일
//   - 그날 핵심(star_date)으로 뽑은 할 일
//   같은 할 일이 마감+핵심이면 한 번만 센다. 버린 것(archived)은 분모에서 뺀다.
//
// "버림"만 분모에서 빼는 이유: 버림은 "이건 애초에 계획이 잘못됐다"는 인정이라
// 계획에서 지우는 게 맞고, 이월(내일로)은 미룬 것이니 그날은 미완료로 남겨야
// 숫자가 정직해진다. 이렇게 해야 밀린 목록을 정리할 동기가 생긴다.
import { get, all, run } from "./db.js";
import { dayWindow, shiftDate, weekStart, todayStr, nowStamp, loadEvents, expand } from "./day.js";

// 그날 계획에 잡힌 할 일 (마감이 그날 + 그날 핵심, 버린 건 제외)
export async function tasksForDate(user, date) {
  return all(
    `SELECT * FROM tasks WHERE "user" = ? AND archived = 0 AND (due = ? OR star_date = ?)
     ORDER BY star_date IS NULL, plan_at IS NULL, plan_at, id`,
    [user, date, date]);
}

// 한 날의 성적. loaded를 넘기면 이벤트를 다시 읽지 않는다(주간 계산에서 재사용).
export async function dayScore(user, date, loaded) {
  if (!loaded) loaded = await loadEvents(user);
  const { start, end } = dayWindow(date);
  const events = expand(loaded, start, end);
  const tasks = await tasksForDate(user, date);

  const stars = tasks.filter(t => t.star_date === date);
  return {
    date,
    planned: events.length + tasks.length,
    done: events.filter(e => e.done).length + tasks.filter(t => t.done).length,
    starPlanned: stars.length,
    starDone: stars.filter(t => t.done).length,
    events, tasks,
  };
}

// 아직 안 끝난 것들 (하루 닫기 화면에 올릴 목록)
export function leftovers(score) {
  return {
    tasks: score.tasks.filter(t => !t.done),
    events: score.events.filter(e => !e.done),
  };
}

export function ratio(planned, done) {
  return planned ? Math.round((done / planned) * 100) : null;
}

// ── 미완료 항목 처리 ──
// actions: [{ id, action }] — tomorrow(내일로) | week(이번 주 안에) | drop(버림) | keep(그대로)
export async function applyActions(user, date, actions = []) {
  const tomorrow = shiftDate(date, 1);
  // 내일 핵심이 이미 몇 개인지 — 이월하면서 3칸을 넘기지 않도록
  let starRoom = 3 - Number(
    (await get('SELECT COUNT(*) AS c FROM tasks WHERE "user" = ? AND archived = 0 AND star_date = ?',
      [user, tomorrow]))?.c ?? 0);

  for (const { id, action } of actions) {
    const t = await get('SELECT * FROM tasks WHERE id = ? AND "user" = ?', [id, user]);
    if (!t) continue;
    if (action === "drop") {
      await run('UPDATE tasks SET archived = 1, star_date = NULL WHERE id = ? AND "user" = ?', [id, user]);
    } else if (action === "tomorrow") {
      // 오늘 핵심이었으면 내일도 핵심으로 (내일 칸이 남아 있을 때만)
      const keepStar = t.star_date === date && starRoom > 0;
      if (keepStar) starRoom--;
      await run('UPDATE tasks SET due = ?, star_date = ?, plan_at = NULL WHERE id = ? AND "user" = ?',
        [tomorrow, keepStar ? tomorrow : null, id, user]);
    } else if (action === "week") {
      // 다가오는 일요일까지 (오늘이 일요일이면 다음 주 일요일)
      const sunday = shiftDate(weekStart(date), date === shiftDate(weekStart(date), 6) ? 13 : 6);
      await run('UPDATE tasks SET due = ?, star_date = NULL, plan_at = NULL WHERE id = ? AND "user" = ?',
        [sunday, id, user]);
    }
  }
}

// ── 하루 닫기 ── 미완료를 처리하고, 그 시점의 성적 + 회고를 day_log에 남긴다.
// base(= {planned, starPlanned})를 주면 그 값을 분모의 출발점으로 삼는다.
// 텔레그램 회고처럼 항목을 하나씩 먼저 처리한 뒤에 닫는 경우, 이미 옮겨진 것들이
// 분모에서 빠져 버리므로 메시지를 보낸 시점의 계획 개수를 넘겨받아야 한다.
export async function closeDay(user, date, { note = null, mood = null, actions = [], base = null } = {}) {
  // 성적은 "정리하기 전"을 기준으로 잡는다. 내일로 미룬 것은 오늘 분모에 그대로 남아야
  // 이월이 곧 100%가 되는 구멍이 생기지 않는다. 버린 것만 분모에서 뺀다.
  const before = await dayScore(user, date);
  const dropped = new Set(actions.filter(a => a.action === "drop").map(a => Number(a.id)));
  const droppedTasks = before.tasks.filter(t => dropped.has(t.id) && !t.done);

  await applyActions(user, date, actions);
  const after = await dayScore(user, date);   // 완료 개수는 지금 값을 쓴다(그 사이 체크했을 수 있으니)

  const planned = (base?.planned ?? before.planned) - droppedTasks.length;
  const starPlanned = (base?.starPlanned ?? before.starPlanned)
    - droppedTasks.filter(t => t.star_date === date).length;
  const s = {
    date,
    planned: Math.max(0, planned),
    done: Math.min(after.done, Math.max(0, planned)),
    starPlanned: Math.max(0, starPlanned),
    starDone: Math.min(after.starDone, Math.max(0, starPlanned)),
  };
  await run(`INSERT INTO day_log ("user", date, planned, done, star_planned, star_done, note, mood, closed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT ("user", date) DO UPDATE SET planned=EXCLUDED.planned, done=EXCLUDED.done,
      star_planned=EXCLUDED.star_planned, star_done=EXCLUDED.star_done,
      note=EXCLUDED.note, mood=EXCLUDED.mood, closed_at=EXCLUDED.closed_at`,
    [user, date, s.planned, s.done, s.starPlanned, s.starDone, note, mood, nowStamp()]);

  return s;
}

export async function dayLog(user, date) {
  return (await get('SELECT * FROM day_log WHERE "user" = ? AND date = ?', [user, date])) ?? null;
}

// 주간(또는 임의 구간) 성적. 닫은 날은 저장된 스냅샷을, 안 닫은 날은 지금 계산값을 쓴다.
export async function scoresBetween(user, from, to, loaded) {
  if (!loaded) loaded = await loadEvents(user);
  const logs = new Map(
    (await all('SELECT * FROM day_log WHERE "user" = ? AND date >= ? AND date <= ?', [user, from, to]))
      .map(r => [r.date, r]));
  const out = [];
  for (let d = from; d <= to; d = shiftDate(d, 1)) {
    const lg = logs.get(d);
    if (lg?.closed_at) {
      out.push({
        date: d, planned: lg.planned, done: lg.done,
        starPlanned: lg.star_planned, starDone: lg.star_done,
        closed: true, note: lg.note, mood: lg.mood,
      });
    } else {
      const s = await dayScore(user, d, loaded);
      out.push({
        date: d, planned: s.planned, done: s.done,
        starPlanned: s.starPlanned, starDone: s.starDone,
        closed: false, note: lg?.note ?? null, mood: lg?.mood ?? null,
      });
    }
  }
  return out;
}

// 연속 기록: 오늘(또는 어제)부터 거슬러 올라가며 "닫았고 절반 이상 해낸 날"이 며칠 이어졌나.
// 오늘은 아직 안 닫았을 수 있으니 어제부터 세되, 오늘 이미 닫았으면 오늘부터 센다.
export async function streak(user, today = todayStr()) {
  const rows = await all(
    'SELECT date, planned, done FROM day_log WHERE "user" = ? AND closed_at IS NOT NULL AND date <= ? ORDER BY date DESC LIMIT 400',
    [user, today]);
  const byDate = new Map(rows.map(r => [r.date, r]));
  let d = byDate.has(today) ? today : shiftDate(today, -1);
  let n = 0;
  while (byDate.has(d)) {
    const r = byDate.get(d);
    if (!(r.planned > 0 && r.done * 2 >= r.planned)) break;
    n++;
    d = shiftDate(d, -1);
  }
  return n;
}

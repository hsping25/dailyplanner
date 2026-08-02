// 하루 성적 계산과 "하루 닫기" — 앱과 텔레그램이 같은 로직을 쓴다.
//
// 달성률의 분모(planned)에 들어가는 것:
//   - 그날 일정 회차(종일 포함)
//   - 그날 마감인 할 일
//   - 그날 핵심(star_date)으로 뽑은 할 일
//   같은 할 일이 마감+핵심이면 한 번만 센다.
//
// **버린 것(archived)도 분모에 남는다.** 목록에서는 치우되 그날 계획에는 있었던 것이므로,
// 안 하고 버린 걸 없던 일로 치면 동그라미가 꽉 차서 숫자가 거짓말을 한다.
// 이월(내일로)도 마찬가지로 그날은 미완료. 분자(done)에 들어가는 건 실제로 해낸 것뿐이다.
// 버린 개수는 따로(dropped) 세어 "5개 중 2개 완료 · 1개 버림"처럼 보여 준다.
import { get, all, run } from "./db.js";
import { dayWindow, shiftDate, weekStart, todayStr, nowStamp, loadEvents, expand } from "./day.js";

// 그날 계획에 잡힌 할 일 (마감이 그날 + 그날 핵심).
// **버린 것도 포함**해서 돌려준다 — 분모에 남아야 하므로. 목록에 뿌릴 때만 archived를 거른다.
export async function tasksForDate(user, date) {
  return all(
    `SELECT * FROM tasks WHERE "user" = ? AND (due = ? OR star_date = ?)
     ORDER BY star_date IS NULL, plan_at IS NULL, plan_at, id`,
    [user, date, date]);
}

// 구간(주간)의 할 일을 **한 번의 쿼리로** 읽어 날짜별로 묶는다.
// 하루씩 tasksForDate를 부르면 왕복이 날짜 수만큼 늘어나 날짜 이동이 눈에 띄게 느려진다.
// 마감일과 핵심일이 다르면 두 날짜 모두에 들어가고, 같으면 Map이라 한 번만 센다.
export async function tasksByDateInRange(user, from, to) {
  const rows = await all(
    `SELECT * FROM tasks WHERE "user" = ?
       AND ((due >= ? AND due <= ?) OR (star_date >= ? AND star_date <= ?))`,
    [user, from, to, from, to]);
  const byDate = new Map();
  const put = (d, t) => {
    if (!d || d < from || d > to) return;
    if (!byDate.has(d)) byDate.set(d, new Map());
    byDate.get(d).set(t.id, t);
  };
  for (const t of rows) { put(t.due, t); put(t.star_date, t); }
  return byDate;
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
    planned: events.length + tasks.length,          // 버린 것 포함 (계획에는 있었으니까)
    done: events.filter(e => e.done).length + tasks.filter(t => t.done).length,
    dropped: tasks.filter(t => t.archived && !t.done).length,
    starPlanned: stars.length,
    starDone: stars.filter(t => t.done).length,
    events, tasks,
  };
}

// 아직 안 끝난 것들 (하루 닫기 화면에 올릴 목록). 이미 버린 건 다시 묻지 않는다.
export function leftovers(score) {
  return {
    tasks: score.tasks.filter(t => !t.done && !t.archived),
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
      // due/star_date는 그대로 둔다 — 그날 계획이었다는 사실이 남아야 분모에 계속 잡힌다.
      // 목록/주간 점에서는 archived로 걸러지므로 화면은 깨끗해진다.
      await run('UPDATE tasks SET archived = 1 WHERE id = ? AND "user" = ?', [id, user]);
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
// base(= {planned, starPlanned})를 주면 그 값을 분모의 최소치로 삼는다.
// 텔레그램 회고처럼 항목을 하나씩 먼저 처리한 뒤에 닫는 경우, 이미 내일로 옮겨진 것들이
// 분모에서 빠져 버리므로 메시지를 보낸 시점의 계획 개수를 넘겨받아야 한다.
export async function closeDay(user, date, { note = null, mood = null, actions = [], base = null } = {}) {
  const [before, prev] = await Promise.all([
    dayScore(user, date),      // 정리하기 전 = 그날 진짜 계획했던 양
    dayLog(user, date),        // 이미 닫았던 날이면 그때 기록한 분모
  ]);
  await applyActions(user, date, actions);
  const s = await dayScore(user, date);

  // 분모는 넷 중 가장 큰 값. 이월한 것은 다른 날짜로 옮겨 가 s에서 빠지므로 before가 받쳐 주고,
  // 텔레그램 회고처럼 항목을 미리 하나씩 옮긴 경우엔 메시지 보낸 시점의 base가,
  // 다시 닫는 경우엔 지난번 기록(prev)이 받쳐 준다. 한번 계획한 양은 줄어들지 않는다.
  // 버린 것은 날짜를 그대로 두므로 s.planned에 이미 들어 있다.
  const planned = Math.max(s.planned, before.planned, base?.planned ?? 0, prev?.planned ?? 0);
  const starPlanned = Math.max(s.starPlanned, before.starPlanned, base?.starPlanned ?? 0, prev?.star_planned ?? 0);
  const snap = {
    date, planned, starPlanned,
    done: Math.min(s.done, planned),
    dropped: s.dropped,
    starDone: Math.min(s.starDone, starPlanned),
  };
  await run(`INSERT INTO day_log ("user", date, planned, done, dropped, star_planned, star_done, note, mood, closed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT ("user", date) DO UPDATE SET planned=EXCLUDED.planned, done=EXCLUDED.done,
      dropped=EXCLUDED.dropped, star_planned=EXCLUDED.star_planned, star_done=EXCLUDED.star_done,
      note=EXCLUDED.note, mood=EXCLUDED.mood, closed_at=EXCLUDED.closed_at`,
    [user, date, snap.planned, snap.done, snap.dropped, snap.starPlanned, snap.starDone, note, mood, nowStamp()]);

  return snap;
}

export async function dayLog(user, date) {
  return (await get('SELECT * FROM day_log WHERE "user" = ? AND date = ?', [user, date])) ?? null;
}

// 주간(또는 임의 구간) 성적. 닫은 날은 저장된 스냅샷을, 안 닫은 날은 지금 계산값을 쓴다.
// DB는 두 번만 읽는다(day_log 한 번, 할 일 한 번). 나머지는 전부 메모리 계산.
// byDay를 넘기면 그 날짜의 이벤트 펼치기를 재사용한다(주간 시간표와 중복 계산 방지).
export async function scoresBetween(user, from, to, loaded, byDay = null) {
  const [logRows, tasksByDate] = await Promise.all([
    all('SELECT * FROM day_log WHERE "user" = ? AND date >= ? AND date <= ?', [user, from, to]),
    tasksByDateInRange(user, from, to),
  ]);
  if (!loaded && !byDay) loaded = await loadEvents(user);
  const logs = new Map(logRows.map(r => [r.date, r]));

  const out = [];
  for (let d = from; d <= to; d = shiftDate(d, 1)) {
    const lg = logs.get(d);
    if (lg?.closed_at) {
      out.push({
        date: d, planned: lg.planned, done: lg.done, dropped: lg.dropped ?? 0,
        starPlanned: lg.star_planned, starDone: lg.star_done,
        closed: true, note: lg.note, mood: lg.mood,
      });
      continue;
    }
    const w = dayWindow(d);
    const events = byDay?.get(d) ?? expand(loaded, w.start, w.end);
    const tasks = [...(tasksByDate.get(d)?.values() ?? [])];
    const stars = tasks.filter(t => t.star_date === d);
    out.push({
      date: d,
      planned: events.length + tasks.length,          // 버린 것 포함
      done: events.filter(e => e.done).length + tasks.filter(t => t.done).length,
      dropped: tasks.filter(t => t.archived && !t.done).length,
      starPlanned: stars.length,
      starDone: stars.filter(t => t.done).length,
      closed: false, note: lg?.note ?? null, mood: lg?.mood ?? null,
    });
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

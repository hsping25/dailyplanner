import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { get, all, run, insert, initDb } from "./db.js";
import { parseText } from "./parse.js";
import { todayStr, shiftDate, weekStart, nowStamp, dayWindow, eventsInWindow, loadEvents, expand } from "./day.js";
import { dayScore, closeDay, dayLog, scoresBetween, streak } from "./review.js";
import { startNotifier } from "./notify.js";
import { startSchedules } from "./schedule.js";
import { getBotUsername } from "./telegram.js";
import { linkCode, linkStatus, unlink, startTgPoller } from "./tglink.js";

const app = express();
app.use(express.json({ limit: "5mb" })); // 그림 메모(PNG 데이터 URL)가 기본 100kb를 넘을 수 있음

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
app.use(express.static(path.join(root, "public")));

// async 라우트 핸들러 래퍼 (에러를 500으로)
const ah = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => {
  console.error(e);
  if (!res.headersSent) res.status(500).json({ error: e.message });
});

// UptimeRobot 등이 주기적으로 깨우는 헬스 체크 (서버가 잠들지 않게)
app.get("/healthz", (req, res) => res.type("text").send("ok"));

// 요청한 아이디 (X-User 헤더 우선, 없으면 ?user=, 그래도 없으면 '기본')
// 헤더는 ASCII만 담을 수 있어 클라이언트가 encodeURIComponent로 보낸다 → 여기서 되돌린다.
const userOf = req => {
  const h = req.get("x-user");
  let v = req.query.user || "기본";
  if (h) { try { v = decodeURIComponent(h); } catch { v = h; } }
  return v.trim() || "기본";
};

// ── 읽기 화면용: 그날의 일정 + 할 일 + 주간 점 개수 ──
app.get("/api/day", ah(async (req, res) => {
  const user = userOf(req);
  const date = req.query.date || todayStr();
  const { start, end } = dayWindow(date);

  const monday = weekStart(date);
  const sunday = shiftDate(monday, 6);

  // 이벤트는 한 번만 로드하고, 7일치 펼치기도 한 번만 해서 주간 점·성적·그날 목록이 함께 쓴다.
  // 나머지 조회는 서로 의존하지 않으므로 동시에 던진다 — Neon Postgres에선 왕복 하나가 곧 지연이라
  // 순차로 await하면 날짜를 넘길 때마다 그만큼 기다리게 된다.
  const loaded = await loadEvents(user);
  const byDay = expandWeek(loaded, monday);
  const [tasks, week, scores, log, st, goals] = await Promise.all([
    // 버린 것(archived)은 안 보인다. 핵심(star_date)은 마감이 없어도 그날 목록에 올라온다.
    all(`SELECT * FROM tasks WHERE "user" = ? AND archived = 0
           AND (done = 0 OR due = ? OR star_date = ?)
         ORDER BY CASE WHEN star_date = ? THEN 0 ELSE 1 END, due IS NULL, due, id`,
      [user, date, date, date]),
    weekFor(monday, sunday, user, byDay),
    scoresBetween(user, monday, sunday, loaded, byDay),
    dayLog(user, date),
    streak(user),
    all('SELECT * FROM goals WHERE "user" = ? AND week = ? ORDER BY id', [user, monday]),
  ]);

  res.json({
    date,
    events: byDay.get(date) ?? expand(loaded, start, end),
    tasks, week, scores, log, streak: st, goals,
  });
}));

// 월요일부터 7일치를 한 번에 펼쳐 date → 일정 배열로 (순수 계산, DB 접근 없음)
function expandWeek(loaded, monday) {
  const byDay = new Map();
  for (let i = 0; i < 7; i++) {
    const d = shiftDate(monday, i);
    const w = dayWindow(d);
    byDay.set(d, expand(loaded, w.start, w.end));
  }
  return byDay;
}

// ── 하루 닫기(회고) ──
app.get("/api/review", ah(async (req, res) => {
  const user = userOf(req);
  const date = req.query.date || todayStr();
  const [s, log, st] = await Promise.all([dayScore(user, date), dayLog(user, date), streak(user)]);
  res.json({
    date, planned: s.planned, done: s.done, starPlanned: s.starPlanned, starDone: s.starDone,
    events: s.events, tasks: s.tasks, log, streak: st,
  });
}));

app.post("/api/review", ah(async (req, res) => {
  const user = userOf(req);
  const { date = todayStr(), note = null, mood = null, actions = [] } = req.body ?? {};
  const s = await closeDay(user, date, {
    note: typeof note === "string" && note.trim() ? note.trim() : null,
    mood: mood == null ? null : Math.max(1, Math.min(5, Number(mood))),
    actions: Array.isArray(actions) ? actions : [],
  });
  res.json({ ok: true, planned: s.planned, done: s.done, streak: await streak(user) });
}));

// 임의 구간 성적 (기본: 이번 주)
app.get("/api/scores", ah(async (req, res) => {
  const user = userOf(req);
  const to = req.query.to || todayStr();
  const from = req.query.from || weekStart(to);
  const [scores, st] = await Promise.all([scoresBetween(user, from, to), streak(user)]);
  res.json({ scores, streak: st });
}));

// ── 주간 목표 (한 주 최대 3개) ──
app.get("/api/goals", ah(async (req, res) => {
  const week = weekStart(req.query.date || todayStr());
  res.json({ week, goals: await all('SELECT * FROM goals WHERE "user" = ? AND week = ? ORDER BY id', [userOf(req), week]) });
}));

app.post("/api/goals", ah(async (req, res) => {
  const user = userOf(req);
  const { title, date = todayStr() } = req.body ?? {};
  if (!title?.trim()) return res.status(400).json({ error: "title은 필수" });
  const week = weekStart(date);
  const n = Number((await get('SELECT COUNT(*) AS c FROM goals WHERE "user" = ? AND week = ?', [user, week]))?.c ?? 0);
  if (n >= 3) return res.status(400).json({ error: "이번 주 목표는 3개까지예요" });
  res.json({ id: await insert('INSERT INTO goals ("user", week, title) VALUES (?, ?, ?)', [user, week, title.trim()]) });
}));

app.patch("/api/goals/:id", ah(async (req, res) => {
  const user = userOf(req);
  const cur = await get('SELECT * FROM goals WHERE id = ? AND "user" = ?', [req.params.id, user]);
  if (!cur) return res.status(404).json({ error: "없는 목표" });
  await run('UPDATE goals SET title = ?, done = ? WHERE id = ? AND "user" = ?', [
    req.body?.title?.trim() || cur.title,
    "done" in (req.body ?? {}) ? (req.body.done ? 1 : 0) : cur.done,
    req.params.id, user]);
  res.json({ ok: true });
}));

app.delete("/api/goals/:id", ah(async (req, res) => {
  await run('DELETE FROM goals WHERE id = ? AND "user" = ?', [req.params.id, userOf(req)]);
  res.json({ ok: true });
}));

// 그 주의 요일별 일정 + 안 끝난 할 일 목록 (점 개수와 팝업에 사용).
// 펼치기는 호출자가 준 byDay를 그대로 쓰고, 주간 할 일만 한 번 조회한다.
async function weekFor(monday, sunday, user, byDay) {
  const weekTasks = await all(
    'SELECT title, due FROM tasks WHERE "user" = ? AND archived = 0 AND done = 0 AND due >= ? AND due <= ?',
    [user, monday, sunday]);
  const tasksByDate = new Map();
  for (const t of weekTasks) {
    if (!tasksByDate.has(t.due)) tasksByDate.set(t.due, []);
    tasksByDate.get(t.due).push(t);
  }

  const week = [];
  for (let i = 0; i < 7; i++) {
    const dayDate = shiftDate(monday, i);
    const items = (byDay.get(dayDate) ?? []).map(e => ({
      kind: "event", title: e.title, start: e.start, end: e.end,
      recurring: e.recurring, eventId: e.eventId, occurrenceDate: e.occurrenceDate,
      allday: e.allday, done: e.done,
    }));
    for (const t of tasksByDate.get(dayDate) ?? []) items.push({ kind: "task", title: t.title });
    week.push({ date: dayDate, items });
  }
  return week;
}

// 주간 이동용
app.get("/api/week", ah(async (req, res) => {
  const user = userOf(req);
  const monday = weekStart(req.query.date || todayStr());
  const byDay = expandWeek(await loadEvents(user), monday);
  res.json({ week: await weekFor(monday, shiftDate(monday, 6), user, byDay) });
}));

// 등록 전 겹침 확인
app.get("/api/conflicts", ah(async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: "start, end는 필수" });
  res.json({ conflicts: await eventsInWindow(start, end, userOf(req)) });
}));

// ── 텔레그램 알림 연결 (아이디별) ──
app.post("/api/telegram/link", ah(async (req, res) => {
  const bot = await getBotUsername();
  if (!bot) return res.status(400).json({ error: "봇 토큰이 설정되지 않았어요. .env의 TELEGRAM_BOT_TOKEN을 확인하세요." });
  const code = await linkCode(userOf(req));
  res.json({ url: `https://t.me/${bot}?start=${code}`, bot, code });
}));
app.get("/api/telegram/status", ah(async (req, res) => {
  res.json({ linked: !!(await linkStatus(userOf(req))) });
}));
app.post("/api/telegram/unlink", ah(async (req, res) => {
  await unlink(userOf(req));
  res.json({ ok: true });
}));

// ── 자연어 파싱 ──
app.post("/api/parse", ah(async (req, res) => {
  const { text, history = [] } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: "text는 필수" });
  res.json({ items: await parseText(text.trim(), history) });
}));

// ── 일정 CRUD (모두 요청 아이디로 범위 제한) ──
app.post("/api/events", ah(async (req, res) => {
  const { title, start, end, rrule = null, allday = 0 } = req.body;
  if (!title || !start || !end) return res.status(400).json({ error: "title, start, end는 필수" });
  const id = await insert(
    'INSERT INTO events ("user", title, start, "end", rrule, allday) VALUES (?, ?, ?, ?, ?, ?)',
    [userOf(req), title, start, end, rrule, allday ? 1 : 0]);
  res.json({ id });
}));

app.get("/api/events/:id", ah(async (req, res) => {
  const row = await get('SELECT * FROM events WHERE id = ? AND "user" = ?', [req.params.id, userOf(req)]);
  if (!row) return res.status(404).json({ error: "없는 일정" });
  res.json(row);
}));

app.put("/api/events/:id", ah(async (req, res) => {
  const { title, start, end, rrule = null, allday = 0 } = req.body;
  if (!title || !start || !end) return res.status(400).json({ error: "title, start, end는 필수" });
  const r = await run(
    'UPDATE events SET title = ?, start = ?, "end" = ?, rrule = ?, allday = ? WHERE id = ? AND "user" = ?',
    [title, start, end, rrule, allday ? 1 : 0, req.params.id, userOf(req)]);
  if (r.changes === 0) return res.status(404).json({ error: "없는 일정" });
  res.json({ ok: true });
}));

app.delete("/api/events/:id", ah(async (req, res) => {
  const r = await run('DELETE FROM events WHERE id = ? AND "user" = ?', [req.params.id, userOf(req)]);
  if (r.changes) {
    await run("DELETE FROM event_exceptions WHERE event_id = ?", [req.params.id]);
    await run("DELETE FROM event_done WHERE event_id = ?", [req.params.id]);
  }
  res.json({ ok: true });
}));

// 일정 완료 체크 토글 (반복은 회차 date별). body: { date, done }
app.post("/api/events/:id/done", ah(async (req, res) => {
  const { date, done } = req.body;
  if (!date) return res.status(400).json({ error: "date는 필수" });
  const owns = await get('SELECT 1 FROM events WHERE id = ? AND "user" = ?', [req.params.id, userOf(req)]);
  if (!owns) return res.status(404).json({ error: "없는 일정" });
  if (done) {
    await run(`INSERT INTO event_done (event_id, date) VALUES (?, ?)
      ON CONFLICT (event_id, date) DO NOTHING`, [req.params.id, date]);
  } else {
    await run("DELETE FROM event_done WHERE event_id = ? AND date = ?", [req.params.id, date]);
  }
  res.json({ ok: true });
}));

// 반복 일정 예외: 특정 날짜 건너뛰기 또는 그 회차만 수정
app.post("/api/events/:id/exceptions", ah(async (req, res) => {
  const { date, kind, title = null, start = null, end = null } = req.body;
  if (!date || !["skip", "override"].includes(kind)) {
    return res.status(400).json({ error: "date와 kind(skip|override)는 필수" });
  }
  const owns = await get('SELECT 1 FROM events WHERE id = ? AND "user" = ?', [req.params.id, userOf(req)]);
  if (!owns) return res.status(404).json({ error: "없는 일정" });
  await run(
    `INSERT INTO event_exceptions (event_id, date, kind, title, start, "end")
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (event_id, date) DO UPDATE SET kind=EXCLUDED.kind,
       title=EXCLUDED.title, start=EXCLUDED.start, "end"=EXCLUDED."end"`,
    [req.params.id, date, kind, title, start, end]);
  res.json({ ok: true });
}));

// ── 할 일 CRUD ──
app.post("/api/tasks", ah(async (req, res) => {
  const { title, due = null } = req.body;
  if (!title) return res.status(400).json({ error: "title은 필수" });
  const id = await insert('INSERT INTO tasks ("user", title, due) VALUES (?, ?, ?)', [userOf(req), title, due]);
  res.json({ id });
}));

app.patch("/api/tasks/:id", ah(async (req, res) => {
  const user = userOf(req);
  const cur = await get('SELECT * FROM tasks WHERE id = ? AND "user" = ?', [req.params.id, user]);
  if (!cur) return res.status(404).json({ error: "없는 할 일" });
  const b = req.body ?? {};
  const title = b.title ?? cur.title;
  const due = "due" in b ? b.due : cur.due;
  const done = "done" in b ? (b.done ? 1 : 0) : cur.done;
  const planAt = "plan_at" in b ? (b.plan_at || null) : cur.plan_at;
  const archived = "archived" in b ? (b.archived ? 1 : 0) : cur.archived;
  // 완료로 바뀌는 순간의 시각을 남긴다(되돌리면 지운다) — 나중에 "언제 해냈나"를 볼 수 있게
  const doneAt = done ? (cur.done ? cur.done_at : nowStamp()) : null;
  await run(`UPDATE tasks SET title = ?, due = ?, done = ?, done_at = ?, plan_at = ?, archived = ?
    WHERE id = ? AND "user" = ?`,
    [title, due, done, doneAt, planAt, archived, req.params.id, user]);
  res.json({ ok: true });
}));

// 오늘의 핵심 3개 지정/해제. body: { date, star }  — 3개를 넘기면 거절한다(제한이 우선순위를 만든다)
app.post("/api/tasks/:id/star", ah(async (req, res) => {
  const user = userOf(req);
  const { date = todayStr(), star = true } = req.body ?? {};
  const cur = await get('SELECT * FROM tasks WHERE id = ? AND "user" = ?', [req.params.id, user]);
  if (!cur) return res.status(404).json({ error: "없는 할 일" });
  if (star) {
    const n = Number((await get(
      'SELECT COUNT(*) AS c FROM tasks WHERE "user" = ? AND archived = 0 AND star_date = ? AND id <> ?',
      [user, date, req.params.id]))?.c ?? 0);
    if (n >= 3) return res.status(400).json({ error: "핵심은 3개까지예요. 하나를 빼고 다시 골라 보세요." });
  }
  await run('UPDATE tasks SET star_date = ? WHERE id = ? AND "user" = ?',
    [star ? date : null, req.params.id, user]);
  res.json({ ok: true });
}));

// 타이머로 집중한 시간 누적. body: { minutes }
app.post("/api/tasks/:id/focus", ah(async (req, res) => {
  const user = userOf(req);
  const min = Math.max(0, Math.round(Number(req.body?.minutes) || 0));
  const r = await run('UPDATE tasks SET spent_min = spent_min + ? WHERE id = ? AND "user" = ?',
    [min, req.params.id, user]);
  if (r.changes === 0) return res.status(404).json({ error: "없는 할 일" });
  res.json({ ok: true });
}));

// 보관함 (버린 할 일 되살리기용)
app.get("/api/tasks/archived", ah(async (req, res) => {
  res.json({ tasks: await all(
    'SELECT * FROM tasks WHERE "user" = ? AND archived = 1 ORDER BY id DESC LIMIT 100', [userOf(req)]) });
}));

app.delete("/api/tasks/:id", ah(async (req, res) => {
  await run('DELETE FROM tasks WHERE id = ? AND "user" = ?', [req.params.id, userOf(req)]);
  res.json({ ok: true });
}));

// ── 메모장 CRUD ── (updated 정렬에 day.js의 nowStamp 사용)
app.get("/api/memos", ah(async (req, res) => {
  const memos = await all(
    'SELECT * FROM memos WHERE "user" = ? ORDER BY updated DESC, id DESC', [userOf(req)]);
  res.json({ memos });
}));

app.post("/api/memos", ah(async (req, res) => {
  const content = typeof req.body?.content === "string" ? req.body.content : "";
  const kind = req.body?.kind === "draw" ? "draw" : "text";
  const id = await insert(
    'INSERT INTO memos ("user", content, kind, updated) VALUES (?, ?, ?, ?)',
    [userOf(req), content, kind, nowStamp()]);
  res.json({ id });
}));

app.patch("/api/memos/:id", ah(async (req, res) => {
  const { content } = req.body;
  if (typeof content !== "string") return res.status(400).json({ error: "content는 필수" });
  const r = await run(
    'UPDATE memos SET content = ?, updated = ? WHERE id = ? AND "user" = ?',
    [content, nowStamp(), req.params.id, userOf(req)]);
  if (r.changes === 0) return res.status(404).json({ error: "없는 메모" });
  res.json({ ok: true });
}));

app.delete("/api/memos/:id", ah(async (req, res) => {
  await run('DELETE FROM memos WHERE id = ? AND "user" = ?', [req.params.id, userOf(req)]);
  res.json({ ok: true });
}));

// 날짜 로직은 서버의 시간대를 KST로 가정한다. 클라우드(UTC)에선 TZ=Asia/Seoul 필수.
const tzOffset = -new Date().getTimezoneOffset(); // KST면 540(분)
if (tzOffset !== 540) {
  console.warn(`⚠ 시간대가 KST가 아닙니다(offset ${tzOffset}분). 환경변수 TZ=Asia/Seoul 를 설정하세요. 안 하면 '오늘' 계산이 어긋납니다.`);
}

const PORT = process.env.PORT || 3456;
await initDb();  // 스키마 준비 후 시작
app.listen(PORT, () => console.log(`planner listening on http://localhost:${PORT}`));
startNotifier();
startSchedules();
startTgPoller();

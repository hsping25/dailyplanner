import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { get, all, run, insert, initDb } from "./db.js";
import { parseText } from "./parse.js";
import { pad, todayStr, shiftDate, dayWindow, eventsInWindow, loadEvents, expand } from "./day.js";
import { startNotifier } from "./notify.js";
import { startSchedules } from "./schedule.js";
import { getBotUsername } from "./telegram.js";
import { linkCode, linkStatus, unlink, startTgPoller } from "./tglink.js";

const app = express();
app.use(express.json());

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

  const loaded = await loadEvents(user);        // 이벤트는 한 번만 로드해 아래에서 재사용
  const events = expand(loaded, start, end);
  const tasks = await all(
    'SELECT * FROM tasks WHERE "user" = ? AND (done = 0 OR due = ?) ORDER BY due IS NULL, due, id',
    [user, date]);

  res.json({ date, events, tasks, week: await weekFor(date, user, loaded) });
}));

// date가 속한 주(월~일)의 요일별 일정 + 안 끝난 할 일 목록 (점 개수와 팝업에 사용)
// 이벤트는 한 번만 로드해 7일치를 메모리에서 펼치고, 주간 할일도 한 번의 쿼리로.
async function weekFor(date, user, loaded) {
  if (!loaded) loaded = await loadEvents(user);
  const [y, m, d] = date.split("-").map(Number);
  const dow = (new Date(y, m - 1, d).getDay() + 6) % 7; // 월=0
  const monday = shiftDate(date, -dow);
  const sunday = shiftDate(monday, 6);

  const weekTasks = await all(
    'SELECT title, due FROM tasks WHERE "user" = ? AND done = 0 AND due >= ? AND due <= ?',
    [user, monday, sunday]);
  const tasksByDate = new Map();
  for (const t of weekTasks) {
    if (!tasksByDate.has(t.due)) tasksByDate.set(t.due, []);
    tasksByDate.get(t.due).push(t);
  }

  const week = [];
  for (let i = 0; i < 7; i++) {
    const dayDate = shiftDate(monday, i);
    const w = dayWindow(dayDate);
    const items = expand(loaded, w.start, w.end).map(e => ({
      kind: "event", title: e.title, start: e.start, end: e.end,
      recurring: e.recurring, eventId: e.eventId, occurrenceDate: e.occurrenceDate,
      allday: e.allday,
    }));
    for (const t of tasksByDate.get(dayDate) ?? []) items.push({ kind: "task", title: t.title });
    week.push({ date: dayDate, items });
  }
  return week;
}

// 주간 이동용
app.get("/api/week", ah(async (req, res) => {
  const date = req.query.date || todayStr();
  res.json({ week: await weekFor(date, userOf(req)) });
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
  if (r.changes) await run("DELETE FROM event_exceptions WHERE event_id = ?", [req.params.id]);
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
  const title = req.body.title ?? cur.title;
  const due = "due" in req.body ? req.body.due : cur.due;
  const done = "done" in req.body ? (req.body.done ? 1 : 0) : cur.done;
  await run('UPDATE tasks SET title = ?, due = ?, done = ? WHERE id = ? AND "user" = ?',
    [title, due, done, req.params.id, user]);
  res.json({ ok: true });
}));

app.delete("/api/tasks/:id", ah(async (req, res) => {
  await run('DELETE FROM tasks WHERE id = ? AND "user" = ?', [req.params.id, userOf(req)]);
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

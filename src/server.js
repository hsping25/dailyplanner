import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "./db.js";
import { parseText } from "./parse.js";
import { pad, todayStr, shiftDate, dayWindow, eventsInWindow } from "./day.js";
import { startNotifier } from "./notify.js";
import { startSchedules } from "./schedule.js";

const app = express();
app.use(express.json());

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
app.use(express.static(path.join(root, "public")));

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
app.get("/api/day", (req, res) => {
  const user = userOf(req);
  const date = req.query.date || todayStr();
  const { start, end } = dayWindow(date);

  const events = eventsInWindow(start, end, user);

  // 할 일: 안 끝난 것 전부 + 그날이 마감이거나 마감 없는 완료 항목(그날 정리한 것)
  const tasks = db.prepare(
    "SELECT * FROM tasks WHERE user = ? AND (done = 0 OR due = ?) ORDER BY due IS NULL, due, id"
  ).all(user, date);

  res.json({ date, events, tasks, week: weekFor(date, user) });
});

// date가 속한 주(월~일)의 요일별 일정 + 안 끝난 할 일 목록 (점 개수와 팝업에 사용)
function weekFor(date, user) {
  const [y, m, d] = date.split("-").map(Number);
  const dow = (new Date(y, m - 1, d).getDay() + 6) % 7; // 월=0
  const monday = shiftDate(date, -dow);
  const week = [];
  for (let i = 0; i < 7; i++) {
    const dayDate = shiftDate(monday, i);
    const w = dayWindow(dayDate);
    const items = eventsInWindow(w.start, w.end, user).map(e => ({
      kind: "event", title: e.title, start: e.start, recurring: e.recurring,
    }));
    for (const t of db.prepare("SELECT title FROM tasks WHERE user = ? AND done = 0 AND due = ?").all(user, dayDate)) {
      items.push({ kind: "task", title: t.title });
    }
    week.push({ date: dayDate, items });
  }
  return week;
}

// 주간 이동용: 해당 날짜가 속한 주의 점/팝업 데이터만
app.get("/api/week", (req, res) => {
  const date = req.query.date || todayStr();
  res.json({ week: weekFor(date, userOf(req)) });
});

// 등록 전 겹침 확인: 이 시간 범위와 겹치는 기존 일정(반복 펼침 포함)
app.get("/api/conflicts", (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: "start, end는 필수" });
  res.json({ conflicts: eventsInWindow(start, end, userOf(req)) });
});

// ── 자연어 파싱 ──
app.post("/api/parse", async (req, res) => {
  const { text, history = [] } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: "text는 필수" });
  try {
    res.json({ items: await parseText(text.trim(), history) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 일정 CRUD (모두 요청 아이디로 범위 제한) ──
app.post("/api/events", (req, res) => {
  const { title, start, end, rrule = null } = req.body;
  if (!title || !start || !end) return res.status(400).json({ error: "title, start, end는 필수" });
  const r = db.prepare("INSERT INTO events (user, title, start, end, rrule) VALUES (?, ?, ?, ?, ?)")
    .run(userOf(req), title, start, end, rrule);
  res.json({ id: Number(r.lastInsertRowid) });
});

app.get("/api/events/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM events WHERE id = ? AND user = ?").get(req.params.id, userOf(req));
  if (!row) return res.status(404).json({ error: "없는 일정" });
  res.json(row);
});

app.put("/api/events/:id", (req, res) => {
  const { title, start, end, rrule = null } = req.body;
  if (!title || !start || !end) return res.status(400).json({ error: "title, start, end는 필수" });
  const r = db.prepare("UPDATE events SET title = ?, start = ?, end = ?, rrule = ? WHERE id = ? AND user = ?")
    .run(title, start, end, rrule, req.params.id, userOf(req));
  if (r.changes === 0) return res.status(404).json({ error: "없는 일정" });
  res.json({ ok: true });
});

app.delete("/api/events/:id", (req, res) => {
  const r = db.prepare("DELETE FROM events WHERE id = ? AND user = ?").run(req.params.id, userOf(req));
  if (r.changes) db.prepare("DELETE FROM event_exceptions WHERE event_id = ?").run(req.params.id);
  res.json({ ok: true });
});

// 반복 일정 예외: 특정 날짜 건너뛰기 또는 그 회차만 수정
app.post("/api/events/:id/exceptions", (req, res) => {
  const { date, kind, title = null, start = null, end = null } = req.body;
  if (!date || !["skip", "override"].includes(kind)) {
    return res.status(400).json({ error: "date와 kind(skip|override)는 필수" });
  }
  const owns = db.prepare("SELECT 1 FROM events WHERE id = ? AND user = ?").get(req.params.id, userOf(req));
  if (!owns) return res.status(404).json({ error: "없는 일정" });
  db.prepare(`
    INSERT INTO event_exceptions (event_id, date, kind, title, start, end)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (event_id, date) DO UPDATE SET kind=excluded.kind,
      title=excluded.title, start=excluded.start, end=excluded.end
  `).run(req.params.id, date, kind, title, start, end);
  res.json({ ok: true });
});

// ── 할 일 CRUD (모두 요청 아이디로 범위 제한) ──
app.post("/api/tasks", (req, res) => {
  const { title, due = null } = req.body;
  if (!title) return res.status(400).json({ error: "title은 필수" });
  const r = db.prepare("INSERT INTO tasks (user, title, due) VALUES (?, ?, ?)").run(userOf(req), title, due);
  res.json({ id: Number(r.lastInsertRowid) });
});

app.patch("/api/tasks/:id", (req, res) => {
  const user = userOf(req);
  const cur = db.prepare("SELECT * FROM tasks WHERE id = ? AND user = ?").get(req.params.id, user);
  if (!cur) return res.status(404).json({ error: "없는 할 일" });
  const title = req.body.title ?? cur.title;
  const due = "due" in req.body ? req.body.due : cur.due;
  const done = "done" in req.body ? (req.body.done ? 1 : 0) : cur.done;
  db.prepare("UPDATE tasks SET title = ?, due = ?, done = ? WHERE id = ? AND user = ?")
    .run(title, due, done, req.params.id, user);
  res.json({ ok: true });
});

app.delete("/api/tasks/:id", (req, res) => {
  db.prepare("DELETE FROM tasks WHERE id = ? AND user = ?").run(req.params.id, userOf(req));
  res.json({ ok: true });
});

// 날짜 로직은 서버의 시간대를 KST로 가정한다. 클라우드(UTC)에선 TZ=Asia/Seoul 필수.
const tzOffset = -new Date().getTimezoneOffset(); // KST면 540(분)
if (tzOffset !== 540) {
  console.warn(`⚠ 시간대가 KST가 아닙니다(offset ${tzOffset}분). 환경변수 TZ=Asia/Seoul 를 설정하세요. 안 하면 '오늘' 계산이 어긋납니다.`);
}

const PORT = process.env.PORT || 3456;
app.listen(PORT, () => console.log(`planner listening on http://localhost:${PORT}`));
startNotifier();
startSchedules();

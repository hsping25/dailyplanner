// 저장 계층. DATABASE_URL이 있으면 Postgres, 없으면 로컬 SQLite 파일.
// 두 경우 모두 아래 async 헬퍼(get/all/run/insert)로 통일해서 나머지 코드는 동일하게 쓴다.
// 예약어인 "user", "end" 컬럼은 두 DB 모두에서 통하도록 항상 큰따옴표로 감싼다.
import { fileURLToPath } from "node:url";
import path from "node:path";

const usePg = !!process.env.DATABASE_URL;
let sqlite = null, pgPool = null;

if (usePg) {
  const pg = (await import("pg")).default;
  pgPool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, // Neon 등 관리형 Postgres
  });
} else {
  const { DatabaseSync } = await import("node:sqlite");
  const dbPath = process.env.DB_PATH
    || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "planner.db");
  sqlite = new DatabaseSync(dbPath);
}

// "?" 자리표시자를 Postgres의 $1,$2… 로 변환
function toPg(sql) { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); }

export async function get(sql, params = []) {
  if (usePg) return (await pgPool.query(toPg(sql), params)).rows[0];
  return sqlite.prepare(sql).get(...params);
}
export async function all(sql, params = []) {
  if (usePg) return (await pgPool.query(toPg(sql), params)).rows;
  return sqlite.prepare(sql).all(...params);
}
export async function run(sql, params = []) {
  if (usePg) return { changes: (await pgPool.query(toPg(sql), params)).rowCount };
  return { changes: Number(sqlite.prepare(sql).run(...params).changes) };
}
// INSERT 후 새 id가 필요할 때
export async function insert(sql, params = []) {
  if (usePg) return Number((await pgPool.query(toPg(sql) + " RETURNING id", params)).rows[0].id);
  return Number(sqlite.prepare(sql).run(...params).lastInsertRowid);
}

// 기존 DB에 칸 추가 (이미 있으면 에러 → 무시). 두 DB 모두 ADD COLUMN 문법은 같다.
async function addColumn(table, col, type) {
  await run(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`).catch(() => {});
}

// 스키마 생성 (두 DB 공통; id 자동증가만 방언이 다름)
export async function initDb() {
  const AUTO = usePg ? "SERIAL PRIMARY KEY" : "INTEGER PRIMARY KEY AUTOINCREMENT";
  await run(`CREATE TABLE IF NOT EXISTS events (
    id ${AUTO},
    "user" TEXT NOT NULL DEFAULT '기본',
    title TEXT NOT NULL,
    start TEXT NOT NULL,
    "end" TEXT NOT NULL,
    rrule TEXT,
    allday INTEGER NOT NULL DEFAULT 0
  )`);
  await run(`CREATE TABLE IF NOT EXISTS event_exceptions (
    id ${AUTO},
    event_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT,
    start TEXT,
    "end" TEXT,
    UNIQUE (event_id, date)
  )`);
  await run(`CREATE TABLE IF NOT EXISTS notified (key TEXT PRIMARY KEY, sent_at TEXT NOT NULL)`);
  // 일정 완료 체크: 반복은 회차(date)별로 완료 처리. 행이 있으면 그 회차는 완료.
  await run(`CREATE TABLE IF NOT EXISTS event_done (
    event_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    PRIMARY KEY (event_id, date)
  )`);
  await run(`CREATE TABLE IF NOT EXISTS tg_link ("user" TEXT PRIMARY KEY, chat_id TEXT, code TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS tasks (
    id ${AUTO},
    "user" TEXT NOT NULL DEFAULT '기본',
    title TEXT NOT NULL,
    due TEXT,
    done INTEGER NOT NULL DEFAULT 0
  )`);
  // 실행 장치용 칸들. star_date = "이 날의 핵심 3개"로 뽑힌 날짜(하루 단위, 없으면 평범한 할 일).
  // plan_at = "언제 할지" 정해둔 시각("YYYY-MM-DDTHH:MM", 일정이 아니라 계획), spent_min = 타이머 누적 집중 분,
  // archived = 하루 닫기에서 버린 것(지우지 않고 숨김), asked_at = 밀린 할 일을 언제 물어봤나(중복 질문 방지).
  await addColumn("tasks", "star_date", "TEXT");
  await addColumn("tasks", "plan_at", "TEXT");
  await addColumn("tasks", "done_at", "TEXT");
  await addColumn("tasks", "spent_min", "INTEGER NOT NULL DEFAULT 0");
  await addColumn("tasks", "archived", "INTEGER NOT NULL DEFAULT 0");
  await addColumn("tasks", "asked_at", "TEXT");
  // 하루 닫기 기록. planned/done은 닫는 순간의 스냅샷(나중에 할 일을 지워도 그날 성적은 남는다).
  // note = 스스로 쓴 회고 한 줄, mood = 하루 점수 1~5.
  await run(`CREATE TABLE IF NOT EXISTS day_log (
    "user" TEXT NOT NULL,
    date TEXT NOT NULL,
    planned INTEGER NOT NULL DEFAULT 0,
    done INTEGER NOT NULL DEFAULT 0,
    dropped INTEGER NOT NULL DEFAULT 0,
    star_planned INTEGER NOT NULL DEFAULT 0,
    star_done INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    mood INTEGER,
    closed_at TEXT,
    PRIMARY KEY ("user", date)
  )`);
  // dropped 칸이 없던 시절 DB엔 칸만 추가 (버린 개수 — 분모엔 남고 따로 표시된다)
  await addColumn("day_log", "dropped", "INTEGER NOT NULL DEFAULT 0");
  // 주간 목표: week = 그 주 월요일 날짜("YYYY-MM-DD"). 한 주에 최대 3개.
  await run(`CREATE TABLE IF NOT EXISTS goals (
    id ${AUTO},
    "user" TEXT NOT NULL DEFAULT '기본',
    week TEXT NOT NULL,
    title TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0
  )`);
  // 메모장: 자유 메모. kind='text'면 content는 글, 'draw'면 PNG 데이터 URL(손그림).
  // updated는 "YYYY-MM-DDTHH:MM" 로컬 시각(정렬용).
  await run(`CREATE TABLE IF NOT EXISTS memos (
    id ${AUTO},
    "user" TEXT NOT NULL DEFAULT '기본',
    content TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'text',
    updated TEXT NOT NULL
  )`);
  // kind 칸이 없던 시절 DB엔 칸만 추가 (이미 있으면 에러 → 무시)
  await run(`ALTER TABLE memos ADD COLUMN kind TEXT NOT NULL DEFAULT 'text'`).catch(() => {});
}

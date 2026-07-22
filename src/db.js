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
  // 메모장: 자유 텍스트 메모. updated는 "YYYY-MM-DDTHH:MM" 로컬 시각(정렬용).
  await run(`CREATE TABLE IF NOT EXISTS memos (
    id ${AUTO},
    "user" TEXT NOT NULL DEFAULT '기본',
    content TEXT NOT NULL DEFAULT '',
    updated TEXT NOT NULL
  )`);
}

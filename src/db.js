import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import path from "node:path";

// 기본은 프로젝트 폴더의 planner.db. 클라우드에서 영구 디스크를 쓰면 DB_PATH로 그 경로 지정.
const dbPath = process.env.DB_PATH
  || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "planner.db");
export const db = new DatabaseSync(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    user    TEXT NOT NULL DEFAULT '기본',  -- 아이디별 분리
    title   TEXT NOT NULL,
    start   TEXT NOT NULL,            -- 로컬 시각 "YYYY-MM-DDTHH:MM"
    end     TEXT NOT NULL,
    rrule   TEXT                      -- 반복이면 RRULE 문자열, 단발이면 NULL
  );

  -- 반복 일정의 예외: 특정 날짜만 건너뛰거나(skip) 내용을 바꾼다(override)
  CREATE TABLE IF NOT EXISTS event_exceptions (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id  INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    date      TEXT NOT NULL,          -- 해당 회차의 날짜 "YYYY-MM-DD"
    kind      TEXT NOT NULL CHECK (kind IN ('skip', 'override')),
    title     TEXT,
    start     TEXT,
    end       TEXT,
    UNIQUE (event_id, date)
  );

  -- 10분 전 알림을 이미 보낸 회차 기록 (재시작해도 중복 전송 방지)
  CREATE TABLE IF NOT EXISTS notified (
    key      TEXT PRIMARY KEY,   -- "eventId|회차 start"
    sent_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    user    TEXT NOT NULL DEFAULT '기본',  -- 아이디별 분리
    title   TEXT NOT NULL,
    due     TEXT,                     -- "YYYY-MM-DD", 없으면 NULL
    done    INTEGER NOT NULL DEFAULT 0
  );
`);

// 이미 만들어진 DB(구버전)에 user 칸이 없으면 추가하고 기존 데이터를 '기본'에 넣는다.
for (const table of ["events", "tasks"]) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === "user")) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN user TEXT NOT NULL DEFAULT '기본'`);
  }
}

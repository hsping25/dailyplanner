// 공부 세션 → 출석 → 연속 기록 규칙 검증 (src/attend.js). 실행: npm test
// 임시 SQLite 파일에 실제로 쓰고 읽는다. 시각은 now(ms)를 직접 넘겨 경계값을 정확히 찌른다.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.TZ = "Asia/Seoul";
delete process.env.DATABASE_URL;
const dbFile = path.join(os.tmpdir(), `attend-test-${process.pid}.db`);
process.env.DB_PATH = dbFile;

const { initDb, insert } = await import("../src/db.js");
const A = await import("../src/attend.js");

const SEC = 1000, MIN = 60 * SEC, HOUR = 60 * MIN;
const at = (date, hm = "10:00:00") => {
  const [y, m, d] = date.split("-").map(Number);
  const [h, mi, s = 0] = hm.split(":").map(Number);
  return new Date(y, m - 1, d, h, mi, s).getTime();
};
let uid = 0;
const newUser = () => `u${++uid}`;

// 세션 하나: start에 시작해 len 뒤에 완료
async function session(user, start, len, note = "수학 문제 풀이") {
  const s = await A.startSession(user, start);
  return A.finishSession(user, s.id, note, start + len);
}
// 그날 출석 처리(30분 1회)
const attendDay = (user, date) => session(user, at(date, "09:00"), 30 * MIN);
// 그날 10분짜리 유효 세션 n회
async function shortSessions(user, date, n) {
  let r;
  for (let i = 0; i < n; i++) r = await session(user, at(date, `${10 + i}:00`), 10 * MIN);
  return r;
}

before(async () => { await initDb(); });
after(() => { try { fs.rmSync(dbFile); } catch {} });

// ── 세션 길이 경계 ──

test("9분 59초에는 완료가 거절되고 세션은 그대로 진행 중", async () => {
  const u = newUser(), t0 = at("2026-11-03");
  const s = await A.startSession(u, t0);
  await assert.rejects(A.finishSession(u, s.id, "영단어 외우기", t0 + 9 * MIN + 59 * SEC), /10분/);
  const st = await A.attendStatus(u, t0 + 9 * MIN + 59 * SEC);
  assert.equal(st.count, 0);
  assert.equal(st.open?.id, s.id);
});

test("정확히 10분이면 유효 세션 1회", async () => {
  const u = newUser(), t0 = at("2026-11-03");
  const s = await A.startSession(u, t0);
  await A.finishSession(u, s.id, "영단어 외우기", t0 + 10 * MIN);
  const st = await A.attendStatus(u, t0 + 11 * MIN);
  assert.equal(st.count, 1);
  assert.equal(st.attended, false);
  assert.equal(st.open, null);
});

test("29분 59초 1회는 출석 아님, 30분 1회는 출석", async () => {
  const a = newUser(), b = newUser(), t0 = at("2026-11-03");
  await session(a, t0, 30 * MIN - SEC);
  await session(b, t0, 30 * MIN);
  const sa = await A.attendStatus(a, t0 + HOUR), sb = await A.attendStatus(b, t0 + HOUR);
  assert.equal(sa.attended, false);
  assert.equal(sb.attended, true);
  assert.equal(sb.count, 1);
  assert.equal(sb.streak, 1);
});

test("유효 세션 2회는 출석 아님, 3회면 출석", async () => {
  const u = newUser();
  await shortSessions(u, "2026-11-03", 2);
  assert.equal((await A.attendStatus(u, at("2026-11-03", "20:00"))).attended, false);
  await shortSessions(u, "2026-11-03", 1);
  const st = await A.attendStatus(u, at("2026-11-03", "20:00"));
  assert.equal(st.count, 3);
  assert.equal(st.attended, true);
});

test("공부 내용은 앞뒤 공백 빼고 5자 이상", async () => {
  const u = newUser(), t0 = at("2026-11-03");
  const s = await A.startSession(u, t0);
  for (const bad of ["", "abcd", "  abcd  ", "수학공부", null, undefined])
    await assert.rejects(A.finishSession(u, s.id, bad, t0 + 15 * MIN), /5자/);
  const r = await A.finishSession(u, s.id, " 수학 공부 ", t0 + 15 * MIN);
  assert.equal(r.minutes, 15);
});

// ── 새벽 4시 경계: 날짜는 시작 시각 기준 ──

test("sessionDay: 03:59:59는 전날, 04:00:00은 그날", () => {
  assert.equal(A.sessionDay(at("2026-11-04", "03:59:59")), "2026-11-03");
  assert.equal(A.sessionDay(at("2026-11-04", "04:00:00")), "2026-11-04");
  assert.equal(A.sessionDay(at("2026-11-04", "00:00:00")), "2026-11-03");
});

test("03:50에 시작해 04:20에 끝낸 세션은 전날 출석", async () => {
  const u = newUser(), t0 = at("2026-11-04", "03:50");
  await session(u, t0, 30 * MIN);
  const st = await A.attendStatus(u, at("2026-11-04", "05:00"));   // 이제 '오늘'은 11/4
  assert.equal(st.date, "2026-11-04");
  assert.equal(st.count, 0);                                       // 11/4엔 0회
  assert.equal(st.streak, 1);                                      // 어제(11/3) 출석으로 1일
  const prev = await A.attendStatus(u, at("2026-11-04", "03:59"));
  assert.equal(prev.date, "2026-11-03");
  assert.equal(prev.attended, true);
});

test("04:00에 시작한 세션은 그날 것", async () => {
  const u = newUser();
  await session(u, at("2026-11-04", "04:00"), 30 * MIN);
  const st = await A.attendStatus(u, at("2026-11-04", "05:00"));
  assert.equal(st.date, "2026-11-04");
  assert.equal(st.attended, true);
});

// ── 세션 중복 방지 / 6시간 ──

test("진행 중인 세션이 있으면 새로 시작할 수 없다", async () => {
  const u = newUser(), t0 = at("2026-11-03");
  const s = await A.startSession(u, t0);
  await assert.rejects(A.startSession(u, t0 + MIN), /진행 중/);
  await A.finishSession(u, s.id, "물리 2단원 정리", t0 + 10 * MIN);
  await A.startSession(u, t0 + 11 * MIN);   // 끝낸 뒤엔 된다
});

test("동시에 두 번 눌러도 하나만 시작된다", async () => {
  const u = newUser(), t0 = at("2026-11-03");
  const rs = await Promise.allSettled([A.startSession(u, t0), A.startSession(u, t0)]);
  assert.equal(rs.filter(r => r.status === "fulfilled").length, 1);
});

test("앱 검사를 건너뛰어도 DB가 진행 중 세션 두 개를 받지 않는다", async () => {
  const u = newUser(), t0 = at("2026-11-03");
  await A.startSession(u, t0);
  await assert.rejects(insert(
    `INSERT INTO study_sessions ("user", date, started_ms, status) VALUES (?, ?, ?, 'open')`, [u, "2026-11-03", t0]));
});

test("취소한 세션은 세지 않고, 취소 뒤엔 새로 시작할 수 있다", async () => {
  const u = newUser(), t0 = at("2026-11-03");
  const s = await A.startSession(u, t0);
  await A.cancelSession(u, s.id);
  await assert.rejects(A.finishSession(u, s.id, "취소한 세션 완료", t0 + 20 * MIN), /진행 중인 세션이 아니/);
  await A.startSession(u, t0 + MIN);
  assert.equal((await A.attendStatus(u, t0 + 2 * MIN)).count, 0);
});

test("6시간 안(5:59:59)이면 완료, 6시간이 되면 미완료", async () => {
  const u = newUser(), t0 = at("2026-11-03", "08:00");
  const s1 = await A.startSession(u, t0);
  await A.finishSession(u, s1.id, "긴 공부 세션", t0 + 6 * HOUR - SEC);
  const t1 = at("2026-11-03", "15:00");
  const s2 = await A.startSession(u, t1);
  await assert.rejects(A.finishSession(u, s2.id, "너무 늦은 완료", t1 + 6 * HOUR), /미완료/);
  const st = await A.attendStatus(u, t1 + 6 * HOUR);
  assert.equal(st.count, 1);
  assert.equal(st.open, null);
});

test("6시간 지난 세션은 새 시작을 막지 않는다", async () => {
  const u = newUser(), t0 = at("2026-11-03", "08:00");
  await A.startSession(u, t0);
  await assert.rejects(A.startSession(u, t0 + 6 * HOUR - SEC), /진행 중/);
  await A.startSession(u, t0 + 6 * HOUR);
});

// ── 연속 기록 / 복구 ──

test("연속 기록: 오늘 출석 전엔 어제까지, 출석하면 오늘 포함", async () => {
  const u = newUser();
  for (const d of ["2026-11-01", "2026-11-02"]) await attendDay(u, d);
  assert.equal((await A.attendStatus(u, at("2026-11-03", "08:00"))).streak, 2);
  await attendDay(u, "2026-11-03");
  assert.equal((await A.attendStatus(u, at("2026-11-03", "12:00"))).streak, 3);
  // 하루를 통째로 빠지면 끊긴다
  assert.equal((await A.attendStatus(u, at("2026-11-05", "08:00"))).streak, 0);
});

test("복구: 끊긴 다음 날 유효 5회 — 4회까진 안 되고 5회째에 메워진다", async () => {
  const u = newUser();
  for (const d of ["2026-11-01", "2026-11-02"]) await attendDay(u, d);
  // 11/3 빠짐. 11/4에 세션
  const pre = await A.attendStatus(u, at("2026-11-04", "08:00"));
  assert.equal(pre.streak, 0);
  assert.deepEqual(pre.recover, { missed: "2026-11-03", prev: 2, need: 5 });

  const r3 = await shortSessions(u, "2026-11-04", 3);
  assert.equal(r3.recovered, null);
  const mid = await A.attendStatus(u, at("2026-11-04", "14:00"));
  assert.equal(mid.attended, true);       // 3회 = 그날 출석
  assert.equal(mid.streak, 1);            // 11/3이 비어 있어 아직 1일
  assert.ok(mid.recover);                 // 출석 뒤에도 복구 안내는 남는다

  const r4 = await A.finishSession(u, (await A.startSession(u, at("2026-11-04", "15:00"))).id,
    "네 번째 세션", at("2026-11-04", "15:10"));
  assert.equal(r4.recovered, null);
  const r5 = await A.finishSession(u, (await A.startSession(u, at("2026-11-04", "16:00"))).id,
    "다섯 번째 세션", at("2026-11-04", "16:10"));
  assert.equal(r5.recovered, "2026-11-03");
  const post = await A.attendStatus(u, at("2026-11-04", "17:00"));
  assert.equal(post.streak, 4);           // 11/1·2·3(복구)·4
  assert.equal(post.recover, null);
});

test("복구는 끊긴 '다음 날'에만 — 이틀 뒤 5회는 복구 안 됨", async () => {
  const u = newUser();
  for (const d of ["2026-11-01", "2026-11-02"]) await attendDay(u, d);
  const r = await shortSessions(u, "2026-11-05", 5);    // 11/3·4 빠짐
  assert.equal(r.recovered, null);
  assert.equal((await A.attendStatus(u, at("2026-11-05", "20:00"))).streak, 1);
});

test("복구는 살릴 연속이 있을 때만", async () => {
  const u = newUser();
  const r = await shortSessions(u, "2026-11-04", 5);    // 그 전 기록 없음
  assert.equal(r.recovered, null);
});

test("30분 1회 + 10분 4회도 유효 5회로 복구된다", async () => {
  const u = newUser();
  for (const d of ["2026-11-01", "2026-11-02"]) await attendDay(u, d);
  await attendDay(u, "2026-11-04");                      // 30분 1회로 출석
  const r = await shortSessions(u, "2026-11-04", 4);
  assert.equal(r.recovered, "2026-11-03");
});

test("복구는 한 달 1회 — 같은 달 두 번째는 안 되고 다음 달엔 된다", async () => {
  const u = newUser();
  for (const d of ["2026-11-01", "2026-11-02"]) await attendDay(u, d);
  assert.equal((await shortSessions(u, "2026-11-04", 5)).recovered, "2026-11-03");
  // 11/5 출석, 11/6 빠짐, 11/7에 5회 → 이번 달 이미 썼다
  await attendDay(u, "2026-11-05");
  const st = await A.attendStatus(u, at("2026-11-07", "08:00"));
  assert.equal(st.recover, null);
  assert.equal((await shortSessions(u, "2026-11-07", 5)).recovered, null);
  assert.equal((await A.attendStatus(u, at("2026-11-07", "20:00"))).streak, 1);
  // 다음 달: 11/29·30 출석, 12/1 빠짐, 12/2에 5회 → 된다
  for (const d of ["2026-11-29", "2026-11-30"]) await attendDay(u, d);
  assert.equal((await shortSessions(u, "2026-12-02", 5)).recovered, "2026-12-01");
  assert.equal((await A.attendStatus(u, at("2026-12-02", "20:00"))).streak, 4);
});

// ── 밤 알림 문구 ──

test("밤 알림: 출석했으면 안 보내고, 못 채웠으면 남은 횟수와 이어질 날수", () => {
  assert.equal(A.nightMessage({ attended: true, count: 3, need: 3, streak: 23 }), null);
  assert.equal(A.nightMessage({ attended: false, count: 2, need: 3, streak: 22, recover: null }),
    "📚 오늘 1회만 더 하면 23일째 유지");
  assert.match(A.nightMessage({ attended: false, count: 1, need: 3, streak: 0,
    recover: { missed: "2026-11-03", prev: 5, need: 5 } }), /4회 더 하면.*7일째/);
  assert.match(A.nightMessage({ attended: false, count: 0, need: 3, streak: 0, recover: null }), /3회 하면 출석/);
});

test("밤 알림 문구는 실제 상태로도 맞게 나온다", async () => {
  const u = newUser();
  for (const d of ["2026-11-01", "2026-11-02"]) await attendDay(u, d);
  await shortSessions(u, "2026-11-03", 2);
  const st = await A.attendStatus(u, at("2026-11-03", "21:00"));
  assert.equal(A.nightMessage(st), "📚 오늘 1회만 더 하면 3일째 유지");
});

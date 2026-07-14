// 아이디 ↔ 텔레그램 연결. 딥링크(t.me/<봇>?start=<코드>)로 사용자가 "시작"만 누르면 연결됨.
import { get, all, run } from "./db.js";
import { sendTelegram, getUpdatesRaw } from "./telegram.js";

// ── 매핑 조회/변경 ──
export async function chatIdFor(user) {
  const r = await get('SELECT chat_id FROM tg_link WHERE "user" = ? AND chat_id IS NOT NULL', [user]);
  return r ? r.chat_id : null;
}
export function linkStatus(user) { return chatIdFor(user); }
export async function linkedUsers() {
  const rows = await all('SELECT "user", chat_id FROM tg_link WHERE chat_id IS NOT NULL', []);
  return rows.map(r => ({ user: r.user, chat_id: r.chat_id }));
}
export async function unlink(user) { await run('DELETE FROM tg_link WHERE "user" = ?', [user]); }

// 연결용 1회 코드 발급 (기존 chat_id는 유지, 새 코드로 덮어씀)
export async function linkCode(user) {
  const code = Math.random().toString(36).slice(2, 8);
  await run(`INSERT INTO tg_link ("user", code) VALUES (?, ?)
    ON CONFLICT ("user") DO UPDATE SET code = EXCLUDED.code`, [user, code]);
  return code;
}

// .env에 TELEGRAM_CHAT_ID가 있으면 그 값을 NOTIFY_USER(기본)에 자동 연결(레거시 유지)
export async function seedLegacyLink() {
  const chat = process.env.TELEGRAM_CHAT_ID;
  const user = process.env.NOTIFY_USER || "기본";
  if (chat && !(await get('SELECT 1 FROM tg_link WHERE "user" = ?', [user]))) {
    await run('INSERT INTO tg_link ("user", chat_id) VALUES (?, ?)', [user, String(chat)]);
  }
}

// ── getUpdates 폴러: 봇에게 온 /start <코드> 를 보고 연결 확정 ──
async function getOffset() {
  const r = await get("SELECT v FROM kv WHERE k = 'tg_offset'", []);
  return r ? Number(r.v) : 0;
}
async function setOffset(v) {
  await run(`INSERT INTO kv (k, v) VALUES ('tg_offset', ?)
    ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`, [String(v)]);
}

let polling = false;
async function pollOnce() {
  if (polling) return;
  polling = true;
  try {
    const offset = await getOffset();
    const ups = await getUpdatesRaw(offset || undefined);
    if (!ups.length) return;
    let maxId = offset - 1;
    for (const u of ups) {
      if (u.update_id > maxId) maxId = u.update_id;
      const text = (u.message?.text || "").trim();
      const chat = u.message?.chat?.id;
      if (chat == null) continue;
      const m = text.match(/^\/start\s+(\S+)$/) || (/^[a-z0-9]{4,12}$/i.test(text) ? [text, text] : null);
      if (!m) continue;
      const row = await get('SELECT "user" FROM tg_link WHERE code = ?', [m[1]]);
      if (row) {
        await run('UPDATE tg_link SET chat_id = ?, code = NULL WHERE "user" = ?', [String(chat), row.user]);
        try { await sendTelegram(`✅ '${row.user}' 아이디 알림이 이 대화로 연결됐어요.`, String(chat)); } catch {}
      }
    }
    await setOffset(maxId + 1);
  } catch { /* 네트워크 오류 등은 다음 주기에 재시도 */ }
  finally { polling = false; }
}
export async function startTgPoller() {
  await seedLegacyLink();
  pollOnce();
  setInterval(pollOnce, 4000);
  console.log("텔레그램 연결 폴러 시작 (4초 간격)");
}

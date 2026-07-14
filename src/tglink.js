// 아이디 ↔ 텔레그램 연결. 딥링크(t.me/<봇>?start=<코드>)로 사용자가 "시작"만 누르면 연결됨.
import { db } from "./db.js";
import { sendTelegram, getUpdatesRaw } from "./telegram.js";

// ── 매핑 조회/변경 ──
export function chatIdFor(user) {
  const r = db.prepare("SELECT chat_id FROM tg_link WHERE user = ? AND chat_id IS NOT NULL").get(user);
  return r ? r.chat_id : null;
}
export function linkStatus(user) { return chatIdFor(user); }
export function linkedUsers() {
  return db.prepare("SELECT user, chat_id FROM tg_link WHERE chat_id IS NOT NULL").all();
}
export function unlink(user) { db.prepare("DELETE FROM tg_link WHERE user = ?").run(user); }

// 연결용 1회 코드 발급 (기존 chat_id는 유지, 새 코드로 덮어씀)
export function linkCode(user) {
  const code = Math.random().toString(36).slice(2, 8);
  db.prepare(`INSERT INTO tg_link (user, code) VALUES (?, ?)
    ON CONFLICT(user) DO UPDATE SET code = excluded.code`).run(user, code);
  return code;
}

// .env에 TELEGRAM_CHAT_ID가 있으면 그 값을 NOTIFY_USER(기본)에 자동 연결(레거시 유지)
export function seedLegacyLink() {
  const chat = process.env.TELEGRAM_CHAT_ID;
  const user = process.env.NOTIFY_USER || "기본";
  if (chat && !db.prepare("SELECT 1 FROM tg_link WHERE user = ?").get(user)) {
    db.prepare("INSERT INTO tg_link (user, chat_id) VALUES (?, ?)").run(user, String(chat));
  }
}

// ── getUpdates 폴러: 봇에게 온 /start <코드> 를 보고 연결 확정 ──
function getOffset() {
  const r = db.prepare("SELECT v FROM kv WHERE k = 'tg_offset'").get();
  return r ? Number(r.v) : 0;
}
function setOffset(v) {
  db.prepare(`INSERT INTO kv (k, v) VALUES ('tg_offset', ?)
    ON CONFLICT(k) DO UPDATE SET v = excluded.v`).run(String(v));
}

let polling = false;
async function pollOnce() {
  if (polling) return;
  polling = true;
  try {
    const offset = getOffset();
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
      const row = db.prepare("SELECT user FROM tg_link WHERE code = ?").get(m[1]);
      if (row) {
        db.prepare("UPDATE tg_link SET chat_id = ?, code = NULL WHERE user = ?").run(String(chat), row.user);
        try { await sendTelegram(`✅ '${row.user}' 아이디 알림이 이 대화로 연결됐어요.`, String(chat)); } catch {}
      }
    }
    setOffset(maxId + 1);
  } catch { /* 네트워크 오류 등은 다음 주기에 재시도 */ }
  finally { polling = false; }
}
export function startTgPoller() {
  seedLegacyLink();
  pollOnce();
  setInterval(pollOnce, 4000);
  console.log("텔레그램 연결 폴러 시작 (4초 간격)");
}

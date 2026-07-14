// 일정 시작 10분 전 텔레그램 알림. 서버(server.js)가 켜져 있는 동안 30초마다 확인한다.
// 이미 보낸 회차는 notified 테이블에 기록해 중복 전송을 막는다.
import { db } from "./db.js";
import { pad, dateStr, eventsInWindow } from "./day.js";
import { sendTelegram } from "./telegram.js";
import { linkedUsers } from "./tglink.js";

const LEAD_MIN = 10;      // 몇 분 전에 알릴지
const TICK_MS = 30_000;

const localIso = d => `${dateStr(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const hm = s => {
  const [h, m] = s.split("T")[1].split(":");
  return m === "00" ? `${Number(h)}시` : `${Number(h)}시 ${Number(m)}분`;
};

export async function tick(now = new Date()) {
  const winStart = localIso(now);
  const winEnd = localIso(new Date(now.getTime() + (LEAD_MIN + 1) * 60000));
  // 연결된 아이디마다 그 사람 일정을 그 사람 chat_id로
  for (const { user, chat_id } of linkedUsers()) {
    for (const occ of eventsInWindow(winStart, winEnd, user)) {
      if (occ.allday) continue; // 종일 일정은 "10분 전" 알림 없음
      const mins = Math.round((new Date(occ.start) - now) / 60000);
      if (mins < 0 || mins > LEAD_MIN) continue;
      const key = `${user}|${occ.eventId}|${occ.start}`;
      if (db.prepare("SELECT 1 FROM notified WHERE key = ?").get(key)) continue;
      db.prepare("INSERT INTO notified (key, sent_at) VALUES (?, ?)").run(key, winStart);
      try {
        await sendTelegram(`⏰ ${mins <= 0 ? "지금" : `${mins}분 뒤`} ${hm(occ.start)} ${occ.title}`, chat_id);
      } catch (e) {
        console.error("일정 알림 실패:", e.message);
      }
    }
  }
  // 오래된 기록 정리 (일주일 지난 것)
  const cutoff = localIso(new Date(now.getTime() - 7 * 86400000));
  db.prepare("DELETE FROM notified WHERE sent_at < ?").run(cutoff);
}

export function startNotifier() {
  tick().catch(e => console.error("알림 확인 실패:", e.message));
  setInterval(() => tick().catch(e => console.error("알림 확인 실패:", e.message)), TICK_MS);
  console.log(`일정 ${LEAD_MIN}분 전 알림 감시 시작 (${TICK_MS / 1000}초 간격)`);
}

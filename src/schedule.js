// 매일 07:00 브리핑 / 14:00 할 일 알림. 연결된 아이디마다 각자 텔레그램으로.
// 정각에만 쏘지 않고 "그 시각이 지났는데 오늘 아직 안 보냈으면 보낸다"는 놓침-보정 방식.
// → 서버가 정각에 잠깐 꺼져 있어도(PC 절전, Render 유휴) 깨어나면 그날 안에 발송된다.
import { get, run } from "./db.js";
import { dateStr } from "./day.js";
import { sendBriefingTo } from "./briefing.js";
import { sendReminderTo } from "./remind-tasks.js";
import { linkedUsers } from "./tglink.js";

const CHECK_MS = 60_000;  // 1분마다 점검
const BRIEF_HM = 7 * 60;  // 07:00
const REMIND_HM = 14 * 60; // 14:00

async function once(key, when, send) {
  if (await get("SELECT 1 FROM notified WHERE key = ?", [key])) return;   // 오늘 이미 보냄
  await run("INSERT INTO notified (key, sent_at) VALUES (?, ?)", [key, when]); // 먼저 표시(중복/스팸 방지)
  try { await send(); } catch (e) { console.error(`알림 실패(${key}):`, e.message); }
}

export async function checkDaily(now = new Date()) {
  const hm = now.getHours() * 60 + now.getMinutes(); // TZ가 KST면 KST 기준
  const date = dateStr(now);
  for (const { user, chat_id } of await linkedUsers()) {
    if (hm >= BRIEF_HM) await once(`brief|${user}|${date}`, date, () => sendBriefingTo(user, chat_id));
    if (hm >= REMIND_HM) await once(`remind|${user}|${date}`, date, () => sendReminderTo(user, chat_id));
  }
}

export function startSchedules() {
  checkDaily().catch(e => console.error("스케줄 점검 실패:", e.message));
  setInterval(() => checkDaily().catch(e => console.error("스케줄 점검 실패:", e.message)), CHECK_MS);
  console.log("일일 알림 스케줄 시작: 07:00 브리핑 / 14:00 할 일 (놓쳐도 그날 안에 보정 발송)");
}

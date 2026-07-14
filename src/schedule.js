// 서버 안에서 매일 정해진 시각에 알림을 보낸다 (클라우드 배포용).
// 연결된 아이디마다 각자의 일정/할 일을 각자의 텔레그램으로 보낸다.
import cron from "node-cron";
import { sendBriefingTo } from "./briefing.js";
import { sendReminderTo } from "./remind-tasks.js";
import { linkedUsers } from "./tglink.js";

const TZ = "Asia/Seoul";

async function forEachLinked(fn, label) {
  for (const { user, chat_id } of linkedUsers()) {
    try { await fn(user, chat_id); }
    catch (e) { console.error(`${label} 실패(${user}):`, e.message); }
  }
}

export function startSchedules() {
  // 매일 07:00 아침 브리핑
  cron.schedule("0 7 * * *", () => forEachLinked(sendBriefingTo, "브리핑"), { timezone: TZ });
  // 매일 14:00 할 일 리마인드
  cron.schedule("0 14 * * *", () => forEachLinked(sendReminderTo, "할 일 알림"), { timezone: TZ });
  console.log("스케줄 등록: 매일 07:00 브리핑, 14:00 할 일 알림 (KST, 연결된 아이디별)");
}

// 서버 안에서 매일 정해진 시각에 알림을 보낸다 (클라우드 배포용).
// 로컬 Windows에서 작업 스케줄러를 쓰던 것을, 서버가 항상 켜져 있는 환경에서는 이걸로 대체한다.
import cron from "node-cron";
import { sendBriefing } from "./briefing.js";
import { sendTaskReminder } from "./remind-tasks.js";

const TZ = "Asia/Seoul";

export function startSchedules() {
  // 매일 07:00 아침 브리핑
  cron.schedule("0 7 * * *", () => {
    sendBriefing().catch(e => console.error("브리핑 실패:", e.message));
  }, { timezone: TZ });

  // 매일 14:00 할 일 리마인드
  cron.schedule("0 14 * * *", () => {
    sendTaskReminder().catch(e => console.error("할 일 알림 실패:", e.message));
  }, { timezone: TZ });

  console.log("스케줄 등록: 매일 07:00 브리핑, 14:00 할 일 알림 (KST)");
}

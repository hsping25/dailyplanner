// 오후 2시 할 일 알림: 오늘이 마감인데 아직 안 끝난 할 일만 다시 알려준다.
// 남은 게 없으면 아무것도 보내지 않는다. 배포 시 서버 스케줄러가 매일 14:00(KST) 호출. 수동: npm run remind
import { fileURLToPath } from "node:url";
import { db } from "./db.js";
import { todayStr } from "./day.js";
import { sendTelegram } from "./telegram.js";

const NOTIFY_USER = process.env.NOTIFY_USER || "기본";

export async function sendTaskReminder() {
  const date = todayStr();
  const tasks = db.prepare("SELECT title FROM tasks WHERE user = ? AND done = 0 AND due = ?").all(NOTIFY_USER, date);
  if (tasks.length === 0) {
    console.log("오늘 마감 할 일 없음 — 전송 생략");
    return true;
  }
  const text = `📌 오늘까지 할 일 ${tasks.length}개 남았어요 — ${tasks.map(t => t.title).join(" · ")}`;
  const ok = await sendTelegram(text);
  console.log(ok ? "할 일 알림 전송 완료" : "할 일 알림 전송 생략(텔레그램 미설정)");
  return ok;
}

// 직접 실행(npm run remind)일 때만 즉시 전송
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!(await sendTaskReminder())) process.exitCode = 1;
}

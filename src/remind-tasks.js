// 오후 2시 할 일 알림: 오늘이 마감인데 아직 안 끝난 할 일만 다시 알려준다.
// 남은 게 없으면 아무것도 보내지 않는다. 서버 스케줄러가 매일 14:00(KST) 호출. 수동: npm run remind
import { fileURLToPath } from "node:url";
import { all, initDb } from "./db.js";
import { todayStr } from "./day.js";
import { sendTelegram } from "./telegram.js";

// 남은 할 일 안내 문구 (없으면 null)
export async function composeReminder(user) {
  const date = todayStr();
  // 오늘 마감 + 오늘 핵심으로 뽑아 둔 것 (핵심은 마감이 없어도 오후에 한 번 되새긴다)
  const tasks = await all(
    `SELECT title, star_date FROM tasks WHERE "user" = ? AND archived = 0 AND done = 0
       AND (due = ? OR star_date = ?) ORDER BY CASE WHEN star_date = ? THEN 0 ELSE 1 END, id`,
    [user, date, date, date]);
  if (tasks.length === 0) return null;
  const label = t => (t.star_date === date ? `⭐${t.title}` : t.title);
  return `📌 아직 ${tasks.length}개 남았어요 — ${tasks.map(label).join(" · ")}`;
}

// 특정 아이디의 리마인드를 그 사람 chat_id로 전송
export async function sendReminderTo(user, chatId) {
  const text = await composeReminder(user);
  if (!text) return true; // 남은 게 없으면 안 보냄
  return sendTelegram(text, chatId);
}

// 레거시 수동 실행(npm run remind)
export async function sendTaskReminder() {
  const user = process.env.NOTIFY_USER || "기본";
  const text = await composeReminder(user);
  if (!text) { console.log("오늘 마감 할 일 없음 — 전송 생략"); return true; }
  const ok = await sendTelegram(text);
  console.log(ok ? "할 일 알림 전송 완료" : "할 일 알림 전송 생략(텔레그램 미설정)");
  return ok;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await initDb();
  if (!(await sendTaskReminder())) process.exitCode = 1;
}

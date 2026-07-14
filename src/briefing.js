// 아침 브리핑: 오늘 일정 + 할 일을 한 문단으로 정리해 텔레그램으로 보낸다.
// 배포 시 서버 안의 스케줄러(src/schedule.js)가 매일 07:00(KST) 호출한다. 수동 실행: npm run brief
import { fileURLToPath } from "node:url";
import { db } from "./db.js";
import { todayStr, dayWindow, eventsInWindow } from "./day.js";
import { sendTelegram } from "./telegram.js";

const DAY = ["일", "월", "화", "수", "목", "금", "토"];
const hm = s => {
  const [h, m] = s.split("T")[1].split(":");
  return m === "00" ? `${Number(h)}시` : `${Number(h)}시 ${Number(m)}분`;
};

export function composeBriefing(user) {
  const date = todayStr();
  const [y, m, d] = date.split("-").map(Number);
  const dayName = DAY[new Date(y, m - 1, d).getDay()];
  const { start, end } = dayWindow(date);
  const events = eventsInWindow(start, end, user);
  const todayTasks = db.prepare("SELECT * FROM tasks WHERE user = ? AND done = 0 AND due = ?").all(user, date);
  const overdue = db.prepare("SELECT * FROM tasks WHERE user = ? AND done = 0 AND due < ? ORDER BY due").all(user, date);

  const lines = [`🌅 ${m}월 ${d}일 ${dayName}요일`];

  if (events.length === 0) {
    lines.push("오늘은 일정이 없어요.");
  } else {
    const list = events.map(e => `${e.allday ? "종일" : hm(e.start)} ${e.title}`).join(", ");
    lines.push(`오늘 일정 ${events.length}개 — ${list}.`);
    const firstTimed = events.find(e => !e.allday);
    if (firstTimed) lines.push(`첫 일정은 ${hm(firstTimed.start)} ${firstTimed.title}예요.`);
  }

  const taskBits = [
    ...overdue.map(t => {
      const days = Math.round((new Date(date) - new Date(t.due)) / 86400000);
      return `${t.title}(${days}일 지남!)`;
    }),
    ...todayTasks.map(t => `${t.title}(오늘까지)`),
  ];
  if (taskBits.length) lines.push(`✅ 할 일: ${taskBits.join(" · ")}`);

  return lines.join("\n");
}

// 특정 아이디의 브리핑을 그 사람 chat_id로 전송
export async function sendBriefingTo(user, chatId) {
  return sendTelegram(composeBriefing(user), chatId);
}

// 레거시 수동 실행(npm run brief): NOTIFY_USER를 .env의 기본 chat으로
export async function sendBriefing() {
  const user = process.env.NOTIFY_USER || "기본";
  const ok = await sendTelegram(composeBriefing(user));
  console.log(ok ? "브리핑 전송 완료" : "브리핑 전송 생략(텔레그램 미설정)");
  return ok;
}

// 직접 실행(npm run brief)일 때만 즉시 전송
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!(await sendBriefing())) process.exitCode = 1;
}

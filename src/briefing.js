// 아침 브리핑: 오늘 일정 + 할 일을 한 문단으로 정리해 텔레그램으로 보낸다.
// 배포 시 서버 안의 스케줄러(src/schedule.js)가 매일 07:00(KST) 호출한다. 수동 실행: npm run brief
import { fileURLToPath } from "node:url";
import { all, run, initDb } from "./db.js";
import { todayStr, dayWindow, eventsInWindow, shiftDate } from "./day.js";
import { sendTelegram, keyboard } from "./telegram.js";
import { streak } from "./review.js";

// 오래 밀린 할 일은 며칠 지나야 "아직 할 거야?" 하고 한 번 물어보는지
const STALE_DAYS = 3;

const DAY = ["일", "월", "화", "수", "목", "금", "토"];
const hm = s => {
  const [h, m] = s.split("T")[1].split(":");
  return m === "00" ? `${Number(h)}시` : `${Number(h)}시 ${Number(m)}분`;
};

export async function composeBriefing(user) {
  const date = todayStr();
  const [y, m, d] = date.split("-").map(Number);
  const dayName = DAY[new Date(y, m - 1, d).getDay()];
  const { start, end } = dayWindow(date);
  const events = await eventsInWindow(start, end, user);
  const todayTasks = await all(
    'SELECT * FROM tasks WHERE "user" = ? AND archived = 0 AND done = 0 AND due = ?', [user, date]);
  const overdue = await all(
    'SELECT * FROM tasks WHERE "user" = ? AND archived = 0 AND done = 0 AND due < ? ORDER BY due', [user, date]);
  const stars = await all(
    'SELECT * FROM tasks WHERE "user" = ? AND archived = 0 AND star_date = ? ORDER BY id', [user, date]);

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

  // 어제 핵심 3개를 골라 뒀으면 되새기고, 아직 안 골랐으면 고르라고 한다 (하루의 시작 = 3개 정하기)
  if (stars.length) lines.push(`⭐ 오늘 핵심: ${stars.map(t => t.title).join(" · ")}`);
  else if (todayTasks.length + overdue.length >= 2) lines.push("⭐ 오늘 핵심 3개는 아직 안 골랐어요. 앱에서 별을 눌러 정해 보세요.");

  const st = await streak(user);
  if (st >= 2) lines.push(`🔥 ${st}일 연속 (닫고 절반 이상 해낸 날)`);

  return lines.join("\n");
}

// 특정 아이디의 브리핑을 그 사람 chat_id로 전송. 이어서 오래 밀린 할 일이 있으면 하나 물어본다.
export async function sendBriefingTo(user, chatId) {
  const ok = await sendTelegram(await composeBriefing(user), chatId);
  await askStale(user, chatId).catch(e => console.error("밀린 할 일 질문 실패:", e.message));
  return ok;
}

// 밀린 할 일 정리: STALE_DAYS 넘게 지났고 아직 안 물어본 것 하나만 골라 묻는다.
// 한 번에 하나만 묻는 이유 — 아침에 다섯 개를 들이밀면 전부 무시하게 된다.
export async function askStale(user, chatId) {
  const date = todayStr();
  const cutoff = shiftDate(date, -STALE_DAYS);
  const t = (await all(
    `SELECT * FROM tasks WHERE "user" = ? AND archived = 0 AND done = 0
       AND due IS NOT NULL AND due <= ? AND (asked_at IS NULL OR asked_at < ?)
     ORDER BY due LIMIT 1`,
    [user, cutoff, shiftDate(date, -7)]))[0];
  if (!t) return false;
  await run('UPDATE tasks SET asked_at = ? WHERE id = ?', [date, t.id]);
  const days = Math.round((new Date(date) - new Date(t.due)) / 86400000);
  return sendTelegram(
    `🧹 "${t.title}" — ${days}일째 밀려 있어요. 아직 할 거예요?`,
    chatId,
    keyboard([[
      { text: "⭐ 오늘 핵심으로", data: `od|${t.id}|star` },
      { text: "📆 이번 주 안에", data: `od|${t.id}|week` },
      { text: "🗑 버림", data: `od|${t.id}|drop` },
    ]]));
}

// 레거시 수동 실행(npm run brief): NOTIFY_USER를 .env의 기본 chat으로
export async function sendBriefing() {
  const user = process.env.NOTIFY_USER || "기본";
  const ok = await sendTelegram(await composeBriefing(user));
  console.log(ok ? "브리핑 전송 완료" : "브리핑 전송 생략(텔레그램 미설정)");
  return ok;
}

// 직접 실행(npm run brief)일 때만 즉시 전송
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await initDb();
  if (!(await sendBriefing())) process.exitCode = 1;
}

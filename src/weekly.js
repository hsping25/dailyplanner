// 일요일 밤 주간 회고: 이번 주 달성률 + 주간 목표 결과를 한 번 보여 준다.
// 다음 주 목표는 앱에서 고르게 한다(세 개를 고르는 건 손으로 하는 게 낫다).
import { all } from "./db.js";
import { weekStart, shiftDate } from "./day.js";
import { scoresBetween, ratio, streak } from "./review.js";
import { sendTelegram } from "./telegram.js";

const DAY = ["월", "화", "수", "목", "금", "토", "일"];
// 달성률을 한 글자로 (종이 플래너를 넘겨볼 때의 그 느낌)
const mark = s => s.planned === 0 ? "·" : s.done === s.planned ? "●" : s.done * 2 >= s.planned ? "◐" : "○";

export async function composeWeekly(user, date) {
  const monday = weekStart(date);
  const sunday = shiftDate(monday, 6);
  const scores = await scoresBetween(user, monday, sunday);
  const planned = scores.reduce((a, s) => a + s.planned, 0);
  const done = scores.reduce((a, s) => a + s.done, 0);
  const starP = scores.reduce((a, s) => a + s.starPlanned, 0);
  const starD = scores.reduce((a, s) => a + s.starDone, 0);

  const lines = [`📊 이번 주 (${monday.slice(5)} ~ ${sunday.slice(5)})`];
  lines.push(DAY.map((d, i) => `${d}${mark(scores[i])}`).join(" "));
  lines.push(planned ? `계획 ${planned}개 중 ${done}개 (${ratio(planned, done)}%)` : "이번 주는 계획에 잡은 게 없었어요.");
  if (starP) lines.push(`⭐ 핵심 ${starD}/${starP}`);

  const goals = await all('SELECT * FROM goals WHERE "user" = ? AND week = ? ORDER BY id', [user, monday]);
  if (goals.length) {
    lines.push("", "이번 주 목표:");
    for (const g of goals) lines.push(`  ${g.done ? "✅" : "⬜"} ${g.title}`);
  }

  const notes = scores.filter(s => s.note).map(s => `  ${s.date.slice(5)} “${s.note}”`);
  if (notes.length) lines.push("", "남긴 말:", ...notes);

  const st = await streak(user);
  if (st >= 2) lines.push("", `🔥 ${st}일 연속`);
  lines.push("", "다음 주 목표 3개는 앱에서 골라 보세요.");
  return lines.join("\n");
}

export async function sendWeeklyTo(user, chatId, date) {
  return sendTelegram(await composeWeekly(user, date), chatId);
}

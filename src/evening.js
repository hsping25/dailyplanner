// 저녁 회고("하루 닫기")를 텔레그램 대화로. 앱을 안 열어도 하루가 닫히게 하는 게 목적이다.
//
// 흐름: 21:00 성적 요약 → [남은 것 정리] 누르면 미완료를 하나씩 물어봄(내일로/이번주/버림/그대로)
//       → 회고 한 줄(답장으로 입력) → 하루 점수 1~5 → 닫기(day_log 저장).
// 진행 상태는 kv 테이블에 chat별로 저장해서 서버가 재시작돼도 이어진다.
import { get, run } from "./db.js";
import { todayStr } from "./day.js";
import { dayScore, leftovers, ratio, closeDay, applyActions, streak, dayLog } from "./review.js";
import { sendTelegram, api, keyboard, editMessage, answerCallback, forceReply } from "./telegram.js";

const DAY = ["일", "월", "화", "수", "목", "금", "토"];
const MOODS = ["", "😖", "😕", "😐", "🙂", "😄"];

// ── 진행 상태 (kv: tgflow|<chat_id>) ──
const flowKey = chat => `tgflow|${chat}`;
async function getFlow(chat) {
  const r = await get("SELECT v FROM kv WHERE k = ?", [flowKey(chat)]);
  try { return r ? JSON.parse(r.v) : null; } catch { return null; }
}
async function setFlow(chat, flow) {
  if (!flow) return run("DELETE FROM kv WHERE k = ?", [flowKey(chat)]);
  return run(`INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`,
    [flowKey(chat), JSON.stringify(flow)]);
}

// ── 저녁 요약 문구 ──
export async function composeEvening(user, date = todayStr()) {
  const s = await dayScore(user, date);
  const [y, m, d] = date.split("-").map(Number);
  const lines = [`🌙 ${m}월 ${d}일 ${DAY[new Date(y, m - 1, d).getDay()]}요일 — 하루 닫기`];

  const pct = ratio(s.planned, s.done);
  lines.push(s.planned
    ? `오늘 계획 ${s.planned}개 중 ${s.done}개 완료 (${pct}%)`
    : "오늘은 계획에 잡아 둔 게 없었어요.");

  if (s.starPlanned) {
    const stars = s.tasks.filter(t => t.star_date === date);
    lines.push(`⭐ 핵심 ${s.starDone}/${s.starPlanned} — ` +
      stars.map(t => `${t.done ? "✅" : "⬜"} ${t.title}`).join("  "));
  }

  const left = leftovers(s);
  if (left.tasks.length) {
    lines.push("", "남은 할 일:");
    left.tasks.forEach((t, i) => lines.push(`  ${i + 1}. ${t.title}`));
  } else if (s.planned) {
    lines.push("", "남은 할 일 없음. 깔끔하네요.");
  }

  const st = await streak(user);
  if (st >= 2) lines.push("", `🔥 ${st}일 연속`);

  return { text: lines.join("\n"), score: s, left };
}

// 21:00 발송. 이미 닫은 날이면 보내지 않는다.
export async function sendEveningTo(user, chatId, date = todayStr()) {
  if ((await dayLog(user, date))?.closed_at) return false;
  const { text, left, score } = await composeEvening(user, date);
  // 보낸 시점의 계획 개수를 들고 간다 — 대화 중에 항목을 옮기면 분모가 줄어 버리므로
  await setFlow(chatId, {
    user, date, step: "idle", queue: left.tasks.map(t => t.id), note: null,
    base: { planned: score.planned, starPlanned: score.starPlanned },
  });
  const buttons = [];
  if (left.tasks.length) buttons.push([{ text: "📋 남은 것 정리", data: "rv|start" }]);
  buttons.push([{ text: "✍️ 회고 한 줄", data: "rv|note" }, { text: "✅ 그냥 닫기", data: "rv|close" }]);
  return sendTelegram(text, chatId, keyboard(buttons));
}

// ── 미완료 하나씩 묻기 ──
async function askNext(chat, messageId) {
  const flow = await getFlow(chat);
  if (!flow) return;
  while (flow.queue.length) {
    const id = flow.queue[0];
    const t = await get('SELECT * FROM tasks WHERE id = ? AND "user" = ?', [id, flow.user]);
    if (!t || t.done || t.archived) { flow.queue.shift(); continue; }  // 그 사이에 처리됐으면 건너뜀
    await setFlow(chat, flow);
    const body = `📋 "${t.title}"\n이건 어떻게 할까요?`;
    const kb = keyboard([
      [{ text: "➡️ 내일로", data: `rv|a|${id}|tomorrow` }, { text: "📆 이번 주 안에", data: `rv|a|${id}|week` }],
      [{ text: "🗑 버림", data: `rv|a|${id}|drop` }, { text: "그대로 둠", data: `rv|a|${id}|keep` }],
    ]);
    if (messageId) await api("editMessageText", { chat_id: chat, message_id: messageId, text: body, ...kb });
    else await sendTelegram(body, chat, kb);
    return;
  }
  await setFlow(chat, flow);
  await askNote(chat, messageId);
}

async function askNote(chat, messageId) {
  const body = "✍️ 오늘 하루, 스스로에게 한 줄 남긴다면?";
  const kb = keyboard([[{ text: "건너뛰기", data: "rv|skipnote" }]]);
  if (messageId) await api("editMessageText", { chat_id: chat, message_id: messageId, text: body, ...kb });
  else await sendTelegram(body, chat, kb);
  // 답장으로 받기 위해 별도 메시지 하나 더 (force_reply는 새 메시지에만 붙는다)
  await sendTelegram("답장으로 적어 주세요.", chat, forceReply());
  const flow = await getFlow(chat);
  if (flow) { flow.step = "note"; await setFlow(chat, flow); }
}

async function askMood(chat) {
  const flow = await getFlow(chat);
  if (flow) { flow.step = "mood"; await setFlow(chat, flow); }
  await sendTelegram("오늘 하루 점수는?", chat,
    keyboard([MOODS.slice(1).map((e, i) => ({ text: e, data: `rv|m|${i + 1}` }))]));
}

async function finish(chat, mood) {
  const flow = await getFlow(chat);
  if (!flow) return;
  const s = await closeDay(flow.user, flow.date, { note: flow.note, mood, base: flow.base });
  await setFlow(chat, null);
  const pct = ratio(s.planned, s.done);
  const st = await streak(flow.user);
  const bits = [`🌙 ${flow.date} 닫았어요. ${s.done}/${s.planned}${pct == null ? "" : ` (${pct}%)`}`];
  if (flow.note) bits.push(`“${flow.note}”`);
  if (st >= 2) bits.push(`🔥 ${st}일 연속`);
  await sendTelegram(bits.join("\n"), chat);
}

// ── 폴러가 넘겨주는 이벤트 처리 ──

// 인라인 버튼 탭. 처리했으면 true.
export async function handleCallback(cb) {
  const data = cb.data || "";
  const chat = cb.message?.chat?.id;
  const messageId = cb.message?.message_id;
  if (chat == null) return false;

  if (data.startsWith("rv|")) {
    const [, kind, a, b] = data.split("|");
    if (kind === "start") { await answerCallback(cb.id); await askNext(chat, messageId); return true; }
    if (kind === "note") { await answerCallback(cb.id); await askNote(chat, messageId); return true; }
    if (kind === "skipnote") { await answerCallback(cb.id); await editMessage(chat, messageId, "✍️ 회고는 건너뛰었어요."); await askMood(chat); return true; }
    if (kind === "close") { await answerCallback(cb.id, "닫는 중"); await editMessage(chat, messageId, "✅ 닫는 중…"); await askMood(chat); return true; }
    if (kind === "m") { await answerCallback(cb.id); await editMessage(chat, messageId, `오늘 하루 점수: ${MOODS[Number(a)] ?? ""}`); await finish(chat, Number(a)); return true; }
    if (kind === "a") {
      const flow = await getFlow(chat);
      if (!flow) { await answerCallback(cb.id, "이미 지난 회고예요"); return true; }
      const id = Number(a);
      // 버린 것만 분모에서 뺀다 (이월은 오늘의 미완료로 남는다)
      if (b === "drop" && flow.base) {
        const t = await get('SELECT star_date, done FROM tasks WHERE id = ? AND "user" = ?', [id, flow.user]);
        if (t && !t.done) {
          flow.base.planned = Math.max(0, flow.base.planned - 1);
          if (t.star_date === flow.date) flow.base.starPlanned = Math.max(0, flow.base.starPlanned - 1);
        }
      }
      await applyAction(flow.user, flow.date, id, b);
      flow.queue = flow.queue.filter(q => q !== id);
      await setFlow(chat, flow);
      await answerCallback(cb.id, { tomorrow: "내일로", week: "이번 주 안에", drop: "버렸어요", keep: "그대로" }[b] ?? "");
      await askNext(chat, messageId);
      return true;
    }
  }

  if (data.startsWith("od|")) {   // 아침 브리핑의 "밀린 할 일 아직 할 거야?"
    const [, a, b] = data.split("|");
    const owner = (await get('SELECT "user" FROM tg_link WHERE chat_id = ?', [String(chat)]))?.user;
    if (owner) await applyAction(owner, todayStr(), Number(a), b);
    const said = { star: "⭐ 오늘 핵심에 넣었어요.", week: "📆 이번 주 안으로 옮겼어요.", drop: "🗑 정리했어요." }[b] ?? "처리했어요.";
    await answerCallback(cb.id, said.slice(2));
    await editMessage(chat, messageId, said);
    return true;
  }
  return false;
}

// 회고 한 줄 답장. 처리했으면 true.
export async function handleText(chat, text) {
  const flow = await getFlow(chat);
  if (!flow || flow.step !== "note") return false;
  flow.note = text.slice(0, 300);
  flow.step = "idle";
  await setFlow(chat, flow);
  await sendTelegram(`📝 “${flow.note}”`, chat);
  await askMood(chat);
  return true;
}

// 한 항목에 대한 결정을 실제로 적용 (앱의 하루 닫기와 같은 규칙)
export async function applyAction(user, date, id, action) {
  if (!["tomorrow", "week", "drop", "star"].includes(action)) return;
  if (action === "star") {
    const n = Number((await get(
      'SELECT COUNT(*) AS c FROM tasks WHERE "user" = ? AND archived = 0 AND star_date = ?', [user, date]))?.c ?? 0);
    if (n < 3) await run('UPDATE tasks SET star_date = ? WHERE id = ? AND "user" = ?', [date, id, user]);
    return;
  }
  // day_log는 건드리지 않는다 (회고/점수는 마지막 finish에서 한 번에 저장)
  await applyActions(user, date, [{ id, action }])
    .catch(e => console.error("항목 처리 실패:", e.message));
}

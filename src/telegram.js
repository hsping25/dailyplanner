// 텔레그램 전송 공용 모듈. 브리핑/할일 알림/10분 전 알림이 함께 쓴다.
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
try { process.loadEnvFile(path.join(root, ".env")); } catch {}

const token = () => process.env.TELEGRAM_BOT_TOKEN;

/**
 * 전송 성공 시 true. chatId를 주면 그 대화로, 없으면 .env의 TELEGRAM_CHAT_ID(레거시 단일 사용자)로.
 */
export async function sendTelegram(text, chatId, extra = {}) {
  const t = token();
  const to = chatId || process.env.TELEGRAM_CHAT_ID;
  if (!t) {
    console.error("TELEGRAM_BOT_TOKEN이 .env에 없어 전송을 생략합니다. 보냈을 내용:");
    console.log(text);
    return false;
  }
  if (!to) {
    // 레거시: chat id가 아직 없을 때 안내 (멀티 사용자에선 앱에서 🔔로 연결)
    const j = await (await fetch(`https://api.telegram.org/bot${t}/getUpdates`)).json();
    const id = j.result?.at(-1)?.message?.chat?.id;
    console.error(id
      ? `TELEGRAM_CHAT_ID=${id} 를 .env에 추가하거나, 앱에서 🔔로 연결하세요.`
      : "앱에서 🔔(알림 연결)을 눌러 텔레그램을 연결하세요.");
    return false;
  }
  const j = await api("sendMessage", { chat_id: to, text, ...extra });
  if (!j.ok) throw new Error(`텔레그램 전송 실패: ${j.description}`);
  return true;
}

// 텔레그램 Bot API 호출 공용 (실패해도 던지지 않고 { ok:false } 를 돌려준다)
export async function api(method, body) {
  const t = token();
  if (!t) return { ok: false, description: "토큰 없음" };
  try {
    const res = await fetch(`https://api.telegram.org/bot${t}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return await res.json();
  } catch (e) { return { ok: false, description: e.message }; }
}

// 인라인 버튼 한 줄짜리 키보드 만들기: [[{text, data}], ...]
export const keyboard = rows => ({
  reply_markup: { inline_keyboard: rows.map(r => r.map(b => ({ text: b.text, callback_data: b.data }))) },
});

// 버튼을 누른 메시지 본문 바꾸기 (버튼은 없앤다 → 두 번 눌리지 않게)
export async function editMessage(chatId, messageId, text) {
  return api("editMessageText", { chat_id: chatId, message_id: messageId, text, reply_markup: { inline_keyboard: [] } });
}

// 버튼 탭에 대한 응답 (안 하면 텔레그램이 로딩 표시를 계속 돌린다)
export async function answerCallback(id, text) {
  return api("answerCallbackQuery", { callback_query_id: id, text });
}

// 다음 메시지를 답장으로 받고 싶을 때 (회고 한 줄 입력)
export const forceReply = () => ({ reply_markup: { force_reply: true, input_field_placeholder: "오늘 한 줄" } });

// 봇 유저네임 (딥링크 https://t.me/<유저네임>?start=<코드> 에 사용). 한 번 조회 후 캐시.
let botUsernameCache = null;
export async function getBotUsername() {
  if (botUsernameCache) return botUsernameCache;
  const t = token();
  if (!t) return null;
  try {
    const j = await (await fetch(`https://api.telegram.org/bot${t}/getMe`)).json();
    if (j.ok) botUsernameCache = j.result.username;
  } catch {}
  return botUsernameCache;
}

// getUpdates 원본 (연결 폴러 전용). offset 이후의 업데이트만.
export async function getUpdatesRaw(offset) {
  const t = token();
  if (!t) return [];
  try {
    const url = `https://api.telegram.org/bot${t}/getUpdates?timeout=0` + (offset ? `&offset=${offset}` : "");
    const j = await (await fetch(url)).json();
    return j.ok ? j.result : [];
  } catch { return []; }
}

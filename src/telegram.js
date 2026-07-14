// 텔레그램 전송 공용 모듈. 브리핑/할일 알림/10분 전 알림이 함께 쓴다.
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
try { process.loadEnvFile(path.join(root, ".env")); } catch {}

const token = () => process.env.TELEGRAM_BOT_TOKEN;

/**
 * 전송 성공 시 true. chatId를 주면 그 대화로, 없으면 .env의 TELEGRAM_CHAT_ID(레거시 단일 사용자)로.
 */
export async function sendTelegram(text, chatId) {
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
  const res = await fetch(`https://api.telegram.org/bot${t}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: to, text }),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(`텔레그램 전송 실패: ${j.description}`);
  return true;
}

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

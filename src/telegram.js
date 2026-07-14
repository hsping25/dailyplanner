// 텔레그램 전송 공용 모듈. 브리핑/할일 알림/10분 전 알림이 함께 쓴다.
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
try { process.loadEnvFile(path.join(root, ".env")); } catch {}

/** 전송 성공 시 true. 토큰/챗ID가 없으면 안내만 하고 false. */
export async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (token && !chatId) {
    // 봇에게 먼저 메시지를 보내놨다면 chat id를 찾아서 알려준다
    const j = await (await fetch(`https://api.telegram.org/bot${token}/getUpdates`)).json();
    const id = j.result?.at(-1)?.message?.chat?.id;
    console.error(id
      ? `TELEGRAM_CHAT_ID=${id} 를 .env에 추가한 뒤 다시 실행하세요.`
      : "텔레그램에서 봇에게 아무 메시지나 먼저 보낸 뒤 다시 실행하세요. chat id를 찾아드릴게요.");
    return false;
  }
  if (!token) {
    console.error("TELEGRAM_BOT_TOKEN이 .env에 없어 전송을 생략합니다. 보냈을 내용:");
    console.log(text);
    return false;
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(`텔레그램 전송 실패: ${j.description}`);
  return true;
}

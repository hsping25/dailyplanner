// 일정 텔레그램 알림: 시작 10분 전 + 정시, 총 2번. 서버(server.js)가 켜져 있는 동안 30초마다 확인한다.
// 이미 보낸 회차는 notified 테이블에 단계(lead/start)별 키로 기록해 중복 전송을 막는다.
import { get, run, dataVersion } from "./db.js";
import { pad, dateStr, loadEvents, expand } from "./day.js";
import { sendTelegram } from "./telegram.js";
import { linkedUsers } from "./tglink.js";

const LEAD_MIN = 10;      // 몇 분 전에 알릴지
const TICK_MS = 30_000;

const localIso = d => `${dateStr(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const hm = s => {
  const [h, m] = s.split("T")[1].split(":");
  return m === "00" ? `${Number(h)}시` : `${Number(h)}시 ${Number(m)}분`;
};

// 아이디별 일정 원본을 메모리에 들고 있다가 DB에 쓰기가 있을 때만 다시 읽는다.
// 펼치기(expand)는 순수 계산이라 시간창이 움직여도 DB가 필요 없다.
const loadedCache = new Map(); // user → { v, loaded }
async function cachedEvents(user) {
  const v = dataVersion();
  const c = loadedCache.get(user);
  if (c?.v === v) return c.loaded;
  const loaded = await loadEvents(user);
  loadedCache.set(user, { v, loaded });
  return loaded;
}

// 알림 키를 "보냄"으로 표시. 처음 표시하면 true, 이미 보낸 키면 false.
// 보낸 키는 메모리에도 기억해서, 같은 키를 또 물을 때 DB를 깨우지 않는다(일일 알림도 함께 쓴다).
// 메모리에 없을 때만 DB를 확인 — 서버가 재시작된 뒤 같은 알림을 또 보내지 않기 위해서.
const sentKeys = new Set();
export async function claimKey(key, when) {
  if (sentKeys.has(key)) return false;
  if (await get("SELECT 1 FROM notified WHERE key = ?", [key])) { sentKeys.add(key); return false; }
  await run("INSERT INTO notified (key, sent_at) VALUES (?, ?)", [key, when]);
  sentKeys.add(key);
  // 오래된 기록 정리 (일주일 지난 것). DB가 이미 깨어 있는 김에 한다.
  const cutoff = localIso(new Date(Date.now() - 7 * 86400000));
  await run("DELETE FROM notified WHERE sent_at < ?", [cutoff]);
  return true;
}

export async function tick(now = new Date()) {
  const winStart = localIso(now);
  const winEnd = localIso(new Date(now.getTime() + (LEAD_MIN + 1) * 60000));
  // 연결된 아이디마다 그 사람 일정을 그 사람 chat_id로
  for (const { user, chat_id } of await linkedUsers()) {
    for (const occ of expand(await cachedEvents(user), winStart, winEnd)) {
      if (occ.allday) continue; // 종일 일정은 시각 알림 없음
      const mins = Math.round((new Date(occ.start) - now) / 60000);
      // 두 단계: 10분 전(lead)과 정시(start). 단계별 키로 각각 한 번씩만 보낸다.
      // 정시는 1분 지각까지만 허용 — 서버가 한참 자다 깨서 뒷북 알림 보내는 걸 막는다.
      if (mins > LEAD_MIN || mins < -1) continue;
      const stage = mins > 0 ? "lead" : "start";
      const key = `${user}|${occ.eventId}|${occ.start}|${stage}`;
      if (!(await claimKey(key, winStart))) continue;
      try {
        const msg = stage === "lead"
          ? `⏰ ${mins}분 뒤 ${hm(occ.start)} ${occ.title}`
          : `⏰ 지금 ${hm(occ.start)} ${occ.title} 시작`;
        await sendTelegram(msg, chat_id);
      } catch (e) {
        console.error("일정 알림 실패:", e.message);
      }
    }
  }
}

export function startNotifier() {
  tick().catch(e => console.error("알림 확인 실패:", e.message));
  setInterval(() => tick().catch(e => console.error("알림 확인 실패:", e.message)), TICK_MS);
  console.log(`일정 ${LEAD_MIN}분 전 + 정시 알림 감시 시작 (${TICK_MS / 1000}초 간격)`);
}

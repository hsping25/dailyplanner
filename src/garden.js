// 정원(게이미피케이션). 할 일·일정을 끝내면 물을 받고, 그 물로 식물을 키운다.
// 물 잔고 = water_log(받은 기록)의 합 − plants.given(준 물)의 합. 따로 잔고 칸을 두지 않는다.
// water_log는 key(task:<id>, ev:<id>:<date>)로 한 번만 받는다. 체크를 풀면 그 기록을 지워
// 회수한다 — 껐다 켜며 물을 불리지 못하게. 이미 써 버렸다면 잔고가 잠깐 음수가 될 수 있다(정직하게 보인다).
// 식물은 물을 안 주면 시든다(죽지는 않음). 시든 식물에 준 물은 먼저 살리는 데 쓰이고, 그다음부터 자란다.
import { get, all, run, insert } from "./db.js";
import { todayStr, nowStamp } from "./day.js";

// growth(자라는 데 쓴 물)가 at 이상이면 그 단계. 마지막(꽃)이 다 자란 것.
export const STAGES = [
  { name: "씨앗", at: 0 },
  { name: "새싹", at: 3 },
  { name: "줄기", at: 8 },
  { name: "꽃봉오리", at: 15 },
  { name: "꽃", at: 25 },
];
export const GOAL = STAGES[STAGES.length - 1].at;
// 온실에 하나씩 쌓일 때마다 다음 종류로 (클라이언트가 이름으로 모양·색을 고른다)
export const KINDS = ["데이지", "해바라기", "코스모스", "도라지", "동백"];

// 물을 안 준 날 수 → 다시 살리는 데 드는 물. 3일째부터 시들고 5일째부터 많이 시든다.
const reviveNeed = dry => dry >= 5 ? 5 : dry >= 3 ? 2 : 0;
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

// ── 물 받기/회수 ── 바뀐 양(+amount / −amount / 0)을 돌려준다. 클라이언트가 잔고에 더해 보여 준다.
export async function earn(user, key, amount, label) {
  const r = await run(`INSERT INTO water_log ("user", key, amount, label, created) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT ("user", key) DO NOTHING`, [user, key, amount, label, nowStamp()]);
  return r.changes ? amount : 0;
}
export async function revoke(user, key) {
  const row = await get('SELECT amount FROM water_log WHERE "user" = ? AND key = ?', [user, key]);
  if (!row) return 0;
  await run('DELETE FROM water_log WHERE "user" = ? AND key = ?', [user, key]);
  return -Number(row.amount);
}

// 왕복 한 번으로 잔고 계산
export async function balance(user) {
  const r = await get(`SELECT
      (SELECT COALESCE(SUM(amount), 0) FROM water_log WHERE "user" = ?)
    - (SELECT COALESCE(SUM(given), 0) FROM plants WHERE "user" = ?) AS w`, [user, user]);
  return Number(r?.w ?? 0);
}

// 키우는 중인 식물(아이디당 하나). 없으면 새 씨앗을 심는다.
async function currentPlant(user) {
  const p = await get('SELECT * FROM plants WHERE "user" = ? AND grown_at IS NULL ORDER BY id LIMIT 1', [user]);
  if (p) return p;
  const n = Number((await get('SELECT COUNT(*) AS c FROM plants WHERE "user" = ?', [user]))?.c ?? 0);
  const today = todayStr();
  const id = await insert(`INSERT INTO plants ("user", kind, started, last_watered) VALUES (?, ?, ?, ?)`,
    [user, KINDS[n % KINDS.length], today, today]);
  return get("SELECT * FROM plants WHERE id = ?", [id]);
}

// 화면에 그릴 상태 (순수 계산). need = 살리는 데 남은 물, wilt = 0 싱싱 / 1 시듦 / 2 많이 시듦.
export function plantStatus(p, today = todayStr()) {
  const growth = Number(p.growth);
  let stage = 0;
  STAGES.forEach((s, i) => { if (growth >= s.at) stage = i; });
  const grown = growth >= GOAL;
  // 다 자란 꽃은 시들지 않는다(온실로 옮기기만 기다린다)
  const need = grown ? 0 : Math.max(Number(p.revive), reviveNeed(daysBetween(p.last_watered, today)));
  return {
    id: p.id, kind: p.kind, growth, stage, stageName: STAGES[stage].name, grown,
    toNext: grown ? 0 : STAGES[stage + 1].at - growth,
    need, wilt: need >= 5 ? 2 : need > 0 ? 1 : 0,
    started: p.started, lastWatered: p.last_watered,
  };
}

export async function gardenState(user) {
  const [p, water, greenhouse, recent] = await Promise.all([
    currentPlant(user),
    balance(user),
    all('SELECT kind, started, grown_at FROM plants WHERE "user" = ? AND grown_at IS NOT NULL ORDER BY id DESC', [user]),
    all('SELECT amount, label, created FROM water_log WHERE "user" = ? ORDER BY created DESC LIMIT 8', [user]),
  ]);
  return { water, plant: plantStatus(p), goal: GOAL, stages: STAGES, greenhouse, recent };
}

// n방울 주기. 잔고와 "더 줄 수 있는 만큼"(살리기 + 다 자랄 때까지) 중 작은 쪽만 쓴다.
export async function water(user, n) {
  const [p, bal] = await Promise.all([currentPlant(user), balance(user)]);
  const today = todayStr();
  const s = plantStatus(p, today);
  const use = Math.max(0, Math.min(n, bal, s.need + GOAL - s.growth));
  if (use > 0) {
    const heal = Math.min(use, s.need);
    await run("UPDATE plants SET given = given + ?, growth = ?, revive = ?, last_watered = ? WHERE id = ?",
      [use, s.growth + use - heal, s.need - heal, today, p.id]);
  }
  return use;
}

// 다 자란 꽃을 온실로 옮기고 새 씨앗을 심는다
export async function harvest(user) {
  const p = await currentPlant(user);
  if (Number(p.growth) < GOAL) return false;
  await run("UPDATE plants SET grown_at = ? WHERE id = ?", [todayStr(), p.id]);
  await currentPlant(user);
  return true;
}

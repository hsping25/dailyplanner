// AI 코멘트 — 하루 요약 + 피로도 + 계획 수정 제안, 그리고 주간 리포트.
//
// 숫자(피로도·달성률)는 **코드가 계산**하고, AI는 그 숫자를 읽고 말로 풀어 주기만 한다.
// AI에게 숫자를 지어내게 하면 매번 달라져서 의미가 없다. (달성률 규칙과 같은 정신)
//
// 수정 제안은 '필수'(must) 표시가 없는 것만 후보로 넘긴다. AI가 그래도 다른 걸 고르면 서버가 버린다.
// 제안 개수도 피로도에 맞춘다 — 여유로운 날엔 0개, 빡빡할 때만 몇 개. "적당히".
//
// 앱에서 버튼을 눌렀을 때만 부른다(백그라운드 루프 없음 → Neon도 API도 놀 때는 안 깨운다).
// 결과는 ai_notes에 입력 데이터의 지문(sig)과 함께 저장해, 계획이 그대로면 다시 부르지 않는다.
import { createHash } from "node:crypto";
import { get, all, run } from "./db.js";
import { dayWindow, shiftDate, todayStr, nowStamp, loadEvents, expand } from "./day.js";
import { tasksByDateInRange, scoresBetween, ratio, applyActions } from "./review.js";

// ── LLM 호출 (키는 .env: LLM_PROVIDER = gemini | anthropic | openai, LLM_MODEL) ──
// .env는 telegram.js가 읽어 들이므로 모듈 로드 시점이 아니라 쓸 때 읽는다
const provider = () => (process.env.LLM_PROVIDER || "gemini").toLowerCase();
const DEFAULT_MODEL = { gemini: "gemini-3-flash-preview", anthropic: "claude-haiku-5-5", openai: "gpt-5-mini" };

export function aiReady() {
  const PROVIDER = provider();
  const key = { gemini: "GEMINI_API_KEY", anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY" }[PROVIDER];
  return !!(key && process.env[key]);
}

// system + user 프롬프트를 보내고 JSON 객체를 돌려받는다
async function askJson(system, user) {
  const PROVIDER = provider();
  const model = process.env.LLM_MODEL || DEFAULT_MODEL[PROVIDER];
  const signal = AbortSignal.timeout(60_000);
  let text;
  if (PROVIDER === "gemini") {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST", signal,
      headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { responseMimeType: "application/json" },
      }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`Gemini ${r.status}: ${j.error?.message ?? ""}`);
    text = (j.candidates?.[0]?.content?.parts ?? []).map(p => p.text ?? "").join("");
  } else if (PROVIDER === "anthropic") {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", signal,
      headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 2000, system, messages: [{ role: "user", content: user }] }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`Anthropic ${r.status}: ${j.error?.message ?? ""}`);
    text = (j.content ?? []).filter(b => b.type === "text").map(b => b.text).join("");
  } else if (PROVIDER === "openai") {
    const base = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
    const r = await fetch(`${base}/chat/completions`, {
      method: "POST", signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model, response_format: { type: "json_object" },
        messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`OpenAI ${r.status}: ${j.error?.message ?? ""}`);
    text = j.choices?.[0]?.message?.content ?? "";
  } else {
    throw new Error(`모르는 LLM_PROVIDER: ${PROVIDER}`);
  }
  // 코드펜스로 감싸 오는 경우가 있어 첫 { ~ 마지막 } 만 잘라 읽는다
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s < 0 || e < s) throw new Error("AI 응답을 읽지 못했어요");
  return JSON.parse(text.slice(s, e + 1));
}

// ── 피로도 (0~100, 순수 계산) ──
// 무엇이 점수를 올렸는지(factors)를 같이 돌려줘서 숫자가 어디서 왔는지 보이게 한다.
const hhmm = s => s.slice(11, 16);
const mins = s => { const [h, m] = hhmm(s).split(":").map(Number); return h * 60 + m; };
// 하루는 04시에 시작하므로 04시 이전은 24시간 뒤로 본다(새벽 1시 = 25시)
const dayMin = (s, date) => mins(s) + (s.slice(0, 10) > date ? 24 * 60 : 0);
const fmtH = m => (m < 60 ? `${m}분` : m % 60 ? `${Math.floor(m / 60)}시간 ${m % 60}분` : `${m / 60}시간`);

export function fatigue(date, events, tasks, prev = null) {
  const timed = events.filter(e => !e.allday)
    .map(e => ({ s: dayMin(e.start, date), e: dayMin(e.end, date) }))
    .sort((a, b) => a.s - b.s);
  // 겹친 일정은 합쳐서 잰다 (같은 시간을 두 번 세지 않게)
  let busy = 0, curS = -1, curE = -1, tight = 0;
  for (const t of timed) {
    if (t.s > curE) { if (curE > curS) busy += curE - curS; if (curE >= 0 && t.s - curE <= 10) tight++; curS = t.s; curE = t.e; }
    else curE = Math.max(curE, t.e);
  }
  if (curE > curS) busy += curE - curS;
  const open = tasks.filter(t => !t.done && !t.archived);
  const late = timed.filter(t => t.e > 23 * 60).length;
  const early = timed.filter(t => t.s < 7 * 60).length;

  const parts = [];
  const add = (pts, label) => { if (pts > 0) parts.push({ pts: Math.round(pts), label }); };
  add(Math.min(50, busy / 60 * 6), `일정 ${fmtH(busy)}`);
  add(Math.min(20, open.length * 3), `남은 할 일 ${open.length}개`);
  add(Math.min(16, late * 8), `밤 11시 넘는 일정 ${late}개`);
  add(Math.min(10, early * 5), `아침 7시 전 일정 ${early}개`);
  add(Math.min(12, tight * 4), `쉴 틈 없이 붙은 일정 ${tight}번`);
  if (prev?.mood != null && prev.mood <= 2) add(8, "어제 기분 낮음");
  if (prev?.busy >= 8 * 60) add(6, "어제도 바빴음");

  const score = Math.min(100, parts.reduce((a, p) => a + p.pts, 0));
  const level = score >= 70 ? "빡빡" : score >= 40 ? "보통" : "여유";
  return { score, level, busyMin: busy, factors: parts.map(p => p.label) };
}
// 제안 개수 상한 — 여유로운 날엔 건드리지 않는다
const SUGGEST_CAP = { 여유: 0, 보통: 1, 빡빡: 3 };

// ── 캐시 ──
const sigOf = obj => createHash("sha1").update(JSON.stringify(obj)).digest("hex").slice(0, 16);
async function cached(user, kind, key) {
  const r = await get('SELECT sig, body, created FROM ai_notes WHERE "user" = ? AND kind = ? AND key = ?', [user, kind, key]);
  return r ? { sig: r.sig, created: r.created, ...JSON.parse(r.body) } : null;
}
async function save(user, kind, key, sig, body) {
  const created = nowStamp();
  await run(`INSERT INTO ai_notes ("user", kind, key, sig, body, created) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT ("user", kind, key) DO UPDATE SET sig=EXCLUDED.sig, body=EXCLUDED.body, created=EXCLUDED.created`,
    [user, kind, key, sig, JSON.stringify(body), created]);
  return created;
}
// 그 주에 하루라도 닫았는데 리포트를 아직 안 받았나 (앱의 ✨에 점을 찍을지)
export async function weekReportPending(user, monday) {
  const [rep, used] = await Promise.all([
    get('SELECT 1 FROM ai_notes WHERE "user" = ? AND kind = ? AND key = ?', [user, "week", monday]),
    get('SELECT 1 FROM day_log WHERE "user" = ? AND date >= ? AND date <= ? AND closed_at IS NOT NULL',
      [user, monday, shiftDate(monday, 6)]),
  ]);
  return !rep && !!used;
}

// ── 하루 ──
// 그날 데이터 + 피로도 + 수정 후보를 모은다. AI를 부르지 않아도 화면에 숫자는 바로 보여 줄 수 있게.
async function dayContext(user, date) {
  const yday = shiftDate(date, -1);
  const [loaded, byDate, ylog] = await Promise.all([
    loadEvents(user),
    tasksByDateInRange(user, yday, date),
    get('SELECT mood FROM day_log WHERE "user" = ? AND date = ?', [user, yday]),
  ]);
  // 마감·핵심이 없어도 plan_at이 그날인 할 일은 그날 할 일로 본다
  const planned = await all(
    `SELECT * FROM tasks WHERE "user" = ? AND archived = 0 AND plan_at >= ? AND plan_at < ?`,
    [user, `${date}T00:00`, `${shiftDate(date, 1)}T00:00`]);
  const tmap = new Map([...(byDate.get(date)?.values() ?? []), ...planned].map(t => [t.id, t]));
  const tasks = [...tmap.values()];
  const w = dayWindow(date), yw = dayWindow(yday);
  const events = expand(loaded, w.start, w.end);
  const yBusy = fatigue(yday, expand(loaded, yw.start, yw.end), [...(byDate.get(yday)?.values() ?? [])]).busyMin;
  const fat = fatigue(date, events, tasks, { mood: ylog?.mood ?? null, busy: yBusy });

  // 수정 후보: 필수가 아니고, 아직 안 했고, (오늘이면) 아직 시작 안 한 것만
  const now = nowStamp(), today = todayStr();
  const canTouch = date >= today;
  const items = [
    ...events.map(e => ({
      ref: `e${e.eventId}`, kind: "일정", title: e.title,
      when: e.allday ? "종일" : `${hhmm(e.start)}~${hhmm(e.end)}`,
      recurring: e.recurring, done: e.done, must: !!loaded.events.find(x => x.id === e.eventId)?.must,
      movable: canTouch && !e.done && !(date === today && e.start <= now),
    })),
    ...tasks.map(t => ({
      ref: `t${t.id}`, kind: "할 일", title: t.title,
      when: t.plan_at?.startsWith(date) ? `${hhmm(t.plan_at)}에 하기로` : t.due === date ? "오늘 마감" : "",
      star: t.star_date === date, done: !!t.done, archived: !!t.archived, must: !!t.must,
      spent: t.spent_min || 0,
      movable: canTouch && !t.done && !t.archived,
    })),
  ];
  for (const it of items) it.movable = it.movable && !it.must;
  return { date, fat, items };
}

const DAY_SYSTEM = `너는 한국어 개인 플래너 앱의 코치다. 사용자는 종이 플래너처럼 "실제로 하게 되는" 하루를 원한다.
말투: 다정하지만 짧고 구체적으로. 반말 금지, "~해요"체. 과장된 칭찬·이모지 남발 금지.
피로도 점수와 요인은 앱이 계산한 값이다. 숫자를 바꾸거나 새로 지어내지 말고 그대로 인용만 해라.
수정 제안 규칙:
- movable=true 인 항목만 제안할 수 있다. must=true(필수) 항목은 절대 제안하지 마라.
- 제안은 최대 cap개. 계획이 감당할 만하면 제안하지 말고 빈 배열을 돌려줘라. 억지로 채우지 마라.
- action: 할 일 → "tomorrow"(내일로) 또는 "week"(이번 주 안으로). 일정 → 반복이면 "skip"(이 날만 빼기), 단발이면 "tomorrow"(같은 시각 내일로).
- 핵심(star) 할 일은 가급적 남겨라.
지난 날이면 제안 없이 그날을 돌아보는 코멘트만 해라.
반드시 아래 JSON만 출력:
{"summary":"하루 요약 2~4문장","fatigue":"피로도에 대한 한두 문장","suggestions":[{"ref":"t12","action":"tomorrow","reason":"이유 한 문장"}]}`;

export async function dayNote(user, date, { force = false } = {}) {
  const ctx = await dayContext(user, date);
  const sig = sigOf([ctx.items, ctx.fat.score]);
  const prev = await cached(user, "day", date);
  const base = { date, fatigue: ctx.fat, ready: aiReady() };
  if (prev && (prev.sig === sig || !force)) return { ...base, note: prev, stale: prev.sig !== sig };
  if (!force && !prev) return { ...base, note: null, stale: false };
  if (!aiReady()) throw new Error("AI 키가 설정되지 않았어요 (.env의 GEMINI_API_KEY)");

  const cap = date < todayStr() ? 0 : SUGGEST_CAP[ctx.fat.level];
  const prompt = JSON.stringify({
    날짜: date, 지금: nowStamp(), 지난날: date < todayStr(),
    피로도: { 점수: ctx.fat.score, 수준: ctx.fat.level, 요인: ctx.fat.factors }, cap,
    항목: ctx.items,
  });
  const out = await askJson(DAY_SYSTEM, prompt);
  const byRef = new Map(ctx.items.map(i => [i.ref, i]));
  // AI가 규칙을 어겨도 여기서 거른다 — 필수/완료/지난 것, 모르는 ref, 맞지 않는 action, 상한 초과
  const seen = new Set();
  const suggestions = (Array.isArray(out.suggestions) ? out.suggestions : []).filter(s => {
    const it = byRef.get(s?.ref);
    if (!it?.movable || seen.has(s.ref)) return false;
    const ok = it.kind === "할 일" ? ["tomorrow", "week"] : [it.recurring ? "skip" : "tomorrow"];
    if (!ok.includes(s.action)) return false;
    seen.add(s.ref);
    return true;
  }).slice(0, cap).map(s => ({ ref: s.ref, action: s.action, title: byRef.get(s.ref).title, reason: String(s.reason ?? "") }));

  const body = { summary: String(out.summary ?? ""), fatigueText: String(out.fatigue ?? ""), suggestions };
  const created = await save(user, "day", date, sig, body);
  return { ...base, note: { ...body, created }, stale: false };
}

// 제안 적용. 필수 여부를 서버에서 다시 확인한다.
export async function applySuggestion(user, date, ref, action) {
  const id = Number(ref.slice(1));
  if (ref[0] === "t") {
    const t = await get('SELECT must FROM tasks WHERE id = ? AND "user" = ?', [id, user]);
    if (!t || t.must) return false;
    await applyActions(user, date, [{ id, action }]);
    return true;
  }
  const e = await get('SELECT * FROM events WHERE id = ? AND "user" = ?', [id, user]);
  if (!e || e.must) return false;
  if (action === "skip" && e.rrule) {
    await run(`INSERT INTO event_exceptions (event_id, date, kind) VALUES (?, ?, 'skip')
      ON CONFLICT (event_id, date) DO UPDATE SET kind = EXCLUDED.kind`, [id, date]);
    return true;
  }
  if (action === "tomorrow" && !e.rrule) {
    const shift = s => `${shiftDate(s.slice(0, 10), 1)}${s.slice(10)}`;
    await run('UPDATE events SET start = ?, "end" = ? WHERE id = ? AND "user" = ?', [shift(e.start), shift(e.end), id, user]);
    return true;
  }
  return false;
}

// ── 주간 리포트 ──
const WEEK_SYSTEM = `너는 한국어 개인 플래너 앱의 코치다. 한 주를 돌아보는 리포트를 쓴다.
말투: "~해요"체, 따뜻하지만 정직하게. 못 한 건 못 했다고 말하되 탓하지 않는다.
달성률·피로도 숫자는 앱이 계산한 값이다. 바꾸거나 지어내지 말고 인용만 해라.
사용자가 직접 쓴 회고(note)와 기분(mood 1~5)이 있으면 그 말을 존중해서 반영해라.
진행중=true면 오늘까지의 중간 점검이다. 남은 날은 평가하지 말고, next에는 남은 날에 할 것을 써라.
반드시 아래 JSON만 출력:
{"headline":"한 주를 한 줄로","summary":"3~5문장 요약","good":["잘한 점 1~3개"],"improve":["아쉬운 점 1~2개"],"next":["다음 주에 해 볼 것 1~3개, 구체적으로"]}`;

async function weekContext(user, monday) {
  const sunday = shiftDate(monday, 6);
  const [loaded, byDate, goals, prevScores] = await Promise.all([
    loadEvents(user),
    tasksByDateInRange(user, monday, sunday),
    all('SELECT title, done FROM goals WHERE "user" = ? AND week = ? ORDER BY id', [user, monday]),
    scoresBetween(user, shiftDate(monday, -7), shiftDate(monday, -1)),
  ]);
  // 진행 중인 주는 오늘까지만 센다 — 아직 오지 않은 날을 "못 한 날"로 치면 리포트가 거짓말을 한다
  const today = todayStr();
  const scores = await scoresBetween(user, monday, sunday < today ? sunday : today, loaded);
  const sum = arr => arr.reduce((a, s) => ({ p: a.p + s.planned, d: a.d + s.done }), { p: 0, d: 0 });
  const tot = sum(scores), prevTot = sum(prevScores);
  const days = scores.map(s => {
    const w = dayWindow(s.date);
    const tasks = [...(byDate.get(s.date)?.values() ?? [])];
    const f = fatigue(s.date, expand(loaded, w.start, w.end), tasks);
    return {
      date: s.date, 계획: s.planned, 완료: s.done, 버림: s.dropped, 핵심: `${s.starDone}/${s.starPlanned}`,
      닫음: s.closed, 기분: s.mood, 회고: s.note, 피로도: f.score,
    };
  });
  const allTasks = [...new Map([...byDate.entries()].filter(([d]) => d <= today)
    .flatMap(([, m]) => [...m.values()]).map(t => [t.id, t])).values()];
  return {
    주: `${monday} ~ ${sunday}`, 진행중: sunday >= today, 남은날: Math.max(0, 7 - scores.length),
    달성률: ratio(tot.p, tot.d), 지난주달성률: ratio(prevTot.p, prevTot.d),
    완료: tot.d, 계획: tot.p,
    집중분: allTasks.reduce((a, t) => a + (t.spent_min || 0), 0),
    해낸할일: allTasks.filter(t => t.done).map(t => t.title).slice(0, 30),
    버린할일: allTasks.filter(t => t.archived && !t.done).map(t => t.title).slice(0, 15),
    주간목표: goals.map(g => ({ 목표: g.title, 이룸: !!g.done })),
    요일별: days,
  };
}

export async function weekReport(user, monday, { force = false } = {}) {
  const ctx = await weekContext(user, monday);
  const sig = sigOf(ctx);
  const prev = await cached(user, "week", monday);
  const base = { monday, stats: { ratio: ctx.달성률, prevRatio: ctx.지난주달성률, done: ctx.완료, planned: ctx.계획, focusMin: ctx.집중분, inProgress: ctx.진행중 }, ready: aiReady() };
  if (prev && (prev.sig === sig || !force)) return { ...base, report: prev, stale: prev.sig !== sig };
  if (!force && !prev) return { ...base, report: null, stale: false };
  if (!aiReady()) throw new Error("AI 키가 설정되지 않았어요 (.env의 GEMINI_API_KEY)");

  const out = await askJson(WEEK_SYSTEM, JSON.stringify(ctx));
  const list = v => (Array.isArray(v) ? v : []).map(String).slice(0, 3);
  const body = {
    headline: String(out.headline ?? ""), summary: String(out.summary ?? ""),
    good: list(out.good), improve: list(out.improve), next: list(out.next),
  };
  const created = await save(user, "week", monday, sig, body);
  return { ...base, report: { ...body, created }, stale: false };
}


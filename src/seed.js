// 1단계에서 쓰던 가짜 데이터를 실제 DB에 넣는다. 여러 번 실행해도 초기화 후 다시 넣는다.
import { db } from "./db.js";

const pad = n => String(n).padStart(2, "0");
const now = new Date();
const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const shift = days => {
  const d = new Date(now);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

db.exec("DELETE FROM event_exceptions; DELETE FROM events; DELETE FROM tasks;");

const insEvent = db.prepare("INSERT INTO events (title, start, end, rrule) VALUES (?, ?, ?, ?)");
insEvent.run("아침 운동", `${today}T07:00`, `${today}T08:00`, "FREQ=DAILY");
insEvent.run("헬스", `${today}T19:00`, `${today}T20:00`, "FREQ=WEEKLY;BYDAY=TU,TH");
insEvent.run("독서실", `${today}T14:30`, `${today}T18:00`, null);
insEvent.run("민수랑 저녁", `${today}T20:30`, `${today}T22:00`, null);
insEvent.run("병원 예약", `${shift(3)}T10:00`, `${shift(3)}T11:00`, null);

const insTask = db.prepare("INSERT INTO tasks (title, due, done) VALUES (?, ?, ?)");
insTask.run("세탁소 옷 찾기", shift(-1), 0);
insTask.run("수학 숙제", today, 0);
insTask.run("자격증 시험 접수", null, 0);
insTask.run("방 청소", today, 1);

console.log("시드 완료:", today);

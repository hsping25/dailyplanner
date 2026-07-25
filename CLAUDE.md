# Daily Planner (개인용)

한국어 문장으로 일정을 등록하고, 오늘 할 일을 한눈에 보는 개인용 웹앱.
사용자 1명, 주 사용 기기: 삼성 폰 (세로, 좁은 화면).

## 왜 만드는가
구글 캘린더의 두 가지 문제를 해결하는 것이 이 앱의 전부다:
1. 한국어 자연어 입력이 제대로 안 된다 — "2시 30분 독서실"을 새벽 1시에 넣는다.
2. 정보가 빽빽해서 오늘 뭘 해야 하는지 한눈에 안 들어온다.

## 원칙 (항상 지킬 것)
- **구글 캘린더 연동은 하지 않는다.** OAuth 없음. 데이터는 SQLite에 직접 저장.
- **한눈에 들어오는 게 최우선.** 기능을 늘리기보다 화면에서 덜어내는 쪽을 택한다.
- **폰 화면(세로, 좁은 폭) 기준 디자인.** 글씨는 크게, 버튼은 손가락으로 누르기 편하게.
- **색 팔레트 고정:** 파랑(--accent)=단발 일정, 청록(--accent2)=반복 일정, 빨강(--warn)=지난 할 일. 이 셋 외의 색은 추가하지 않는다.
- **API 키는 서버 환경변수(.env)로.** 코드에 하드코딩 금지. `.env`는 `.gitignore`에 포함.
- 반복 일정은 날짜마다 복사해 저장하지 않는다. RRULE 문자열 하나만 저장하고 화면에 그릴 때 펼친다(`rrule` 라이브러리 사용). 예외(건너뛰기/수정)는 별도 목록으로 관리.
- 문장 파싱은 **정규식 전용**(`parseText(text, history)`, src/parse.js). LLM/API 키 사용 안 함. 못 알아들으면 `{kind:"unparsed"}` → 프론트가 "다시 말해 주세요" 안내.
- 핵심 구분: **시각 있으면 일정 / 시각 없으면 할 일**(날짜 있으면 그날이 마감). "동안"·시간범위 = 기간.
- 날짜: 오늘/내일/모레/글피, N월N일, `7/16`·`7-16`·`2026-07-16`, `16일`, `3일 뒤/안에`, 다음달N일, (다음/이번/저번)주 요일.
- 시각: 오전/오후/아침/점심/저녁/밤/새벽/낮 + N시(반/N분/정각), `14:30` 콜론(24시제·안 물음), 한글숫자(세시), 자정/정오. 범위 `2시~4시`·`2시부터 4시까지`·`14:00-16:00`.
- 마감 신호(할일): 까지/마감/안에. 시각 없는 "~하기/사기" 등도 할 일(마감 없음).
- 반복: 매일/평일/주말/매주·격주 요일/매달 N일. 여러 개는 "그리고"/줄바꿈. 시각 애매(1~12시 단서없음)면 오전/오후 되묻기(범위는 시작 기준). 반복+시각없음은 미지원.

## 기술 스택
- Node.js 백엔드 + 단일 HTML 페이지 프론트엔드
- 저장: **DATABASE_URL 있으면 Postgres(Neon), 없으면 로컬 SQLite 파일**. src/db.js가 async get/all/run/insert로 두 방언을 통일. 예약어 컬럼("user","end")은 항상 큰따옴표. id는 SERIAL(pg)/AUTOINCREMENT(sqlite). 스키마는 initDb()가 생성.
- DB 접근은 모두 async. 라우트는 ah() 래퍼로 감싸 에러를 500으로.
- 파싱: 정규식 전용 (src/parse.js), 외부 API 없음

## 아이디(멀티 유저)
- events/tasks에 `user` 칸(기본값 '기본'). 모든 API가 요청 아이디로 범위 제한.
- 아이디는 클라이언트가 localStorage('planner_user')에 저장, 모든 fetch에 `X-User` 헤더로 전송.
  헤더는 ASCII만 되므로 encodeURIComponent로 감싸 보내고 서버(userOf)가 decodeURIComponent로 복원.
- 비밀번호 없음 = 인증이 아니라 "칸막이". 주소+아이디 알면 접근 가능. 필요 시 비번 추가.
- **아이디별 텔레그램 알림**: 봇 하나로 아이디마다 각자 chat으로 전송. tg_link 테이블(user↔chat_id, code). 앱의 🔔 → POST /api/telegram/link → 딥링크 t.me/<봇>?start=<코드> → 사용자가 "시작" → 서버 폴러(src/tglink.js, getUpdates 4초)가 code 매칭해 연결. 스케줄러/notify는 linkedUsers()를 돌며 각자 전송. .env TELEGRAM_CHAT_ID가 있으면 NOTIFY_USER에 자동 연결(레거시). 수동 npm run brief는 NOTIFY_USER+env chat.
- 로그인 화면: 아이디 없으면 표시. 헤더의 @아이디 터치 → 다른 아이디로 전환.

## 데이터 모델
- event: user, 제목, 시작/종료 시각, RRULE 문자열(반복일 때), 예외 목록 별도(event_exceptions: skip/override), 종일 여부(allday)
- 일정 완료 체크: event_done 테이블(event_id, date) — 반복은 회차(date)별. 목록 오른쪽 체크박스. expandEvent가 occurrenceDate로 done 판정.
- task: user, 제목, 마감일(선택), 완료 여부
- memo: user, kind(text|draw), 내용(text=글, draw=PNG 데이터 URL), updated(수정 시각 — 최근 수정순 정렬용). API: /api/memos CRUD. 그림 때문에 express.json limit 5mb.
- 시각은 로컬 시각 문자열 "YYYY-MM-DDTHH:MM"로 저장 (KST 고정)
- **하루의 경계는 오전 4시.** "오늘" = [오늘 04:00, 내일 04:00). 시간표 뷰는 06시~다음날 04시 표시.
- RRULE 펼치기는 fake-UTC 기법 사용 (src/recur.js 주석 참고)

## 화면 구성 (읽기 화면)
- 맨 위: 날짜 이동 바(‹ 날짜 › + "오늘" 버튼) + 다크/라이트 토글(🌙/☀️). 그 아래 목록/시간표/메모장/타이머 전환 + @아이디.
- 히어로: 오늘이면 다음 일정, 다른 날이면 그날 요약.
- 목록 모드: 그날 일정(시간순, 반복 흐리게/단발 진하게) + 할 일 + 하단 주간 점(요일 탭=그날로 이동, 호버=미리보기 팝업).
- 시간표 모드: **일주일 전체**를 7열 타임라인(06시~다음날 04시)으로. 블록은 색+앞글자만, 탭/호버 시 팝업으로 세부(제목·시간·수정버튼).
- 날짜 이동은 두 모드 공통 ±1일. 시간표는 보는 날이 속한 주를 보여주고 그 날 열을 강조.
- 메모장 모드: 날짜와 무관한 자유 메모 목록(최근 수정순). "＋ 새 메모"로 추가, 카드의 textarea에 바로 쓰면 자동 저장(입력 멈춤 0.6초/포커스 아웃), 삭제 버튼(내용 있으면 confirm). 이 모드에선 히어로와 입력바를 감춘다.
- 그림 메모: "✏️ 그림" → 전체 화면 캔버스(펜/지우개/되돌리기 20단계/비우기, 포인터 이벤트+touch-action:none, dpr 배율). 저장 시 PNG 데이터 URL을 content에. 카드의 그림 탭 = 이어서 그리기(기존 그림을 캔버스에 contain으로 깔고 시작). 캔버스는 항상 흰 바탕+검정 펜(테마 무관).
- 타이머 모드: 서버/DB 없이 클라이언트 전용. 일반/포모도로 2종 미니 스위치. 일반=분·초 입력+프리셋(1·3·5·10·25분). 포모도로=집중·휴식 분 입력, 완료 시 집중↔휴식 자동 전환 반복(중지 전까지). 시작/일시정지(계속)/중지. 완료 시 WebAudio 삑2회+navigator.vibrate. 남은 시간은 목표 종료 시각(tmEndAt) 기준으로 계산해 폰이 잠들었다 깨어나도 정확. 실행 중엔 설정 입력/모드 스위치 잠금. 메모장처럼 히어로·입력바 숨김. 뷰 전환해도 인터벌은 계속 돎(새로고침하면 초기화).
- 팜 리젝션: 펜(pointerType=pen)이 한 번이라도 닿으면 penSeen=true → 그 세션에선 손가락(touch) 입력 무시(마우스는 항상 허용). 펜을 안 쓰면 손가락 그리기 그대로. 한 번에 한 포인터만(activePointer). 손가락으로 긋던 중 펜이 닿으면 그 손가락 획을 되돌리고 펜이 이어받음. openDraw마다 초기화.

## UI 상태/설정 (localStorage)
- planner_user(아이디), view(list|blocks|memo|timer), theme(auto|light|dark).
- 타이머: timer_mode(simple|pomo), timer_min/timer_sec(일반), timer_focus/timer_break(포모도로).
- 테마: html[data-theme]로 시스템 설정 덮어씀. CSS는 :root(라이트)/[data-theme=dark]/media(:not([data-theme]))로 3분기.
- 클라이언트 렌더는 loadDay(date)로 재렌더(위임 핸들러는 1회만 부착). /api/day 가 그날 데이터 + 그 주(week, 이벤트 full) 반환.
- 가로 모드: body max-width 720px, 시간표 열 넓힘 (@media orientation:landscape).

## 진행 단계
1. ✅ 읽기 화면 (가짜 데이터) — public/index.html
2. ✅ SQLite 저장소 + CRUD API — src/server.js (Node 내장 node:sqlite 사용, 실행: npm start, 시드: npm run seed)
3. ✅ 자연어 파싱 — src/parse.js (정규식 전용, LLM 없음, POST /api/parse). 반복·복수·되묻기 지원.
4. ✅ 입력창 + 등록 전 확인 + 겹침 경고 (GET /api/conflicts, 경고만 하고 막지 않음, 반복 새 일정은 첫 회차만 확인).
   일정/할 일 수정·삭제: 항목 터치 → 바텀시트 모달 (GET /api/events/:id + PUT/DELETE, tasks PATCH/DELETE). 반복은 "이 날짜만 빼기(skip)" / "반복 전체 삭제".
5. ✅ 아침 브리핑 — src/briefing.js (npm run brief). Windows 작업 스케줄러 "DailyPlannerBriefing"이 매일 07:00 실행. .env에 TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID 필요 (아직 미설정)
   - 알림 체계: 할 일은 마감 당일 07:00(브리핑 포함) + 14:00(src/remind-tasks.js, 스케줄러 "DailyPlannerTasks2pm", 남은 것 없으면 안 보냄).
     일정은 시작 10분 전 + 정시 총 2번(src/notify.js, 서버에 내장된 30초 감시 루프, notified 테이블에 단계별 키(lead/start)로 중복 방지, 정시는 1분 지각까지만). 텔레그램 전송은 src/telegram.js 공용.
6. ✅ PWA — public/manifest.json, public/sw.js, public/icons/ (아이콘 생성기: scripts/gen-icons.mjs).
   index.html에 manifest 링크 + theme-color(라이트/다크) + apple-touch-icon + SW 등록.
   SW는 /api/* 는 캐시하지 않음(항상 최신). 배포는 아래 "배포" 절 참고.

## 배포 (Render + UptimeRobot) — README.md에 사용자용 안내 있음
- 실행: `npm start`(=node src/server.js, 프로덕션). 로컬 개발은 `npm run dev`(nodemon). Node 24 필수(node:sqlite). `.node-version`=24, engines 지정.
- 알림 3종 모두 서버 안에서 동작: 일정 10분 전+정시(src/notify.js 30초 루프) + 07:00 브리핑/14:00 할 일(src/schedule.js, node-cron, KST). Windows 작업 스케줄러는 더 이상 불필요(로컬용 잔재는 지워도 됨).
- **시간대**: 날짜 로직이 서버 로컬시간=KST 가정. 클라우드(UTC)에선 **env TZ=Asia/Seoul 필수**. 아니면 '오늘' 계산이 9시간 어긋남. 서버 시작 시 offset≠540이면 경고 로그.
- **영속성**: 배포는 Neon Postgres(무료·영구). Render 환경변수 DATABASE_URL에 Neon 연결 문자열 넣으면 자동으로 Postgres 사용. 안 넣으면 SQLite(로컬/휘발). DB_PATH는 SQLite 파일 경로용(로컬).
- planner.db와 .env는 .gitignore → 깃/Render엔 안 올라감. Postgres는 최초 배포 때 빈 스키마로 시작.
- render.yaml = Render Blueprint(원클릭). /healthz = UptimeRobot용 헬스체크(5분 간격 핑 → 무료 티어 잠들기 방지).
- PWA 설치와 SW는 HTTPS에서만 동작(Render는 https 제공).

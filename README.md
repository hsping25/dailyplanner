# 오늘 — 한국어 일일 플래너

한국어 문장으로 일정을 등록하고, 오늘 할 일을 한눈에 보는 개인용 웹앱.
문장 파싱은 **정규식 전용**(외부 AI API 없음), 저장은 **SQLite 파일 하나**, 알림은 **텔레그램**.

## 기능
- 한국어 자연어 입력: "내일 저녁 7시 헬스", "매주 화목 아침 7시 운동", "수학 숙제 금요일까지"
- 등록 전 확인 카드 + 같은 시간대 겹침 경고
- 목록 뷰 / 시간표(블록) 뷰 전환, 주간 점 보기(◀▶ 이동)
- 일정·할 일 수정/삭제, 반복 일정은 "이 날짜만 빼기" 지원
- 아이디별 분리(멀티 프로필) — 아이디 입력 시 그 아이디 일정만 표시
- 텔레그램 알림: 아침 7시 브리핑 · 오후 2시 할 일 · 일정 10분 전
- PWA: 폰 홈 화면에 앱처럼 추가

## 로컬 실행
```bash
npm install
npm run dev        # 개발(자동 재시작). 배포용 실행은 npm start
```
`http://localhost:3456` 접속. 예시 데이터를 넣어보려면 `npm run seed`.

## 환경변수 (.env)
`.env.example`를 `.env`로 복사해서 채운다. 문장 파싱엔 키가 필요 없고, 텔레그램 알림에만 필요.
```
TELEGRAM_BOT_TOKEN=   # @BotFather로 봇 만들고 받은 토큰
TELEGRAM_CHAT_ID=     # 봇에게 메시지 한 번 보낸 뒤 npm run brief 하면 안내됨
NOTIFY_USER=기본       # 알림을 보낼 아이디
TZ=Asia/Seoul         # (클라우드에서 필수) 날짜/알림 시각 기준
```

## Render 배포 (무료 티어)
1. 이 저장소를 GitHub에 올린다.
2. Render 대시보드 → **New + → Blueprint** → 이 저장소 선택 (`render.yaml` 자동 인식).
   - 또는 **New + → Web Service**: Build `npm install`, Start `npm start`, Health Check Path `/healthz`.
3. 환경변수에 `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` 입력. `TZ=Asia/Seoul`, `NOTIFY_USER`는 blueprint에 이미 있음.
4. 배포되면 나오는 `https://...onrender.com` 주소를 폰에서 열고 홈 화면에 추가.

### ⚠️ 무료 티어의 데이터 보존 한계
Render 무료 웹 서비스는 디스크가 없어서 **재배포·재시작 때마다 SQLite(`planner.db`)가 초기화**된다.
데이터를 계속 보존하려면:
- 유료 인스턴스 + 영구 디스크: `render.yaml`의 `disk` 주석을 풀고 `DB_PATH=/data/planner.db` 추가, 또는
- 외부 DB(Postgres 등)로 전환 (코드 수정 필요).

## UptimeRobot으로 깨어 있게 하기
무료 티어는 15분간 요청이 없으면 잠든다(다음 접속이 느려지고, 그동안 10분 전 알림도 멈춤).
1. [UptimeRobot](https://uptimerobot.com)에서 **HTTP(s) 모니터** 생성.
2. URL: `https://<당신-앱>.onrender.com/healthz`
3. 간격: 5분.

이러면 서버가 계속 깨어 있어 10분 전 알림 루프와 매일 07:00/14:00 알림이 정상 동작한다.
(7시/14시 알림은 서버 안 스케줄러 `src/schedule.js`가 처리하므로 PC를 켜둘 필요 없음.)

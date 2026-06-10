# BSSM Stock
> 부산소프트웨어마이스터고등학교 교내 가상 주식 거래 시스템

<br>

## 뭐 만들었냐

학교 공간이랑 학급을 주식 종목으로 만들어서 사고파는 서비스  
나이스 API로 학사일정이랑 급식 메뉴를 불러와서 주가에 자동 반영되고  
관리자가 따로 뭔가 안 해도 알아서 돌아갑니다.

<br>

## 기술 스택

```
Backend  : Node.js + Express
DB       : MySQL 8.0
Frontend : HTML / CSS / JavaScript
Infra    : Docker Compose + nginx
외부 API  : NEIS 오픈API
```

<br>

접속 → http://localhost:70  

<br>

## 주요 기능

- 3개 거래소 — BSSM MARKET / CLASS / VENTURE (총 28종목)
- 30초마다 자동 주가 변동
- 나이스 API 연동 — 학사일정 이벤트 보정, 급식 메뉴로 급식소 주가 보정
- 서킷브레이커 자동 발동
- 배당금 / 출석 보너스 / 퀴즈로 혼자서 돈 벌 수 있음
- 예약 주문 (지정가 / 시간예약)
- 관리자 페이지 — 공시, 종목 관리, 유저 관리
- 상장 요청 시스템

<br>

## 주가 변동 시스템

30초마다 스케줄러가 실행되며 아래 요소들을 합산해 가격을 결정합니다.

```
새 가격 = 현재가 x (1 + 랜덤변동 + 거래량보정 + 이벤트보정)
```

### 1. 랜덤 변동
종목마다 설정된 `volatility` 기준으로 매 틱 랜덤 등락

| 거래소 | volatility |
|--------|-----------|
| BSSM MARKET  | 0.010 ~ 0.025 |
| BSSM CLASS   | 0.030 |
| BSSM VENTURE | 0.025 ~ 0.035 |

### 2. 거래량 보정
직전 30초 내 매수/매도 내역을 집계해 가격에 반영

```
netQty = 매수량 - 매도량
volRatio = min(총거래량 / 발행주식수, 10%)
보정값 = (netQty / 총거래량) x volRatio x 80

최대 ±8% / 거래 없으면 0
```

매수가 몰리면 가격 상승, 매도가 몰리면 하락  
발행주식수 대비 거래 비중이 클수록 보정 강도가 세짐

### 3. 이벤트 보정 (NEIS API)
학사일정 키워드를 감지해 관련 종목 자동 보정

| 일정 | 영향 종목 |
|------|----------|
| 체육대회 / 학예전 | 강당 +15%, 운동장 +15%, 매점 +10%, 도서관 -10% |
| 중간 / 기말고사  | 도서관 +18%, 위클래스실 +10%, 매점 +5% |
| 현장체험학습     | 해당 학년 반 -10% |
| 아이디어톤       | 강당 +10%, 도서관 +5% |
| 개교기념일       | 전체 +5% |
| 방학 / 휴업일    | 전체 거래 정지 |

급식 메뉴에 장어·삼겹살·치킨 등 프리미엄 메뉴가 포함되면 급식소 주가 상승,  
두부조림·나물 등이 포함되면 하락

### 4. 안전장치

```
상한가 / 하한가 : 당일 시작가(daily_open) 대비 ±15%
서킷브레이커 : 하락 -10% → 10분 거래 정지
            하락 -20% → 당일 거래 정지
거래 시간 : 평일 07:00 ~ 20:00 (KST)
```

## 테이블 구성

ddddd

<br>

## 디렉토리 구조

```
tutorial/
├── docker-compose.yml
├── .gitignore
├── README.md
├── mysql/
│   ├── Dockerfile
│   ├── conf/
│   │   └── my.cnf
│   └── init.sql
├── api/
│   ├── Dockerfile
│   ├── package.json
│   └── server.js
└── web/
    ├── Dockerfile
    └── src/
        ├── css/
        │   ├── common.css
        │   ├── index.css
        │   ├── login.css
        │   ├── trade.css
        │   ├── mypage.css
        │   ├── ranking.css
        │   ├── announce.css
        │   ├── quiz.css
        │   └── admin.css
        ├── js/
        │   └── nav.js
        ├── login.html
        ├── index.html
        ├── trade.html
        ├── mypage.html
        ├── ranking.html
        ├── quiz.html
        ├── announce.html
        └── admin.html
```# BSSM-Stock
# BSSM-Stock

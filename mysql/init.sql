SET NAMES utf8mb4;
SET CHARACTER SET utf8mb4;
USE study;

-- 1. 유저
CREATE TABLE IF NOT EXISTS user (
  user_id        BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id     VARCHAR(10)  NOT NULL UNIQUE COMMENT '학번 (학생) 또는 admin',
  name           VARCHAR(20)  NOT NULL,
  password       VARCHAR(100) NOT NULL COMMENT 'bcrypt 해시',
  is_admin       TINYINT(1)   NOT NULL DEFAULT 0,
  seed_money     BIGINT       NOT NULL DEFAULT 1000000,
  is_banned      TINYINT(1)   NOT NULL DEFAULT 0,
  seed_notify    TEXT         NULL COMMENT '관리자 시드머니 조정 알림 (JSON)',
  attend_days    INT          NOT NULL DEFAULT 0  COMMENT '총 누적 출석일',
  last_attend    DATE         NULL               COMMENT '마지막 출석일',
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 2. 종목
CREATE TABLE IF NOT EXISTS stock (
  stock_id        BIGINT AUTO_INCREMENT PRIMARY KEY,
  ticker_name     VARCHAR(50)  NOT NULL COMMENT '종목명',
  market          VARCHAR(20)  NOT NULL COMMENT 'BSSM_MARKET | BSSM_CLASS | BSSM_VENTURE',
  sector          VARCHAR(20)  NOT NULL COMMENT '섹터',
  current_price   INT          NOT NULL,
  base_price      INT          NOT NULL COMMENT '공모가 (상하한가 계산 기준은 daily_open)',
  daily_open      INT          NOT NULL COMMENT '당일 시가 (상하한가 기준)',
  total_shares    INT          NOT NULL COMMENT '총 발행 주식 수',
  volatility      FLOAT        NOT NULL DEFAULT 0.02 COMMENT '기본 변동폭',
  dividend_per_share INT       NOT NULL DEFAULT 0 COMMENT '주당 배당금',
  dividend_cycle  VARCHAR(10)  NOT NULL DEFAULT 'NONE' COMMENT 'DAILY | WEEKLY | EVENT | NONE',
  is_trading      TINYINT(1)   NOT NULL DEFAULT 1 COMMENT '거래 가능 여부',
  circuit_until   DATETIME     NULL COMMENT '서킷브레이커 해제 시각',
  circuit_reason  VARCHAR(100) NULL,
  listed_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 3. 주가 히스토리
CREATE TABLE IF NOT EXISTS price_history (
  history_id  BIGINT AUTO_INCREMENT PRIMARY KEY,
  stock_id    BIGINT   NOT NULL,
  price       INT      NOT NULL,
  recorded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_stock_time (stock_id, recorded_at),
  FOREIGN KEY (stock_id) REFERENCES stock(stock_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 4. 거래 내역
CREATE TABLE IF NOT EXISTS trade_log (
  trade_id   BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id    BIGINT      NOT NULL,
  stock_id   BIGINT      NOT NULL,
  trade_type VARCHAR(4)  NOT NULL COMMENT 'BUY | SELL',
  quantity   INT         NOT NULL,
  price      INT         NOT NULL,
  created_at DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id)  REFERENCES user(user_id),
  FOREIGN KEY (stock_id) REFERENCES stock(stock_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- 5. 보유 주식
CREATE TABLE IF NOT EXISTS holding (
  holding_id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id    BIGINT NOT NULL,
  stock_id   BIGINT NOT NULL,
  quantity   INT    NOT NULL DEFAULT 0,
  avg_price  INT    NOT NULL DEFAULT 0,
  UNIQUE KEY uq_user_stock (user_id, stock_id),
  FOREIGN KEY (user_id)  REFERENCES user(user_id),
  FOREIGN KEY (stock_id) REFERENCES stock(stock_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 6. 예약 주문
CREATE TABLE IF NOT EXISTS order_book (
  order_id     BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id      BIGINT      NOT NULL,
  stock_id     BIGINT      NOT NULL,
  order_type   VARCHAR(10) NOT NULL COMMENT 'LIMIT | TIME',
  trade_type   VARCHAR(4)  NOT NULL COMMENT 'BUY | SELL',
  quantity     INT         NOT NULL,
  limit_price  INT         NULL,
  execute_at   DATETIME    NULL,
  status       VARCHAR(10) NOT NULL DEFAULT 'PENDING' COMMENT 'PENDING | FILLED | CANCELLED',
  created_at   DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  filled_at    DATETIME    NULL,
  filled_price INT         NULL,
  INDEX idx_pending (status, stock_id),
  FOREIGN KEY (user_id)  REFERENCES user(user_id),
  FOREIGN KEY (stock_id) REFERENCES stock(stock_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 7. 공시
CREATE TABLE IF NOT EXISTS announcement (
  ann_id      BIGINT AUTO_INCREMENT PRIMARY KEY,
  title       VARCHAR(100) NOT NULL,
  content     TEXT         NOT NULL,
  ann_type    VARCHAR(20)  NOT NULL COMMENT 'EVENT | CIRCUIT | DIVIDEND | SYSTEM | QUIZ',
  stock_id    BIGINT       NULL COMMENT 'NULL이면 전체 공시',
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (stock_id) REFERENCES stock(stock_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 8. 배당금 지급 내역
CREATE TABLE IF NOT EXISTS dividend_log (
  div_id      BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id     BIGINT   NOT NULL,
  stock_id    BIGINT   NOT NULL,
  amount      INT      NOT NULL,
  quantity    INT      NOT NULL COMMENT '지급 당시 보유 수량',
  paid_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id)  REFERENCES user(user_id),
  FOREIGN KEY (stock_id) REFERENCES stock(stock_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 9. 출석 보너스 지급 내역
CREATE TABLE IF NOT EXISTS attend_log (
  attend_id   BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id     BIGINT   NOT NULL,
  amount      INT      NOT NULL,
  attend_days INT      NOT NULL COMMENT '달성 누적일',
  reason      VARCHAR(50) NOT NULL COMMENT 'DAILY | MILESTONE_10 | MILESTONE_30 | ...',
  paid_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES user(user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 10. 퀴즈
CREATE TABLE IF NOT EXISTS quiz (
  quiz_id     BIGINT AUTO_INCREMENT PRIMARY KEY,
  question    VARCHAR(200) NOT NULL,
  opt_a       VARCHAR(100) NOT NULL,
  opt_b       VARCHAR(100) NOT NULL,
  opt_c       VARCHAR(100) NOT NULL,
  opt_d       VARCHAR(100) NOT NULL,
  answer      CHAR(1)      NOT NULL COMMENT 'A | B | C | D',
  reward      INT          NOT NULL DEFAULT 3000,
  quiz_date   DATE         NOT NULL UNIQUE COMMENT '하루 1문제',
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS quiz_answer (
  ans_id    BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id   BIGINT   NOT NULL,
  quiz_id   BIGINT   NOT NULL,
  answer    CHAR(1)  NOT NULL,
  is_correct TINYINT(1) NOT NULL,
  answered_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_user_quiz (user_id, quiz_id),
  FOREIGN KEY (user_id) REFERENCES user(user_id),
  FOREIGN KEY (quiz_id) REFERENCES quiz(quiz_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 11. 서킷브레이커 이력
CREATE TABLE IF NOT EXISTS circuit_log (
  circuit_id  BIGINT AUTO_INCREMENT PRIMARY KEY,
  stock_id    BIGINT      NOT NULL,
  reason      VARCHAR(100) NOT NULL,
  triggered_at DATETIME   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resume_at   DATETIME    NOT NULL,
  FOREIGN KEY (stock_id) REFERENCES stock(stock_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- 12. 문의
CREATE TABLE IF NOT EXISTS inquiry (
  inquiry_id  BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id  VARCHAR(30) NOT NULL COMMENT '문의자 아이디 (비로그인이면 입력값)',
  name        VARCHAR(20) NOT NULL,
  content     TEXT        NOT NULL,
  is_read     TINYINT(1)  NOT NULL DEFAULT 0,
  created_at  DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- 13. 종목 추가 요청
CREATE TABLE IF NOT EXISTS stock_request (
  request_id    BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id       BIGINT       NOT NULL,
  ticker_name   VARCHAR(50)  NOT NULL COMMENT '요청 종목명',
  market        VARCHAR(20)  NOT NULL COMMENT 'BSSM_MARKET|BSSM_CLASS|BSSM_VENTURE',
  sector        VARCHAR(20)  NOT NULL,
  base_price    INT          NOT NULL COMMENT '제안 공모가',
  total_shares  INT          NOT NULL COMMENT '제안 발행주식수',
  reason        TEXT         NOT NULL COMMENT '신청 사유',
  status        VARCHAR(10)  NOT NULL DEFAULT 'PENDING' COMMENT 'PENDING|APPROVED|REJECTED',
  reject_reason VARCHAR(200) NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  handled_at    DATETIME     NULL,
  FOREIGN KEY (user_id) REFERENCES user(user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

---------- 종목 데이터 삽입 ------------

-- BSSM MARKET (대형주)
INSERT INTO stock (ticker_name, market, sector, current_price, base_price, daily_open, total_shares, volatility, dividend_per_share, dividend_cycle) VALUES
('급식소',     'BSSM_MARKET', '필수소비재', 10000, 10000, 10000, 1000, 0.015, 20,  'DAILY'),
('강당',       'BSSM_MARKET', '엔터',       8000,  8000,  8000,  800,  0.025, 0,   'EVENT'),
('운동장',     'BSSM_MARKET', '스포츠',     6000,  6000,  6000,  900,  0.025, 0,   'EVENT'),
('도서관',     'BSSM_MARKET', '교육',       6000,  6000,  6000,  1000, 0.015, 30,  'WEEKLY'),
('매점',       'BSSM_MARKET', '소비재',     5000,  5000,  5000,  1200, 0.020, 25,  'WEEKLY'),
('피트니스실', 'BSSM_MARKET', '스포츠',     4000,  4000,  4000,  600,  0.020, 15,  'WEEKLY'),
('기숙사 A동', 'BSSM_MARKET', '인프라',     7000,  7000,  7000,  800,  0.010, 50,  'WEEKLY'),
('기숙사 B동', 'BSSM_MARKET', '인프라',     7000,  7000,  7000,  800,  0.010, 50,  'WEEKLY'),
('커뮤니티홀', 'BSSM_MARKET', '엔터',       5000,  5000,  5000,  700,  0.025, 20,  'WEEKLY');

-- BSSM CLASS (학급주)
INSERT INTO stock (ticker_name, market, sector, current_price, base_price, daily_open, total_shares, volatility, dividend_per_share, dividend_cycle) VALUES
('1학년 1반', 'BSSM_CLASS', '학급', 3000, 3000, 3000, 400, 0.030, 0, 'NONE'),
('1학년 2반', 'BSSM_CLASS', '학급', 3000, 3000, 3000, 400, 0.030, 0, 'NONE'),
('1학년 3반', 'BSSM_CLASS', '학급', 3000, 3000, 3000, 400, 0.030, 0, 'NONE'),
('1학년 4반', 'BSSM_CLASS', '학급', 3000, 3000, 3000, 400, 0.030, 0, 'NONE'),
('2학년 1반', 'BSSM_CLASS', '학급', 3500, 3500, 3500, 400, 0.030, 0, 'NONE'),
('2학년 2반', 'BSSM_CLASS', '학급', 3500, 3500, 3500, 400, 0.030, 0, 'NONE'),
('2학년 3반', 'BSSM_CLASS', '학급', 3500, 3500, 3500, 400, 0.030, 0, 'NONE'),
('2학년 4반', 'BSSM_CLASS', '학급', 3500, 3500, 3500, 400, 0.030, 0, 'NONE'),
('3학년 1반', 'BSSM_CLASS', '학급', 4000, 4000, 4000, 400, 0.030, 0, 'NONE'),
('3학년 2반', 'BSSM_CLASS', '학급', 4000, 4000, 4000, 400, 0.030, 0, 'NONE'),
('3학년 3반', 'BSSM_CLASS', '학급', 4000, 4000, 4000, 400, 0.030, 0, 'NONE'),
('3학년 4반', 'BSSM_CLASS', '학급', 4000, 4000, 4000, 400, 0.030, 0, 'NONE');

-- BSSM VENTURE (소형주)
INSERT INTO stock (ticker_name, market, sector, current_price, base_price, daily_open, total_shares, volatility, dividend_per_share, dividend_cycle) VALUES
('과학실',     'BSSM_VENTURE', '기술',     3000, 3000, 3000, 500, 0.035, 0, 'NONE'),
('디자인실',   'BSSM_VENTURE', '크리에이티브', 3000, 3000, 3000, 500, 0.035, 0, 'NONE'),
('영어실',     'BSSM_VENTURE', '교육',     2500, 2500, 2500, 500, 0.025, 0, 'NONE'),
('위클래스실', 'BSSM_VENTURE', '헬스케어', 2000, 2000, 2000, 400, 0.020, 0, 'NONE'),
('베르실',     'BSSM_VENTURE', '교육인프라', 2000, 2000, 2000, 600, 0.025, 0, 'NONE'),
('보건실',     'BSSM_VENTURE', '헬스케어', 2500, 2500, 2500, 400, 0.020, 0, 'NONE'),
('택배보관함', 'BSSM_VENTURE', '물류',     1500, 1500, 1500, 800, 0.035, 0, 'NONE');

-- 초기 히스토리 시드
INSERT INTO price_history (stock_id, price)
SELECT stock_id, current_price FROM stock;

-- 아래 INSERT는 server.js의 initAdmin() 함수가 처리

-- 오늘의 퀴즈 샘플
INSERT INTO quiz (question, opt_a, opt_b, opt_c, opt_d, answer, reward, quiz_date) VALUES
('오늘 부산소마고 중식 칼로리는 몇 kcal인가요?', '650 Kcal', '750 Kcal', '850 Kcal 이상', '모름', 'C', 3000, CURDATE());
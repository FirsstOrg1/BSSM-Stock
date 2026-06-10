const express = require('express');
const mysql   = require('mysql2/promise');
const cors    = require('cors');
const https   = require('https');
const bcrypt  = require('bcrypt');

const app  = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// DB 연결
const pool = mysql.createPool({
  host:               process.env.DB_HOST     || 'mysql',
  port:               Number(process.env.DB_PORT) || 3306,
  user:               process.env.DB_USER     || 'root',
  password:           process.env.DB_PASSWORD || 'q1w2e3',
  database:           process.env.DB_NAME     || 'study',
  charset:            'utf8mb4',
  waitForConnections: true,
  connectionLimit:    10,
});

// 관리자 계정 초기화
async function initAdmin() {
  try {
    const [[existing]] = await pool.query(
      "SELECT user_id FROM user WHERE student_id = 'admin'"
    );
    if (!existing) {
      const hash = await bcrypt.hash('lackoy0q@@', 10);
      await pool.query(
        "INSERT INTO user (student_id, name, password, is_admin, seed_money) VALUES ('admin', '관리자', ?, 1, 999999999999)",
        [hash]
      );
      console.log('✅ 관리자 계정 생성 완료');
    }
  } catch (e) {
    console.error('[initAdmin]', e.message);
  }
}

async function waitForDB(retries = 15, delay = 3000) {
  for (let i = 0; i < retries; i++) {
    try {
      const conn = await pool.getConnection();
      conn.release();
      console.log('✅ DB 연결 성공');
      return;
    } catch (e) {
      console.log(`⏳ DB 대기 중... (${i + 1}/${retries})`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  console.error('❌ DB 연결 실패');
  process.exit(1);
}

// 나이스 API
const NEIS = {
  KEY:    process.env.NEIS_API_KEY    || '2c8af733841b46b3932d9cdaeec0c1fc',
  SCHOOL: process.env.NEIS_SCHOOL_CODE || '7150658',
  OFFICE: process.env.NEIS_OFFICE_CODE || 'C10',
};

// KST 기준 오늘 날짜 (YYYYMMDD)
function getKSTDateYMD() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10).replace(/-/g, '');
}

// KST 기준 올해
function getKSTYear() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.getFullYear().toString();
}

function neisGet(service, params) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams({
      KEY: NEIS.KEY, Type: 'json',
      ATPT_OFCDC_SC_CODE: NEIS.OFFICE,
      SD_SCHUL_CODE: NEIS.SCHOOL,
      ...params,
    }).toString();
    const url = `https://open.neis.go.kr/hub/${service}?${qs}`;
    https.get(url, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    }).on('error', reject);
  });
}

// 오늘 학사일정 조회
async function getTodaySchedule() {
  const ymd = getKSTDateYMD();
  const ay  = getKSTYear();
  try {
    const data = await neisGet('SchoolSchedule', { AY: ay, AA_FROM_YMD: ymd, AA_TO_YMD: ymd });
    const rows = data?.SchoolSchedule?.[1]?.row || [];
    return rows.map(r => ({
      date:   r.AA_YMD,
      name:   r.EVENT_NM,
      type:   r.SBTR_DD_SC_NM, // 휴업일 | 공휴일 | 해당없음
    }));
  } catch { return []; }
}

// 오늘 급식 조회
async function getTodayMeal() {
  const ymd = getKSTDateYMD();
  try {
    const data = await neisGet('mealServiceDietInfo', { MLSV_YMD: ymd });
    const rows = data?.mealServiceDietInfo?.[1]?.row || [];
    return rows.map(r => ({
      type:  r.MMEAL_SC_NM,  // 조식 | 중식 | 석식
      menu:  r.DDISH_NM?.replace(/<br\/>/g, ', ').replace(/\s*\([^)]*\)/g, ''),
      kcal:  parseFloat(r.CAL_INFO) || 0,
    }));
  } catch { return []; }
}

// 거래시간 체크 (07:00~20:00 평일)
let marketOpen   = true; // 나이스 API 기반 자동 개폐
let marketForced = null;  // 관리자 강제 설정: 'open' | 'close' | null

function isTradeTime() {
  // 관리자 강제 설정이 있으면 최우선 적용
  if (marketForced === 'open')  return true;
  if (marketForced === 'close') return false;
  // 주말 체크
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const day = kst.getUTCDay();
  if (day === 0 || day === 6) return false;
  // 거래 시간 체크 (07:00~20:00 KST)
  const h = kst.getUTCHours();
  if (h < 7 || h >= 20) return false;
  // 나이스 API 기반 휴장
  if (!marketOpen) return false;
  return true;
}

// 이벤트 → 종목 보정 규칙
const EVENT_RULES = [
  { keywords: ['체육대회', '학예전'],
    adjustments: { '강당': 15, '운동장': 15, '매점': 10, '도서관': -10 } },
  { keywords: ['중간고사', '기말고사'],
    adjustments: { '도서관': 18, '위클래스실': 10, '매점': 5 } },
  { keywords: ['현장체험학습'],
    gradeAdjust: -10 }, // 해당 학년 반 처리는 별도
  { keywords: ['아이디어톤'],
    adjustments: { '강당': 10, '도서관': 5 } },
  { keywords: ['개교기념일'],
    allAdjust: 5 },
];

// 급식 메뉴 → 급식소 보정
const PREMIUM_MENU = ['장어', '삼겹살', '치킨', '스테이크', '초밥', '피자', '탕수육', '갈비', '떡볶이', '돈까스'];
const BAD_MENU     = ['두부조림', '나물', '잡채', '콩나물'];

function calcMealAdjust(meals) {
  const lunch = meals.find(m => m.type === '중식');
  if (!lunch) return 0;
  const menu  = lunch.menu || '';
  let score   = 0;
  PREMIUM_MENU.forEach(k => { if (menu.includes(k)) score += 3; });
  BAD_MENU.forEach(k    => { if (menu.includes(k)) score -= 2; });
  if (lunch.kcal >= 900) score += 2;
  if (lunch.kcal <= 650) score -= 1;
  return Math.max(-8, Math.min(10, score)); // -8% ~ +10%
}

// 거래 체결 공통 함수
async function executeTrade(conn, { user_id, stock_id, trade_type, qty, price }) {
  const [[user]] = await conn.query(
    'SELECT * FROM user WHERE user_id = ? FOR UPDATE', [user_id]
  );
  if (!user) throw new Error('등록되지 않은 유저입니다.');
  const total = price * qty;

  if (trade_type === 'BUY') {
    if (!user.is_admin && user.seed_money < total) throw new Error('잔액이 부족합니다.');
    await conn.query('UPDATE user SET seed_money = seed_money - ? WHERE user_id = ?', [total, user_id]);
    const [[h]] = await conn.query(
      'SELECT * FROM holding WHERE user_id = ? AND stock_id = ? FOR UPDATE', [user_id, stock_id]
    );
    if (!h) {
      await conn.query(
        'INSERT INTO holding (user_id, stock_id, quantity, avg_price) VALUES (?, ?, ?, ?)',
        [user_id, stock_id, qty, price]
      );
    } else {
      const newQty = h.quantity + qty;
      const newAvg = Math.floor((h.avg_price * h.quantity + price * qty) / newQty);
      await conn.query(
        'UPDATE holding SET quantity = ?, avg_price = ? WHERE user_id = ? AND stock_id = ?',
        [newQty, newAvg, user_id, stock_id]
      );
    }
  } else {
    const [[h]] = await conn.query(
      'SELECT * FROM holding WHERE user_id = ? AND stock_id = ? FOR UPDATE', [user_id, stock_id]
    );
    if (!h || h.quantity < qty) throw new Error('보유 수량이 부족합니다.');
    await conn.query('UPDATE user SET seed_money = seed_money + ? WHERE user_id = ?', [total, user_id]);
    await conn.query(
      'UPDATE holding SET quantity = ? WHERE user_id = ? AND stock_id = ?',
      [h.quantity - qty, user_id, stock_id]
    );
  }
  await conn.query(
    'INSERT INTO trade_log (user_id, stock_id, trade_type, quantity, price) VALUES (?, ?, ?, ?, ?)',
    [user_id, stock_id, trade_type, qty, price]
  );
  return total;
}

// 다중 계정 방지 (IP 기반 가입 제한)
// 같은 IP에서 하루 3계정 이상 가입 불가
const registerAttempts = new Map(); // ip → { count, date }

function checkRegisterLimit(ip) {
  const today = new Date().toISOString().slice(0, 10);
  const rec   = registerAttempts.get(ip);
  if (!rec || rec.date !== today) {
    registerAttempts.set(ip, { count: 1, date: today });
    return true;
  }
  if (rec.count >= 3) return false;
  rec.count++;
  return true;
}

// AUTH

// POST /api/auth/check  — 학번 존재 여부 확인 (첫 로그인 분기용)
app.post('/api/auth/check', async (req, res) => {
  const { student_id } = req.body;
  if (!student_id) return res.status(400).json({ error: '아이디를 입력해주세요.' });
  try {
    const [[user]] = await pool.query(
      'SELECT user_id, name, is_admin FROM user WHERE student_id = ?', [student_id]
    );
    res.json({ exists: !!user, is_admin: user?.is_admin === 1 });
  } catch (e) {
    console.error('[check]', e);
    res.status(500).json({ error: 'DB 오류' });
  }
});

// POST /api/auth/register  — 신규 유저 등록
app.post('/api/auth/register', async (req, res) => {
  const { student_id, name, password } = req.body;
  if (!student_id || !name || !password)
    return res.status(400).json({ error: '아이디, 이름, 비밀번호를 모두 입력해주세요.' });
  if (password.length < 4)
    return res.status(400).json({ error: '비밀번호는 4자 이상이어야 합니다.' });
  if (student_id.length < 2)
    return res.status(400).json({ error: '아이디는 2자 이상이어야 합니다.' });
  if (student_id === 'admin')
    return res.status(400).json({ error: '사용할 수 없는 아이디입니다.' });
  // IP 기반 다중 계정 방지
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || '';
  if (!checkRegisterLimit(ip))
    return res.status(429).json({ error: '하루 가입 한도를 초과했습니다. (IP당 하루 3계정)' });
  try {
    const [[existing]] = await pool.query(
      'SELECT user_id FROM user WHERE student_id = ?', [student_id]
    );
    if (existing) return res.status(409).json({ error: '이미 사용 중인 아이디입니다.' });
    const hash = await bcrypt.hash(password, 10);
    const [r]  = await pool.query(
      'INSERT INTO user (student_id, name, password) VALUES (?, ?, ?)',
      [student_id, name, hash]
    );
    return res.json({ user_id: r.insertId, student_id, name, seed_money: 1000000, is_admin: 0 });
  } catch (e) {
    console.error('[register]', e);
    res.status(500).json({ error: 'DB 오류' });
  }
});

// POST /api/auth/login  — 로그인
app.post('/api/auth/login', async (req, res) => {
  const { student_id, password } = req.body;
  if (!student_id || !password)
    return res.status(400).json({ error: '아이디와 비밀번호를 입력해주세요.' });
  try {
    const [[user]] = await pool.query(
      'SELECT * FROM user WHERE student_id = ?', [student_id]
    );
    if (!user) return res.status(401).json({ error: '존재하지 않는 아이디입니다.' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: '비밀번호가 틀렸습니다.' });
    if (user.is_banned) return res.status(403).json({ error: '정지된 계정입니다. 관리자에게 문의하세요.' });
    return res.json({
      user_id:    user.user_id,
      student_id: user.student_id,
      name:       user.name,
      seed_money: user.seed_money,
      is_admin:   user.is_admin === 1,
    });
  } catch (e) {
    console.error('[login]', e);
    res.status(500).json({ error: 'DB 오류' });
  }
});

// STOCKS
// GET /api/stocks?market=BSSM_MARKET
app.get('/api/stocks', async (req, res) => {
  try {
    const { market } = req.query;
    const where = market ? 'WHERE s.market = ?' : '';
    const params = market ? [market] : [];
    const [stocks] = await pool.query(
      `SELECT * FROM stock ${where} ORDER BY market, stock_id`, params
    );
    const [histories] = await pool.query(
      'SELECT stock_id, price FROM price_history ORDER BY stock_id ASC, recorded_at DESC'
    );
    const histMap = {};
    for (const h of histories) {
      if (!histMap[h.stock_id]) histMap[h.stock_id] = [];
      if (histMap[h.stock_id].length < 40) histMap[h.stock_id].unshift(h.price);
    }
    res.json(stocks.map(s => ({
      ...s,
      history: histMap[s.stock_id]?.length > 0 ? histMap[s.stock_id] : [s.current_price],
    })));
  } catch (e) {
    console.error('[stocks]', e);
    res.status(500).json({ error: 'DB 오류' });
  }
});

// GET /api/market/status — 현재 거래 가능 여부 + 오늘 이벤트
app.get('/api/market/status', async (req, res) => {
  try {
    const schedule = await getTodaySchedule();
    const meals    = await getTodayMeal();
    const isOpen   = isTradeTime();
    const holidays = schedule.filter(s => ['휴업일','공휴일'].includes(s.type));
    const events   = schedule.filter(s => s.type === '해당없음');
    res.json({ isOpen, isTradeTime: isOpen, holidays, events, meals, neisAvailable: schedule.length > 0, forced: marketForced });
  } catch (e) {
    // 나이스 API 실패해도 기본 응답 반환
    res.json({ isOpen: isTradeTime(), isTradeTime: isTradeTime(), holidays: [], events: [], meals: [], neisAvailable: false, forced: marketForced });
  }
});

// USERS COUNT
app.get('/api/users/count', async (req, res) => {
  try {
    const [[row]] = await pool.query('SELECT COUNT(*) AS count FROM user');
    res.json({ count: row.count });
  } catch (e) { res.status(500).json({ error: 'DB 오류' }); }
});

// PORTFOLIO
// GET /api/portfolio/:user_id
app.get('/api/portfolio/:user_id', async (req, res) => {
  try {
    const uid = req.params.user_id;
    const [[user]] = await pool.query(
      'SELECT user_id, student_id, name, seed_money, attend_days, last_attend, seed_notify FROM user WHERE user_id = ?', [uid]
    );
    if (!user) return res.status(404).json({ error: '유저 없음' });

    const [holdings] = await pool.query(`
      SELECT h.stock_id, h.quantity, h.avg_price,
             s.ticker_name, s.current_price, s.base_price, s.market, s.sector
      FROM holding h
      JOIN stock s ON h.stock_id = s.stock_id
      WHERE h.user_id = ? AND h.quantity > 0
    `, [uid]);

    const [trade_logs] = await pool.query(`
      SELECT t.trade_type, t.quantity, t.price, t.created_at, s.ticker_name
      FROM trade_log t
      JOIN stock s ON t.stock_id = s.stock_id
      WHERE t.user_id = ?
      ORDER BY t.trade_id DESC LIMIT 20
    `, [uid]);

    const stock_value = holdings.reduce((sum, h) => sum + h.current_price * h.quantity, 0);
    const total_asset = user.seed_money + stock_value;
    const pnl         = total_asset - 1000000;
    const pnl_pct     = parseFloat(((pnl / 1000000) * 100).toFixed(2));

    // 시드머니 조정 알림 꺼내기
    let seed_notify = null;
    if (user.seed_notify) {
      try { seed_notify = JSON.parse(user.seed_notify); } catch {}
      await pool.query('UPDATE user SET seed_notify = NULL WHERE user_id = ?', [uid]);
    }
    res.json({ user, holdings, trade_logs, stock_value, total_asset, pnl, pnl_pct, seed_notify });
  } catch (e) {
    console.error('[portfolio]', e);
    res.status(500).json({ error: 'DB 오류' });
  }
});

// TRADE
// POST /api/trade
app.post('/api/trade', async (req, res) => {
  const { user_id, stock_id, trade_type, quantity } = req.body;

  // 관리자는 거래시간 제한 없음
  if (!isTradeTime()) {
    const [[u]] = await pool.query('SELECT is_admin FROM user WHERE user_id = ?', [user_id]);
    if (!u || !u.is_admin) return res.status(403).json({ error: '거래 시간이 아닙니다. (07:00~20:00 평일)' });
  }
  if (!user_id || !stock_id || !trade_type || !quantity)
    return res.status(400).json({ error: '필수 값 누락' });
  if (!['BUY','SELL'].includes(trade_type))
    return res.status(400).json({ error: 'trade_type은 BUY 또는 SELL' });
  const qty = parseInt(quantity);
  if (qty <= 0) return res.status(400).json({ error: '수량은 1 이상' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[stock]] = await conn.query('SELECT * FROM stock WHERE stock_id = ? FOR UPDATE', [stock_id]);
    if (!stock) throw new Error('존재하지 않는 종목입니다.');
    if (!stock.is_trading) throw new Error('현재 거래 정지된 종목입니다.');
    if (stock.circuit_until && new Date(stock.circuit_until) > new Date())
      throw new Error(`서킷브레이커 발동 중입니다. (${new Date(stock.circuit_until).toLocaleTimeString('ko-KR')} 해제)`);

    // 발행주식수 초과 체크 (매수 시)
    if (trade_type === 'BUY') {
      const [[totalHeld]] = await conn.query(
        'SELECT COALESCE(SUM(quantity), 0) AS total FROM holding WHERE stock_id = ?', [stock_id]
      );
      const [[trader]] = await conn.query('SELECT is_admin FROM user WHERE user_id = ?', [user_id]);
      if (!trader?.is_admin && totalHeld.total + qty > stock.total_shares)
        throw new Error(`발행 주식 수 초과입니다. (잔여: ${stock.total_shares - totalHeld.total}주)`);
    }

    await executeTrade(conn, { user_id, stock_id, trade_type, qty, price: stock.current_price });
    await conn.commit();

    const [[updated]] = await conn.query('SELECT seed_money FROM user WHERE user_id = ?', [user_id]);
    res.json({ success: true, price: stock.current_price, total_cost: stock.current_price * qty, seed_money: updated.seed_money });
  } catch (e) {
    await conn.rollback();
    console.error('[trade]', e);
    res.status(400).json({ error: e.message });
  } finally {
    conn.release();
  }
});

// ORDER BOOK
app.post('/api/orders', async (req, res) => {
  const { user_id, stock_id, order_type, trade_type, quantity, limit_price, execute_at } = req.body;
  if (!user_id || !stock_id || !order_type || !trade_type || !quantity)
    return res.status(400).json({ error: '필수 값 누락' });
  if (!['LIMIT','TIME'].includes(order_type))
    return res.status(400).json({ error: 'order_type은 LIMIT 또는 TIME' });
  if (order_type === 'LIMIT' && !limit_price)
    return res.status(400).json({ error: '지정가 입력 필요' });
  if (order_type === 'TIME' && !execute_at)
    return res.status(400).json({ error: '예약 시각 입력 필요' });
  const qty = parseInt(quantity);
  if (qty <= 0) return res.status(400).json({ error: '수량은 1 이상' });
  try {
    const [r] = await pool.query(
      'INSERT INTO order_book (user_id, stock_id, order_type, trade_type, quantity, limit_price, execute_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [user_id, stock_id, order_type, trade_type, qty, limit_price || null, execute_at || null]
    );
    res.json({ success: true, order_id: r.insertId });
  } catch (e) {
    console.error('[orders]', e);
    res.status(500).json({ error: 'DB 오류' });
  }
});

app.get('/api/orders/:user_id', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT o.*, s.ticker_name, s.current_price, s.market
      FROM order_book o
      JOIN stock s ON o.stock_id = s.stock_id
      WHERE o.user_id = ?
      ORDER BY o.created_at DESC LIMIT 30
    `, [req.params.user_id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'DB 오류' }); }
});

app.delete('/api/orders/:order_id', async (req, res) => {
  try {
    const { user_id } = req.body;
    const [r] = await pool.query(
      "UPDATE order_book SET status='CANCELLED' WHERE order_id=? AND user_id=? AND status='PENDING'",
      [req.params.order_id, user_id]
    );
    if (r.affectedRows === 0) return res.status(404).json({ error: '취소할 수 없는 주문입니다.' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'DB 오류' }); }
});

// 출석 체크
// POST /api/attend
app.post('/api/attend', async (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id 필요' });

  try {
    const [[user]] = await pool.query('SELECT * FROM user WHERE user_id = ?', [user_id]);
    if (!user) return res.status(404).json({ error: '유저 없음' });

    const today     = getKSTDateYMD().slice(0,4) + '-' + getKSTDateYMD().slice(4,6) + '-' + getKSTDateYMD().slice(6,8);
    const lastAttend = user.last_attend ? user.last_attend.toISOString?.().slice(0,10) || String(user.last_attend).slice(0,10) : null;

    if (lastAttend === today)
      return res.json({ already: true, attend_days: user.attend_days, seed_money: user.seed_money });

    // 출석 처리
    const newDays  = user.attend_days + 1;
    let   reward   = 1000;
    let   reason   = 'DAILY';
    const bonuses  = [];

    // 마일스톤 보너스
    const milestones = [
      { day: 10,  amount: 5000,   key: 'MILESTONE_10' },
      { day: 30,  amount: 20000,  key: 'MILESTONE_30' },
      { day: 50,  amount: 50000,  key: 'MILESTONE_50' },
      { day: 100, amount: 100000, key: 'MILESTONE_100' },
    ];
    for (const m of milestones) {
      if (newDays === m.day) {
        bonuses.push({ amount: m.amount, reason: m.key });
        reward += m.amount;
      }
    }

    const totalReward = reward;
    await pool.query(
      'UPDATE user SET seed_money = seed_money + ?, attend_days = ?, last_attend = ? WHERE user_id = ?',
      [totalReward, newDays, today, user_id]
    );
    await pool.query(
      'INSERT INTO attend_log (user_id, amount, attend_days, reason) VALUES (?, ?, ?, ?)',
      [user_id, 1000, newDays, 'DAILY']
    );
    for (const b of bonuses) {
      await pool.query(
        'INSERT INTO attend_log (user_id, amount, attend_days, reason) VALUES (?, ?, ?, ?)',
        [user_id, b.amount, newDays, b.reason]
      );
    }

    const [[updated]] = await pool.query('SELECT seed_money FROM user WHERE user_id = ?', [user_id]);
    res.json({ already: false, attend_days: newDays, reward: totalReward, bonuses, seed_money: updated.seed_money });
  } catch (e) {
    console.error('[attend]', e);
    res.status(500).json({ error: 'DB 오류' });
  }
});

// 퀴즈
app.get('/api/quiz/today', async (req, res) => {
  try {
    const today = getKSTDateYMD().replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
    const [[quiz]] = await pool.query(
      'SELECT quiz_id, question, opt_a, opt_b, opt_c, opt_d, reward, quiz_date FROM quiz WHERE quiz_date = ?', [today]
    );
    if (!quiz) return res.json({ quiz: null });
    res.json({ quiz });
  } catch (e) { res.status(500).json({ error: 'DB 오류' }); }
});

app.post('/api/quiz/answer', async (req, res) => {
  const { user_id, quiz_id, answer } = req.body;
  if (!user_id || !quiz_id || !answer)
    return res.status(400).json({ error: '필수 값 누락' });
  try {
    const [[quiz]] = await pool.query('SELECT * FROM quiz WHERE quiz_id = ?', [quiz_id]);
    if (!quiz) return res.status(404).json({ error: '퀴즈 없음' });

    const [[existing]] = await pool.query(
      'SELECT * FROM quiz_answer WHERE user_id = ? AND quiz_id = ?', [user_id, quiz_id]
    );
    if (existing) return res.json({ already: true, correct: existing.is_correct === 1 });

    const is_correct = answer === quiz.answer ? 1 : 0;
    await pool.query(
      'INSERT INTO quiz_answer (user_id, quiz_id, answer, is_correct) VALUES (?, ?, ?, ?)',
      [user_id, quiz_id, answer, is_correct]
    );

    if (is_correct) {
      await pool.query('UPDATE user SET seed_money = seed_money + ? WHERE user_id = ?', [quiz.reward, user_id]);
    }

    const [[updated]] = await pool.query('SELECT seed_money FROM user WHERE user_id = ?', [user_id]);
    res.json({ already: false, correct: is_correct === 1, reward: is_correct ? quiz.reward : 0, correct_answer: quiz.answer, seed_money: updated.seed_money });
  } catch (e) {
    console.error('[quiz]', e);
    res.status(500).json({ error: 'DB 오류' });
  }
});

// 공시
// GET /api/announcements
app.get('/api/announcements', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT a.*, s.ticker_name
      FROM announcement a
      LEFT JOIN stock s ON a.stock_id = s.stock_id
      ORDER BY a.created_at DESC LIMIT 20
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'DB 오류' }); }
});



// 종목 추가 요청

// POST /api/stock-request — 요청 등록
app.post('/api/stock-request', async (req, res) => {
  const { user_id, ticker_name, market, sector, base_price, total_shares, reason } = req.body;
  if (!user_id || !ticker_name || !market || !sector || !base_price || !total_shares || !reason)
    return res.status(400).json({ error: '모든 항목을 입력해주세요.' });
  if (!['BSSM_MARKET','BSSM_CLASS','BSSM_VENTURE'].includes(market))
    return res.status(400).json({ error: '잘못된 거래소입니다.' });
  if (base_price < 100 || base_price > 100000)
    return res.status(400).json({ error: '공모가는 100원~100,000원 사이로 설정해주세요.' });
  if (total_shares < 100 || total_shares > 10000)
    return res.status(400).json({ error: '발행주식수는 100~10,000주 사이로 설정해주세요.' });
  try {
    // 이미 같은 이름으로 pending 요청이 있으면 거절
    const [[dup]] = await pool.query(
      "SELECT request_id FROM stock_request WHERE ticker_name = ? AND status = 'PENDING'", [ticker_name]
    );
    if (dup) return res.status(409).json({ error: '이미 동일한 이름으로 대기 중인 요청이 있습니다.' });
    // 이미 상장된 종목명이면 거절
    const [[exist]] = await pool.query('SELECT stock_id FROM stock WHERE ticker_name = ?', [ticker_name]);
    if (exist) return res.status(409).json({ error: '이미 상장된 종목명입니다.' });

    const [r] = await pool.query(
      'INSERT INTO stock_request (user_id, ticker_name, market, sector, base_price, total_shares, reason) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [user_id, ticker_name, market, sector, base_price, total_shares, reason]
    );
    res.json({ success: true, request_id: r.insertId });
  } catch (e) {
    console.error('[stock-request]', e);
    res.status(500).json({ error: 'DB 오류' });
  }
});

// GET /api/stock-request/my/:user_id — 내 요청 목록
app.get('/api/stock-request/my/:user_id', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM stock_request WHERE user_id = ? ORDER BY created_at DESC',
      [req.params.user_id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'DB 오류' }); }
});

// GET /api/admin/stock-requests — 전체 요청 목록 (관리자)
app.get('/api/admin/stock-requests', async (req, res) => {
  if (!await checkAdmin(req, res)) return;
  try {
    const [rows] = await pool.query(`
      SELECT sr.*, u.student_id, u.name AS user_name
      FROM stock_request sr
      JOIN user u ON sr.user_id = u.user_id
      ORDER BY sr.created_at DESC
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'DB 오류' }); }
});

// POST /api/admin/stock-request/:id/approve — 승인 (즉시 상장)
app.post('/api/admin/stock-request/:id/approve', async (req, res) => {
  if (!await checkAdmin(req, res)) return;
  try {
    const [[req_row]] = await pool.query(
      "SELECT * FROM stock_request WHERE request_id = ? AND status = 'PENDING'",
      [req.params.id]
    );
    if (!req_row) return res.status(404).json({ error: '요청 없음 또는 이미 처리됨' });

    // stock 테이블에 INSERT
    await pool.query(`
      INSERT INTO stock (ticker_name, market, sector, current_price, base_price, daily_open, total_shares, volatility)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0.030)
    `, [req_row.ticker_name, req_row.market, req_row.sector,
        req_row.base_price, req_row.base_price, req_row.base_price, req_row.total_shares]);

    // 초기 히스토리 삽입
    const [[newStock]] = await pool.query('SELECT stock_id FROM stock WHERE ticker_name = ?', [req_row.ticker_name]);
    await pool.query('INSERT INTO price_history (stock_id, price) VALUES (?, ?)', [newStock.stock_id, req_row.base_price]);

    // 요청 상태 업데이트
    await pool.query(
      "UPDATE stock_request SET status='APPROVED', handled_at=NOW() WHERE request_id=?",
      [req.params.id]
    );

    // 공시 등록
    await pool.query(
      "INSERT INTO announcement (title, content, ann_type, stock_id) VALUES (?, ?, 'EVENT', ?)",
      [`[신규 상장] ${req_row.ticker_name}`, `${req_row.ticker_name}이(가) ${req_row.market.replace('BSSM_','')} 거래소에 신규 상장되었습니다. 공모가: ${req_row.base_price.toLocaleString()}원`, newStock.stock_id]
    );

    // 신청자에게 승인 알림
    try {
      const notifyData = JSON.stringify({ type: 'STOCK_APPROVED', ticker_name: req_row.ticker_name });
      console.log('[approve] seed_notify 저장 시도 user_id=' + req_row.user_id);
      const [nr] = await pool.query("UPDATE user SET seed_notify = ? WHERE user_id = ?", [notifyData, req_row.user_id]);
      console.log('[approve] affectedRows=' + nr.affectedRows);
    } catch (ne) {
      console.error('[approve] seed_notify 저장 실패:', ne.message);
    }

    res.json({ success: true, stock_id: newStock.stock_id });
  } catch (e) {
    console.error('[stock-request/approve]', e);
    res.status(500).json({ error: 'DB 오류' });
  }
});

// POST /api/admin/stock-request/:id/reject — 거절
app.post('/api/admin/stock-request/:id/reject', async (req, res) => {
  if (!await checkAdmin(req, res)) return;
  const { reject_reason } = req.body;
  try {
    await pool.query(
      "UPDATE stock_request SET status='REJECTED', reject_reason=?, handled_at=NOW() WHERE request_id=?",
      [reject_reason || '관리자 거절', req.params.id]
    );
    // 신청자에게 알림
    const [[req_row]] = await pool.query('SELECT user_id, ticker_name FROM stock_request WHERE request_id=?', [req.params.id]);
    if (req_row) {
      await pool.query(
        "UPDATE user SET seed_notify = ? WHERE user_id = ?",
        [JSON.stringify({ type: 'STOCK_REJECTED', ticker_name: req_row.ticker_name, reason: reject_reason || '관리자 거절' }), req_row.user_id]
      );
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'DB 오류' }); }
});

// ADMIN APIs

// 관리자 권한 체크 미들웨어
async function checkAdmin(req, res) {
  const adminId = req.body?.admin_id || req.headers['x-admin-id'];
  if (!adminId) { res.status(403).json({ error: '관리자 권한 필요' }); return false; }
  const [[user]] = await pool.query('SELECT is_admin FROM user WHERE user_id = ?', [adminId]);
  if (!user?.is_admin) { res.status(403).json({ error: '관리자 권한 없음' }); return false; }
  return true;
}

// GET /api/admin/users
app.get('/api/admin/users', async (req, res) => {
  if (!await checkAdmin(req, res)) return;
  try {
    const [rows] = await pool.query(`
      SELECT u.user_id, u.student_id, u.name, u.seed_money, u.attend_days,
            u.is_admin, u.is_banned,
            COALESCE(SUM(h.quantity * s.current_price), 0) + u.seed_money AS total_asset
      FROM user u
      LEFT JOIN holding h ON u.user_id = h.user_id AND h.quantity > 0
      LEFT JOIN stock s   ON h.stock_id = s.stock_id
      GROUP BY u.user_id
      ORDER BY total_asset DESC
    `);
    res.json(rows);
  } catch (e) { console.error('[admin/users]', e); res.status(500).json({ error: 'DB 오류' }); }
});

// POST /api/admin/market — 시장 제어
app.post('/api/admin/market', async (req, res) => {
  if (!await checkAdmin(req, res)) return;
  const { action } = req.body;
  try {
    if (action === 'open') {
      marketForced = 'open';
      await pool.query("INSERT INTO announcement (title, content, ann_type) VALUES ('시장 강제 개장', '관리자에 의해 시장이 강제 개장되었습니다.', 'SYSTEM')");
      res.json({ success: true, message: '시장 강제 개장 완료 (시간 제한 무시)' });
    } else if (action === 'close') {
      marketForced = 'close';
      await pool.query("INSERT INTO announcement (title, content, ann_type) VALUES ('시장 강제 휴장', '관리자에 의해 시장이 강제 휴장되었습니다.', 'SYSTEM')");
      res.json({ success: true, message: '시장 강제 휴장 완료' });
    } else if (action === 'reset_forced') {
      marketForced = null;
      res.json({ success: true, message: '강제 설정 해제 완료 (자동 모드 복귀)' });
    } else if (action === 'reset_circuit') {
      await pool.query('UPDATE stock SET circuit_until = NULL, circuit_reason = NULL');
      res.json({ success: true, message: '서킷브레이커 전체 해제 완료' });
    } else {
      res.status(400).json({ error: '알 수 없는 액션' });
    }
  } catch (e) { console.error('[admin/market]', e); res.status(500).json({ error: 'DB 오류' }); }
});

// POST /api/admin/reset-daily-open
app.post('/api/admin/reset-daily-open', async (req, res) => {
  if (!await checkAdmin(req, res)) return;
  try {
    await pool.query('UPDATE stock SET daily_open = current_price');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'DB 오류' }); }
});

// POST /api/admin/stock/trade — 거래 정지/재개
app.post('/api/admin/stock/trade', async (req, res) => {
  if (!await checkAdmin(req, res)) return;
  const { stock_id, is_trading } = req.body;
  try {
    await pool.query('UPDATE stock SET is_trading = ? WHERE stock_id = ?', [is_trading ? 1 : 0, stock_id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'DB 오류' }); }
});

// DELETE /api/admin/stock/circuit — 서킷브레이커 해제
app.delete('/api/admin/stock/circuit', async (req, res) => {
  if (!await checkAdmin(req, res)) return;
  const { stock_id } = req.body;
  try {
    await pool.query('UPDATE stock SET circuit_until = NULL, circuit_reason = NULL WHERE stock_id = ?', [stock_id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'DB 오류' }); }
});

// POST /api/admin/stock/price — 가격 직접 조정
app.post('/api/admin/stock/price', async (req, res) => {
  if (!await checkAdmin(req, res)) return;
  const { stock_id, price } = req.body;
  if (!stock_id || !price || price <= 0) return res.status(400).json({ error: '잘못된 요청' });
  try {
    await pool.query('UPDATE stock SET current_price = ? WHERE stock_id = ?', [price, stock_id]);
    await pool.query('INSERT INTO price_history (stock_id, price) VALUES (?, ?)', [stock_id, price]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'DB 오류' }); }
});

// POST /api/admin/dividend — 배당금 즉시 지급
app.post('/api/admin/dividend', async (req, res) => {
  if (!await checkAdmin(req, res)) return;
  const { stock_id } = req.body;
  try {
    const where  = stock_id ? 'WHERE stock_id = ? AND dividend_per_share > 0' : 'WHERE dividend_per_share > 0';
    const params = stock_id ? [stock_id] : [];
    const [stocks] = await pool.query(`SELECT * FROM stock ${where}`, params);
    let totalCount = 0;
    for (const s of stocks) {
      const [holders] = await pool.query('SELECT * FROM holding WHERE stock_id = ? AND quantity > 0', [s.stock_id]);
      for (const h of holders) {
        const amount = s.dividend_per_share * h.quantity;
        await pool.query('UPDATE user SET seed_money = seed_money + ? WHERE user_id = ?', [amount, h.user_id]);
        await pool.query('INSERT INTO dividend_log (user_id, stock_id, amount, quantity) VALUES (?, ?, ?, ?)', [h.user_id, s.stock_id, amount, h.quantity]);
        totalCount++;
      }
    }
    res.json({ success: true, count: totalCount });
  } catch (e) { console.error('[admin/dividend]', e); res.status(500).json({ error: 'DB 오류' }); }
});

// POST /api/admin/seed — 시드머니 조정
app.post('/api/admin/seed', async (req, res) => {
  if (!await checkAdmin(req, res)) return;
  const { student_id, amount, reason } = req.body;
  if (!student_id || !amount) return res.status(400).json({ error: '아이디와 금액 필요' });
  try {
    const [[user]] = await pool.query('SELECT user_id FROM user WHERE student_id = ?', [student_id]);
    if (!user) return res.status(404).json({ error: '유저 없음' });
    await pool.query('UPDATE user SET seed_money = seed_money + ?, seed_notify = ? WHERE user_id = ?',
      [amount, JSON.stringify({ amount, reason: reason || '관리자 조정' }), user.user_id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'DB 오류' }); }
});

// POST /api/admin/ban — 계정 정지/해제
app.post('/api/admin/ban', async (req, res) => {
  if (!await checkAdmin(req, res)) return;
  const { target_id, ban } = req.body;
  try {
    await pool.query('UPDATE user SET is_banned = ? WHERE user_id = ?', [ban ? 1 : 0, target_id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'DB 오류' }); }
});

// POST /api/admin/announce — 공시 발행 (이벤트 보정 포함)
app.post('/api/admin/announce', async (req, res) => {
  if (!await checkAdmin(req, res)) return;
  const { title, content, ann_type, stock_id, adj_pct, adj_dir } = req.body;
  if (!title || !content) return res.status(400).json({ error: '제목과 내용 필요' });
  try {
    await pool.query(
      'INSERT INTO announcement (title, content, ann_type, stock_id) VALUES (?, ?, ?, ?)',
      [title, content, ann_type || 'SYSTEM', stock_id || null]
    );
    // 이벤트 보정 적용
    if (stock_id && adj_pct && adj_pct > 0) {
      const [[s]] = await pool.query('SELECT current_price FROM stock WHERE stock_id = ?', [stock_id]);
      if (s) {
        const mult     = adj_dir === 'up' ? (1 + adj_pct / 100) : (1 - adj_pct / 100);
        const newPrice = Math.max(100, Math.round(s.current_price * mult));
        await pool.query('UPDATE stock SET current_price = ? WHERE stock_id = ?', [newPrice, stock_id]);
        await pool.query('INSERT INTO price_history (stock_id, price) VALUES (?, ?)', [stock_id, newPrice]);
      }
    }
    res.json({ success: true });
  } catch (e) { console.error('[admin/announce]', e); res.status(500).json({ error: 'DB 오류' }); }
});

// POST /api/admin/quiz — 퀴즈 등록
app.post('/api/admin/quiz', async (req, res) => {
  if (!await checkAdmin(req, res)) return;
  const { quiz_date, question, opt_a, opt_b, opt_c, opt_d, answer, reward } = req.body;
  if (!quiz_date || !question || !opt_a || !opt_b || !opt_c || !opt_d || !answer)
    return res.status(400).json({ error: '모든 항목 필요' });
  try {
    await pool.query(
      'INSERT INTO quiz (quiz_date, question, opt_a, opt_b, opt_c, opt_d, answer, reward) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE question=VALUES(question), opt_a=VALUES(opt_a), opt_b=VALUES(opt_b), opt_c=VALUES(opt_c), opt_d=VALUES(opt_d), answer=VALUES(answer), reward=VALUES(reward)',
      [quiz_date, question, opt_a, opt_b, opt_c, opt_d, answer, reward || 3000]
    );
    res.json({ success: true });
  } catch (e) { console.error('[admin/quiz]', e); res.status(500).json({ error: 'DB 오류' }); }
});

// GET /api/admin/quizzes
app.get('/api/admin/quizzes', async (req, res) => {
  if (!await checkAdmin(req, res)) return;
  try {
    const [rows] = await pool.query('SELECT * FROM quiz ORDER BY quiz_date DESC LIMIT 30');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'DB 오류' }); }
});


// -- 문의 ------------------------
// POST /api/inquiry — 문의 등록 (누구나)
app.post('/api/inquiry', async (req, res) => {
  const { student_id, name, content } = req.body;
  if (!name || !content) return res.status(400).json({ error: '이름과 내용을 입력해주세요.' });
  if (content.length > 500) return res.status(400).json({ error: '내용은 500자 이내로 입력해주세요.' });
  try {
    await pool.query(
      'INSERT INTO inquiry (student_id, name, content) VALUES (?, ?, ?)',
      [student_id || '비로그인', name, content]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'DB 오류' }); }
});

// GET /api/admin/inquiries — 문의 목록 (관리자)
app.get('/api/admin/inquiries', async (req, res) => {
  if (!await checkAdmin(req, res)) return;
  try {
    const [rows] = await pool.query(
      'SELECT * FROM inquiry ORDER BY created_at DESC LIMIT 50'
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'DB 오류' }); }
});

// PATCH /api/admin/inquiries/:id/read — 읽음 처리
app.patch('/api/admin/inquiries/:id/read', async (req, res) => {
  if (!await checkAdmin(req, res)) return;
  try {
    await pool.query('UPDATE inquiry SET is_read = 1 WHERE inquiry_id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'DB 오류' }); }
});

// 랭킹
app.get('/api/ranking', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT u.user_id, u.student_id, u.name, u.seed_money, u.attend_days,
             COALESCE(SUM(h.quantity * s.current_price), 0)                AS stock_value,
             u.seed_money + COALESCE(SUM(h.quantity * s.current_price), 0) AS total_asset
      FROM user u
      LEFT JOIN holding h ON u.user_id = h.user_id AND h.quantity > 0
      LEFT JOIN stock   s ON h.stock_id = s.stock_id
      WHERE u.is_admin = 0
      GROUP BY u.user_id
      ORDER BY total_asset DESC
    `);
    res.json(rows);
  } catch (e) {
    console.error('[ranking]', e);
    res.status(500).json({ error: 'DB 오류' });
  }
});

// 30초 스케줄러
async function processOrders(conn, stocks) {
  const now = new Date();
  const [orders] = await conn.query("SELECT * FROM order_book WHERE status='PENDING' FOR UPDATE");
  for (const order of orders) {
    const stock = stocks.find(s => s.stock_id === order.stock_id);
    if (!stock) continue;
    let fill = false;
    if (order.order_type === 'LIMIT') {
      if (order.trade_type === 'BUY'  && stock.newPrice <= order.limit_price) fill = true;
      if (order.trade_type === 'SELL' && stock.newPrice >= order.limit_price) fill = true;
    } else if (new Date(order.execute_at) <= now) {
      fill = true;
    }
    if (!fill) continue;
    try {
      await executeTrade(conn, { user_id: order.user_id, stock_id: order.stock_id, trade_type: order.trade_type, qty: order.quantity, price: stock.newPrice });
      await conn.query("UPDATE order_book SET status='FILLED', filled_at=NOW(), filled_price=? WHERE order_id=?", [stock.newPrice, order.order_id]);
      console.log(`✅ 예약체결: #${order.order_id} ${order.trade_type} ${order.quantity}주 @${stock.newPrice}`);
    } catch (e) {
      await conn.query("UPDATE order_book SET status='CANCELLED' WHERE order_id=?", [order.order_id]);
      console.log(`❌ 예약체결 실패: #${order.order_id} — ${e.message}`);
    }
  }
}

async function payDividends() {
  try {
    const now      = new Date();
    const isMonday = now.getDay() === 1;
    const hour     = now.getHours();
    if (hour !== 7) return; // 매일 07시 1회

    const [stocks] = await pool.query(
      "SELECT * FROM stock WHERE dividend_per_share > 0 AND (dividend_cycle='DAILY' OR (dividend_cycle='WEEKLY' AND ?))",
      [isMonday ? 1 : 0]
    );

    for (const stock of stocks) {
      const [holders] = await pool.query(
        'SELECT * FROM holding WHERE stock_id = ? AND quantity > 0', [stock.stock_id]
      );
      for (const h of holders) {
        const amount = stock.dividend_per_share * h.quantity;
        await pool.query('UPDATE user SET seed_money = seed_money + ? WHERE user_id = ?', [amount, h.user_id]);
        await pool.query(
          'INSERT INTO dividend_log (user_id, stock_id, amount, quantity) VALUES (?, ?, ?, ?)',
          [h.user_id, stock.stock_id, amount, h.quantity]
        );
      }
      if (holders.length > 0) {
        await pool.query(
          "INSERT INTO announcement (title, content, ann_type, stock_id) VALUES (?, ?, 'DIVIDEND', ?)",
          [`[배당] ${stock.ticker_name} 배당금 지급`, `${stock.ticker_name} 주주 여러분께 주당 ${stock.dividend_per_share}원 배당금이 지급되었습니다.`, stock.stock_id]
        );
        console.log(`💰 배당 지급: ${stock.ticker_name} (${holders.length}명)`);
      }
    }
  } catch (e) {
    console.error('[배당]', e.message);
  }
}

async function checkMarketOpen() {
  try {
    const schedule = await getTodaySchedule();
    // 나이스 API 실패 시 schedule이 빈 배열 → 기본적으로 거래 가능
    if (schedule.length === 0) {
      console.log('⚠️ 나이스 API 응답 없음 — 기본 거래 가능 상태 유지');
      marketOpen = true;
      return;
    }
    const isHoliday  = schedule.some(s => ['휴업일','공휴일'].includes(s.type));
    const isVacation = schedule.some(s => s.name?.includes('방학'));
    const wasOpen    = marketOpen;
    marketOpen       = !isHoliday && !isVacation;

    if (wasOpen && !marketOpen) {
      await pool.query("INSERT INTO announcement (title, content, ann_type) VALUES ('시장 휴장', '오늘은 휴장일입니다. 거래가 중단됩니다.', 'SYSTEM')");
      console.log('🔴 시장 휴장');
    } else if (!wasOpen && marketOpen) {
      // 당일 시가 갱신
      await pool.query('UPDATE stock SET daily_open = current_price');
      await pool.query("INSERT INTO announcement (title, content, ann_type) VALUES ('시장 개장', '오늘 시장이 개장되었습니다. 07:00부터 거래 가능합니다.', 'SYSTEM')");
      console.log('🟢 시장 개장');
    }
  } catch (e) {
    console.error('[marketCheck]', e.message);
  }
}

function startScheduler() {
  // 매일 00:00 시장 개폐 확인 + 시가 갱신
  setInterval(async () => {
    const now = new Date();
    if (now.getHours() === 0 && now.getMinutes() === 0) {
      await checkMarketOpen();
    }
    await payDividends();
  }, 60000); // 1분마다 체크

  // 30초마다 주가 변동
  setInterval(async () => {
    if (!isTradeTime()) return;

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [stocks] = await conn.query('SELECT * FROM stock FOR UPDATE');

      // 오늘 이벤트 + 급식 가져오기 (캐시 없으면 API 호출)
      const schedule = await getTodaySchedule();
      const meals    = await getTodayMeal();
      const mealAdj  = calcMealAdjust(meals);

      for (const s of stocks) {
        if (!s.is_trading) continue;
        if (s.circuit_until && new Date(s.circuit_until) > new Date()) continue;

        // 기본 랜덤 변동
        let adjPct = (Math.random() - 0.48) * s.volatility * 100;

        // 거래량 보정 — 직전 30초간 매수/매도 집계
        const [[vol]] = await conn.query(`
          SELECT
            COALESCE(SUM(CASE WHEN trade_type='BUY'  THEN quantity ELSE 0 END),0) AS buy_qty,
            COALESCE(SUM(CASE WHEN trade_type='SELL' THEN quantity ELSE 0 END),0) AS sell_qty
          FROM trade_log
          WHERE stock_id = ? AND created_at >= NOW() - INTERVAL 30 SECOND
        `, [s.stock_id]);

        const netQty   = vol.buy_qty - vol.sell_qty;  // 양수=매수우위, 음수=매도우위
        const totalVol = vol.buy_qty + vol.sell_qty;

        if (totalVol > 0) {
          // 거래량이 발행주식수의 몇 %인지 기준으로 보정 강도 결정
          // 최대 ±8% (발행주식수의 10% 이상 거래 시)
          const volRatio  = Math.min(totalVol / s.total_shares, 0.1); // 최대 10%
          const maxEffect = 8;  // 최대 보정폭 (%)
          const volEffect = (netQty / totalVol) * volRatio * maxEffect * 10;
          adjPct += Math.max(-maxEffect, Math.min(maxEffect, volEffect));
        }

        // 이벤트 보정 적용
        for (const rule of EVENT_RULES) {
          const matched = rule.keywords.some(k => schedule.some(e => e.name?.includes(k)));
          if (!matched) continue;

          if (rule.allAdjust) {
            adjPct += rule.allAdjust;
          }
          if (rule.adjustments?.[s.ticker_name] !== undefined) {
            adjPct += rule.adjustments[s.ticker_name];
          }
          if (rule.gradeAdjust && s.market === 'BSSM_CLASS') {
            // 현장체험학습: 해당 학년 반에만 적용 (이벤트 학년 파싱)
            const ev = schedule.find(e => rule.keywords.some(k => e.name?.includes(k)));
            if (ev) {
              const g1 = ev.ONE_GRADE_EVENT_YN === 'Y' && s.ticker_name.startsWith('1학년');
              const g2 = ev.TW_GRADE_EVENT_YN  === 'Y' && s.ticker_name.startsWith('2학년');
              const g3 = ev.THREE_GRADE_EVENT_YN === 'Y' && s.ticker_name.startsWith('3학년');
              if (g1 || g2 || g3) adjPct += rule.gradeAdjust;
            }
          }
        }

        // 급식소 메뉴 보정
        if (s.ticker_name === '급식소') adjPct += mealAdj;

        // 상한가/하한가 적용 (±15%)
        const dailyChangePct = ((s.current_price - s.daily_open) / s.daily_open) * 100;
        const remainUp   = 15 - dailyChangePct;
        const remainDown = -15 - dailyChangePct;
        adjPct = Math.max(remainDown, Math.min(remainUp, adjPct));

        const newPrice = Math.max(100, Math.round(s.current_price * (1 + adjPct / 100)));
        s.newPrice = newPrice;

        await conn.query('UPDATE stock SET current_price = ? WHERE stock_id = ?', [newPrice, s.stock_id]);
        await conn.query('INSERT INTO price_history (stock_id, price) VALUES (?, ?)', [s.stock_id, newPrice]);

        // 히스토리 100틱 유지
        await conn.query(`
          DELETE FROM price_history WHERE stock_id = ?
          AND history_id NOT IN (
            SELECT history_id FROM (
              SELECT history_id FROM price_history WHERE stock_id = ? ORDER BY recorded_at DESC LIMIT 100
            ) t
          )
        `, [s.stock_id, s.stock_id]);

        // 서킷브레이커 체크
        const newChangePct = ((newPrice - s.daily_open) / s.daily_open) * 100;
        if (newChangePct <= -10 && !s.circuit_until) {
          const resume = new Date(Date.now() + 10 * 60 * 1000);
          await conn.query(
            'UPDATE stock SET circuit_until = ?, circuit_reason = ? WHERE stock_id = ?',
            [resume, '10% 이상 하락 — 10분 거래 정지', s.stock_id]
          );
          await conn.query(
            "INSERT INTO circuit_log (stock_id, reason, resume_at) VALUES (?, '10% 이상 하락', ?)",
            [s.stock_id, resume]
          );
          await conn.query(
            "INSERT INTO announcement (title, content, ann_type, stock_id) VALUES (?, ?, 'CIRCUIT', ?)",
            [`[서킷브레이커] ${s.ticker_name}`, `${s.ticker_name}이(가) 급락하여 10분간 거래가 정지됩니다.`, s.stock_id]
          );
          console.log(`🚨 서킷브레이커: ${s.ticker_name}`);
        }
        // 당일 -20% → 당일 거래 정지
        if (newChangePct <= -20) {
          const eod = new Date(); eod.setHours(23, 59, 59);
          await conn.query('UPDATE stock SET circuit_until = ?, circuit_reason = ? WHERE stock_id = ?',
            [eod, '20% 이상 하락 — 당일 거래 정지', s.stock_id]);
          console.log(`🚨 당일 정지: ${s.ticker_name}`);
        }
        // 서킷브레이커 해제
        if (s.circuit_until && new Date(s.circuit_until) < new Date()) {
          await conn.query('UPDATE stock SET circuit_until = NULL, circuit_reason = NULL WHERE stock_id = ?', [s.stock_id]);
        }
      }

      // 예약 주문 처리
      await processOrders(conn, stocks);
      await conn.commit();
      console.log(`📈 주가 변동 완료 (${new Date().toLocaleTimeString('ko-KR')})`);
    } catch (e) {
      await conn.rollback();
      console.error('[스케줄러]', e.message);
    } finally {
      conn.release();
    }
  }, 30000);
}

// 서버 시작
waitForDB().then(async () => {
  await initAdmin();
  await checkMarketOpen();
  startScheduler();
  app.listen(PORT, () => console.log(`🚀 BSSM Stock API → http://0.0.0.0:${PORT}`));
});
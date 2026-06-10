/**
 * nav.js — BSSM Stock 공통 모듈 v3.0
 */

const API_BASE  = 'http://localhost:3000/api';
const userId    = sessionStorage.getItem('userId');
const studentId = sessionStorage.getItem('studentId');
const userName  = sessionStorage.getItem('userName');
const isAdmin   = sessionStorage.getItem('isAdmin') === '1';

const PUBLIC_PAGES = ['index.html', ''];
const curPage = location.pathname.split('/').pop();
if (!userId && !PUBLIC_PAGES.includes(curPage)) {
  alert('로그인이 필요합니다.');
  window.location.href = 'login.html';
}

document.addEventListener('DOMContentLoaded', function() {
  const elSid  = document.getElementById('navStudentId');
  const elName = document.getElementById('navName');
  const elSeed = document.getElementById('navSeed');
  if (elSid)  elSid.textContent  = studentId || '-';
  if (elName) elName.textContent = userName  || '-';
  if (!userId) {
    if (elSeed) elSeed.style.display = 'none';
    const lb = document.querySelector('.btn-logout');
    if (lb) lb.style.display = 'none';
  }
  if (isAdmin && userId) {
    const links = document.querySelector('.nav-links');
    if (links) {
      const a = document.createElement('a');
      a.href = 'admin.html';
      a.textContent = '관리자';
      a.style.cssText = 'color:var(--up) !important;';
      if (location.pathname.endsWith('admin.html')) a.classList.add('active');
      links.appendChild(a);
    }
  }
  // 테마 복원
  const saved = localStorage.getItem('theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
  const btn = document.getElementById('themeBtn');
  if (btn) btn.textContent = saved === 'dark' ? '라이트' : '다크';
});

// 시드머니 알림 팝업
function showSeedNotify(notify, curSeed) {
  const old = document.getElementById('seedNotifyModal');
  if (old) old.remove();
  const overlay = document.createElement('div');
  overlay.id = 'seedNotifyModal';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9998;display:flex;align-items:center;justify-content:center;';

  const closeBtn = 'onclick="document.getElementById(\'seedNotifyModal\').remove()"';
  let inner = '';

  if (notify.type === 'STOCK_APPROVED') {
    inner = '<div style="background:var(--bg2);border:1px solid rgba(34,197,94,0.3);border-top:3px solid #22c55e;border-radius:14px;padding:32px;max-width:360px;width:90%;text-align:center;">'
      + '<div style="font-size:32px;margin-bottom:12px">🎉</div>'
      + '<div style="font-size:17px;font-weight:600;color:var(--text);margin-bottom:8px">종목 상장 승인</div>'
      + '<div style="font-size:16px;font-weight:700;color:#22c55e;margin-bottom:8px">' + notify.ticker_name + '</div>'
      + '<div style="font-size:13px;color:var(--text2);margin-bottom:24px">요청하신 종목이 상장되었습니다.</div>'
      + '<button ' + closeBtn + ' style="background:#22c55e;border:none;border-radius:8px;padding:10px 28px;font-size:13px;font-weight:600;color:#fff;cursor:pointer;font-family:inherit;">확인</button>'
      + '</div>';
  } else if (notify.type === 'STOCK_REJECTED') {
    inner = '<div style="background:var(--bg2);border:1px solid rgba(239,68,68,0.3);border-top:3px solid var(--up);border-radius:14px;padding:32px;max-width:360px;width:90%;text-align:center;">'
      + '<div style="font-size:32px;margin-bottom:12px">❌</div>'
      + '<div style="font-size:17px;font-weight:600;color:var(--text);margin-bottom:8px">종목 신청 거절</div>'
      + '<div style="font-size:15px;font-weight:700;color:var(--up);margin-bottom:8px">' + notify.ticker_name + '</div>'
      + '<div style="font-size:12px;color:var(--text2);margin-bottom:6px">거절 사유</div>'
      + '<div style="font-size:13px;color:var(--text);padding:10px;background:var(--bg3);border-radius:7px;margin-bottom:24px;">' + (notify.reason||'관리자 거절') + '</div>'
      + '<button ' + closeBtn + ' style="background:var(--up);border:none;border-radius:8px;padding:10px 28px;font-size:13px;font-weight:600;color:#fff;cursor:pointer;font-family:inherit;">확인</button>'
      + '</div>';
  } else {
    const isPlus = notify.amount >= 0;
    const clr    = isPlus ? '#22c55e' : 'var(--up)';
    inner = '<div style="background:var(--bg2);border:1px solid ' + (isPlus?'rgba(34,197,94,0.3)':'rgba(239,68,68,0.3)') + ';border-top:3px solid ' + clr + ';border-radius:14px;padding:32px;max-width:360px;width:90%;text-align:center;">'
      + '<div style="font-size:32px;margin-bottom:12px">' + (isPlus?'💰':'📉') + '</div>'
      + '<div style="font-size:17px;font-weight:600;color:var(--text);margin-bottom:8px">관리자 시드머니 ' + (isPlus?'지급':'차감') + '</div>'
      + '<div style="font-size:24px;font-weight:700;color:' + clr + ';margin-bottom:8px">' + (isPlus?'+':'') + Number(notify.amount).toLocaleString() + '원</div>'
      + '<div style="font-size:12px;color:var(--text2);margin-bottom:4px">사유: ' + (notify.reason||'관리자 조정') + '</div>'
      + '<div style="font-size:12px;color:var(--text3);margin-bottom:24px">현재 잔액: ₩' + Number(curSeed).toLocaleString() + '</div>'
      + '<button ' + closeBtn + ' style="background:var(--text);border:none;border-radius:8px;padding:10px 28px;font-size:13px;font-weight:600;color:var(--bg);cursor:pointer;font-family:inherit;">확인</button>'
      + '</div>';
  }

  overlay.innerHTML = inner;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

// nav 현금 갱신 + 알림
async function updateNavCash() {
  if (!userId) return;
  try {
    const res  = await fetch(`${API_BASE}/portfolio/${userId}`);
    const data = await res.json();
    if (!data.user) return;
    const el = document.getElementById('navSeed');
    if (el) el.textContent = '₩' + Number(data.user.seed_money).toLocaleString();
    if (data.seed_notify) showSeedNotify(data.seed_notify, data.user.seed_money);
  } catch {}
}

// 거래시간 상태
async function updateMarketStatus() {
  try {
    const res  = await fetch(`${API_BASE}/market/status`);
    const data = await res.json();
    const dot  = document.getElementById('statusDot');
    const txt  = document.getElementById('marketStatus');
    if (!txt) return;
    if (data.isOpen) {
      if (dot) dot.style.background = '#22c55e';
      txt.textContent = '거래중';
    } else {
      if (dot) dot.style.background = '#ef4444';
      txt.textContent = data.holidays?.[0]?.name || '휴장';
    }
  } catch {}
}

// 출석 체크
async function checkAttend() {
  if (!userId) return;
  try {
    const res  = await fetch(`${API_BASE}/attend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: Number(userId) }),
    });
    const data = await res.json();
    if (!data.already && data.reward > 0) showAttendToast(data);
  } catch {}
}

function showAttendToast(data) {
  const old = document.getElementById('attendToast');
  if (old) old.remove();
  const t = document.createElement('div');
  t.id = 'attendToast';
  t.style.cssText = 'position:fixed;bottom:24px;left:24px;background:var(--bg2);border:1px solid var(--line2);border-left:3px solid #22c55e;border-radius:10px;padding:12px 18px;font-size:13px;z-index:9999;box-shadow:0 8px 24px rgba(0,0,0,0.2);';
  t.innerHTML = '<div style="font-weight:600;color:#22c55e;margin-bottom:2px">출석 체크</div><div style="font-size:12px;color:var(--text2)">+' + data.reward.toLocaleString() + '원 지급' + (data.bonuses?.length ? ' 🎉 ' + data.attend_days + '일 달성!' : '') + '</div>';
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

function logout() {
  sessionStorage.clear();
  window.location.href = 'login.html';
}

updateNavCash();
updateMarketStatus();
checkAttend();
setInterval(updateNavCash,      5000);
setInterval(updateMarketStatus, 30000);
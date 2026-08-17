/* ================================================================
   ویت‌لایف — احراز هویت تلگرام و دروازه‌های پنل مدیریت
   هویت با امضای HMAC خود تلگرام تأیید می‌شود — جعل‌ناپذیر
================================================================= */
const crypto = require('crypto');
const { BOT_TOKEN, DEV_MODE, ADMIN_IDS } = require('./config');
const { audit, clientIP } = require('./util');


/* ---------------- احراز هویت تلگرام ---------------- */
/* امضای initData با کلید مخفی بات بررسی می‌شود؛ بدون این، هرکسی
   می‌تواند خودش را هر کاربری جا بزند. */
function checkTelegram(initData) {
  if (!initData || !BOT_TOKEN) return null;
  try {
    const p = new URLSearchParams(initData);
    const hash = p.get('hash');
    if (!hash) return null;
    p.delete('hash');
    const arr = [];
    for (const [k, v] of p.entries()) arr.push(k + '=' + v);
    arr.sort();
    const dcs = arr.join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const calc = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
    const a = Buffer.from(calc, 'hex'), b = Buffer.from(hash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const authDate = Number(p.get('auth_date') || 0);
    if (!authDate || (Date.now() / 1000 - authDate) > 86400) return null;  // ۲۴ ساعت
    const user = JSON.parse(p.get('user') || 'null');
    if (!user || !user.id) return null;
    return {
      id: String(user.id),
      name: [user.first_name, user.last_name].filter(Boolean).join(' ') || 'بازیکن',
      startParam: p.get('start_param') || ''
    };
  } catch (e) { return null; }
}
function auth(req, res, next) {
  const initData = req.get('X-TG-Init') || (req.body && req.body.initData) || '';
  let u = checkTelegram(initData);
  if (!u && DEV_MODE) {
    const dev = req.get('X-Dev-Id') || 'dev-user';
    u = { id: 'dev:' + dev, name: 'کاربر تست', startParam: req.get('X-Dev-Ref') || '' };
  }
  if (!u) return res.status(401).json({ ok: false, err: 'unauthorized' });
  req.user = u;
  next();
}
function isAdminId(id) {
  return ADMIN_IDS.includes(String(id).replace(/^dev:/, ''));
}

/* ================================================================
   امنیت پنل مدیریت
   لایه ۱: شناسهٔ تلگرام باید در ADMIN_IDS باشد
     (هویت را خود تلگرام با امضای HMAC تأیید می‌کند — جعل‌ناپذیر)
   لایه ۲: ثبت هر اقدام در دفتر رویداد
   نکته: رمز دوم (PIN) حذف شد — چون هویت تلگرام از قبل تأیید شده،
   رمز دوم فقط اصطکاک اضافه بود.
================================================================= */
const SESSION_MS = 30 * 60 * 1000;
const adminSessions = new Map();            /* token -> {id, exp, ip} — فقط برای آمار */

setInterval(() => {
  const now = Date.now();
  for (const [t, v] of adminSessions) if (now > v.exp) adminSessions.delete(t);
}, 5 * 60 * 1000).unref();

function newSession(id, ip) {
  const token = crypto.randomBytes(24).toString('base64url');
  adminSessions.set(token, { id: String(id), exp: Date.now() + SESSION_MS, ip });
  return token;
}

/* دروازهٔ پایه: فقط شناسهٔ مدیر */
function adminOnly(req, res, next) {
  const raw = String(req.user.id).replace(/^dev:/, '');
  if (!ADMIN_IDS.length && DEV_MODE) return next();
  if (!ADMIN_IDS.includes(raw)) {
    audit(raw, 'admin-denied', 0, req.path, raw, clientIP(req));
    return res.status(403).json({ ok: false, err: 'forbidden' });
  }
  next();
}
/* دروازهٔ کارهای حساس: همان دروازهٔ پایه — هویت تلگرام کافی است */
const adminSecure = adminOnly;


module.exports = {
  checkTelegram, auth, isAdminId,
  SESSION_MS, adminSessions, newSession, adminOnly, adminSecure
};

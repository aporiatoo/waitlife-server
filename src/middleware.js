/* ================================================================
   ویت‌لایف — میان‌افزارها
   فشرده‌سازی gzip | محدودیت نرخ | پیدا کردن فایل بازی
================================================================= */
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { ROOT } = require('./config');

/* ---------------- فشرده‌سازی gzip ----------------
   فایل بازی حدود یک مگابایت است. روی گوشی‌های ضعیف و اینترنت کند،
   دانلود کامل آن دردناک است. یک بار در حافظه فشرده می‌شود و بعد از آن
   به همهٔ مرورگرهایی که gzip می‌پذیرند (یعنی همه) همان نسخه داده می‌شود.
   بدون نیاز به هیچ پکیج اضافه — از zlib خود Node استفاده می‌کنیم. */
const zlib = require('zlib');
const GZ_CACHE = new Map();          /* مسیر → {buf, etag, mtime} */
const GZ_TYPES = /\.(html|js|css|json|svg)$/i;
function gzipFile(file) {
  try {
    const st = fs.statSync(file);
    const key = file;
    const hit = GZ_CACHE.get(key);
    if (hit && hit.mtime === st.mtimeMs) return hit;
    const raw = fs.readFileSync(file);
    const buf = zlib.gzipSync(raw, { level: 8 });
    const etag = 'W/"' + crypto.createHash('sha1').update(raw).digest('hex').slice(0, 20) + '"';
    const rec = { buf, etag, mtime: st.mtimeMs, size: raw.length };
    GZ_CACHE.set(key, rec);
    return rec;
  } catch (e) { return null; }
}
function tryGzip(req, res, file) {
  const ae = String(req.headers['accept-encoding'] || '');
  if (!/\bgzip\b/.test(ae)) return false;
  if (!GZ_TYPES.test(file)) return false;
  const rec = gzipFile(file);
  if (!rec) return false;
  if (req.headers['if-none-match'] === rec.etag) { res.status(304).end(); return true; }
  const type = file.endsWith('.html') ? 'text/html; charset=utf-8'
             : file.endsWith('.js')   ? 'application/javascript; charset=utf-8'
             : file.endsWith('.css')  ? 'text/css; charset=utf-8'
             : file.endsWith('.svg')  ? 'image/svg+xml'
             : 'application/json; charset=utf-8';
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Encoding', 'gzip');
  res.setHeader('Vary', 'Accept-Encoding');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.setHeader('ETag', rec.etag);
  res.end(rec.buf);
  return true;
}
/* پیدا کردن فایل بازی، هرجا که باشد */
function findGame() {
  const spots = [
    path.join(ROOT, 'public', 'index.html'),
    path.join(ROOT, 'index.html'),
    path.join(ROOT, 'public', 'waitlife.html'),
    path.join(ROOT, 'waitlife.html')
  ];
  for (const f of spots) { try { if (fs.existsSync(f)) return f; } catch (e) {} }
  return null;
}

/* ================================================================
   محدودیت نرخ درخواست
   بدون این، یک نفر با یک اسکریپت ساده سرور رایگان را می‌خواباند.
================================================================= */
const RL = new Map();
function rateLimit(max, windowMs) {
  return function (req, res, next) {
    const key = (req.user && req.user.id)
      || req.ip
      || (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || 'anon';
    const now = Date.now();
    let e = RL.get(key);
    if (!e || now > e.reset) { e = { n: 0, reset: now + windowMs }; RL.set(key, e); }
    e.n++;
    if (e.n > max) {
      res.set('Retry-After', String(Math.ceil((e.reset - now) / 1000)));
      return res.status(429).json({ ok: false, err: 'too_many_requests' });
    }
    next();
  };
}
/* پاکسازی دوره‌ای تا حافظه رشد نکند */
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of RL) if (now > v.reset) RL.delete(k);
  if (RL.size > 50000) RL.clear();
}, 5 * 60 * 1000).unref();

const limitApi   = rateLimit(90, 60 * 1000);   /* ۹۰ درخواست در دقیقه */
const limitHeavy = rateLimit(12, 60 * 1000);   /* سفارش/رسید/فاکتور */
/* وب‌هوک از محدودیت مستثناست: همهٔ آپدیت‌ها از یک آی‌پی تلگرام می‌آیند،
   اگر محدود شود پیام‌های کاربرها گم می‌شوند. مسیرش رمزدار است. */

module.exports = { gzipFile, tryGzip, findGame, RL, rateLimit, limitApi, limitHeavy };

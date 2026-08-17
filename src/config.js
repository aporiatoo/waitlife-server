/* ================================================================
   ویت‌لایف — تنظیمات سراسری
   همهٔ ماژول‌ها فقط از اینجا پیکربندی می‌خوانند.
================================================================= */
const crypto = require('crypto');
const path   = require('path');

/* ریشهٔ پروژه — فایل داده و بازی اینجا هستند */
const ROOT = path.join(__dirname, '..');

const PORT = process.env.PORT || 3000;

const BOT_TOKEN  = process.env.BOT_TOKEN || '';
const BOT_USER   = String(process.env.BOT_USERNAME || '').replace(/^@/, '');
const APP_SHORT  = String(process.env.APP_SHORT || 'play');
const ADMIN_IDS  = String(process.env.ADMIN_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const DEV_MODE   = String(process.env.DEV_MODE || '') === '1';
const SELF_URL   = String(process.env.SELF_URL || '').replace(/\/+$/, '');
const TEST_HOOK  = String(process.env.TEST_HOOK || '');

/* رمز مسیر وب‌هوک — از توکن ساخته می‌شود تا نیاز به تنظیم دستی نباشد */
const HOOK_SECRET = BOT_TOKEN
  ? crypto.createHash('sha256').update('hook' + BOT_TOKEN).digest('hex').slice(0, 24)
  : 'nohook';

/* ================================================================
   بسته‌های فروش — منبع حقیقت سمت سرور
   قیمت را کاربر نمی‌فرستد؛ فقط کلید بسته را می‌فرستد.
================================================================= */
/* هر استارز = ۳٬۵۰۰ تومان */
const STAR_TOMAN = 3500;
const PACKS = {
  p1: { n: 'بستهٔ کوچک',   bakht: 45,   stars: 15  },
  p2: { n: 'بستهٔ برنزی',   bakht: 105,  stars: 30  },
  p3: { n: 'بستهٔ نقره‌ای',  bakht: 270,  stars: 70  },
  p4: { n: 'بستهٔ طلایی',   bakht: 620,  stars: 150 },
  p5: { n: 'بستهٔ الماس',   bakht: 1400, stars: 320 },
  p6: { n: 'بستهٔ سلطنتی',  bakht: 3300, stars: 700, perk: 'gold' }
};
Object.values(PACKS).forEach(p => { p.toman = p.stars * STAR_TOMAN; });


/* ---------------- دفتر درآمد بخت ----------------
   سقف روزانه + سقف هر درخواست، جلوی تقلب را می‌گیرد. */
const EARN_MAX_PER_CALL = 60;      /* بیشترین بخت در یک همگام‌سازی */
const EARN_MAX_PER_DAY  = 220;     /* سقف روزانهٔ درآمد بازی */
module.exports = {
  ROOT, PORT,
  BOT_TOKEN, BOT_USER, APP_SHORT, ADMIN_IDS, DEV_MODE, SELF_URL, TEST_HOOK,
  HOOK_SECRET, STAR_TOMAN, PACKS,
  EARN_MAX_PER_CALL, EARN_MAX_PER_DAY
};

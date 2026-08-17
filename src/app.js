/* ================================================================
   ویت‌لایف — اپلیکیشن Express
   همهٔ مسیرها اینجا به هم وصل می‌شوند
================================================================= */
const express = require('express');
const path = require('path');
const fs = require('fs');

const { ROOT, TEST_HOOK } = require('./config');
const { tryGzip, limitApi, findGame } = require('./middleware');
const db = require('./db');
const core  = require('./routes-core');
const world = require('./routes-world');
const shop  = require('./routes-shop');
const admin = require('./routes-admin');
const bot   = require('./bot');
const notify = require('./notify');
const auction = require('./auction');

function createApp() {
  const app = express();

  app.set('trust proxy', 1);
  app.use(express.json({ limit: '6mb' }));

/* میان‌افزار: قبل از static، نسخهٔ فشرده را امتحان کن */
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  let rel = req.path === '/' ? 'index.html' : req.path.replace(/^\/+/, '');
  if (rel.includes('..')) return next();
  for (const base of [path.join(ROOT, 'public'), __dirname]) {
    const f = path.join(base, rel);
    if (!f.startsWith(base)) continue;
    try { if (fs.existsSync(f) && fs.statSync(f).isFile()) {
      if (tryGzip(req, res, f)) return;
      break;
    } } catch (e) {}
  }
  next();
});

/* بازی ممکن است در public/ باشد یا کنار server.js — هر دو را می‌گردیم */
app.use(express.static(path.join(ROOT, 'public'), { maxAge: '5m' }));
app.use(express.static(ROOT, { maxAge: '5m', index: false }));


  /* همهٔ مسیرهای /api محدودیت نرخ دارند — به جز وب‌هوک تلگرام */
app.use('/api/', (req, res, next) => {
  if (req.path.indexOf('/tg/') === 0) return next();
  return limitApi(req, res, next);
});


  /* ---- نصب مسیرها ---- */
  core.registerCoreRoutes(app);
  auction.createAuction(app);                        /* حراج + ساعت جهان */
  world.registerWorldRoutes(app, auction.worldTick);
  shop.registerShopRoutes(app);
  admin.registerAdminRoutes(app);
  bot.registerBotRoutes(app);

/* مسیر تست خودکار — فقط وقتی TEST_HOOK=1 باشد (در تولید وجود ندارد) */
if (TEST_HOOK === '1') {
  app.post('/api/__test_settle', async (req, res) => {
    const r = await auction.settleAuction(auction.weekNo());
    res.json({ ok: true, r });
  });
  app.post('/api/__test_notif', async (req, res) => {
    await notify.notifRound();
    res.json({ ok: true });
  });
}


app.get('*', (req, res) => {
  const f = findGame();
  /* نسخهٔ فشرده را ترجیح بده — برای گوشی‌های ضعیف و اینترنت کند */
  if (f && tryGzip(req, res, f)) return;
  if (f) return res.sendFile(f);
  res.status(200).send('<!DOCTYPE html><html lang="fa" dir="rtl"><head>'
  + '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
  + '<title>فایل بازی پیدا نشد</title><style>body{font-family:system-ui,sans-serif;'
  + 'background:#0f1720;color:#e8eef5;padding:22px;line-height:2;max-width:640px;margin:auto}'
  + '.box{background:#1a2430;border-radius:12px;padding:16px;margin:14px 0}'
  + '.ok{color:#4ade80}.bad{color:#f87171}code{background:#0b1118;padding:2px 7px;'
  + 'border-radius:5px;font-size:13px;direction:ltr;display:inline-block}'
  + 'h2{color:#ffd400}</style></head><body>'
  + '<h2>⚠️ فایل بازی آپلود نشده</h2>'
  + '<div class="box"><b class="ok">✅ سرور سالم است</b><br>'
  + '<b class="ok">✅ دیتابیس: ' + (db.pool ? 'پستگرس متصل' : 'حالت فایل') + '</b><br>'
  + '<b class="bad">❌ فایل بازی پیدا نشد</b></div>'
  + '<div class="box"><b>راه‌حل — در گیت‌هاب:</b><br>'
  + '۱) <code>Add file → Upload files</code><br>'
  + '۲) فایل <code>index.html</code> را آپلود کن<br>'
  + '۳) <code>Commit changes</code><br><br>'
  + 'همین یک فایل کافی است. نیازی به ساختن پوشه نیست.</div>'
  + '</body></html>');
});

  return app;
}

module.exports = { createApp };

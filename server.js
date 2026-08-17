/* ================================================================
   ویت‌لایف — نقطهٔ ورود سرور
   دیتابیس را راه می‌اندازد، وب‌هوک را وصل می‌کند،
   اعلان هوشمند و پشتیبان‌گیری خودکار را زمان‌بندی می‌کند.
================================================================= */
const { PORT, SELF_URL, BOT_TOKEN, ADMIN_IDS } = require('./src/config');
const db = require('./src/db');
const telegram = require('./src/telegram');
const backup = require('./src/backup');
const notify = require('./src/notify');
const { findGame } = require('./src/middleware');
const { createApp } = require('./src/app');

const app = createApp();

/* ---------------- بیدار نگه داشتن ----------------
   سرویس‌های رایگان بعد از ۱۵ دقیقه بی‌کاری می‌خوابند. */
if (SELF_URL) {
  setInterval(() => {
    try { fetch(SELF_URL + '/api/health').catch(() => {}); } catch (e) {}
  }, 10 * 60 * 1000).unref();
  console.log('[keepalive] فعال شد:', SELF_URL);
}

db.initDB()
  .catch(e => { console.error('[db] خطا، حالت فایل فعال شد:', e.message); db.fileLoad(); })
  .finally(() => app.listen(PORT, '0.0.0.0', async () => {
    const f = findGame();
    console.log('[waitlife] روی پورت ' + PORT + ' بالا آمد');
    if (f) console.log('[game] فایل بازی پیدا شد:', f.replace(__dirname, '.'));
    else console.warn('[game] ⚠️ فایل بازی پیدا نشد — public/index.html را آپلود کن');
    await telegram.setupWebhook();
    /* اعلان هوشمند: هر ۶ ساعت یک دور */
    if (BOT_TOKEN) {
      setInterval(notify.notifRound, 6 * 60 * 60 * 1000);
      setTimeout(notify.notifRound, 3 * 60 * 1000);
      console.log('[notif] اعلان هوشمند فعال شد');
    }
    /* پشتیبان‌گیری خودکار */
    if (BOT_TOKEN && backup.BACKUP_ON && ADMIN_IDS.length) {
      const ms = backup.BACKUP_HOURS * 60 * 60 * 1000;
      setInterval(() => { backup.runBackup(false); }, ms);
      /* یک نسخه کمی بعد از بالا آمدن، تا مطمئن شوی کار می‌کند */
      setTimeout(() => { backup.runBackup(false); }, 90 * 1000);
      console.log('[backup] پشتیبان خودکار هر ' + backup.BACKUP_HOURS + ' ساعت فعال شد');
    } else if (!ADMIN_IDS.length) {
      console.warn('[backup] ⚠️ ADMIN_IDS خالی است — پشتیبان ارسال نمی‌شود');
    }
  }));

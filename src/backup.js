/* ================================================================
   ویت‌لایف — پشتیبان‌گیری خودکار
   هر چند ساعت یک نسخهٔ کامل از دیتابیس، فشرده، در چت تلگرام
================================================================= */
const zlib = require('zlib');
const { BOT_TOKEN, ADMIN_IDS } = require('./config');
const db = require('./db');
const auction = require('./auction');
const { faNum, notifyAdmins } = require('./telegram');

/* ================================================================
   ═══ پشتیبان‌گیری خودکار ═══
   هر چند ساعت یک نسخهٔ کامل از دیتابیس ساخته می‌شود، فشرده می‌شود
   و مستقیم در تلگرام برای مدیر فرستاده می‌شود. اگر سرور یا دیتابیس
   از دست برود، همه‌چیز در چت تلگرام موجود است.
================================================================= */
const BACKUP_HOURS = Math.max(1, Math.min(168,
  Number(process.env.BACKUP_HOURS || 24) || 24));   /* پیش‌فرض: روزی یک بار */
const BACKUP_ON = String(process.env.BACKUP || '1') !== '0';

/* جمع‌آوری کل داده‌ها از هر دو حالت (پستگرس یا فایل) */
async function collectBackup() {
  const out = {
    v: 1,
    at: new Date().toISOString(),
    mode: db.pool ? 'postgres' : 'file',
        epoch: auction.WORLD_EPOCH,
    tables: {}
  };
  if (db.pool) {
    /* هر جدول جداگانه؛ اگر یکی خطا داد بقیه از دست نروند */
    const tabs = ['users', 'orders', 'cfg', 'audit', 'ghosts', 'wevents', 'bids'];
    for (const t of tabs) {
      try {
        const r = await db.pool.query('SELECT * FROM ' + t);
        out.tables[t] = r.rows;
      } catch (e) { out.tables[t] = { error: String(e.message).slice(0, 120) }; }
    }
  } else {
    out.tables.users  = Object.values(db.mem.users || {});
    out.tables.orders = db.mem.orders || [];
    out.tables.cfg    = db.mem.cfg || {};
  }
  /* خلاصهٔ آماری برای متن پیام */
  const u = Array.isArray(out.tables.users) ? out.tables.users : [];
  out.summary = {
    users: u.length,
    withSave: u.filter(x => x && x.save).length,
    bakhtTotal: u.reduce((a, x) => a + ((x && x.bakht) | 0), 0),
    orders: Array.isArray(out.tables.orders) ? out.tables.orders.length : 0,
    ghosts: Array.isArray(out.tables.ghosts) ? out.tables.ghosts.length : 0
  };
  return out;
}

/* ارسال فایل به تلگرام با multipart — بدون نیاز به هیچ پکیج اضافه */
async function tgSendDocument(chatId, filename, buf, caption) {
  if (!BOT_TOKEN) return false;
  try {
    const fd = new FormData();
    fd.append('chat_id', String(chatId));
    if (caption) { fd.append('caption', caption); fd.append('parse_mode', 'HTML'); }
    fd.append('document', new Blob([buf], { type: 'application/gzip' }), filename);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 90000);
    const r = await fetch(TGAPI + 'sendDocument', { method: 'POST', body: fd, signal: ctrl.signal });
    clearTimeout(t);
    const j = await r.json().catch(() => null);
    return !!(j && j.ok);
  } catch (e) {
    console.warn('[backup] ارسال ناموفق:', e.message);
    return false;
  }
}

let lastBackupAt = 0, lastBackupOk = null, backupBusy = false;
async function runBackup(manual) {
  if (backupBusy) return { ok: false, err: 'busy' };
  if (!ADMIN_IDS.length) return { ok: false, err: 'no_admin' };
  if (!BOT_TOKEN) return { ok: false, err: 'no_token' };
  backupBusy = true;
  try {
    const data = await collectBackup();
    const raw = Buffer.from(JSON.stringify(data), 'utf8');
    const gz = zlib.gzipSync(raw, { level: 9 });
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    const stamp = d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate())
                + '_' + pad(d.getUTCHours()) + pad(d.getUTCMinutes());
    const name = 'waitlife-backup_' + stamp + '.json.gz';
    const S = data.summary;
    const kb = (gz.length / 1024).toFixed(1);
    const caption =
      '💾 <b>پشتیبان خودکار ویت‌لایف</b>\n' +
      '📅 ' + stamp.replace('_', ' — ') + ' (UTC)\n' +
      '👥 کاربران: <b>' + faNum(S.users) + '</b>' +
        ' (با ذخیرهٔ بازی: ' + faNum(S.withSave) + ')\n' +
      '⭐ مجموع بخت: <b>' + faNum(S.bakhtTotal) + '</b>\n' +
      '🧾 سفارش‌ها: ' + faNum(S.orders) + ' • 👻 ارواح: ' + faNum(S.ghosts) + '\n' +
      '🗄️ منبع: ' + (data.mode === 'postgres' ? 'دیتابیس' : 'فایل') +
        ' • حجم: ' + faNum(kb) + ' کیلوبایت\n\n' +
      '<i>این فایل را نگه دار. برای بازگردانی، همین فایل را به پشتیبانی بده.</i>';

    /* سقف تلگرام برای فایل حدود ۵۰ مگابایت است. با فشرده‌سازی، حتی
       ۱۰۰ هزار بازیکن هم حدود ۱۲ مگابایت می‌شود، ولی اگر روزی از حد
       گذشت باید بدانی — بی‌سروصدا شکست نخورد. */
    if (gz.length > 45 * 1024 * 1024) {
      await notifyAdmins('⚠️ <b>پشتیبان خیلی بزرگ شد</b>\n' +
        'حجم: ' + faNum(Math.round(gz.length / 1048576)) + ' مگابایت — ' +
        'تلگرام فایل بالای ۵۰ مگابایت را نمی‌پذیرد.\n' +
        'باید پشتیبان‌گیری به چند بخش تقسیم شود.');
      return { ok: false, err: 'too_large', size: gz.length };
    }
    let sent = 0;
    for (const a of ADMIN_IDS) {
      if (await tgSendDocument(a, name, gz, caption)) sent++;
    }
    lastBackupAt = Date.now();
    lastBackupOk = sent > 0;
    if (!sent) console.warn('[backup] برای هیچ مدیری ارسال نشد');
    else console.log('[backup] ارسال شد به ' + sent + ' مدیر (' + kb + 'KB)');
    return { ok: sent > 0, sent, size: gz.length, users: S.users, name };
  } catch (e) {
    lastBackupOk = false;
    console.error('[backup] خطا:', e.message);
    try { await notifyAdmins('⚠️ پشتیبان‌گیری خودکار با خطا مواجه شد: ' + e.message.slice(0, 120)); } catch (e2) {}
    return { ok: false, err: String(e.message).slice(0, 140) };
  } finally { backupBusy = false; }
}


/* آخرین وضعیت پشتیبان — برای دستور /backupinfo */
function backupStatus() { return { at: lastBackupAt, ok: lastBackupOk }; }

module.exports = {
  collectBackup, runBackup, tgSendDocument, backupStatus, BACKUP_HOURS, BACKUP_ON
};

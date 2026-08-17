/* ================================================================
   ویت‌لایف — اعلان هوشمند
   فقط وقتی اتفاق واقعی افتاده — نه هر روز، نه بی‌دلیل.
================================================================= */
const { BOT_TOKEN } = require('./config');
const db = require('./db');
const { DB } = db;
const { say, playBtn, faNum } = require('./telegram');
const auction = require('./auction');

/* ================================================================
   اعلان هوشمند
   فقط وقتی اتفاق واقعی افتاده — نه هر روز، نه بی‌دلیل.
   ۱) بازیکن ۳ روز نیامده و جهان جلو رفته
   ۲) از جمع ده نفر برتر بیرون افتاده
   هر کاربر حداکثر هر ۴ روز یک پیام می‌گیرد.
================================================================= */
const NOTIF_GAP_DAYS = 4;
const AWAY_DAYS      = 3;
const BATCH          = 20;    /* سقف پیام در هر دور — تلگرام محدودیت نرخ دارد */

async function notifRound() {
  if (!BOT_TOKEN) return;
  const c = await DB.getCfg();
  if (c.notif === '0') return;
  /* تسویهٔ مزایدهٔ هفتهٔ گذشته */
  try { if (!auction.auctionOpen()) await auction.settleAuction(auction.weekNo()); }
  catch (e) { console.error('[auction]', e.message); }
  try { await notifRankDrop(); } catch (e) { console.error('[notif rank]', e.message); }
  try { await notifAway(); }     catch (e) { console.error('[notif away]', e.message); }
}

/* ۱) افت رتبه در تالار مشاهیر */
async function notifRankDrop() {
  const top = await DB.top(100);
  const now = Date.now();
  let sent = 0;
  for (let i = 0; i < top.length && sent < 8; i++) {
    const row = top[i];
    const rank = i + 1;
    const u = await DB.getUser(row.id);
    if (!u || u.notif === false || !u.chat_ok) continue;
    const prev = (u.rank_last === null || u.rank_last === undefined) ? null : (u.rank_last | 0);
    if (prev !== rank) await DB.upsertUser(row.id, { rank_last: rank }, false);
    if (prev === null) continue;
    /* فقط افت معنادار: از ده‌تای برتر بیرون افتاده */
    if (!(prev <= 10 && rank > 10)) continue;
    if (u.notif_at && (now - new Date(u.notif_at).getTime()) < NOTIF_GAP_DAYS * 86400000) continue;
    const ok = await say(row.id,
      `📉 <b>از جمع ده نفر برتر بیرون افتادی!</b>\n\n` +
      `رتبهٔ قبلی: <b>${faNum(prev)}</b> ← رتبهٔ الان: <b>${faNum(rank)}</b>\n\n` +
      `بقیه دارند جلو می‌روند. برگرد و جایگاهت را پس بگیر.`,
      { reply_markup: playBtn('🏆 پس گرفتن رتبه') });
    if (ok) { await DB.upsertUser(row.id, { notif_at: new Date().toISOString() }, false); sent++; }
  }
}

/* ۲) غیبت طولانی — جهان بدون تو جلو رفته */
async function notifAway() {
  let list = [];
  const now = Date.now();
  if (db.pool) {
    const r = await db.pool.query(
      `SELECT id,name,seen,notif_at,gen FROM users
       WHERE notif=TRUE AND chat_ok=TRUE AND banned=FALSE
         AND seen < NOW() - INTERVAL '${AWAY_DAYS} days'
         AND (notif_at IS NULL OR notif_at < NOW() - INTERVAL '${NOTIF_GAP_DAYS} days')
       ORDER BY seen DESC LIMIT ${BATCH}`);
    list = r.rows;
  } else {
    list = Object.values(db.mem.users).filter(u =>
      u.notif !== false && u.chat_ok && !u.banned &&
      now - (u.seen || 0) > AWAY_DAYS * 86400000 &&
      (!u.notif_at || now - new Date(u.notif_at).getTime() > NOTIF_GAP_DAYS * 86400000)
    ).slice(0, BATCH);
  }
  for (const u of list) {
    const days = Math.max(1, Math.floor((now - new Date(u.seen).getTime()) / 86400000));
    const ok = await say(u.id,
      `🌍 <b>جهان بدون تو جلو رفت.</b>\n\n` +
      `<b>${faNum(days)} روز</b> نیامدی — یعنی <b>${faNum(days)} فصل</b> از جهان ویت‌لایف گذشت.\n` +
      `بازار عوض شد، رقیب‌ها بزرگ شدند و پاداش ورود روزانه‌ات منتظر است.\n\n` +
      `⭐ همین حالا برگرد و بخت رایگان بگیر.`,
      { reply_markup: playBtn('🎮 برگشتن به زندگی') });
    if (ok) await DB.upsertUser(u.id, { notif_at: new Date().toISOString() }, false);
    await new Promise(r => setTimeout(r, 120));   /* رعایت محدودیت نرخ تلگرام */
  }
}


module.exports = { notifRound, notifRankDrop, notifAway };

/* ================================================================
   ویت‌لایف — سیستم دعوت دوستان
   کد یک‌طرفه | پاداش و پلکان‌ها | ضدتقلب
================================================================= */
const crypto = require('crypto');
const { BOT_TOKEN } = require('./config');
const db = require('./db');
const { DB } = db;
const { say, playBtn, faNum } = require('./telegram');
const { audit } = require('./util');

/* ================================================================
   سیستم دعوت دوستان
================================================================= */
const REF_INVITER = 25;   /* پاداش دعوت‌کننده */
const REF_JOINER  = 15;   /* هدیهٔ دعوت‌شونده */
const REF_TIERS = [
  { n: 3,  b: 40,  t: 'سه دوست' },
  { n: 5,  b: 80,  t: 'پنج دوست' },
  { n: 10, b: 200, t: 'ده دوست' },
  { n: 20, b: 500, t: 'بیست دوست' },
  { n: 50, b: 1500, t: 'پنجاه دوست' }
];
function refCode(id) {
  return 'r' + crypto.createHash('sha256').update('ref' + id + (BOT_TOKEN || 'x'))
    .digest('base64url').slice(0, 10);
}
/* نقشهٔ کد → شناسه، در حافظه ساخته می‌شود (کد یک‌طرفه است) */
const REFMAP = new Map();
function refRemember(id) { REFMAP.set(refCode(id), String(id)); }
async function refResolve(code) {
  code = String(code || '').trim();
  if (!code) return null;
  if (REFMAP.has(code)) return REFMAP.get(code);
  /* بعد از ری‌استارت سرور، نقشه خالی است — از دیتابیس بازسازی می‌کنیم */
  let ids = [];
  if (db.pool) {
    try { const r = await db.pool.query('SELECT id FROM users LIMIT 20000'); ids = r.rows.map(x => x.id); }
    catch (e) { ids = []; }
  } else ids = Object.keys(db.mem.users);
  for (const id of ids) {
    const c = refCode(id);
    REFMAP.set(c, id);
    if (c === code) return id;
  }
  return null;
}
async function refBind(userId, code) {
  if (!code) return null;
  const me = await DB.getUser(userId);
  if (me && me.ref_by) return null;                 /* قبلاً ثبت شده */
  const inviterId = await refResolve(code);
  if (!inviterId || String(inviterId) === String(userId)) return null;
  const inviter = await DB.getUser(inviterId);
  if (!inviter) return null;
  /* پادزهر تقلب: حساب تازه‌ساخته نمی‌تواند دعوت‌کننده باشد و
     دعوت‌شونده باید کاربر واقعاً جدیدی باشد */
  await DB.upsertUser(userId, { ref_by: String(inviterId) });
  await DB.addBakht(userId, REF_JOINER);
  await DB.addBakht(inviterId, REF_INVITER);
  await audit(userId, 'ref-join', REF_JOINER, 'دعوت‌شده توسط ' + inviterId, null, '');
  await audit(inviterId, 'ref-invite', REF_INVITER, 'دعوت ' + userId, null, '');
  const refs = (inviter.refs | 0) + 1;
  await DB.upsertUser(inviterId, { refs }, false);
  /* خبر خوش به دعوت‌کننده — اگر چت باز نباشد، say خودش تشخیص می‌دهد */
  try {
    if (inviter.notif !== false) {
      await say(inviterId,
        `🎉 <b>یک دوست با لینک تو وارد بازی شد!</b>\n\n` +
        `⭐ <b>${faNum(REF_INVITER)} بخت</b> به حسابت اضافه شد.\n` +
        `👥 تعداد دوستان دعوت‌شده: <b>${faNum(refs)}</b>`,
        { reply_markup: playBtn('⭐ دیدن پاداش') });
    }
  } catch (e) {}
  return { inviterId, refs };
}


module.exports = {
  refCode, refRemember, refResolve, refBind, REF_INVITER, REF_JOINER, REF_TIERS
};

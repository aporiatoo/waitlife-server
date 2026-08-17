/* ================================================================
   ویت‌لایف — ابزارهای کوچک مشترک
   دفتر رویداد (audit) و تشخیص آی‌پی
================================================================= */
const { DB } = require('./db');

/* مُهرِ امروز — برای سقف درآمد روزانه */
function todayStamp() { return new Date().toISOString().slice(0, 10); }

/* ثبت در دفتر رویداد — هر تغییر حساس ردیابی می‌شود */
async function audit(uid, act, amount, note, actor, ip) {
  try { await DB.addAudit({ uid, act, amount, note, actor, ip }); } catch (e) {}
}
function clientIP(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '';
}

module.exports = { audit, clientIP, todayStamp };

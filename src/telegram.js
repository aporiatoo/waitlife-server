/* ================================================================
   ویت‌لایف — لایهٔ بات تلگرام
   API پایه | پیام‌ها | لینک دعوت | وب‌هوک
================================================================= */
const { BOT_TOKEN, BOT_USER, APP_SHORT, SELF_URL, HOOK_SECRET } = require('./config');
const { DB } = require('./db');

/* ================================================================
   لایهٔ بات تلگرام
================================================================= */
/* پایهٔ API تلگرام — قابل تغییر فقط برای تست خودکار */
const TG_BASE = process.env.TG_API_BASE || 'https://api.telegram.org';
const TGAPI = TG_BASE + '/bot' + BOT_TOKEN + '/';
async function tg(method, body, timeout) {
  if (!BOT_TOKEN) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout || 12000);
    const r = await fetch(TGAPI + method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: ctrl.signal
    });
    clearTimeout(t);
    const j = await r.json().catch(() => null);
    if (j && j.ok === false) return j;
    return j;
  } catch (e) { return null; }
}
/* اگر کاربر بات را بلاک کرده باشد، دیگر برایش پیام نمی‌فرستیم */
async function say(chatId, text, extra) {
  const r = await tg('sendMessage', Object.assign(
    { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true },
    extra || {}));
  if (r && r.ok === false) {
    const d = String(r.description || '');
    if (/blocked|deactivated|chat not found|user is deactivated/i.test(d)) {
      try { await DB.upsertUser(String(chatId), { notif: false, chat_ok: false }, false); } catch (e) {}
    }
    return false;
  }
  return !!(r && r.ok);
}
function playBtn(label) {
  const url = deepLink();
  if (!url) return undefined;
  return { inline_keyboard: [[{ text: label || '🎮 ادامهٔ بازی', url }]] };
}
let BOT_USER_LIVE = BOT_USER;
function deepLink(param) {
  const u = BOT_USER_LIVE || '';
  if (u) return 'https://t.me/' + u + '/' + APP_SHORT + (param ? '?startapp=' + param : '');
  return SELF_URL || '';
}
function faNum(n) {
  return String(n).replace(/[0-9]/g, d => '۰۱۲۳۴۵۶۷۸۹'[+d]);
}
async function notifyAdmins(text, extra) {
  for (const a of ADMIN_IDS) { try { await say(a, text, extra); } catch (e) {} }
}


/* نام کاربری زندهٔ بات — بعد از getMe پر می‌شود */
function getBotUser() { return BOT_USER_LIVE; }
function setBotUser(u) { if (u) BOT_USER_LIVE = String(u); }


/* ---------------- راه‌اندازی وب‌هوک ---------------- */
async function setupWebhook() {
  if (!BOT_TOKEN) { console.warn('[bot] BOT_TOKEN تنظیم نشده — بات غیرفعال'); return; }
  /* نام کاربری بات را همیشه می‌گیریم — لینک دعوت به آن نیاز دارد */
  const me = await tg('getMe', {});
  if (me && me.ok && me.result && me.result.username) {
    if (!getBotUser()) setBotUser(me.result.username);
    console.log('[bot] @' + getBotUser());
  } else {
    console.warn('[bot] ⚠️ getMe ناموفق — BOT_TOKEN را بررسی کن');
  }
  if (!SELF_URL) {
    console.warn('[bot] ⚠️ SELF_URL تنظیم نشده — وب‌هوک وصل نشد (اعلان و استارز کار نمی‌کند)');
    return;
  }
  const url = SELF_URL + '/api/tg/' + HOOK_SECRET;
  const r = await tg('setWebhook', {
    url,
    allowed_updates: ['message', 'callback_query', 'pre_checkout_query'],
    drop_pending_updates: false
  });
  if (r && r.ok) console.log('[bot] وب‌هوک وصل شد');
  else console.warn('[bot] وب‌هوک وصل نشد:', r && r.description);
}

module.exports = {
  tg, say, playBtn, deepLink, faNum, notifyAdmins,
  setupWebhook, getBotUser, setBotUser
};

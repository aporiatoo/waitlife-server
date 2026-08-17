/* ================================================================
   ویت‌لایف — مغز بات تلگرام
   وب‌هوک | پرداخت استارز | دکمه‌های تأیید سفارش | دستورهای مدیر
================================================================= */
const { HOOK_SECRET, ADMIN_IDS, PACKS } = require('./config');
const { DB, statsSnapshot } = require('./db');
const { tg, say, playBtn, faNum, notifyAdmins } = require('./telegram');
const { refBind, refRemember, REF_JOINER } = require('./refs');
const backup = require('./backup');
const { audit } = require('./util');

function registerBotRoutes(app) {
/* ================================================================
   وب‌هوک بات
================================================================= */
app.post('/api/tg/' + HOOK_SECRET, async (req, res) => {
  res.json({ ok: true });                 /* همیشه سریع جواب بده */
  const up = req.body || {};
  try { await handleUpdate(up); } catch (e) { console.error('[bot]', e.message); }
});

async function handleUpdate(up) {
  /* ---- پیش‌تأیید پرداخت استارز ---- */
  if (up.pre_checkout_query) {
    await tg('answerPreCheckoutQuery', {
      pre_checkout_query_id: up.pre_checkout_query.id, ok: true });
    return;
  }
  /* ---- دکمه‌های شیشه‌ای (تأیید/رد سفارش) ---- */
  if (up.callback_query) {
    const cq = up.callback_query;
    const from = String(cq.from && cq.from.id || '');
    const data = String(cq.data || '');
    if (!ADMIN_IDS.includes(from)) {
      await tg('answerCallbackQuery', { callback_query_id: cq.id, text: '⛔ دسترسی نداری.' });
      return;
    }
    const m = data.match(/^(ok|no):(\d+)$/);
    if (!m) { await tg('answerCallbackQuery', { callback_query_id: cq.id }); return; }
    const act = m[1], id = Number(m[2]);
    const before = await DB.getOrder(id);
    if (!before) {
      await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'سفارش پیدا نشد.' });
      return;
    }
    if (before.status !== 'pending') {
      await tg('answerCallbackQuery', {
        callback_query_id: cq.id,
        text: 'این سفارش قبلاً ' + (before.status === 'approved' ? 'تأیید' : 'رد') + ' شده.' });
      return;
    }
    const o = await DB.setOrder(id, act === 'ok' ? 'approved' : 'rejected');
    let tail = '';
    if (act === 'ok' && o) {
      await DB.addBakht(o.uid, o.bakht | 0);
      await audit(o.uid, 'order-approve', o.bakht | 0, o.pack || '', from, '');
      const pk = PACKS[o.pack];
      const buyer = await DB.getUser(o.uid);
      await DB.upsertUser(o.uid,
        { spent: ((buyer && buyer.spent) | 0) + ((PACKS[o.pack] && PACKS[o.pack].toman) | 0) }, false);
      tail = `\n\n✅ <b>تأیید شد</b> — ${faNum(o.bakht | 0)} بخت شارژ شد.`;
      await say(o.uid,
        `✅ <b>سفارشت تأیید شد!</b>\n\n` +
        `${pk ? pk.n : ''}\n⭐ <b>${faNum(o.bakht | 0)} بخت</b> به حسابت اضافه شد.\n\n` +
        `ممنون که از ویت‌لایف حمایت کردی 🙏`,
        { reply_markup: playBtn('⭐ خرج کردن بخت') });
    } else if (o) {
      tail = '\n\n❌ <b>رد شد</b>';
      await say(o.uid,
        `❌ <b>سفارشت رد شد.</b>\n\n` +
        `کد پیگیری: <code>${o.code || '—'}</code>\n` +
        `اگر فکر می‌کنی اشتباهی شده، رسید را دوباره برای پشتیبانی بفرست.`);
    }
    await tg('answerCallbackQuery', {
      callback_query_id: cq.id,
      text: act === 'ok' ? '✅ شارژ شد' : '❌ رد شد' });
    /* دکمه‌ها را بردار تا دوبار زده نشود */
    const chat = cq.message && cq.message.chat && cq.message.chat.id;
    const mid  = cq.message && cq.message.message_id;
    if (chat && mid) {
      const base = (cq.message.caption || cq.message.text || '') + tail;
      if (cq.message.caption !== undefined)
        await tg('editMessageCaption', { chat_id: chat, message_id: mid,
          caption: base, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } });
      else
        await tg('editMessageText', { chat_id: chat, message_id: mid,
          text: base, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } });
    }
    return;
  }

  const msg = up.message || up.edited_message;
  if (!msg) return;
  const chatId = msg.chat && msg.chat.id;
  const uid = String(msg.from && msg.from.id || chatId || '');
  if (!uid) return;

  /* ---- پرداخت موفق استارز ---- */
  if (msg.successful_payment) {
    const sp = msg.successful_payment;
    const parts = String(sp.invoice_payload || '').split(':');
    const key = parts[1] || '';
    const pk = PACKS[key];
    if (pk) {
      const nu = await DB.addBakht(uid, pk.bakht);
      if (pk.perk) { try { await DB.setCfg('perk:' + uid + ':' + pk.perk, '1'); } catch (e) {} }
      const prev = await DB.getUser(uid);
      await DB.upsertUser(uid, { spent: ((prev && prev.spent) | 0) + (pk.stars | 0) }, false);
      await DB.addOrder({
        uid, code: 'STARS-' + (sp.telegram_payment_charge_id || '').slice(-8),
        pack: key, bakht: pk.bakht, receipt: null, status: 'approved', kind: 'stars' });
      await audit(uid, 'buy-stars', pk.bakht, key + ' ⭐' + pk.stars, uid, '');
      await say(chatId,
        `✅ <b>پرداخت انجام شد!</b>\n\n` +
        `${pk.n}\n⭐ <b>${faNum(pk.bakht)} بخت</b> همین حالا به حسابت اضافه شد.\n\n` +
        `ممنون که از ویت‌لایف حمایت کردی 🙏`,
        { reply_markup: playBtn('🎮 برگرد به بازی') });
      await notifyAdmins(
        `💎 <b>خرید استارز</b>\n\n${pk.n} — ⭐${faNum(pk.stars)}\n` +
        `بازیکن: ${msg.from && msg.from.first_name || '—'}\n` +
        `شناسه: <code>${uid}</code>\n` +
        `موجودی تازه: ${faNum(nu ? nu.bakht | 0 : 0)} بخت`);
    }
    return;
  }

  const text = String(msg.text || '').trim();

  /* ---- شروع ---- */
  if (/^\/start/.test(text)) {
    const arg = text.split(/\s+/)[1] || '';
    await DB.upsertUser(uid, {
      name: [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || 'بازیکن',
      chat_ok: true, notif: true
    });
    refRemember(uid);
    let extra = '';
    if (arg) {
      const done = await refBind(uid, arg);
      if (done) extra = `\n\n🎁 <b>${faNum(REF_JOINER)} بخت هدیهٔ دعوت</b> به حسابت اضافه شد!`;
    }
    await say(chatId,
      `🌍 <b>به ویت‌لایف خوش آمدی!</b>\n\n` +
      `از تولد تا مرگ — هر انتخابی سرنوشتت را عوض می‌کند.\n` +
      `شغل، عشق، ثروت، جرم، زندان، خاندان و نسل‌های بعدی.\n\n` +
      `همه‌چیز داخل تلگرام، بدون نصب.${extra}`,
      { reply_markup: playBtn('🎮 شروع زندگی') });
    return;
  }

  /* ---- خاموش/روشن کردن اعلان ---- */
  if (/^\/(stop|mute|off)/.test(text)) {
    await DB.upsertUser(uid, { notif: false }, false);
    await say(chatId, '🔕 اعلان‌ها خاموش شد.\nبرای روشن کردن دوباره بفرست: /on');
    return;
  }
  if (/^\/on/.test(text)) {
    await DB.upsertUser(uid, { notif: true, chat_ok: true }, false);
    await say(chatId, '🔔 اعلان‌ها روشن شد.', { reply_markup: playBtn() });
    return;
  }

  /* ---- دستورهای مدیر ---- */
  if (ADMIN_IDS.includes(uid)) {
    /* پشتیبان دستی — هر وقت خواستی، از همین چت.
       دقت: /backupinfo باید *قبل* بررسی شود، وگرنه الگوی /backup
       آن را هم می‌گیرد و به‌جای نمایش وضعیت، یک نسخهٔ کامل می‌سازد. */
    if (/^\/backup(?:@\S+)?\s*$/.test(text)) {
      await say(chatId, '⏳ در حال ساختن پشتیبان…');
      const r = await backup.runBackup(true);
      if (!r.ok) await say(chatId, '⚠️ پشتیبان‌گیری ناموفق بود: ' + (r.err || 'نامشخص'));
      return;
    }
    if (/^\/backupinfo/.test(text)) {
      const nextIn = backup.backupStatus().at
        ? Math.max(0, Math.round((backup.backupStatus().at + backup.BACKUP_HOURS * 3600000 - Date.now()) / 60000))
        : null;
      await say(chatId,
        '💾 <b>وضعیت پشتیبان‌گیری</b>\n\n' +
        'خودکار: ' + (backup.BACKUP_ON ? '✅ روشن' : '❌ خاموش') + '\n' +
        'هر ' + faNum(backup.BACKUP_HOURS) + ' ساعت یک بار\n' +
        'آخرین نسخه: ' + (backup.backupStatus().at
          ? (new Date(backup.backupStatus().at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
             + (backup.backupStatus().ok ? ' ✅' : ' ⚠️'))
          : 'هنوز ساخته نشده') + '\n' +
        (nextIn !== null ? ('نسخهٔ بعدی تا ' + faNum(nextIn) + ' دقیقهٔ دیگر\n') : '') +
        '\nبرای گرفتن فوری: /backup');
      return;
    }
    if (/^\/pending/.test(text)) {
      const list = await DB.listOrders('pending');
      if (!list.length) { await say(chatId, '✅ هیچ سفارش در انتظاری نیست.'); return; }
      let t = `🧾 <b>${faNum(list.length)} سفارش در انتظار</b>\n\n`;
      list.slice(0, 15).forEach(o => {
        const pk = PACKS[o.pack];
        t += `#${o.id} — ${pk ? pk.n : o.pack} — <code>${o.code || '—'}</code>\n`;
      });
      await say(chatId, t);
      return;
    }
    if (/^\/stats/.test(text)) {
      const s = await statsSnapshot();
      await say(chatId,
        `📊 <b>آمار ویت‌لایف</b>\n\n` +
        `👥 بازیکن: <b>${faNum(s.users)}</b>\n` +
        `🟢 فعال امروز: <b>${faNum(s.today)}</b>\n` +
        `📅 فعال این هفته: <b>${faNum(s.week)}</b>\n` +
        `⭐ کل بخت: <b>${faNum(s.bakht)}</b>\n` +
        `🧾 در انتظار: <b>${faNum(s.pending)}</b>\n` +
        `🤝 دعوت‌ها: <b>${faNum(s.refs)}</b>\n` +
        `💾 دیتابیس: ${s.db}`);
      return;
    }
    if (/^\/help/.test(text)) {
      await say(chatId,
        `🛠️ <b>دستورهای مدیر</b>\n\n` +
        `/pending — سفارش‌های در انتظار\n` +
        `/stats — آمار کامل\n` +
        `/on و /stop — اعلان‌ها`);
      return;
    }
  }

  /* ---- هر پیام دیگر ---- */
  await DB.upsertUser(uid, { chat_ok: true }, false);
  await say(chatId, 'برای بازی روی دکمهٔ پایین بزن 👇', { reply_markup: playBtn() });
}


}

module.exports = { registerBotRoutes };

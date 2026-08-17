/* ================================================================
   ویت‌لایف — فروشگاه
   دعوت دوستان | سفارش کارت‌به‌کارت | پرداخت استارز
================================================================= */
const { auth } = require('./auth');
const { limitHeavy } = require('./middleware');
const { DB } = require('./db');
const { PACKS, BOT_TOKEN, ADMIN_IDS } = require('./config');
const { refCode, refRemember, REF_TIERS, REF_INVITER, REF_JOINER } = require('./refs');
const { deepLink, faNum, tg } = require('./telegram');
const { audit, clientIP } = require('./util');

function registerShopRoutes(app) {
/* ---------------- دعوت دوستان ---------------- */
app.post('/api/ref', auth, async (req, res) => {
  const u = (await DB.getUser(req.user.id)) || {};
  refRemember(req.user.id);
  const refs = u.refs | 0, claimed = u.ref_claimed | 0;
  const tiers = REF_TIERS.map(t => ({
    n: t.n, b: t.b, t: t.t,
    done: refs >= t.n,
    claimed: claimed >= t.n
  }));
  const ready = REF_TIERS.filter(t => refs >= t.n && claimed < t.n)
    .reduce((s, t) => s + t.b, 0);
  res.json({
    ok: true, refs, claimed, tiers, ready,
    inviter: REF_INVITER, joiner: REF_JOINER,
    link: deepLink(refCode(req.user.id)),
    code: refCode(req.user.id)
  });
});
app.post('/api/ref/claim', auth, async (req, res) => {
  const u = (await DB.getUser(req.user.id)) || {};
  const refs = u.refs | 0;
  let claimed = u.ref_claimed | 0, add = 0;
  for (const t of REF_TIERS) {
    if (refs >= t.n && claimed < t.n) { add += t.b; claimed = t.n; }
  }
  if (!add) return res.json({ ok: true, add: 0 });
  await DB.upsertUser(req.user.id, { ref_claimed: claimed });
  const nu = await DB.addBakht(req.user.id, add);
  await audit(req.user.id, 'ref-tier', add, 'پاداش پلکانی', null, clientIP(req));
  res.json({ ok: true, add, bakht: nu ? nu.bakht | 0 : 0 });
});

/* ---------------- سفارش کارت‌به‌کارت ---------------- */
app.post('/api/order', auth, limitHeavy, async (req, res) => {
  const b = req.body || {};
  const rc = String(b.receipt || '');
  if (rc && !/^data:image\/(png|jpe?g|webp);base64,/.test(rc))
    return res.status(400).json({ ok: false, err: 'bad_image' });
  if (rc.length > 4000000) return res.status(413).json({ ok: false, err: 'image_too_big' });
  const pk = PACKS[String(b.pack || '')] || null;
  const id = await DB.addOrder({
    uid: req.user.id,
    code: String(b.code || '').slice(0, 40),
    pack: String(b.pack || '').slice(0, 20),
    bakht: pk ? pk.bakht : Math.max(0, Math.min(100000, Number(b.bakht) | 0)),
    receipt: rc || null,
    kind: 'card'
  });
  /* خبر فوری به مدیر — با دکمهٔ تأیید/رد در همان چت */
  try { pushOrderToAdmin(id, req.user, pk, rc); } catch (e) {}
  res.json({ ok: true, id });
});

async function pushOrderToAdmin(id, user, pk, receipt) {
  if (!BOT_TOKEN || !ADMIN_IDS.length) return;
  const cap =
    `🧾 <b>سفارش تازه</b>\n\n` +
    `بسته: <b>${pk ? pk.n : '—'}</b>\n` +
    `مبلغ: <b>${pk ? faNum(pk.toman.toLocaleString('en-US')) : '—'} تومان</b>\n` +
    `بخت: <b>${pk ? faNum(pk.bakht) : '—'}</b>\n` +
    `بازیکن: ${user.name || '—'}\n` +
    `شناسه: <code>${String(user.id).replace(/^dev:/, '')}</code>\n` +
    `شمارهٔ سفارش: <code>#${id}</code>`;
  const kb = { inline_keyboard: [[
    { text: '✅ تأیید و شارژ', callback_data: 'ok:' + id },
    { text: '❌ رد',           callback_data: 'no:' + id }
  ]] };
  for (const a of ADMIN_IDS) {
    let sent = null;
    if (receipt && /^data:image\/(png|jpe?g|webp);base64,/.test(receipt)) {
      /* رسید را به‌صورت عکس واقعی می‌فرستیم تا مدیر همان‌جا ببیند */
      try {
        const b64 = receipt.split(',')[1];
        const buf = Buffer.from(b64, 'base64');
        const fd = new FormData();
        fd.append('chat_id', a);
        fd.append('caption', cap);
        fd.append('parse_mode', 'HTML');
        fd.append('reply_markup', JSON.stringify(kb));
        fd.append('photo', new Blob([buf], { type: 'image/jpeg' }), 'receipt.jpg');
        const r = await fetch(TGAPI + 'sendPhoto', { method: 'POST', body: fd });
        sent = await r.json().catch(() => null);
      } catch (e) { sent = null; }
    }
    if (!sent || !sent.ok) {
      sent = await tg('sendMessage', {
        chat_id: a, text: cap, parse_mode: 'HTML', reply_markup: kb });
    }
    if (sent && sent.ok && sent.result && sent.result.message_id)
      await DB.setOrderMsg(id, sent.result.message_id);
  }
}

app.get('/api/paycfg', async (req, res) => {
  const c = await DB.getCfg();
  res.json({ ok: true, cfg: {
    card:  c.card  || '', sheba: c.sheba || '',
    owner: c.owner || '', bank:  c.bank  || '',
    tg:    c.tg    || '', on: c.on !== '0',
    stars: !!BOT_TOKEN && c.stars !== '0' } });
});

/* ================================================================
   پرداخت با استارز تلگرام ⭐
   خودکار، آنی، بدون دخالت مدیر، برای کاربر خارج از ایران هم کار می‌کند.
================================================================= */
app.post('/api/stars/invoice', auth, limitHeavy, async (req, res) => {
  if (!BOT_TOKEN) return res.status(400).json({ ok: false, err: 'no_bot' });
  const c = await DB.getCfg();
  if (c.stars === '0') return res.status(400).json({ ok: false, err: 'off' });
  const key = String((req.body && req.body.pack) || '');
  const pk = PACKS[key];
  if (!pk) return res.status(400).json({ ok: false, err: 'bad_pack' });
  const payload = 'wl:' + key + ':' + String(req.user.id).replace(/^dev:/, '') + ':' + Date.now();
  const r = await tg('createInvoiceLink', {
    title: pk.n,
    description: `${pk.bakht} بخت برای ویت‌لایف — آنی به حسابت اضافه می‌شود.`,
    payload,
    provider_token: '',           /* استارز نیاز به درگاه ندارد */
    currency: 'XTR',
    prices: [{ label: pk.n, amount: pk.stars }]
  });
  if (!r || !r.ok || !r.result)
    return res.status(502).json({ ok: false, err: 'invoice_failed' });
  res.json({ ok: true, link: r.result, stars: pk.stars, bakht: pk.bakht });
});


}

module.exports = { registerShopRoutes };

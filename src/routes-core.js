/* ================================================================
   ویت‌لایف — مسیرهای اصلی
   سلامت | ورود | ذخیرهٔ ابری | درآمد بخت | رتبه‌بندی
================================================================= */
const { auth } = require('./auth');
const db = require('./db');
const { DB, wealthFromSave, scoreFromSave } = db;
const { refRemember, refBind, REF_JOINER, refCode } = require('./refs');
const { deepLink } = require('./telegram');
const { ADMIN_IDS, BOT_TOKEN, EARN_MAX_PER_CALL, EARN_MAX_PER_DAY } = require('./config');
const { audit, todayStamp } = require('./util');

function registerCoreRoutes(app) {
/* ---------------- مسیرها ---------------- */
app.get('/api/health', (req, res) =>
  res.json({ ok: true, db: db.pool ? 'postgres' : 'file', time: Date.now() }));

app.post('/api/me', auth, async (req, res) => {
  const u = await DB.upsertUser(req.user.id, { name: req.user.name });
  if (u.banned) return res.status(403).json({ ok: false, err: 'banned' });
  refRemember(req.user.id);
  /* اگر با لینک دعوت آمده، همین‌جا ثبت می‌شود */
  let refBonus = 0;
  const sp = String(req.user.startParam || '');
  if (sp && !u.ref_by) {
    const done = await refBind(req.user.id, sp);
    if (done) refBonus = REF_JOINER;
  }
  const fresh = refBonus ? await DB.getUser(req.user.id) : u;
  res.json({
    ok: true,
    user: { id: fresh.id, name: fresh.name, bakht: fresh.bakht | 0 },
    isAdmin: ADMIN_IDS.includes(String(req.user.id).replace(/^dev:/, '')),
    refBonus,
    stars: !!BOT_TOKEN,
    refLink: deepLink(refCode(req.user.id))
  });
});

app.post('/api/save', auth, async (req, res) => {
  const b = req.body || {};
  const s = b.save, w = b.wallet;
  if (s && JSON.stringify(s).length > 900000)
    return res.status(413).json({ ok: false, err: 'too_big' });
  const patch = {};
  /* فقط چیزهایی که واقعاً فرستاده شده‌اند به‌روز می‌شوند —
     همگام‌سازی کیف پول نباید ذخیرهٔ زندگی را پاک کند */
  if (s !== undefined) patch.save = s || null;
  if (w !== undefined) patch.wallet = w || null;
  /* ⛔ ثروت و نسل هرگز مستقیم از کاربر پذیرفته نمی‌شوند.
     همان درسی که دربارهٔ «بخت» گرفتیم: هر عددی که جدول رتبه‌بندی را
     تعیین می‌کند باید سمت سرور و از روی خودِ ذخیرهٔ بازی محاسبه شود.
     پیش‌تر یک درخواست ساده می‌توانست ۹۰۰ تریلیون ثروت جعلی ثبت کند. */
  if (s !== undefined) {
    patch.wealth = wealthFromSave(s);
    patch.gen    = Math.max(1, Math.min(200, Number(s && s.gen) | 0 || 1));
    patch.score  = scoreFromSave(s);
  }
  if (b.fam    !== undefined) patch.fam    = String(b.fam || '').slice(0, 40) || null;
  /* نام شخصیت داخل بازی — جهان مشترک باید این را نشان دهد، نه نام تلگرام */
  if (s && s.name) patch.char_name = String(s.name).slice(0, 40).replace(/[<>]/g, '');
  /* مکان و شهرت — پایهٔ برخورد واقع‌گرایانه و اخبار */
  if (s) {
    if (s.country) patch.country = String(s.country).slice(0, 40).replace(/[<>]/g, '');
    if (s.city)    patch.city    = String(s.city).slice(0, 40).replace(/[<>]/g, '');
    patch.fame  = Math.max(0, Math.min(100, Number(s.fame) | 0));
    patch.fame_rep = Math.max(0, Math.min(100, Number(s.fameR === undefined ? 60 : s.fameR) | 0));
    patch.p_age = Math.max(0, Math.min(130, Number(s.age) | 0));
    patch.job_t = String((s.job && s.job.t) || '').slice(0, 40).replace(/[<>]/g, '');
    patch.alive = s.alive !== false;
  }
  /* ⛔ بخت هرگز از سمت کاربر پذیرفته نمی‌شود.
     تنها راه افزایش بخت: خرید تأییدشده، پاداش دعوت، یا اقدام مدیر.
     کلاینت فقط «درآمد بازی» را گزارش می‌دهد و سرور آن را سقف‌گذاری می‌کند. */
  const cur = (await DB.getUser(req.user.id)) || {};
  let credited = 0;
  if (b.earn !== undefined) {
    const claim = Math.max(0, Math.min(EARN_MAX_PER_CALL, Number(b.earn) | 0));
    credited = await earnBakht(req.user.id, claim, cur);
  }
  await DB.upsertUser(req.user.id, patch);
  const fresh = credited ? await DB.getUser(req.user.id) : cur;
  res.json({ ok: true, bakht: (fresh.bakht | 0), credited });
});

async function earnBakht(id, amount, cur) {
  if (amount <= 0) return 0;
  cur = cur || (await DB.getUser(id)) || {};
  const today = todayStamp();
  let day = cur.earn_day, used = cur.earn_today | 0;
  if (day !== today) { day = today; used = 0; }
  const room = Math.max(0, EARN_MAX_PER_DAY - used);
  const give = Math.min(amount, room);
  if (give <= 0) {
    await DB.upsertUser(id, { earn_day: day, earn_today: used }, false);
    return 0;
  }
  await DB.addBakht(id, give);
  await DB.upsertUser(id, { earn_day: day, earn_today: used + give }, false);
  await audit(id, 'earn', give, 'درآمد بازی');
  return give;
}
app.post('/api/load', auth, async (req, res) => {
  const u = await DB.getUser(req.user.id);
  if (!u) return res.json({ ok: true, save: null, wallet: null });
  res.json({ ok: true, save: u.save || null, wallet: u.wallet || null, bakht: u.bakht | 0 });
});

/* رتبه‌بندی جهانی */
app.get('/api/top', async (req, res) => {
  const rows = await DB.top(Number(req.query.n) || 50);
  res.json({ ok: true, top: rows.map(r => ({
    name: r.name, wealth: Number(r.wealth) || 0, gen: r.gen | 0, fam: r.fam || '' })) });
});


}

module.exports = { registerCoreRoutes };

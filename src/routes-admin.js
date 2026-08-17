/* ================================================================
   ویت‌لایف — پنل مدیریت
   سفارش‌ها | کاربران | آمار | اقتصاد | نگهداری | پیام همگانی
================================================================= */
const { auth, adminOnly, adminSecure, newSession, adminSessions, SESSION_MS } = require('./auth');
const { rateLimit, RL, findGame } = require('./middleware');
const db = require('./db');
const { DB, statsSnapshot } = db;
const { say, playBtn, faNum, notifyAdmins, tg, getBotUser, setupWebhook } = require('./telegram');
const { notifRound } = require('./notify');
const backup = require('./backup');
const { REF_INVITER, REF_JOINER } = require('./refs');
const { BOT_TOKEN, SELF_URL, DEV_MODE, ADMIN_IDS, PACKS, STAR_TOMAN,
        EARN_MAX_PER_DAY } = require('./config');
const { audit, clientIP } = require('./util');

function registerAdminRoutes(app) {
/* ورود — بدون رمز دوم؛ فقط برای سازگاری با کلاینت‌های قدیمی */
app.post('/api/admin/login', auth, adminOnly, rateLimit(10, 10 * 60 * 1000), async (req, res) => {
  const raw = String(req.user.id).replace(/^dev:/, '');
  const ip = clientIP(req);
  const token = newSession(raw, ip);
  await audit(raw, 'admin-login', 0, 'ورود به پنل', raw, ip);
  res.json({ ok: true, session: token, noPin: true, expires: SESSION_MS });
});
app.post('/api/admin/logout', auth, adminOnly, (req, res) => {
  const tok = req.get('X-Admin-Session') || (req.body && req.body.session) || '';
  adminSessions.delete(String(tok));
  res.json({ ok: true });
});

/* ---------------- پنل ادمین ---------------- */
app.post('/api/admin/orders', auth, adminOnly, async (req, res) => {
  const list = await DB.listOrders(req.body && req.body.status);
  res.json({ ok: true, orders: list });
});
app.post('/api/admin/order/:id', auth, adminOnly, async (req, res) => {
  const act = String((req.body && req.body.action) || '');
  const before = await DB.getOrder(req.params.id);
  if (!before) return res.status(404).json({ ok: false, err: 'not_found' });
  if (before.status !== 'pending')
    return res.json({ ok: true, order: before, already: true });
  const o = await DB.setOrder(req.params.id, act === 'approve' ? 'approved' : 'rejected');
  if (o && act === 'approve') {
    await DB.addBakht(o.uid, o.bakht | 0);
    await audit(o.uid, 'order-approve', o.bakht | 0, o.pack || '',
                String(req.user.id).replace(/^dev:/, ''), clientIP(req));
    const pk = PACKS[o.pack];
    await say(o.uid,
      `✅ <b>سفارشت تأیید شد!</b>\n\n${pk ? pk.n : ''}\n` +
      `⭐ <b>${faNum(o.bakht | 0)} بخت</b> به حسابت اضافه شد.`,
      { reply_markup: playBtn('⭐ خرج کردن بخت') });
  } else if (o) {
    await say(o.uid, `❌ <b>سفارشت رد شد.</b>\nکد: <code>${o.code || '—'}</code>`);
  }
  res.json({ ok: true, order: o });
});
app.post('/api/admin/cfg', auth, adminOnly, async (req, res) => {
  const b = req.body || {};
  for (const k of ['card', 'sheba', 'owner', 'bank', 'tg', 'on', 'stars', 'notif'])
    if (b[k] !== undefined) await DB.setCfg(k, String(b[k]).slice(0, 120));
  res.json({ ok: true, cfg: await DB.getCfg() });
});
app.post('/api/admin/user', auth, adminOnly, async (req, res) => {
  const b = req.body || {};
  const id = String(b.id || '');
  if (!id) return res.status(400).json({ ok: false });
  const u = await DB.getUser(id);
  if (!u) return res.status(404).json({ ok: false, err: 'not_found' });
  if (b.addBakht !== undefined) await DB.addBakht(id, Number(b.addBakht) | 0);
  if (b.banned !== undefined) await DB.upsertUser(id, { banned: !!b.banned }, false);
  const nu = await DB.getUser(id);
  res.json({ ok: true, user: {
    id: nu.id, name: nu.name, bakht: nu.bakht | 0, banned: !!nu.banned, refs: nu.refs | 0 } });
});
app.post('/api/admin/stats', auth, adminOnly, async (req, res) => {
  res.json({ ok: true, stats: await statsSnapshot() });
});

/* ================================================================
   ═══ پنل مدیریت پیشرفته ═══
================================================================= */

/* آمار عمیق: کاربر، درآمد، نگهداشت، دعوت، اقتصاد */
app.post('/api/admin/deep', auth, adminOnly, async (req, res) => {
  const out = { db: db.pool ? 'postgres' : 'file', at: Date.now() };
  if (db.pool) {
    const u = await db.pool.query(`
      SELECT COUNT(*) total,
        COUNT(*) FILTER (WHERE seen > NOW() - INTERVAL '1 day')   d1,
        COUNT(*) FILTER (WHERE seen > NOW() - INTERVAL '7 days')  d7,
        COUNT(*) FILTER (WHERE seen > NOW() - INTERVAL '30 days') d30,
        COUNT(*) FILTER (WHERE created > NOW() - INTERVAL '1 day')  new1,
        COUNT(*) FILTER (WHERE created > NOW() - INTERVAL '7 days') new7,
        COUNT(*) FILTER (WHERE banned=TRUE) banned,
        COUNT(*) FILTER (WHERE chat_ok=TRUE) chat,
        COUNT(*) FILTER (WHERE notif=TRUE AND chat_ok=TRUE) notifiable,
        COALESCE(SUM(bakht),0) bakht, COALESCE(SUM(refs),0) refs,
        COALESCE(SUM(spent),0) spent,
        COALESCE(AVG(NULLIF(gen,0)),0) avggen,
        COALESCE(MAX(wealth),0) maxwealth
      FROM users`);
    Object.assign(out, {
      users: +u.rows[0].total, dau: +u.rows[0].d1, wau: +u.rows[0].d7, mau: +u.rows[0].d30,
      new1: +u.rows[0].new1, new7: +u.rows[0].new7, banned: +u.rows[0].banned,
      chatOk: +u.rows[0].chat, notifiable: +u.rows[0].notifiable,
      bakht: +u.rows[0].bakht, refs: +u.rows[0].refs, spentStars: +u.rows[0].spent,
      avgGen: Math.round((+u.rows[0].avggen) * 10) / 10, maxWealth: +u.rows[0].maxwealth
    });
    const o = await db.pool.query(`
      SELECT status, kind, COUNT(*) c, COALESCE(SUM(bakht),0) b
      FROM orders GROUP BY status, kind`);
    out.orders = o.rows.map(r => ({ status: r.status, kind: r.kind, n: +r.c, bakht: +r.b }));
    const rev = await db.pool.query(`
      SELECT kind, COUNT(*) n, COALESCE(SUM(bakht),0) b
      FROM orders WHERE status='approved' GROUP BY kind`);
    out.revenue = rev.rows.map(r => ({ kind: r.kind, n: +r.n, bakht: +r.b }));
    const daily = await db.pool.query(`
      SELECT to_char(created,'YYYY-MM-DD') d, COUNT(*) n,
             COALESCE(SUM(bakht),0) b
      FROM orders WHERE status='approved' AND created > NOW() - INTERVAL '14 days'
      GROUP BY d ORDER BY d DESC`);
    out.daily = daily.rows.map(r => ({ d: r.d, n: +r.n, bakht: +r.b }));
    const top = await db.pool.query(`
      SELECT id,name,bakht,spent,refs,gen,wealth FROM users
      ORDER BY spent DESC NULLS LAST LIMIT 10`);
    out.topSpenders = top.rows.map(r => ({
      id: r.id, name: r.name, bakht: r.bakht | 0, spent: r.spent | 0,
      refs: r.refs | 0, gen: r.gen | 0, wealth: Number(r.wealth) || 0 }));
    const inv = await db.pool.query(`
      SELECT id,name,refs FROM users WHERE refs>0 ORDER BY refs DESC LIMIT 10`);
    out.topInviters = inv.rows.map(r => ({ id: r.id, name: r.name, refs: r.refs | 0 }));
  } else {
    const arr = Object.values(db.mem.users); const now = Date.now();
    const since = d => arr.filter(u => now - (u.seen || 0) < d * 86400000).length;
    out.users = arr.length; out.dau = since(1); out.wau = since(7); out.mau = since(30);
    out.new1 = 0; out.new7 = 0;
    out.banned = arr.filter(u => u.banned).length;
    out.chatOk = arr.filter(u => u.chat_ok).length;
    out.notifiable = arr.filter(u => u.chat_ok && u.notif !== false).length;
    out.bakht = arr.reduce((s2, u) => s2 + (u.bakht | 0), 0);
    out.refs = arr.reduce((s2, u) => s2 + (u.refs | 0), 0);
    out.spentStars = arr.reduce((s2, u) => s2 + (u.spent | 0), 0);
    out.avgGen = arr.length ? Math.round(arr.reduce((s2, u) => s2 + (u.gen || 1), 0) / arr.length * 10) / 10 : 1;
    out.maxWealth = arr.reduce((s2, u) => Math.max(s2, u.wealth || 0), 0);
    const g = {};
    (db.mem.orders || []).forEach(o => {
      const k = o.status + '|' + (o.kind || 'card');
      g[k] = g[k] || { status: o.status, kind: o.kind || 'card', n: 0, bakht: 0 };
      g[k].n++; g[k].bakht += o.bakht | 0;
    });
    out.orders = Object.values(g);
    out.revenue = out.orders.filter(x => x.status === 'approved');
    out.daily = [];
    out.topSpenders = arr.slice().sort((a2, b2) => (b2.spent | 0) - (a2.spent | 0)).slice(0, 10)
      .map(u => ({ id: u.id, name: u.name, bakht: u.bakht | 0, spent: u.spent | 0,
                   refs: u.refs | 0, gen: u.gen | 0, wealth: u.wealth || 0 }));
    out.topInviters = arr.filter(u => u.refs).sort((a2, b2) => b2.refs - a2.refs).slice(0, 10)
      .map(u => ({ id: u.id, name: u.name, refs: u.refs | 0 }));
  }
  out.sessions = adminSessions.size;
  out.rateKeys = RL.size;
  out.uptime = Math.round(process.uptime());
  out.memMB = Math.round(process.memoryUsage().rss / 1048576);
  out.node = process.version;
  out.pinSet = false;   /* رمز دوم حذف شده — هویت تلگرام کافی است */
  out.botOk = !!BOT_TOKEN;
  out.admins = ADMIN_IDS.length;
  res.json({ ok: true, deep: out });
});

/* ================================================================
   قیف بازیکن — کجا بازیکن‌ها را از دست می‌دهیم؟
   هر پله نسبت به پلهٔ قبل سنجیده می‌شود تا نقطهٔ ریزش پیدا شود:
   ورود → ساخت شخصیت → رسیدن به ۱۸ سالگی → برگشت روز بعد →
   ماندن تا هفتهٔ بعد → باز کردن چت بات → دعوت موفق → خرید
   به‌علاوه: نگهداشت روزانهٔ ۱۴ روز اخیر (چند درصد تازه‌واردها برگشتند)
================================================================= */
app.post('/api/admin/funnel', auth, adminOnly, async (req, res) => {
  const out = { at: Date.now() };
  if (db.pool) {
    /* پله‌های قیف — همه در یک کوئری تا سرور رایگان اذیت نشود */
    const f = await db.pool.query(`
      SELECT COUNT(*) total,
        COUNT(*) FILTER (WHERE save IS NOT NULL OR char_name IS NOT NULL) created_char,
        COUNT(*) FILTER (WHERE p_age >= 18 OR gen > 1) adult,
        COUNT(*) FILTER (WHERE created IS NOT NULL
                         AND seen > created + INTERVAL '20 hours') day2,
        COUNT(*) FILTER (WHERE created IS NOT NULL
                         AND seen > created + INTERVAL '6 days') day7,
        COUNT(*) FILTER (WHERE chat_ok = TRUE) chat,
        COUNT(*) FILTER (WHERE refs > 0) invited,
        COUNT(*) FILTER (WHERE spent > 0) paid_stars
      FROM users WHERE banned = FALSE`);
    const r0 = f.rows[0];
    /* خریدهای کارتی تأییدشده هم «خرید» حساب می‌شوند */
    let paidCard = 0;
    try {
      const pc = await db.pool.query(
        `SELECT COUNT(DISTINCT uid) c FROM orders WHERE status='approved'`);
      paidCard = +pc.rows[0].c;
    } catch (e) {}
    out.steps = [
      { k: 'enter',  n: 'ورود به بازی',        c: +r0.total },
      { k: 'char',   n: 'ساخت شخصیت',          c: +r0.created_char },
      { k: 'adult',  n: 'رسیدن به ۱۸ سالگی',    c: +r0.adult },
      { k: 'day2',   n: 'برگشت روز بعد',        c: +r0.day2 },
      { k: 'day7',   n: 'ماندن تا هفتهٔ بعد',    c: +r0.day7 },
      { k: 'chat',   n: 'باز کردن چت بات',      c: +r0.chat },
      { k: 'invite', n: 'دعوت موفق دوست',       c: +r0.invited },
      { k: 'pay',    n: 'خرید (استارز یا کارت)', c: Math.max(+r0.paid_stars, paidCard) }
    ];
    /* نگهداشت روزانه: از تازه‌واردهای هر روز، چند نفر روز بعد برگشتند */
    try {
      const d = await db.pool.query(`
        SELECT to_char(created,'YYYY-MM-DD') d,
               COUNT(*) new_users,
               COUNT(*) FILTER (WHERE seen > created + INTERVAL '20 hours') ret1
        FROM users
        WHERE banned = FALSE AND created > NOW() - INTERVAL '14 days'
          AND created < NOW() - INTERVAL '1 day'
        GROUP BY 1 ORDER BY 1 DESC`);
      out.cohorts = d.rows.map(r => ({
        d: r.d, new1: +r.new_users, ret1: +r.ret1,
        pct: +r.new_users ? Math.round(+r.ret1 / +r.new_users * 100) : 0
      }));
    } catch (e) { out.cohorts = []; }
    /* آخرین باری که هر گروه دیده شده — برای حس کردن نبض بازی */
    try {
      const g = await db.pool.query(`
        SELECT COUNT(*) FILTER (WHERE seen > NOW() - INTERVAL '1 hour')  h1,
               COUNT(*) FILTER (WHERE seen > NOW() - INTERVAL '6 hours') h6,
               COUNT(*) FILTER (WHERE seen > NOW() - INTERVAL '24 hours') h24
        FROM users WHERE banned = FALSE`);
      out.pulse = { h1: +g.rows[0].h1, h6: +g.rows[0].h6, h24: +g.rows[0].h24 };
    } catch (e) {}
  } else {
    /* حالت فایل — برای تست محلی */
    const arr = Object.values(db.mem.users).filter(u => !u.banned);
    const now = Date.now();
    const step = (n, k, fn) => ({ k, n, c: arr.filter(fn).length });
    out.steps = [
      { k: 'enter', n: 'ورود به بازی', c: arr.length },
      step('ساخت شخصیت', 'char', u => u.save || u.char_name),
      step('رسیدن به ۱۸ سالگی', 'adult', u => (u.p_age | 0) >= 18 || (u.gen | 0) > 1),
      step('برگشت روز بعد', 'day2', u => u.created && u.seen && (u.seen - u.created) > 20 * 3600e3),
      step('ماندن تا هفتهٔ بعد', 'day7', u => u.created && u.seen && (u.seen - u.created) > 6 * 86400e3),
      step('باز کردن چت بات', 'chat', u => u.chat_ok),
      step('دعوت موفق دوست', 'invite', u => (u.refs | 0) > 0),
      step('خرید (استارز یا کارت)', 'pay', u => (u.spent | 0) > 0)
    ];
    out.cohorts = [];
    out.pulse = {
      h1:  arr.filter(u => now - (u.seen || 0) < 3600e3).length,
      h6:  arr.filter(u => now - (u.seen || 0) < 6 * 3600e3).length,
      h24: arr.filter(u => now - (u.seen || 0) < 86400e3).length
    };
  }
  res.json({ ok: true, funnel: out });
});

/* جست‌وجوی کاربر */
app.post('/api/admin/users', auth, adminOnly, async (req, res) => {
  const b = req.body || {};
  const rows = await DB.searchUsers(b.q, b.limit);
  res.json({ ok: true, total: await DB.countUsers(), users: rows.map(u => ({
    id: u.id, name: u.name, bakht: u.bakht | 0, wealth: Number(u.wealth) || 0,
    gen: u.gen | 0, fam: u.fam || '', refs: u.refs | 0, spent: u.spent | 0,
    banned: !!u.banned, chat: !!u.chat_ok, notif: u.notif !== false,
    seen: u.seen, note: u.note || '', flags: u.flags || '',
    earnToday: u.earn_today | 0, hasSave: !!u.save })) });
});

/* پروندهٔ کامل یک کاربر */
app.post('/api/admin/user/detail', auth, adminOnly, async (req, res) => {
  const id = String((req.body && req.body.id) || '');
  const u = await DB.getUser(id);
  if (!u) return res.status(404).json({ ok: false, err: 'not_found' });
  const orders = (await DB.listOrders()).filter(o => String(o.uid) === id).slice(0, 30);
  const log = await DB.listAudit({ uid: id, limit: 40 });
  let invitedBy = null;
  if (u.ref_by) { const iv = await DB.getUser(u.ref_by); invitedBy = iv ? { id: iv.id, name: iv.name } : null; }
  res.json({ ok: true, user: {
    id: u.id, name: u.name, bakht: u.bakht | 0, wealth: Number(u.wealth) || 0,
    score: u.score | 0, gen: u.gen | 0, fam: u.fam || '', refs: u.refs | 0,
    refClaimed: u.ref_claimed | 0, spent: u.spent | 0, banned: !!u.banned,
    chat: !!u.chat_ok, notif: u.notif !== false, seen: u.seen, created: u.created,
    note: u.note || '', flags: u.flags || '', earnToday: u.earn_today | 0,
    earnDay: u.earn_day || '', rankLast: u.rank_last, invitedBy,
    save: u.save ? { name: u.save.name, age: u.save.age, country: u.save.country,
                     cash: u.save.cash, alive: u.save.alive } : null },
    orders: orders.map(o => ({ id: o.id, pack: o.pack, bakht: o.bakht | 0,
      status: o.status, kind: o.kind || 'card', code: o.code, created: o.created })),
    audit: log });
});

/* اقدام روی کاربر — نیازمند نشست امن */
app.post('/api/admin/user/act', auth, adminSecure, async (req, res) => {
  const b = req.body || {};
  const id = String(b.id || '');
  const act = String(b.act || '');
  const actor = String(req.user.id).replace(/^dev:/, '');
  const ip = clientIP(req);
  const u = await DB.getUser(id);
  if (!u) return res.status(404).json({ ok: false, err: 'not_found' });
  let msg = '';
  switch (act) {
    case 'addBakht': {
      const n = Math.max(-1e6, Math.min(1e6, Number(b.amount) | 0));
      await DB.addBakht(id, n);
      await audit(id, 'admin-bakht', n, b.note || '', actor, ip);
      msg = `${n > 0 ? '+' : ''}${n} بخت`;
      if (n > 0) { try { await say(id, `🎁 <b>${faNum(n)} بخت</b> به حسابت اضافه شد.`,
        { reply_markup: playBtn() }); } catch (e) {} }
      break;
    }
    case 'setBakht': {
      const n = Math.max(0, Math.min(1e7, Number(b.amount) | 0));
      await DB.upsertUser(id, { bakht: n }, false);
      await audit(id, 'admin-setbakht', n, b.note || '', actor, ip);
      msg = `بخت روی ${n} تنظیم شد`; break;
    }
    case 'ban':
      await DB.upsertUser(id, { banned: true }, false);
      await audit(id, 'admin-ban', 0, b.note || '', actor, ip);
      msg = 'مسدود شد'; break;
    case 'unban':
      await DB.upsertUser(id, { banned: false }, false);
      await audit(id, 'admin-unban', 0, b.note || '', actor, ip);
      msg = 'رفع مسدودی'; break;
    case 'note':
      await DB.upsertUser(id, { note: String(b.note || '').slice(0, 400) }, false);
      msg = 'یادداشت ذخیره شد'; break;
    case 'flag':
      await DB.upsertUser(id, { flags: String(b.flags || '').slice(0, 120) }, false);
      await audit(id, 'admin-flag', 0, b.flags || '', actor, ip);
      msg = 'برچسب ثبت شد'; break;
    case 'resetSave':
      /* ذخیره + هر عددی که از روی آن ساخته می‌شود (ثروت، امتیاز، رتبه)
         باید با هم صفر شوند — وگرنه بازیکن بدون ذخیره در جدول می‌ماند */
      await DB.upsertUser(id, { save: null, wealth: 0, score: 0, gen: 1,
        fame: 0, p_age: 0, job_t: null, char_name: null, alive: true }, false);
      await audit(id, 'admin-resetsave', 0, '', actor, ip);
      msg = 'ذخیره و آمار رتبه‌بندی پاک شد'; break;
    case 'resetEarn':
      await DB.upsertUser(id, { earn_today: 0, earn_day: null }, false);
      msg = 'سقف روزانه صفر شد'; break;
    case 'message': {
      const t = String(b.text || '').slice(0, 900);
      if (!t) return res.status(400).json({ ok: false, err: 'empty' });
      const sent = await say(id, t, { reply_markup: playBtn() });
      await audit(id, 'admin-msg', 0, t.slice(0, 120), actor, ip);
      msg = sent ? 'پیام ارسال شد' : 'ارسال نشد (چت بسته است)'; break;
    }
    default: return res.status(400).json({ ok: false, err: 'bad_act' });
  }
  const nu = await DB.getUser(id);
  res.json({ ok: true, msg, user: { id: nu.id, name: nu.name, bakht: nu.bakht | 0,
    banned: !!nu.banned, note: nu.note || '', flags: nu.flags || '' } });
});

/* دفتر رویداد */
app.post('/api/admin/audit', auth, adminOnly, async (req, res) => {
  const b = req.body || {};
  res.json({ ok: true, log: await DB.listAudit({ uid: b.uid, limit: b.limit }) });
});

/* تنظیمات اقتصاد — بدون آپدیت بازی قابل تغییر */
app.post('/api/admin/econ', auth, adminSecure, async (req, res) => {
  const b = req.body || {};
  const actor = String(req.user.id).replace(/^dev:/, '');
  const keys = ['refInviter', 'refJoiner', 'earnDayCap', 'starToman', 'saleOff'];
  for (const k of keys) {
    if (b[k] !== undefined) {
      await DB.setCfg('econ:' + k, String(Number(b[k]) || 0));
      await audit(null, 'admin-econ', Number(b[k]) || 0, k, actor, clientIP(req));
    }
  }
  const c = await DB.getCfg();
  res.json({ ok: true, econ: {
    refInviter: Number(c['econ:refInviter']) || REF_INVITER,
    refJoiner: Number(c['econ:refJoiner']) || REF_JOINER,
    earnDayCap: Number(c['econ:earnDayCap']) || EARN_MAX_PER_DAY,
    starToman: Number(c['econ:starToman']) || STAR_TOMAN,
    saleOff: Number(c['econ:saleOff']) || 0 } });
});

/* سلامت سامانه */
app.post('/api/admin/health', auth, adminOnly, async (req, res) => {
  const checks = [];
  const add = (n, ok, d) => checks.push({ n, ok: !!ok, d: d || '' });
  add('دیتابیس', true, db.pool ? 'پستگرس متصل' : 'حالت فایل (داده با ری‌استارت پاک می‌شود)');
  if (db.pool) {
    try { const t0 = Date.now(); await db.pool.query('SELECT 1');
      add('پاسخ دیتابیس', true, (Date.now() - t0) + ' میلی‌ثانیه'); }
    catch (e) { add('پاسخ دیتابیس', false, e.message); }
  }
  add('توکن بات', !!BOT_TOKEN, BOT_TOKEN ? 'تنظیم شده' : 'تنظیم نشده');
  add('نام کاربری بات', !!getBotUser(), getBotUser() ? '@' + getBotUser() : 'ناشناخته');
  add('آدرس سرور', !!SELF_URL, SELF_URL || 'تنظیم نشده — وب‌هوک کار نمی‌کند');
  add('احراز هویت مدیر', true, 'با امضای تلگرام (رمز دوم حذف شده)');
  add('فهرست مدیران', ADMIN_IDS.length > 0, ADMIN_IDS.length + ' نفر');
  add('حالت توسعه', !DEV_MODE, DEV_MODE ? '⚠️ روشن است! در تولید خاموش کن' : 'خاموش (درست)');
  add('فایل بازی', !!findGame(), findGame() ? 'پیدا شد' : 'پیدا نشد');
  if (BOT_TOKEN) {
    try { const w = await tg('getWebhookInfo', {});
      const url = w && w.result && w.result.url;
      add('وب‌هوک', !!url, url ? 'وصل' : 'وصل نیست');
      if (w && w.result && w.result.last_error_message)
        add('آخرین خطای وب‌هوک', false, w.result.last_error_message);
    } catch (e) { add('وب‌هوک', false, e.message); }
  }
  const cfg = await DB.getCfg();
  add('شمارهٔ کارت', !!cfg.card, cfg.card ? 'تنظیم شده' : 'تنظیم نشده — فروش کارتی کار نمی‌کند');
  res.json({ ok: true, checks,
    info: { uptime: Math.round(process.uptime()), memMB: Math.round(process.memoryUsage().rss / 1048576),
            node: process.version, sessions: adminSessions.size } });
});

/* اقدام‌های نگهداری */
/* ---------------- بازگردانی از پشتیبان ----------------
   محتوای فایل پشتیبان (JSON باز شده) را می‌گیرد و کاربران را برمی‌گرداند.
   عمداً فقط جدول users را بازمی‌گرداند: مهم‌ترین چیز، پیشرفت بازیکنان است.
   حالت پیش‌فرض «ادغام» است — کاربر موجود دست‌نخورده می‌ماند مگر اینکه
   صراحتاً overwrite بخواهی. */
app.post('/api/admin/restore', auth, adminSecure, async (req, res) => {
  const b = req.body || {};
  const data = b.data;
  const overwrite = !!b.overwrite;
  const actor = String(req.user.id).replace(/^dev:/, '');
  if (!data || typeof data !== 'object' || !data.tables || !Array.isArray(data.tables.users))
    return res.status(400).json({ ok: false, err: 'bad_backup' });

  const rows = data.tables.users;
  if (rows.length > 20000) return res.status(413).json({ ok: false, err: 'too_big' });

  let added = 0, updated = 0, skipped = 0, failed = 0;
  for (const u of rows) {
    try {
      const id = String(u && u.id || '').slice(0, 40);
      if (!id) { skipped++; continue; }
      const cur = await DB.getUser(id);
      const exists = !!(cur && (cur.save || (cur.bakht | 0) > 0 || cur.name));
      if (exists && !overwrite) { skipped++; continue; }
      const patch = {};
      /* فقط فیلدهای معنادار بازگردانده می‌شوند */
      ['name','save','wallet','fam','char_name','country','city','note'].forEach(k => {
        if (u[k] !== undefined && u[k] !== null) patch[k] = u[k];
      });
      ['bakht','score','wealth','gen','refs','ref_claimed','spent','fame','fame_rep','p_age']
        .forEach(k => { if (u[k] !== undefined && u[k] !== null) patch[k] = Number(u[k]) || 0; });
      if (u.banned !== undefined) patch.banned = !!u.banned;
      if (u.alive  !== undefined) patch.alive  = u.alive !== false;
      await DB.upsertUser(id, patch, false);
      if (exists) updated++; else added++;
    } catch (e) { failed++; }
  }
  await audit(null, 'admin-restore', rows.length,
    'added=' + added + ' updated=' + updated + ' skipped=' + skipped, actor, clientIP(req));
  try {
    await notifyAdmins('♻️ <b>بازگردانی از پشتیبان انجام شد</b>\n' +
      'تازه: ' + faNum(added) + ' • به‌روزشده: ' + faNum(updated) +
      ' • ردشده: ' + faNum(skipped) + (failed ? (' • ناموفق: ' + faNum(failed)) : ''));
  } catch (e) {}
  res.json({ ok: true, added, updated, skipped, failed, total: rows.length });
});

app.post('/api/admin/maintenance', auth, adminSecure, async (req, res) => {
  const act = String((req.body && req.body.act) || '');
  const actor = String(req.user.id).replace(/^dev:/, '');
  const ip = clientIP(req);
  let msg = '';
  if (act === 'rehook') {
    await setupWebhook(); msg = 'وب‌هوک دوباره وصل شد';
  } else if (act === 'clearSessions') {
    adminSessions.clear(); msg = 'همهٔ نشست‌های مدیر بسته شد';
  } else if (act === 'clearRate') {
    RL.clear(); msg = 'محدودیت نرخ پاک شد';
  } else if (act === 'notifRound') {
    notifRound(); msg = 'یک دور اعلان هوشمند اجرا شد';
  } else if (act === 'backupNow') {
    const r = await backup.runBackup(true);
    msg = r.ok ? ('پشتیبان ساخته و در تلگرام فرستاده شد ('
                  + Math.round(r.size / 1024) + ' کیلوبایت، '
                  + r.users + ' کاربر)')
               : ('پشتیبان‌گیری ناموفق: ' + (r.err || 'نامشخص'));
  } else if (act === 'purgeRejected') {
    if (db.pool) { const r = await db.pool.query("DELETE FROM orders WHERE status='rejected'");
      msg = (r.rowCount | 0) + ' سفارش ردشده پاک شد'; }
    else { const n = db.mem.orders.length;
      db.mem.orders = db.mem.orders.filter(o => o.status !== 'rejected'); db.fileSave();
      msg = (n - db.mem.orders.length) + ' سفارش ردشده پاک شد'; }
  } else return res.status(400).json({ ok: false, err: 'bad_act' });
  await audit(null, 'admin-maint', 0, act, actor, ip);
  res.json({ ok: true, msg });
});
/* ارسال پیام همگانی — با احتیاط استفاده شود */
app.post('/api/admin/broadcast', auth, adminOnly, rateLimit(3, 60 * 60 * 1000), async (req, res) => {
  const text = String((req.body && req.body.text) || '').slice(0, 900);
  if (!text) return res.status(400).json({ ok: false, err: 'empty' });
  let ids = [];
  if (db.pool) {
    const r = await db.pool.query(
      'SELECT id FROM users WHERE notif=TRUE AND chat_ok=TRUE AND banned=FALSE LIMIT 5000');
    ids = r.rows.map(x => x.id);
  } else {
    ids = Object.values(db.mem.users)
      .filter(u => u.notif !== false && u.chat_ok && !u.banned).map(u => u.id);
  }
  res.json({ ok: true, queued: ids.length });
  (async () => {
    let n = 0;
    for (const id of ids) {
      if (await say(id, text, { reply_markup: playBtn() })) n++;
      await new Promise(r => setTimeout(r, 120));
    }
    await notifyAdmins(`📣 پیام همگانی به ${faNum(n)} نفر رسید.`);
  })().catch(e => console.error('[broadcast] خطا:', e.message));
});


}

module.exports = { registerAdminRoutes };

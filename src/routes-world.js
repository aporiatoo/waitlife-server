/* ================================================================
   ویت‌لایف — جهان مشترک
   ارواح | رویدادهای زنده | برخوردهای واقع‌گرایانه | نمای جهان
================================================================= */
const { auth } = require('./auth');
const { rateLimit } = require('./middleware');
const db = require('./db');
const { DB, WEALTH_CAP } = db;
const { faNum } = require('./telegram');

function registerWorldRoutes(app, worldTick) {
/* ================================================================
   ═══ جهان مشترک واقعی ═══
   ارواح: زندگی‌های تمام‌شدهٔ بازیکنان واقعی که در جهان بقیه ظاهر می‌شوند
   جریان: رویدادهای زندهٔ بازیکنان دیگر
================================================================= */
const FEED_KINDS = {
  death:  { max: 1 }, birth: { max: 1 }, rich: { max: 1 }, job: { max: 1 },
  crime:  { max: 1 }, jail:  { max: 1 }, wed:  { max: 1 }, kid: { max: 1 },
  fame:   { max: 1 }, gen:   { max: 1 }, ribbon: { max: 1 }
};

/* ثبت پایان یک زندگی — روحش وارد جهان بقیه می‌شود */
app.post('/api/world/ghost', auth, rateLimit(20, 60 * 60 * 1000), async (req, res) => {
  const b = req.body || {};
  const u = (await DB.getUser(req.user.id)) || {};
  if (u.banned) return res.status(403).json({ ok: false, err: 'banned' });
  /* پاکسازی سخت‌گیرانه: فقط حروف فارسی/لاتین، رقم، فاصله و چند نشانهٔ ساده */
  const clean = s2 => String(s2 || '')
    .replace(/<[^>]*>/g, ' ')                    /* هر تگ کامل حذف */
    .replace(/[<>&"'`\\/{}\[\]|]/g, ' ')        /* نویسه‌های خطرناک */
    .replace(/(script|iframe|onerror|onload|javascript)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 32);
  const g = {
    uid: req.user.id,
    name: clean(b.name) || 'بازیکن',
    fam: clean(b.fam),
    country: clean(b.country),
    flag: String(b.flag || '').slice(0, 8),
    gen: Math.max(1, Math.min(200, Number(b.gen) | 0 || 1)),
    age: Math.max(0, Math.min(130, Number(b.age) | 0)),
    /* ثروت و امتیاز روح از آخرین ذخیرهٔ تأییدشدهٔ همین کاربر گرفته می‌شود،
       نه از چیزی که کلاینت ادعا می‌کند — وگرنه تالار مشاهیر جعلی می‌شود. */
    wealth: Math.max(0, Math.min(WEALTH_CAP, Number(u.wealth) || 0)),
    job: clean(b.job),
    ribbon: clean(b.ribbon),
    score: Math.max(0, Math.min(1e7, Number(u.score) | 0)),
    tick: worldTick()
  };
  await DB.addGhost(g);
  await DB.addWEvent({ uid: g.uid, name: g.name, kind: 'death',
    txt: `در ${faNum(g.age)} سالگی درگذشت — ${g.ribbon || 'زندگی معمولی'}`,
    amount: g.wealth, tick: g.tick });
  res.json({ ok: true });
});

/* گزارش یک رویداد مهم به جهان */
app.post('/api/world/event', auth, rateLimit(40, 60 * 60 * 1000), async (req, res) => {
  const b = req.body || {};
  const kind = String(b.kind || '');
  if (!FEED_KINDS[kind]) return res.status(400).json({ ok: false, err: 'bad_kind' });
  const u = (await DB.getUser(req.user.id)) || {};
  if (u.banned) return res.status(403).json({ ok: false, err: 'banned' });
  await DB.addWEvent({
    uid: req.user.id,
    name: String(b.name || u.name || 'بازیکن').slice(0, 40).replace(/[<>]/g, ''),
    kind,
    txt: String(b.txt || '').slice(0, 160).replace(/[<>]/g, ''),
    amount: Math.max(0, Math.min(5e9, Number(b.amount) || 0)),
    tick: worldTick()
  });
  res.json({ ok: true });
});

/* ================================================================
   ═══ کشف واقع‌گرایانهٔ بازیکنان دیگر ═══
   قانون: هیچ‌کس فهرست جهانی نمی‌بیند. فقط:
   ۱) هم‌شهری‌ها  → احتمال برخورد رودررو
   ۲) هم‌وطن‌های مشهور (شهرت ≥۶۰) → خبر ملی
   ۳) مشهورهای جهانی (شهرت ≥۸۵) → خبر بین‌المللی
================================================================= */
const FAME_NATIONAL = 60;
const FAME_GLOBAL   = 85;

async function nearbyOf(uid, country, city) {
  const out = { local: [], national: [], global: [] };
  if (db.pool) {
    /* هم‌شهری‌های زنده و فعال اخیر */
    if (city) {
      const r = await db.pool.query(
        `SELECT COALESCE(char_name,name) nm, fame, p_age, job_t, wealth, gen, fam
         FROM users
         WHERE id<>$1 AND banned=FALSE AND alive=TRUE
           AND country=$2 AND city=$3
           AND char_name IS NOT NULL
           AND seen > NOW() - INTERVAL '3 days'
         ORDER BY random() LIMIT 6`, [uid, country || '', city]);
      out.local = r.rows;
    }
    if (country) {
      const r = await db.pool.query(
        `SELECT COALESCE(char_name,name) nm, fame, fame_rep, p_age, job_t, wealth, city
         FROM users
         WHERE id<>$1 AND banned=FALSE AND alive=TRUE
           AND country=$2 AND fame >= $3 AND char_name IS NOT NULL
         ORDER BY fame DESC LIMIT 5`, [uid, country, FAME_NATIONAL]);
      out.national = r.rows;
    }
    const r2 = await db.pool.query(
      `SELECT COALESCE(char_name,name) nm, fame, fame_rep, country, job_t, wealth
       FROM users
       WHERE id<>$1 AND banned=FALSE AND alive=TRUE
         AND fame >= $2 AND char_name IS NOT NULL
       ORDER BY fame DESC LIMIT 5`, [uid, FAME_GLOBAL]);
    out.global = r2.rows;
    return out;
  }
  const now = Date.now();
  const all = Object.values(db.mem.users).filter(u =>
    String(u.id) !== String(uid) && !u.banned && u.alive !== false && (u.char_name || u.name));
  const nm = u => ({ nm: u.char_name || u.name, fame: u.fame | 0, p_age: u.p_age | 0,
                     fame_rep: u.fame_rep === undefined ? 60 : u.fame_rep | 0,
                     job_t: u.job_t || '', wealth: u.wealth || 0, gen: u.gen || 1,
                     fam: u.fam || '', city: u.city || '', country: u.country || '' });
  if (city) out.local = all.filter(u => u.country === country && u.city === city &&
    now - (u.seen || 0) < 3 * 86400000).slice(0, 6).map(nm);
  if (country) out.national = all.filter(u => u.country === country && (u.fame | 0) >= FAME_NATIONAL)
    .sort((a, b) => (b.fame | 0) - (a.fame | 0)).slice(0, 5).map(nm);
  out.global = all.filter(u => (u.fame | 0) >= FAME_GLOBAL)
    .sort((a, b) => (b.fame | 0) - (a.fame | 0)).slice(0, 5).map(nm);
  return out;
}

/* چه کسانی «می‌توانند» در زندگی من ظاهر شوند */
app.post('/api/world/nearby', auth, rateLimit(60, 60 * 1000), async (req, res) => {
  const b = req.body || {};
  const country = String(b.country || '').slice(0, 40);
  const city = String(b.city || '').slice(0, 40);
  const n = await nearbyOf(req.user.id, country, city);
  const clean = a => a.map(x => ({
    name: x.nm, fame: x.fame | 0, age: x.p_age | 0,
    rep: x.fame_rep === undefined ? 60 : x.fame_rep | 0,
    job: x.job_t || '', wealth: Number(x.wealth) || 0,
    city: x.city || '', country: x.country || '' }));
  res.json({ ok: true, tick: worldTick(),
    local: clean(n.local), national: clean(n.national), global: clean(n.global) });
});

/* نمای کامل جهان: آمار زنده + تالار مشاهیر + جریان رویدادها */
app.get('/api/world', async (req, res) => {
  const [stats, top, recent, feed] = await Promise.all([
    DB.worldStats(), DB.topGhosts(40), DB.recentGhosts(12), DB.feed(40)
  ]);
  const live = await DB.top(40);
  res.json({ ok: true, tick: worldTick(), stats,
    hall: top.map(g => ({ name: g.name, fam: g.fam, country: g.country, flag: g.flag,
      gen: g.gen | 0, age: g.age | 0, wealth: Number(g.wealth) || 0,
      job: g.job, ribbon: g.ribbon })),
    living: live.map(r => ({ name: r.name, fam: r.fam || '', gen: r.gen | 0,
      wealth: Number(r.wealth) || 0 })),
    recent: recent.map(g => ({ name: g.name, age: g.age | 0, ribbon: g.ribbon,
      wealth: Number(g.wealth) || 0, flag: g.flag, at: g.at })),
    feed: feed.map(e => ({ name: e.name, kind: e.kind, txt: e.txt,
      amount: Number(e.amount) || 0, at: e.at })) });
});


}

module.exports = { registerWorldRoutes };

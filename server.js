/* ================================================================
   سرور ویت‌لایف
   کارها: احراز هویت تلگرام | ذخیرهٔ ابری | رتبه‌بندی | سفارش و رسید
          پنل ادمین | دعوت دوستان | اعلان هوشمند | پرداخت استارز
   نکته: اگر دیتابیس نباشد، خودکار روی فایل کار می‌کند (برای شروع رایگان)
================================================================= */
const express = require('express');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const BOT_USER  = String(process.env.BOT_USERNAME || '').replace(/^@/, '');
const APP_SHORT = String(process.env.APP_SHORT || 'play');
const ADMIN_IDS = String(process.env.ADMIN_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const DEV_MODE  = String(process.env.DEV_MODE || '') === '1';
const SELF_URL  = String(process.env.SELF_URL || '').replace(/\/+$/, '');
/* رمز مسیر وب‌هوک — از توکن ساخته می‌شود تا نیاز به تنظیم دستی نباشد */
const HOOK_SECRET = BOT_TOKEN
  ? crypto.createHash('sha256').update('hook' + BOT_TOKEN).digest('hex').slice(0, 24)
  : 'nohook';

app.set('trust proxy', 1);
app.use(express.json({ limit: '6mb' }));
/* بازی ممکن است در public/ باشد یا کنار server.js — هر دو را می‌گردیم */
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m' }));
app.use(express.static(__dirname, { maxAge: '5m', index: false }));

/* پیدا کردن فایل بازی، هرجا که باشد */
function findGame() {
  const spots = [
    path.join(__dirname, 'public', 'index.html'),
    path.join(__dirname, 'index.html'),
    path.join(__dirname, 'public', 'waitlife.html'),
    path.join(__dirname, 'waitlife.html')
  ];
  for (const f of spots) { try { if (fs.existsSync(f)) return f; } catch (e) {} }
  return null;
}

/* ================================================================
   محدودیت نرخ درخواست
   بدون این، یک نفر با یک اسکریپت ساده سرور رایگان را می‌خواباند.
================================================================= */
const RL = new Map();
function rateLimit(max, windowMs) {
  return function (req, res, next) {
    const key = (req.user && req.user.id)
      || req.ip
      || (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || 'anon';
    const now = Date.now();
    let e = RL.get(key);
    if (!e || now > e.reset) { e = { n: 0, reset: now + windowMs }; RL.set(key, e); }
    e.n++;
    if (e.n > max) {
      res.set('Retry-After', String(Math.ceil((e.reset - now) / 1000)));
      return res.status(429).json({ ok: false, err: 'too_many_requests' });
    }
    next();
  };
}
/* پاکسازی دوره‌ای تا حافظه رشد نکند */
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of RL) if (now > v.reset) RL.delete(k);
  if (RL.size > 50000) RL.clear();
}, 5 * 60 * 1000);

const limitApi   = rateLimit(90, 60 * 1000);   /* ۹۰ درخواست در دقیقه */
const limitHeavy = rateLimit(12, 60 * 1000);   /* سفارش/رسید/فاکتور */
/* وب‌هوک از محدودیت مستثناست: همهٔ آپدیت‌ها از یک آی‌پی تلگرام می‌آیند،
   اگر محدود شود پیام‌های کاربرها گم می‌شوند. مسیرش رمزدار است. */
app.use('/api/', (req, res, next) => {
  if (req.path.indexOf('/tg/') === 0) return next();
  return limitApi(req, res, next);
});

/* ---------------- ذخیره‌سازی ---------------- */
/* اگر DATABASE_URL باشد از پستگرس، وگرنه از فایل استفاده می‌شود */
const DB_URL = process.env.DATABASE_URL || '';
let pool = null;
const FILE = path.join(__dirname, 'data.json');
let mem = { users: {}, orders: [], cfg: {} };

function fileLoad() {
  try { mem = JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch (e) { mem = { users: {}, orders: [], cfg: {} }; }
  if (!mem.users)  mem.users  = {};
  if (!mem.orders) mem.orders = [];
  if (!mem.cfg)    mem.cfg    = {};
}
let saveTimer = null;
function fileSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(FILE, JSON.stringify(mem)); } catch (e) {}
  }, 400);
}

async function initDB() {
  if (!DB_URL) { fileLoad(); console.log('[db] حالت فایل (بدون دیتابیس)'); return; }
  const { Pool } = require('pg');
  const local = /localhost|127\.0\.0\.1/.test(DB_URL);
  pool = new Pool({
    connectionString: DB_URL,
    ssl: local ? false : { rejectUnauthorized: false },   /* نئون به SSL نیاز دارد */
    max: 5,                       /* سقف اتصال‌ها — پلن رایگان محدود است */
    idleTimeoutMillis: 20000,
    connectionTimeoutMillis: 15000
  });
  pool.on('error', e => console.error('[db] خطای اتصال:', e.message));
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT,
      bakht INTEGER DEFAULT 0,
      save JSONB,
      wallet JSONB,
      score INTEGER DEFAULT 0,
      wealth BIGINT DEFAULT 0,
      gen INTEGER DEFAULT 1,
      fam TEXT,
      banned BOOLEAN DEFAULT FALSE,
      seen TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      uid TEXT, code TEXT, pack TEXT, bakht INTEGER,
      receipt TEXT, status TEXT DEFAULT 'pending',
      created TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS cfg (k TEXT PRIMARY KEY, v TEXT);
  `);
  /* ستون‌های تازه — روی دیتابیس‌های قدیمی هم بی‌خطر اجرا می‌شود */
  const cols = [
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS ref_by TEXT",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS refs INTEGER DEFAULT 0",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS ref_claimed INTEGER DEFAULT 0",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS notif BOOLEAN DEFAULT TRUE",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS notif_at TIMESTAMPTZ",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS rank_last INTEGER",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS chat_ok BOOLEAN DEFAULT FALSE",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS spent INTEGER DEFAULT 0",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS kind TEXT DEFAULT 'card'",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS msg_id BIGINT",
    "CREATE INDEX IF NOT EXISTS users_seen_idx ON users (seen)",
    "CREATE INDEX IF NOT EXISTS users_wealth_idx ON users (wealth DESC)"
  ];
  for (const q of cols) { try { await pool.query(q); } catch (e) {} }
  console.log('[db] پستگرس متصل شد');
}

/* ---------------- لایهٔ داده ---------------- */
const USER_FIELDS = ['name','bakht','save','wallet','score','wealth','gen','fam','banned',
                     'ref_by','refs','ref_claimed','notif','notif_at','rank_last','chat_ok','spent'];
const DB = {
  async getUser(id) {
    if (pool) {
      const r = await pool.query('SELECT * FROM users WHERE id=$1', [id]);
      return r.rows[0] || null;
    }
    return mem.users[id] || null;
  },
  async upsertUser(id, patch, touch) {
    if (pool) {
      const cur = (await this.getUser(id)) || {};
      const u = Object.assign(
        { id, bakht: 0, gen: 1, score: 0, wealth: 0, refs: 0, ref_claimed: 0,
          notif: true, chat_ok: false, spent: 0 }, cur, patch);
      await pool.query(
        `INSERT INTO users (id,name,bakht,save,wallet,score,wealth,gen,fam,banned,
                            ref_by,refs,ref_claimed,notif,notif_at,rank_last,chat_ok,spent,seen)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
                 ${touch === false ? 'COALESCE($19,NOW())' : 'NOW()'})
         ON CONFLICT (id) DO UPDATE SET
           name=$2,bakht=$3,save=$4,wallet=$5,score=$6,wealth=$7,gen=$8,fam=$9,banned=$10,
           ref_by=$11,refs=$12,ref_claimed=$13,notif=$14,notif_at=$15,rank_last=$16,
           chat_ok=$17,spent=$18${touch === false ? '' : ',seen=NOW()'}`,
        [id, u.name || null, u.bakht | 0, u.save || null, u.wallet || null,
         u.score | 0, Math.round(u.wealth || 0), u.gen | 0, u.fam || null, !!u.banned,
         u.ref_by || null, u.refs | 0, u.ref_claimed | 0, u.notif !== false,
         u.notif_at || null, u.rank_last === undefined ? null : u.rank_last,
         !!u.chat_ok, u.spent | 0].concat(touch === false ? [u.seen || null] : []));
      return u;
    }
    const u = Object.assign(
      { id, bakht: 0, gen: 1, score: 0, wealth: 0, refs: 0, ref_claimed: 0,
        notif: true, chat_ok: false, spent: 0 },
      mem.users[id] || {}, patch);
    if (touch !== false) u.seen = Date.now();
    mem.users[id] = u; fileSave();
    return u;
  },
  async addBakht(id, n) {
    n = n | 0;
    if (!n) return null;
    if (pool) {
      const r = await pool.query(
        `INSERT INTO users (id,bakht) VALUES ($1,GREATEST(0,$2))
         ON CONFLICT (id) DO UPDATE SET bakht=GREATEST(0,users.bakht+$2)
         RETURNING *`, [id, n]);
      return r.rows[0];
    }
    const u = mem.users[id] || (mem.users[id] = { id, bakht: 0, gen: 1, score: 0, wealth: 0 });
    u.bakht = Math.max(0, (u.bakht | 0) + n); fileSave();
    return u;
  },
  async top(limit) {
    limit = Math.min(100, Math.max(1, limit | 0 || 50));
    if (pool) {
      const r = await pool.query(
        `SELECT id,name,wealth,gen,fam,score FROM users
         WHERE banned=FALSE AND name IS NOT NULL
         ORDER BY wealth DESC LIMIT $1`, [limit]);
      return r.rows;
    }
    return Object.values(mem.users)
      .filter(u => !u.banned && u.name)
      .sort((a, b) => (b.wealth || 0) - (a.wealth || 0))
      .slice(0, limit);
  },
  async addOrder(o) {
    if (pool) {
      const r = await pool.query(
        `INSERT INTO orders (uid,code,pack,bakht,receipt,status,kind)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [o.uid, o.code, o.pack, o.bakht | 0, o.receipt || null,
         o.status || 'pending', o.kind || 'card']);
      return r.rows[0].id;
    }
    const id = (mem.orders.length ? mem.orders[mem.orders.length - 1].id : 0) + 1;
    mem.orders.push(Object.assign(
      { id, status: 'pending', kind: 'card', created: Date.now() }, o));
    if (mem.orders.length > 500) mem.orders.shift();
    fileSave();
    return id;
  },
  async getOrder(id) {
    if (pool) {
      const r = await pool.query('SELECT * FROM orders WHERE id=$1', [id | 0]);
      return r.rows[0] || null;
    }
    return mem.orders.find(x => x.id === (id | 0)) || null;
  },
  async listOrders(status) {
    if (pool) {
      const r = status
        ? await pool.query('SELECT * FROM orders WHERE status=$1 ORDER BY id DESC LIMIT 200', [status])
        : await pool.query('SELECT * FROM orders ORDER BY id DESC LIMIT 200');
      return r.rows;
    }
    let a = mem.orders.slice().reverse();
    if (status) a = a.filter(x => x.status === status);
    return a.slice(0, 200);
  },
  async setOrder(id, status) {
    if (pool) {
      const r = await pool.query(
        'UPDATE orders SET status=$1 WHERE id=$2 RETURNING *', [status, id | 0]);
      return r.rows[0] || null;
    }
    const o = mem.orders.find(x => x.id === (id | 0));
    if (o) { o.status = status; fileSave(); }
    return o || null;
  },
  async setOrderMsg(id, msgId) {
    if (pool) { try { await pool.query('UPDATE orders SET msg_id=$1 WHERE id=$2', [msgId, id | 0]); } catch (e) {} return; }
    const o = mem.orders.find(x => x.id === (id | 0));
    if (o) { o.msg_id = msgId; fileSave(); }
  },
  async getCfg() {
    if (pool) {
      const r = await pool.query('SELECT * FROM cfg');
      const o = {}; r.rows.forEach(x => o[x.k] = x.v); return o;
    }
    return mem.cfg;
  },
  async setCfg(k, v) {
    if (pool) {
      await pool.query(
        `INSERT INTO cfg (k,v) VALUES ($1,$2)
         ON CONFLICT (k) DO UPDATE SET v=$2`, [k, String(v)]);
      return;
    }
    mem.cfg[k] = String(v); fileSave();
  }
};

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

/* ---------------- احراز هویت تلگرام ---------------- */
/* امضای initData با کلید مخفی بات بررسی می‌شود؛ بدون این، هرکسی
   می‌تواند خودش را هر کاربری جا بزند. */
function checkTelegram(initData) {
  if (!initData || !BOT_TOKEN) return null;
  try {
    const p = new URLSearchParams(initData);
    const hash = p.get('hash');
    if (!hash) return null;
    p.delete('hash');
    const arr = [];
    for (const [k, v] of p.entries()) arr.push(k + '=' + v);
    arr.sort();
    const dcs = arr.join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const calc = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
    const a = Buffer.from(calc, 'hex'), b = Buffer.from(hash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const authDate = Number(p.get('auth_date') || 0);
    if (!authDate || (Date.now() / 1000 - authDate) > 86400) return null;  // ۲۴ ساعت
    const user = JSON.parse(p.get('user') || 'null');
    if (!user || !user.id) return null;
    return {
      id: String(user.id),
      name: [user.first_name, user.last_name].filter(Boolean).join(' ') || 'بازیکن',
      startParam: p.get('start_param') || ''
    };
  } catch (e) { return null; }
}
function auth(req, res, next) {
  const initData = req.get('X-TG-Init') || (req.body && req.body.initData) || '';
  let u = checkTelegram(initData);
  if (!u && DEV_MODE) {
    const dev = req.get('X-Dev-Id') || 'dev-user';
    u = { id: 'dev:' + dev, name: 'کاربر تست', startParam: req.get('X-Dev-Ref') || '' };
  }
  if (!u) return res.status(401).json({ ok: false, err: 'unauthorized' });
  req.user = u;
  next();
}
function adminOnly(req, res, next) {
  const raw = String(req.user.id).replace(/^dev:/, '');
  if (!ADMIN_IDS.length && DEV_MODE) return next();
  if (!ADMIN_IDS.includes(raw)) return res.status(403).json({ ok: false, err: 'forbidden' });
  next();
}

/* ================================================================
   بسته‌های فروش — منبع حقیقت سمت سرور
   قیمت را کاربر نمی‌فرستد؛ فقط کلید بسته را می‌فرستد.
================================================================= */
const PACKS = {
  p1: { n: 'بستهٔ برنزی',   bakht: 60,  toman: 49000,  stars: 45  },
  p2: { n: 'بستهٔ نقره‌ای',  bakht: 160, toman: 99000,  stars: 90  },
  p3: { n: 'بستهٔ طلایی',   bakht: 400, toman: 199000, stars: 180 },
  p4: { n: 'بستهٔ الماس',   bakht: 900, toman: 399000, stars: 350 }
};

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
  if (pool) {
    try { const r = await pool.query('SELECT id FROM users LIMIT 20000'); ids = r.rows.map(x => x.id); }
    catch (e) { ids = []; }
  } else ids = Object.keys(mem.users);
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

/* ---------------- مسیرها ---------------- */
app.get('/api/health', (req, res) =>
  res.json({ ok: true, db: pool ? 'postgres' : 'file', time: Date.now() }));

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

/* ذخیرهٔ ابری */
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
  if (b.wealth !== undefined) patch.wealth = Math.max(0, Math.min(9e14, Number(b.wealth) || 0));
  if (b.score  !== undefined) patch.score  = Math.max(0, Math.min(1e7, Number(b.score) | 0));
  if (b.gen    !== undefined) patch.gen    = Math.max(1, Math.min(200, Number(b.gen) | 0 || 1));
  if (b.fam    !== undefined) patch.fam    = String(b.fam || '').slice(0, 40) || null;
  if (b.bakht  !== undefined) patch.bakht  = Math.max(0, Math.min(1e7, Number(b.bakht) | 0));
  await DB.upsertUser(req.user.id, patch);
  res.json({ ok: true });
});
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
      const prev = await DB.getUser(uid);
      await DB.upsertUser(uid, { spent: ((prev && prev.spent) | 0) + (pk.stars | 0) }, false);
      await DB.addOrder({
        uid, code: 'STARS-' + (sp.telegram_payment_charge_id || '').slice(-8),
        pack: key, bakht: pk.bakht, receipt: null, status: 'approved', kind: 'stars' });
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

async function statsSnapshot() {
  let users = 0, bakht = 0, pending = 0, today = 0, week = 0, refs = 0;
  if (pool) {
    const a = await pool.query(
      `SELECT COUNT(*) c, COALESCE(SUM(bakht),0) b, COALESCE(SUM(refs),0) r,
              COUNT(*) FILTER (WHERE seen > NOW() - INTERVAL '1 day') d,
              COUNT(*) FILTER (WHERE seen > NOW() - INTERVAL '7 days') w
       FROM users`);
    users = Number(a.rows[0].c); bakht = Number(a.rows[0].b);
    refs = Number(a.rows[0].r);  today = Number(a.rows[0].d); week = Number(a.rows[0].w);
    const p = await pool.query("SELECT COUNT(*) c FROM orders WHERE status='pending'");
    pending = Number(p.rows[0].c);
  } else {
    const arr = Object.values(mem.users);
    const now = Date.now();
    users = arr.length;
    bakht = arr.reduce((s, u) => s + (u.bakht | 0), 0);
    refs  = arr.reduce((s, u) => s + (u.refs | 0), 0);
    today = arr.filter(u => now - (u.seen || 0) < 86400000).length;
    week  = arr.filter(u => now - (u.seen || 0) < 7 * 86400000).length;
    pending = mem.orders.filter(o => o.status === 'pending').length;
  }
  return { users, bakht, pending, today, week, refs, db: pool ? 'postgres' : 'file' };
}

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
  if (pool) {
    const r = await pool.query(
      `SELECT id,name,seen,notif_at,gen FROM users
       WHERE notif=TRUE AND chat_ok=TRUE AND banned=FALSE
         AND seen < NOW() - INTERVAL '${AWAY_DAYS} days'
         AND (notif_at IS NULL OR notif_at < NOW() - INTERVAL '${NOTIF_GAP_DAYS} days')
       ORDER BY seen DESC LIMIT ${BATCH}`);
    list = r.rows;
  } else {
    list = Object.values(mem.users).filter(u =>
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

/* مسیر تست خودکار — فقط وقتی TEST_HOOK=1 باشد (در تولید وجود ندارد) */
if (String(process.env.TEST_HOOK || '') === '1') {
  app.post('/api/__test_notif', async (req, res) => {
    await notifRound();
    res.json({ ok: true });
  });
}

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
/* ارسال پیام همگانی — با احتیاط استفاده شود */
app.post('/api/admin/broadcast', auth, adminOnly, rateLimit(3, 60 * 60 * 1000), async (req, res) => {
  const text = String((req.body && req.body.text) || '').slice(0, 900);
  if (!text) return res.status(400).json({ ok: false, err: 'empty' });
  let ids = [];
  if (pool) {
    const r = await pool.query(
      'SELECT id FROM users WHERE notif=TRUE AND chat_ok=TRUE AND banned=FALSE LIMIT 5000');
    ids = r.rows.map(x => x.id);
  } else {
    ids = Object.values(mem.users)
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
  })();
});

app.get('*', (req, res) => {
  const f = findGame();
  if (f) return res.sendFile(f);
  res.status(200).send('<!DOCTYPE html><html lang="fa" dir="rtl"><head>'
  + '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
  + '<title>فایل بازی پیدا نشد</title><style>body{font-family:system-ui,sans-serif;'
  + 'background:#0f1720;color:#e8eef5;padding:22px;line-height:2;max-width:640px;margin:auto}'
  + '.box{background:#1a2430;border-radius:12px;padding:16px;margin:14px 0}'
  + '.ok{color:#4ade80}.bad{color:#f87171}code{background:#0b1118;padding:2px 7px;'
  + 'border-radius:5px;font-size:13px;direction:ltr;display:inline-block}'
  + 'h2{color:#ffd400}</style></head><body>'
  + '<h2>⚠️ فایل بازی آپلود نشده</h2>'
  + '<div class="box"><b class="ok">✅ سرور سالم است</b><br>'
  + '<b class="ok">✅ دیتابیس: ' + (pool ? 'پستگرس متصل' : 'حالت فایل') + '</b><br>'
  + '<b class="bad">❌ فایل بازی پیدا نشد</b></div>'
  + '<div class="box"><b>راه‌حل — در گیت‌هاب:</b><br>'
  + '۱) <code>Add file → Upload files</code><br>'
  + '۲) فایل <code>index.html</code> را آپلود کن<br>'
  + '۳) <code>Commit changes</code><br><br>'
  + 'همین یک فایل کافی است. نیازی به ساختن پوشه نیست.</div>'
  + '</body></html>');
});

/* ---------------- بیدار نگه داشتن ----------------
   سرویس‌های رایگان بعد از ۱۵ دقیقه بی‌کاری می‌خوابند. */
if (SELF_URL) {
  setInterval(() => {
    try { fetch(SELF_URL + '/api/health').catch(() => {}); } catch (e) {}
  }, 10 * 60 * 1000);
  console.log('[keepalive] فعال شد:', SELF_URL);
}

/* ---------------- راه‌اندازی وب‌هوک ---------------- */
async function setupWebhook() {
  if (!BOT_TOKEN) { console.warn('[bot] BOT_TOKEN تنظیم نشده — بات غیرفعال'); return; }
  /* نام کاربری بات را همیشه می‌گیریم — لینک دعوت به آن نیاز دارد */
  const me = await tg('getMe', {});
  if (me && me.ok && me.result && me.result.username) {
    if (!BOT_USER_LIVE) BOT_USER_LIVE = me.result.username;
    console.log('[bot] @' + BOT_USER_LIVE);
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
initDB()
  .catch(e => { console.error('[db] خطا، حالت فایل فعال شد:', e.message); fileLoad(); })
  .finally(() => app.listen(PORT, '0.0.0.0', async () => {
    const f = findGame();
    console.log('[waitlife] روی پورت ' + PORT + ' بالا آمد');
    if (f) console.log('[game] فایل بازی پیدا شد:', f.replace(__dirname, '.'));
    else console.warn('[game] ⚠️ فایل بازی پیدا نشد — index.html را آپلود کن');
    await setupWebhook();
    /* اعلان هوشمند: هر ۶ ساعت یک دور */
    if (BOT_TOKEN) {
      setInterval(notifRound, 6 * 60 * 60 * 1000);
      setTimeout(notifRound, 3 * 60 * 1000);
      console.log('[notif] اعلان هوشمند فعال شد');
    }
  }));

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

/* ---------------- فشرده‌سازی gzip ----------------
   فایل بازی حدود یک مگابایت است. روی گوشی‌های ضعیف و اینترنت کند،
   دانلود کامل آن دردناک است. یک بار در حافظه فشرده می‌شود و بعد از آن
   به همهٔ مرورگرهایی که gzip می‌پذیرند (یعنی همه) همان نسخه داده می‌شود.
   بدون نیاز به هیچ پکیج اضافه — از zlib خود Node استفاده می‌کنیم. */
const zlib = require('zlib');
const GZ_CACHE = new Map();          /* مسیر → {buf, etag, mtime} */
const GZ_TYPES = /\.(html|js|css|json|svg)$/i;
function gzipFile(file) {
  try {
    const st = fs.statSync(file);
    const key = file;
    const hit = GZ_CACHE.get(key);
    if (hit && hit.mtime === st.mtimeMs) return hit;
    const raw = fs.readFileSync(file);
    const buf = zlib.gzipSync(raw, { level: 8 });
    const etag = 'W/"' + crypto.createHash('sha1').update(raw).digest('hex').slice(0, 20) + '"';
    const rec = { buf, etag, mtime: st.mtimeMs, size: raw.length };
    GZ_CACHE.set(key, rec);
    return rec;
  } catch (e) { return null; }
}
function tryGzip(req, res, file) {
  const ae = String(req.headers['accept-encoding'] || '');
  if (!/\bgzip\b/.test(ae)) return false;
  if (!GZ_TYPES.test(file)) return false;
  const rec = gzipFile(file);
  if (!rec) return false;
  if (req.headers['if-none-match'] === rec.etag) { res.status(304).end(); return true; }
  const type = file.endsWith('.html') ? 'text/html; charset=utf-8'
             : file.endsWith('.js')   ? 'application/javascript; charset=utf-8'
             : file.endsWith('.css')  ? 'text/css; charset=utf-8'
             : file.endsWith('.svg')  ? 'image/svg+xml'
             : 'application/json; charset=utf-8';
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Encoding', 'gzip');
  res.setHeader('Vary', 'Accept-Encoding');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.setHeader('ETag', rec.etag);
  res.end(rec.buf);
  return true;
}
/* میان‌افزار: قبل از static، نسخهٔ فشرده را امتحان کن */
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  let rel = req.path === '/' ? 'index.html' : req.path.replace(/^\/+/, '');
  if (rel.includes('..')) return next();
  for (const base of [path.join(__dirname, 'public'), __dirname]) {
    const f = path.join(base, rel);
    if (!f.startsWith(base)) continue;
    try { if (fs.existsSync(f) && fs.statSync(f).isFile()) {
      if (tryGzip(req, res, f)) return;
      break;
    } } catch (e) {}
  }
  next();
});

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
    CREATE TABLE IF NOT EXISTS bids (
      id SERIAL PRIMARY KEY,
      week INTEGER, lot INTEGER DEFAULT 0, uid TEXT, name TEXT,
      amount BIGINT DEFAULT 0,
      at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(week, lot, uid)
    );
    CREATE TABLE IF NOT EXISTS ghosts (
      id SERIAL PRIMARY KEY,
      uid TEXT, name TEXT, fam TEXT, country TEXT, flag TEXT,
      gen INTEGER DEFAULT 1, age INTEGER, wealth BIGINT DEFAULT 0,
      job TEXT, ribbon TEXT, score INTEGER DEFAULT 0,
      tick INTEGER DEFAULT 0, at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS wevents (
      id SERIAL PRIMARY KEY,
      uid TEXT, name TEXT, kind TEXT, txt TEXT,
      amount BIGINT DEFAULT 0, tick INTEGER DEFAULT 0,
      at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS audit (
      id SERIAL PRIMARY KEY,
      uid TEXT, act TEXT, amount BIGINT, note TEXT,
      actor TEXT, ip TEXT,
      at TIMESTAMPTZ DEFAULT NOW()
    );
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
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS earn_day TEXT",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS earn_today INTEGER DEFAULT 0",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS char_name TEXT",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS country TEXT",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS city TEXT",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS fame INTEGER DEFAULT 0",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS fame_rep INTEGER DEFAULT 60",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS p_age INTEGER DEFAULT 0",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS job_t TEXT",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS alive BOOLEAN DEFAULT TRUE",
    "CREATE INDEX IF NOT EXISTS users_city_idx ON users (country, city)",
    "CREATE INDEX IF NOT EXISTS users_fame_idx ON users (fame DESC)",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS note TEXT",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS flags TEXT",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS created TIMESTAMPTZ DEFAULT NOW()",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS kind TEXT DEFAULT 'card'",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS msg_id BIGINT",
    "CREATE INDEX IF NOT EXISTS users_seen_idx ON users (seen)",
    "CREATE INDEX IF NOT EXISTS users_wealth_idx ON users (wealth DESC)",
    "CREATE INDEX IF NOT EXISTS audit_at_idx ON audit (at DESC)",
    "CREATE INDEX IF NOT EXISTS audit_uid_idx ON audit (uid)",
    "CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status, id DESC)",
    "CREATE INDEX IF NOT EXISTS ghosts_wealth_idx ON ghosts (wealth DESC)",
    "CREATE INDEX IF NOT EXISTS ghosts_tick_idx ON ghosts (tick DESC)",
    "CREATE INDEX IF NOT EXISTS wevents_id_idx ON wevents (id DESC)",
    "ALTER TABLE bids ADD COLUMN IF NOT EXISTS lot INTEGER DEFAULT 0",
    "CREATE INDEX IF NOT EXISTS bids_week_idx ON bids (week, lot, amount DESC)"
  ];
  for (const q of cols) { try { await pool.query(q); } catch (e) {} }
  console.log('[db] پستگرس متصل شد');
}

/* ---------------- لایهٔ داده ---------------- */
const USER_FIELDS = ['name','bakht','save','wallet','score','wealth','gen','fam','banned',
                     'ref_by','refs','ref_claimed','notif','notif_at','rank_last','chat_ok','spent',
                     'earn_day','earn_today','note','flags','char_name',
                     'country','city','fame','fame_rep','p_age','job_t','alive'];
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
                            ref_by,refs,ref_claimed,notif,notif_at,rank_last,chat_ok,spent,
                            earn_day,earn_today,note,flags,char_name,
                            country,city,fame,fame_rep,p_age,job_t,alive,seen)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,
                 $24,$25,$26,$27,$28,$29,$30,
                 ${touch === false ? 'COALESCE($31,NOW())' : 'NOW()'})
         ON CONFLICT (id) DO UPDATE SET
           name=$2,bakht=$3,save=$4,wallet=$5,score=$6,wealth=$7,gen=$8,fam=$9,banned=$10,
           ref_by=$11,refs=$12,ref_claimed=$13,notif=$14,notif_at=$15,rank_last=$16,
           chat_ok=$17,spent=$18,earn_day=$19,earn_today=$20,note=$21,flags=$22,
           char_name=$23,country=$24,city=$25,fame=$26,fame_rep=$27,p_age=$28,
           job_t=$29,alive=$30${touch === false ? '' : ',seen=NOW()'}`,
        [id, u.name || null, u.bakht | 0, u.save || null, u.wallet || null,
         u.score | 0, Math.round(u.wealth || 0), u.gen | 0, u.fam || null, !!u.banned,
         u.ref_by || null, u.refs | 0, u.ref_claimed | 0, u.notif !== false,
         u.notif_at || null, u.rank_last === undefined ? null : u.rank_last,
         !!u.chat_ok, u.spent | 0, u.earn_day || null, u.earn_today | 0,
         u.note || null, u.flags || null,
         u.char_name || null, u.country || null, u.city || null,
         u.fame | 0, (u.fame_rep === undefined ? 60 : u.fame_rep) | 0,
         u.p_age | 0, u.job_t || null,
         u.alive !== false].concat(touch === false ? [u.seen || null] : []));
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
        `SELECT id, COALESCE(char_name,name) AS name, wealth, gen, fam, score
         FROM users
         WHERE banned=FALSE AND COALESCE(char_name,name) IS NOT NULL AND wealth > 0
         ORDER BY wealth DESC LIMIT $1`, [limit]);
      return r.rows;
    }
    return Object.values(mem.users)
      .filter(u => !u.banned && (u.char_name || u.name) && (u.wealth || 0) > 0)
      .map(u => Object.assign({}, u, { name: u.char_name || u.name }))
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
  async addAudit(rec) {
    if (pool) {
      try {
        await pool.query(
          `INSERT INTO audit (uid,act,amount,note,actor,ip) VALUES ($1,$2,$3,$4,$5,$6)`,
          [rec.uid || null, rec.act, Math.round(rec.amount || 0),
           (rec.note || '').slice(0, 300), rec.actor || null, (rec.ip || '').slice(0, 60)]);
      } catch (e) {}
      return;
    }
    mem.audit = mem.audit || [];
    mem.audit.push(Object.assign({ id: mem.audit.length + 1, at: Date.now() }, rec));
    if (mem.audit.length > 3000) mem.audit.shift();
    fileSave();
  },
  async listAudit(opt) {
    opt = opt || {};
    const lim = Math.min(300, Math.max(1, opt.limit | 0 || 100));
    if (pool) {
      const r = opt.uid
        ? await pool.query('SELECT * FROM audit WHERE uid=$1 ORDER BY id DESC LIMIT $2', [opt.uid, lim])
        : await pool.query('SELECT * FROM audit ORDER BY id DESC LIMIT $1', [lim]);
      return r.rows;
    }
    let a = (mem.audit || []).slice().reverse();
    if (opt.uid) a = a.filter(x => String(x.uid) === String(opt.uid));
    return a.slice(0, lim);
  },
  async searchUsers(q, limit) {
    limit = Math.min(100, Math.max(1, limit | 0 || 30));
    q = String(q || '').trim();
    if (pool) {
      if (!q) {
        const r = await pool.query('SELECT * FROM users ORDER BY seen DESC LIMIT $1', [limit]);
        return r.rows;
      }
      const r = await pool.query(
        `SELECT * FROM users WHERE id=$1 OR name ILIKE $2 OR fam ILIKE $2
         ORDER BY seen DESC LIMIT $3`, [q, '%' + q + '%', limit]);
      return r.rows;
    }
    let a = Object.values(mem.users);
    if (q) a = a.filter(u => String(u.id) === q ||
      String(u.name || '').includes(q) || String(u.fam || '').includes(q));
    return a.sort((x, y) => (y.seen || 0) - (x.seen || 0)).slice(0, limit);
  },
  async countUsers() {
    if (pool) { const r = await pool.query('SELECT COUNT(*) c FROM users'); return Number(r.rows[0].c); }
    return Object.keys(mem.users).length;
  },
  /* ---- جهان مشترک: ارواح (زندگی‌های تمام‌شدهٔ بازیکنان واقعی) ---- */
  async addGhost(g) {
    if (pool) {
      await pool.query(
        `INSERT INTO ghosts (uid,name,fam,country,flag,gen,age,wealth,job,ribbon,score,tick)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [g.uid, g.name, g.fam, g.country, g.flag, g.gen | 0, g.age | 0,
         Math.round(g.wealth || 0), g.job, g.ribbon, g.score | 0, g.tick | 0]);
      /* فقط ۵۰۰۰ روح اخیر نگه داشته می‌شود */
      try { await pool.query(
        `DELETE FROM ghosts WHERE id < (SELECT MAX(id)-5000 FROM ghosts)`); } catch (e) {}
      return;
    }
    mem.ghosts = mem.ghosts || [];
    mem.ghosts.push(Object.assign({ id: mem.ghosts.length + 1, at: Date.now() }, g));
    if (mem.ghosts.length > 1200) mem.ghosts.shift();
    fileSave();
  },
  async topGhosts(limit) {
    limit = Math.min(100, Math.max(1, limit | 0 || 50));
    if (pool) {
      const r = await pool.query(
        `SELECT DISTINCT ON (uid) uid,name,fam,country,flag,gen,age,wealth,job,ribbon,score,at
         FROM ghosts ORDER BY uid, wealth DESC`);
      return r.rows.sort((a, b) => Number(b.wealth) - Number(a.wealth)).slice(0, limit);
    }
    const best = {};
    (mem.ghosts || []).forEach(g => {
      if (!best[g.uid] || (g.wealth || 0) > (best[g.uid].wealth || 0)) best[g.uid] = g;
    });
    return Object.values(best).sort((a, b) => (b.wealth || 0) - (a.wealth || 0)).slice(0, limit);
  },
  async recentGhosts(limit) {
    limit = Math.min(60, Math.max(1, limit | 0 || 20));
    if (pool) {
      const r = await pool.query('SELECT * FROM ghosts ORDER BY id DESC LIMIT $1', [limit]);
      return r.rows;
    }
    return (mem.ghosts || []).slice().reverse().slice(0, limit);
  },
  /* ---- جریان رویدادهای زندهٔ جهان ---- */
  async addWEvent(e) {
    if (pool) {
      await pool.query(
        `INSERT INTO wevents (uid,name,kind,txt,amount,tick) VALUES ($1,$2,$3,$4,$5,$6)`,
        [e.uid, e.name, e.kind, String(e.txt || '').slice(0, 200),
         Math.round(e.amount || 0), e.tick | 0]);
      try { await pool.query(
        `DELETE FROM wevents WHERE id < (SELECT MAX(id)-2000 FROM wevents)`); } catch (e2) {}
      return;
    }
    mem.wevents = mem.wevents || [];
    mem.wevents.push(Object.assign({ id: mem.wevents.length + 1, at: Date.now() }, e));
    if (mem.wevents.length > 600) mem.wevents.shift();
    fileSave();
  },
  async feed(limit) {
    limit = Math.min(80, Math.max(1, limit | 0 || 40));
    if (pool) {
      const r = await pool.query('SELECT * FROM wevents ORDER BY id DESC LIMIT $1', [limit]);
      return r.rows;
    }
    return (mem.wevents || []).slice().reverse().slice(0, limit);
  },
  async worldStats() {
    if (pool) {
      const a = await pool.query(`
        SELECT COUNT(*) players,
          COUNT(*) FILTER (WHERE seen > NOW() - INTERVAL '10 minutes') online,
          COUNT(*) FILTER (WHERE seen > NOW() - INTERVAL '1 day') today,
          COALESCE(SUM(wealth),0) wealth, COALESCE(MAX(gen),1) maxgen
        FROM users WHERE banned=FALSE`);
      const g = await pool.query(`
        SELECT COUNT(*) lives, COALESCE(AVG(age),0) avgage,
               COALESCE(MAX(wealth),0) richest
        FROM ghosts`);
      return { players: +a.rows[0].players, online: +a.rows[0].online,
        today: +a.rows[0].today, wealth: Number(a.rows[0].wealth),
        maxGen: +a.rows[0].maxgen, lives: +g.rows[0].lives,
        avgAge: Math.round(+g.rows[0].avgage), richest: Number(g.rows[0].richest) };
    }
    const arr = Object.values(mem.users).filter(u => !u.banned);
    const now = Date.now();
    const gs = mem.ghosts || [];
    return {
      players: arr.length,
      online: arr.filter(u => now - (u.seen || 0) < 600000).length,
      today: arr.filter(u => now - (u.seen || 0) < 86400000).length,
      wealth: arr.reduce((s2, u) => s2 + (u.wealth || 0), 0),
      maxGen: arr.reduce((s2, u) => Math.max(s2, u.gen || 1), 1),
      lives: gs.length,
      avgAge: gs.length ? Math.round(gs.reduce((s2, g) => s2 + (g.age || 0), 0) / gs.length) : 0,
      richest: gs.reduce((s2, g) => Math.max(s2, g.wealth || 0), 0)
    };
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

/* ================================================================
   ═══ پشتیبان‌گیری خودکار ═══
   هر چند ساعت یک نسخهٔ کامل از دیتابیس ساخته می‌شود، فشرده می‌شود
   و مستقیم در تلگرام برای مدیر فرستاده می‌شود. اگر سرور یا دیتابیس
   از دست برود، همه‌چیز در چت تلگرام موجود است.
================================================================= */
const BACKUP_HOURS = Math.max(1, Math.min(168,
  Number(process.env.BACKUP_HOURS || 24) || 24));   /* پیش‌فرض: روزی یک بار */
const BACKUP_ON = String(process.env.BACKUP || '1') !== '0';

/* جمع‌آوری کل داده‌ها از هر دو حالت (پستگرس یا فایل) */
async function collectBackup() {
  const out = {
    v: 1,
    at: new Date().toISOString(),
    mode: pool ? 'postgres' : 'file',
    /* WORLD_EPOCH پایین‌تر تعریف شده؛ اگر به هر دلیل هنوز آماده نباشد
       نباید کل پشتیبان‌گیری شکست بخورد */
    epoch: (typeof WORLD_EPOCH !== 'undefined') ? WORLD_EPOCH : null,
    tables: {}
  };
  if (pool) {
    /* هر جدول جداگانه؛ اگر یکی خطا داد بقیه از دست نروند */
    const tabs = ['users', 'orders', 'cfg', 'audit', 'ghosts', 'wevents', 'bids'];
    for (const t of tabs) {
      try {
        const r = await pool.query('SELECT * FROM ' + t);
        out.tables[t] = r.rows;
      } catch (e) { out.tables[t] = { error: String(e.message).slice(0, 120) }; }
    }
  } else {
    out.tables.users  = Object.values(mem.users || {});
    out.tables.orders = mem.orders || [];
    out.tables.cfg    = mem.cfg || {};
  }
  /* خلاصهٔ آماری برای متن پیام */
  const u = Array.isArray(out.tables.users) ? out.tables.users : [];
  out.summary = {
    users: u.length,
    withSave: u.filter(x => x && x.save).length,
    bakhtTotal: u.reduce((a, x) => a + ((x && x.bakht) | 0), 0),
    orders: Array.isArray(out.tables.orders) ? out.tables.orders.length : 0,
    ghosts: Array.isArray(out.tables.ghosts) ? out.tables.ghosts.length : 0
  };
  return out;
}

/* ارسال فایل به تلگرام با multipart — بدون نیاز به هیچ پکیج اضافه */
async function tgSendDocument(chatId, filename, buf, caption) {
  if (!BOT_TOKEN) return false;
  try {
    const fd = new FormData();
    fd.append('chat_id', String(chatId));
    if (caption) { fd.append('caption', caption); fd.append('parse_mode', 'HTML'); }
    fd.append('document', new Blob([buf], { type: 'application/gzip' }), filename);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 90000);
    const r = await fetch(TGAPI + 'sendDocument', { method: 'POST', body: fd, signal: ctrl.signal });
    clearTimeout(t);
    const j = await r.json().catch(() => null);
    return !!(j && j.ok);
  } catch (e) {
    console.warn('[backup] ارسال ناموفق:', e.message);
    return false;
  }
}

let lastBackupAt = 0, lastBackupOk = null, backupBusy = false;
async function runBackup(manual) {
  if (backupBusy) return { ok: false, err: 'busy' };
  if (!ADMIN_IDS.length) return { ok: false, err: 'no_admin' };
  if (!BOT_TOKEN) return { ok: false, err: 'no_token' };
  backupBusy = true;
  try {
    const data = await collectBackup();
    const raw = Buffer.from(JSON.stringify(data), 'utf8');
    const gz = zlib.gzipSync(raw, { level: 9 });
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    const stamp = d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate())
                + '_' + pad(d.getUTCHours()) + pad(d.getUTCMinutes());
    const name = 'waitlife-backup_' + stamp + '.json.gz';
    const S = data.summary;
    const kb = (gz.length / 1024).toFixed(1);
    const caption =
      '💾 <b>پشتیبان خودکار ویت‌لایف</b>\n' +
      '📅 ' + stamp.replace('_', ' — ') + ' (UTC)\n' +
      '👥 کاربران: <b>' + faNum(S.users) + '</b>' +
        ' (با ذخیرهٔ بازی: ' + faNum(S.withSave) + ')\n' +
      '⭐ مجموع بخت: <b>' + faNum(S.bakhtTotal) + '</b>\n' +
      '🧾 سفارش‌ها: ' + faNum(S.orders) + ' • 👻 ارواح: ' + faNum(S.ghosts) + '\n' +
      '🗄️ منبع: ' + (data.mode === 'postgres' ? 'دیتابیس' : 'فایل') +
        ' • حجم: ' + faNum(kb) + ' کیلوبایت\n\n' +
      '<i>این فایل را نگه دار. برای بازگردانی، همین فایل را به پشتیبانی بده.</i>';

    /* سقف تلگرام برای فایل حدود ۵۰ مگابایت است. با فشرده‌سازی، حتی
       ۱۰۰ هزار بازیکن هم حدود ۱۲ مگابایت می‌شود، ولی اگر روزی از حد
       گذشت باید بدانی — بی‌سروصدا شکست نخورد. */
    if (gz.length > 45 * 1024 * 1024) {
      await notifyAdmins('⚠️ <b>پشتیبان خیلی بزرگ شد</b>\n' +
        'حجم: ' + faNum(Math.round(gz.length / 1048576)) + ' مگابایت — ' +
        'تلگرام فایل بالای ۵۰ مگابایت را نمی‌پذیرد.\n' +
        'باید پشتیبان‌گیری به چند بخش تقسیم شود.');
      return { ok: false, err: 'too_large', size: gz.length };
    }
    let sent = 0;
    for (const a of ADMIN_IDS) {
      if (await tgSendDocument(a, name, gz, caption)) sent++;
    }
    lastBackupAt = Date.now();
    lastBackupOk = sent > 0;
    if (!sent) console.warn('[backup] برای هیچ مدیری ارسال نشد');
    else console.log('[backup] ارسال شد به ' + sent + ' مدیر (' + kb + 'KB)');
    return { ok: sent > 0, sent, size: gz.length, users: S.users, name };
  } catch (e) {
    lastBackupOk = false;
    console.error('[backup] خطا:', e.message);
    try { await notifyAdmins('⚠️ پشتیبان‌گیری خودکار با خطا مواجه شد: ' + e.message.slice(0, 120)); } catch (e2) {}
    return { ok: false, err: String(e.message).slice(0, 140) };
  } finally { backupBusy = false; }
}

/* ثبت در دفتر رویداد — هر تغییر حساس ردیابی می‌شود */
async function audit(uid, act, amount, note, actor, ip) {
  try { await DB.addAudit({ uid, act, amount, note, actor, ip }); } catch (e) {}
}
function clientIP(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '';
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
function isAdminId(id) {
  return ADMIN_IDS.includes(String(id).replace(/^dev:/, ''));
}

/* ================================================================
   امنیت پنل مدیریت
   لایه ۱: شناسهٔ تلگرام باید در ADMIN_IDS باشد
   لایه ۲: رمز دوم (PIN) که فقط در متغیرهای محیطی است
   لایه ۳: نشست کوتاه‌مدت با توکن تصادفی
   لایه ۴: قفل شدن بعد از تلاش‌های ناموفق
   لایه ۵: ثبت هر اقدام در دفتر رویداد
================================================================= */
const ADMIN_PIN = String(process.env.ADMIN_PIN || '');
const SESSION_MS = 30 * 60 * 1000;          /* نشست ۳۰ دقیقه */
const MAX_PIN_TRIES = 5;
const LOCK_MS = 15 * 60 * 1000;
const adminSessions = new Map();            /* token -> {id, exp, ip} */
const pinFails = new Map();                 /* id -> {n, until} */

setInterval(() => {
  const now = Date.now();
  for (const [t, v] of adminSessions) if (now > v.exp) adminSessions.delete(t);
  for (const [k, v] of pinFails) if (now > v.until && v.n === 0) pinFails.delete(k);
}, 5 * 60 * 1000);

function newSession(id, ip) {
  const token = crypto.randomBytes(24).toString('base64url');
  adminSessions.set(token, { id: String(id), exp: Date.now() + SESSION_MS, ip });
  return token;
}
function checkSession(token, id) {
  const s = adminSessions.get(String(token || ''));
  if (!s) return false;
  if (Date.now() > s.exp) { adminSessions.delete(token); return false; }
  if (String(s.id) !== String(id)) return false;
  s.exp = Date.now() + SESSION_MS;          /* تمدید با هر استفاده */
  return true;
}

/* دروازهٔ پایه: فقط شناسهٔ مدیر */
function adminOnly(req, res, next) {
  const raw = String(req.user.id).replace(/^dev:/, '');
  if (!ADMIN_IDS.length && DEV_MODE) return next();
  if (!ADMIN_IDS.includes(raw)) {
    audit(raw, 'admin-denied', 0, req.path, raw, clientIP(req));
    return res.status(403).json({ ok: false, err: 'forbidden' });
  }
  next();
}
/* دروازهٔ سخت: برای کارهای حساس، نشست معتبر هم لازم است */
function adminSecure(req, res, next) {
  const raw = String(req.user.id).replace(/^dev:/, '');
  if (!ADMIN_IDS.length && DEV_MODE) return next();
  if (!ADMIN_IDS.includes(raw)) {
    audit(raw, 'admin-denied', 0, req.path, raw, clientIP(req));
    return res.status(403).json({ ok: false, err: 'forbidden' });
  }
  /* اگر PIN تنظیم نشده، هشدار می‌دهیم ولی جلو را نمی‌گیریم */
  if (!ADMIN_PIN) return next();
  const tok = req.get('X-Admin-Session') || (req.body && req.body.session) || '';
  if (!checkSession(tok, raw)) {
    return res.status(401).json({ ok: false, err: 'need_pin' });
  }
  next();
}

/* ورود با رمز دوم */
app.post('/api/admin/login', auth, adminOnly, rateLimit(10, 10 * 60 * 1000), async (req, res) => {
  const raw = String(req.user.id).replace(/^dev:/, '');
  const ip = clientIP(req);
  const f = pinFails.get(raw);
  if (f && f.until > Date.now()) {
    return res.status(429).json({ ok: false, err: 'locked',
      wait: Math.ceil((f.until - Date.now()) / 1000) });
  }
  if (!ADMIN_PIN) {
    return res.json({ ok: true, session: newSession(raw, ip), noPin: true });
  }
  const pin = String((req.body && req.body.pin) || '');
  const a = Buffer.from(crypto.createHash('sha256').update(pin).digest('hex'));
  const b2 = Buffer.from(crypto.createHash('sha256').update(ADMIN_PIN).digest('hex'));
  const okPin = a.length === b2.length && crypto.timingSafeEqual(a, b2);
  if (!okPin) {
    const n = ((f && f.n) | 0) + 1;
    pinFails.set(raw, { n, until: n >= MAX_PIN_TRIES ? Date.now() + LOCK_MS : 0 });
    await audit(raw, 'admin-pin-fail', n, 'رمز اشتباه', raw, ip);
    if (n >= MAX_PIN_TRIES) {
      await notifyAdmins(`🚨 <b>هشدار امنیتی</b>\n\n${faNum(MAX_PIN_TRIES)} تلاش ناموفق ورود به پنل مدیر.\nحساب ${faNum(15)} دقیقه قفل شد.\nآی‌پی: <code>${ip}</code>`);
      return res.status(429).json({ ok: false, err: 'locked', wait: LOCK_MS / 1000 });
    }
    return res.status(401).json({ ok: false, err: 'bad_pin', left: MAX_PIN_TRIES - n });
  }
  pinFails.delete(raw);
  const token = newSession(raw, ip);
  await audit(raw, 'admin-login', 0, 'ورود موفق', raw, ip);
  await notifyAdmins(`🔐 ورود به پنل مدیر\nآی‌پی: <code>${ip}</code>\nزمان: ${new Date().toLocaleString('fa-IR')}`);
  res.json({ ok: true, session: token, expires: SESSION_MS });
});
app.post('/api/admin/logout', auth, adminOnly, (req, res) => {
  const tok = req.get('X-Admin-Session') || (req.body && req.body.session) || '';
  adminSessions.delete(String(tok));
  res.json({ ok: true });
});

/* ================================================================
   بسته‌های فروش — منبع حقیقت سمت سرور
   قیمت را کاربر نمی‌فرستد؛ فقط کلید بسته را می‌فرستد.
================================================================= */
/* هر استارز = ۳٬۵۰۰ تومان */
const STAR_TOMAN = 3500;
const PACKS = {
  p1: { n: 'بستهٔ کوچک',   bakht: 45,   stars: 15  },
  p2: { n: 'بستهٔ برنزی',   bakht: 105,  stars: 30  },
  p3: { n: 'بستهٔ نقره‌ای',  bakht: 270,  stars: 70  },
  p4: { n: 'بستهٔ طلایی',   bakht: 620,  stars: 150 },
  p5: { n: 'بستهٔ الماس',   bakht: 1400, stars: 320 },
  p6: { n: 'بستهٔ سلطنتی',  bakht: 3300, stars: 700, perk: 'gold' }
};
Object.values(PACKS).forEach(p => { p.toman = p.stars * STAR_TOMAN; });

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
/* ---------------- محاسبهٔ سمت سرور از روی ذخیرهٔ بازی ----------------
   کلاینت فقط «وضعیت زندگی» را می‌فرستد؛ اعدادی که رتبه می‌سازند را
   خود سرور از همان وضعیت درمی‌آورد تا قابل جعل نباشند. */
const WEALTH_CAP = 5e9;      /* سقف واقع‌گرایانه برای یک زندگی */
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function wealthFromSave(s) {
  if (!s || typeof s !== 'object') return 0;
  /* هر جزء جداگانه سقف می‌خورد تا نوشتن عدد نجومی در ذخیره بی‌اثر باشد */
  const cap = (v, m) => Math.max(-m, Math.min(m, num(v)));
  const PART = 8e8;
  let w = cap(s.cash, PART) + cap(s.bank, PART) + cap(s.savings, PART) - cap(s.loan, PART);
  if (Array.isArray(s.assets))
    w += s.assets.slice(0, 60).reduce((a, x) => a + cap(x && x.v, 3e8), 0) * 0.9;
  if (s.biz && typeof s.biz === 'object')
    w += cap(s.biz.val, 5e8) * (num(s.biz.years) >= 3 ? 0.65 : 0.4);
  if (s.port && s.mkt && typeof s.port === 'object' && typeof s.mkt === 'object') {
    for (const k of Object.keys(s.port).slice(0, 12))
      w += cap(num(s.port[k]) * num(s.mkt[k]) / 100, 2e8);
  }
  /* سقف عقلانی بر حسب سن. بیشترین ثروتی که در شبیه‌سازی‌های کامل بازی
     دیده‌ایم حدود ۹۰ هزار در سن ۸۰ بوده؛ این سقف چند برابر آن است تا
     هیچ بازیکن صادقی محدود نشود، ولی جعل نجومی بی‌اثر شود. */
  const age = Math.max(1, Math.min(130, num(s.age) || 1));
  const ageCap = Math.min(WEALTH_CAP, 900 * Math.pow(1.105, age) + 3000);
  return Math.round(Math.max(0, Math.min(ageCap, w)));
}
function scoreFromSave(s) {
  if (!s || typeof s !== 'object') return 0;
  const cl100 = v => Math.max(0, Math.min(100, num(v)));
  let sc = cl100(s.age) * 1.1 + cl100(s.happy) * 0.6 + cl100(s.smarts) * 0.4
         + cl100(s.looks) * 0.2 + cl100(s.fame) * 0.4
         + Math.max(0, Math.min(7, num(s.edu))) * 10
         + Math.max(0, Math.min(30, num(s.kids))) * 5
         + Math.min(wealthFromSave(s) / 300, 120);
  if (s.skills && typeof s.skills === 'object')
    sc += Object.values(s.skills).reduce((a, v) => a + cl100(v), 0) * 0.12;
  return Math.max(0, Math.min(1e7, Math.round(sc)));
}

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

/* ---------------- دفتر درآمد بخت ----------------
   سقف روزانه + سقف هر درخواست، جلوی تقلب را می‌گیرد. */
const EARN_MAX_PER_CALL = 60;      /* بیشترین بخت در یک همگام‌سازی */
const EARN_MAX_PER_DAY  = 220;     /* سقف روزانهٔ درآمد بازی */
function todayStamp() { return new Date().toISOString().slice(0, 10); }
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

/* ================================================================
   ═══ جهان مشترک واقعی ═══
   ارواح: زندگی‌های تمام‌شدهٔ بازیکنان واقعی که در جهان بقیه ظاهر می‌شوند
   جریان: رویدادهای زندهٔ بازیکنان دیگر
================================================================= */
/* آغاز جهان — باید با مقدار داخل بازی یکی بماند. */
const WORLD_EPOCH = Date.UTC(2026, 7, 15, 0, 0, 0);
const WORLD_DAY = 86400000;
function worldTick() {
  const d = Math.floor((Date.now() - WORLD_EPOCH) / WORLD_DAY);
  return d < 0 ? 0 : d;
}
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
  if (pool) {
    /* هم‌شهری‌های زنده و فعال اخیر */
    if (city) {
      const r = await pool.query(
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
      const r = await pool.query(
        `SELECT COALESCE(char_name,name) nm, fame, fame_rep, p_age, job_t, wealth, city
         FROM users
         WHERE id<>$1 AND banned=FALSE AND alive=TRUE
           AND country=$2 AND fame >= $3 AND char_name IS NOT NULL
         ORDER BY fame DESC LIMIT 5`, [uid, country, FAME_NATIONAL]);
      out.national = r.rows;
    }
    const r2 = await pool.query(
      `SELECT COALESCE(char_name,name) nm, fame, fame_rep, country, job_t, wealth
       FROM users
       WHERE id<>$1 AND banned=FALSE AND alive=TRUE
         AND fame >= $2 AND char_name IS NOT NULL
       ORDER BY fame DESC LIMIT 5`, [uid, FAME_GLOBAL]);
    out.global = r2.rows;
    return out;
  }
  const now = Date.now();
  const all = Object.values(mem.users).filter(u =>
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

/* ================================================================
   ═══ مزایدهٔ هفتگی یادگار خاندان ═══
   هر هفته یک «یادگار» عرضه می‌شود. بازیکنان با بخت پیشنهاد می‌دهند.
   فقط ۳ نفر برتر برنده می‌شوند. بازنده‌ها بختشان برمی‌گردد.
   برنده حق انتخاب وارث در مرگ بعدی را دارد.
================================================================= */
/* ================================================================
   ═══ حراج هفتگی ═══
   • فهرست بلندی از آیتم‌های لوکس؛ هر هفته چند تا به‌تصادف عرضه می‌شود
   • ورود نیازمند بلیط است (بلیط با بخت، تعداد محدود در هفته)
   • پیشنهادها با «پول داخل بازی» داده می‌شود، نه بخت
   • NPCهای هوشمند هم رقابت می‌کنند
================================================================= */
const LOTS_PER_WEEK   = 5;      /* چند آیتم در هفته */
const TICKETS_PER_WEEK= 40;     /* سقف بلیط کل بازیکنان */
const TICKET_COST     = 12;     /* بهای هر بلیط به بخت */

/* فهرست بلند آیتم‌های حراج — rar: کمیابی، base: پایهٔ قیمت (پول بازی) */
const AUCTION_ITEMS = [
 {k:'relic',   n:'یادگار خاندان',        e:'🏺', base:900,  rar:5, perk:'relic',
  d:'در مرگ بعدی خودت وارث را انتخاب می‌کنی'},
 {k:'crown',   n:'تاج عتیقهٔ سلطنتی',     e:'👑', base:2600, rar:5, fame:14, look:6,
  d:'نماد قدرت — شهرت و ابهت'},
 {k:'diamond', n:'الماس آبی نایاب',      e:'💎', base:3400, rar:5, wealth:1,
  d:'سرمایه‌ای که سال‌به‌سال گران‌تر می‌شود'},
 {k:'island',  n:'جزیرهٔ خصوصی کوچک',    e:'🏝️', base:5200, rar:5, happy:12, asset:'h',
  d:'پناهگاهی که فقط مال توست'},
 {k:'jet',     n:'جت شخصی',              e:'✈️', base:4400, rar:5, fame:10, asset:'c',
  d:'دنیا کوچک می‌شود'},
 {k:'yacht',   n:'قایق تفریحی لوکس',     e:'🛥️', base:3000, rar:4, happy:10, fame:6, asset:'c'},
 {k:'ferrari', n:'خودروی اسپرت کلاسیک',  e:'🏎️', base:2200, rar:4, fame:7, look:4, asset:'c'},
 {k:'penthouse',n:'پنت‌هاوس مرکز شهر',   e:'🏙️', base:2800, rar:4, happy:9, asset:'h'},
 {k:'vineyard',n:'تاکستان قدیمی',        e:'🍇', base:1900, rar:4, asset:'h', income:1},
 {k:'painting',n:'تابلوی نقاشی اصل',     e:'🖼️', base:1600, rar:4, fame:5, asset:'m'},
 {k:'violin',  n:'ویولن استرادیواری',    e:'🎻', base:1800, rar:4, skill:'music'},
 {k:'watch',   n:'ساعت جواهرنشان',       e:'⌚', base:1100, rar:3, look:5, asset:'m'},
 {k:'statue',  n:'مجسمهٔ باستانی',        e:'🗿', base:1300, rar:3, fame:4, asset:'m'},
 {k:'library', n:'کتابخانهٔ نسخ خطی',     e:'📜', base:1200, rar:3, smarts:6},
 {k:'racehorse',n:'اسب مسابقه‌ای',        e:'🐎', base:1500, rar:3, fame:5, income:1},
 {k:'guitar',  n:'گیتار یک افسانه',      e:'🎸', base:1000, rar:3, skill:'music', fame:3},
 {k:'telescope',n:'تلسکوپ رصدخانه‌ای',   e:'🔭', base:800,  rar:3, smarts:5},
 {k:'ring',    n:'حلقهٔ الماس عتیقه',    e:'💍', base:950,  rar:3, look:4, asset:'m'},
 {k:'wine',    n:'شراب صدساله',          e:'🍷', base:700,  rar:2, happy:6, asset:'m'},
 {k:'camera',  n:'دوربین کلکسیونی',      e:'📷', base:600,  rar:2, skill:'art'},
 {k:'chess',   n:'شطرنج عاج',            e:'♟️', base:550,  rar:2, smarts:4},
 {k:'coin',    n:'سکهٔ طلای تاریخی',     e:'🪙', base:650,  rar:2, asset:'m'},
 {k:'carpet',  n:'فرش دستباف نفیس',      e:'🧶', base:750,  rar:2, happy:5, asset:'m'},
 {k:'saxophone',n:'ساکسیفون جاز',        e:'🎷', base:500,  rar:2, skill:'music'},
 {k:'book',    n:'اولین چاپ یک شاهکار',  e:'📕', base:450,  rar:2, smarts:3},
 {k:'perfume', n:'عطر دست‌ساز کمیاب',    e:'🫧', base:380,  rar:1, look:3},
 {k:'pen',     n:'قلم طلایی نویسنده',    e:'🖋️', base:320,  rar:1, skill:'write'},
 {k:'vase',    n:'گلدان چینی',           e:'🏵️', base:420,  rar:1, asset:'m'},
 {k:'medal',   n:'مدال قهرمانی قدیمی',   e:'🥇', base:360,  rar:1, fame:2},
 {k:'map',     n:'نقشهٔ گنج قدیمی',      e:'🗺️', base:300,  rar:1, luck:4}
];

function weekNo(){ return Math.floor(worldTick()/7); }
function auctionOpen(){ return (worldTick()%7) < 5; }
function auctionClosesInMs(){
  const dayInWeek = worldTick() % 7;
  const daysLeft = Math.max(0, 5 - dayInWeek);
  const elapsed = (Date.now() - WORLD_EPOCH) % WORLD_DAY;
  return daysLeft * WORLD_DAY - elapsed;
}
/* بذر ثابت هفته — همهٔ بازیکنان یک فهرست می‌بینند */
function weekSeed(week, tag){
  return crypto.createHash('sha256').update('AUC|' + tag + '|' + week).digest();
}
function seedRand(buf, i){
  return buf[i % buf.length] / 255;
}
/* آیتم‌های این هفته */
function lotsOf(week){
  const buf = weekSeed(week, 'lots');
  const pool = AUCTION_ITEMS.slice();
  const out = [];
  let idx = 0;
  while (out.length < LOTS_PER_WEEK && pool.length) {
    const r = seedRand(buf, idx++);
    /* آیتم کمیاب‌تر شانس کمتری دارد */
    const weighted = pool.map(x => ({ x, w: 6 - x.rar }));
    const tot = weighted.reduce((s2, y) => s2 + y.w, 0);
    let pick = r * tot, chosen = weighted[0].x;
    for (const y of weighted) { pick -= y.w; if (pick <= 0) { chosen = y.x; break; } }
    out.push(chosen);
    pool.splice(pool.indexOf(chosen), 1);
  }
  return out.map((it, i) => {
    const rr = seedRand(buf, 50 + i);
    return Object.assign({}, it, {
      lot: i,
      start: Math.round(it.base * (0.75 + rr * 0.5))    /* قیمت پایهٔ متغیر */
    });
  });
}
/* رقیب‌های NPC این هفته — هوشمند و با بودجهٔ مشخص */
function npcsOf(week, lot){
  const buf = weekSeed(week, 'npc' + lot);
  const NAMES = ['کلکسیونر ناشناس','حاج‌آقا تهرانی','بانو رستمی','تاجر دبی','خانم صنعتی',
                 'وکیل شمال شهر','سرمایه‌گذار خارجی','عتیقه‌فروش بازار','دکتر مهرابی','آقای موسوی'];
  const n = 2 + Math.floor(seedRand(buf, 0) * 3);      /* ۲ تا ۴ رقیب */
  const pool = NAMES.slice();
  const out = [];
  for (let i = 0; i < n && pool.length; i++) {
    /* نام تکراری نباشد */
    const idx = Math.floor(seedRand(buf, 10 + i * 3) * pool.length) % pool.length;
    const name = pool.splice(idx, 1)[0];
    out.push({
      name,
      /* سقف بودجه: ضریبی از قیمت پایه — هرکس متفاوت */
      max: 1.15 + seedRand(buf, 11 + i * 3) * 1.75,
      grit: 0.3 + seedRand(buf, 12 + i * 3) * 0.55      /* پشتکار در بالا بردن قیمت */
    });
  }
  return out;
}

async function bidsOf(week, lot){
  if (pool) {
    const r = await pool.query(
      'SELECT uid,name,amount FROM bids WHERE week=$1 AND lot=$2 ORDER BY amount DESC, id ASC',
      [week, lot]);
    return r.rows;
  }
  mem.bids = mem.bids || {};
  const key = week + ':' + lot;
  return Object.values(mem.bids[key] || {}).sort((a, b) => b.amount - a.amount);
}
async function placeBid(week, lot, uid, name, amount){
  if (pool) {
    await pool.query(
      `INSERT INTO bids (week,lot,uid,name,amount) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (week,lot,uid) DO UPDATE SET amount=GREATEST(bids.amount,$5), at=NOW()`,
      [week, lot, uid, name, amount]);
    return;
  }
  mem.bids = mem.bids || {};
  const key = week + ':' + lot;
  mem.bids[key] = mem.bids[key] || {};
  const cur = mem.bids[key][uid];
  mem.bids[key][uid] = { uid, name, amount: Math.max(cur ? cur.amount : 0, amount) };
  fileSave();
}
/* بالاترین پیشنهاد فعلی هر آیتم (بازیکن یا NPC) */
async function lotState(week, it){
  const rows = await bidsOf(week, it.lot);
  const top = rows[0] || null;
  const npcs = npcsOf(week, it.lot);
  /* NPC هوشمند: تا سقف بودجه‌اش بالا می‌رود، ولی نه بی‌نهایت */
  let npcBid = Math.round(it.start * (1 + npcs[0].grit * 0.25));
  let npcName = npcs[0].name;
  if (top) {
    for (const nb of npcs) {
      const ceiling = Math.round(it.start * nb.max);
      if (top.amount < ceiling) {
        /* رقیب بالاتر می‌زند، اما فقط کمی — رفتار واقعی حراج */
        const step = Math.max(1, Math.round(top.amount * (0.03 + nb.grit * 0.07)));
        const want = Math.min(ceiling, top.amount + step);
        if (want > npcBid) { npcBid = want; npcName = nb.name; }
      }
    }
  }
  const playerTop = top ? top.amount | 0 : 0;
  const leader = playerTop > npcBid ? { name: top.name, isPlayer: true, amount: playerTop }
                                    : { name: npcName, isPlayer: false, amount: npcBid };
  return { rows, npcBid, leader };
}

/* ---- بلیط ---- */
async function ticketsSold(week){
  const c = await DB.getCfg();
  return Number(c['tix:' + week]) || 0;
}
async function myTickets(uid, week){
  const c = await DB.getCfg();
  return Number(c['tix:' + week + ':' + uid]) || 0;
}

/* وضعیت حراج */
app.post('/api/auction', auth, rateLimit(40, 60 * 1000), async (req, res) => {
  const week = weekNo();
  const uid = String(req.user.id);
  const u = (await DB.getUser(uid)) || {};
  const lots = lotsOf(week);
  const sold = await ticketsSold(week);
  const mine = await myTickets(uid, week);
  const out = [];
  for (const it of lots) {
    const st = await lotState(week, it);
    const my = st.rows.find(r => String(r.uid) === uid);
    out.push({
      lot: it.lot, k: it.k, n: it.n, e: it.e, d: it.d || '',
      rar: it.rar, start: it.start,
      leader: st.leader.name, leaderIsPlayer: st.leader.isPlayer,
      current: st.leader.amount,
      myBid: my ? my.amount | 0 : 0,
      winning: !!(my && my.amount >= st.leader.amount && st.leader.isPlayer),
      bidders: st.rows.length
    });
  }
  res.json({ ok: true, week, open: auctionOpen(),
    closesIn: Math.max(0, auctionClosesInMs()),
    lots: out,
    tickets: mine, ticketsLeft: Math.max(0, TICKETS_PER_WEEK - sold),
    ticketCost: TICKET_COST, bakht: u.bakht | 0 });
});

/* خرید بلیط — با بخت */
app.post('/api/auction/ticket', auth, rateLimit(10, 60 * 1000), async (req, res) => {
  const week = weekNo();
  const uid = String(req.user.id);
  const u = (await DB.getUser(uid)) || {};
  if (u.banned) return res.status(403).json({ ok: false, err: 'banned' });
  const sold = await ticketsSold(week);
  if (sold >= TICKETS_PER_WEEK)
    return res.status(400).json({ ok: false, err: 'sold_out' });
  if ((u.bakht | 0) < TICKET_COST)
    return res.status(400).json({ ok: false, err: 'no_bakht', need: TICKET_COST, have: u.bakht | 0 });
  await DB.addBakht(uid, -TICKET_COST);
  await DB.setCfg('tix:' + week, String(sold + 1));
  const mine = await myTickets(uid, week);
  await DB.setCfg('tix:' + week + ':' + uid, String(mine + 1));
  await audit(uid, 'auction-ticket', TICKET_COST, 'هفتهٔ ' + week, null, clientIP(req));
  res.json({ ok: true, tickets: mine + 1, bakht: (u.bakht | 0) - TICKET_COST,
             left: TICKETS_PER_WEEK - sold - 1 });
});

/* ثبت پیشنهاد — با پول داخل بازی */
app.post('/api/auction/bid', auth, rateLimit(30, 60 * 1000), async (req, res) => {
  if (!auctionOpen()) return res.status(400).json({ ok: false, err: 'closed' });
  const week = weekNo();
  const uid = String(req.user.id);
  const u = (await DB.getUser(uid)) || {};
  if (u.banned) return res.status(403).json({ ok: false, err: 'banned' });
  if ((await myTickets(uid, week)) <= 0)
    return res.status(400).json({ ok: false, err: 'no_ticket' });
  const lot = Math.max(0, Math.min(LOTS_PER_WEEK - 1, Number(req.body && req.body.lot) | 0));
  const want = Math.max(1, Math.min(9e12, Number(req.body && req.body.amount) || 0));
  const lots = lotsOf(week);
  const it = lots[lot];
  if (!it) return res.status(400).json({ ok: false, err: 'bad_lot' });
  const st = await lotState(week, it);
  if (want <= st.leader.amount)
    return res.status(400).json({ ok: false, err: 'too_low', need: st.leader.amount + 1 });
  /* پول بازی سمت کاربر است؛ سرور فقط منطق رقابت را نگه می‌دارد */
  await placeBid(week, lot, uid, (u.char_name || u.name || 'بازیکن').slice(0, 32), Math.round(want));
  const st2 = await lotState(week, it);
  res.json({ ok: true, amount: Math.round(want),
             current: st2.leader.amount, leader: st2.leader.name,
             winning: st2.leader.isPlayer && String(st2.rows[0] && st2.rows[0].uid) === uid });
});

/* تسویه: برندهٔ هر آیتم مشخص می‌شود */
async function settleAuction(week){
  const done = (await DB.getCfg())['auction:' + week];
  if (done) return null;
  const lots = lotsOf(week);
  let n = 0;
  for (const it of lots) {
    const st = await lotState(week, it);
    if (!st.leader.isPlayer) continue;            /* NPC برد */
    const top = st.rows[0];
    if (!top) continue;
    await DB.setCfg('won:' + top.uid + ':' + week + ':' + it.lot,
                    JSON.stringify({ k: it.k, n: it.n, e: it.e, price: top.amount | 0 }));
    await audit(top.uid, 'auction-win', top.amount | 0, it.n, null, '');
    n++;
    try {
      await say(top.uid,
        `${it.e} <b>${it.n} را بردی!</b>\n\n` +
        `قیمت نهایی: <b>${faNum((top.amount | 0).toLocaleString('en-US'))}</b>\n` +
        `${it.d || ''}`,
        { reply_markup: playBtn('🎁 تحویل گرفتن') });
    } catch (e) {}
  }
  await DB.setCfg('auction:' + week, 'done');
  return { won: n };
}

/* تحویل آیتم‌های برده‌شده */
app.post('/api/auction/claim', auth, async (req, res) => {
  const uid = String(req.user.id);
  const cfg = await DB.getCfg();
  const items = [];
  for (const k in cfg) {
    if (k.indexOf('won:' + uid + ':') === 0 && cfg[k] && cfg[k] !== 'claimed') {
      try { items.push(JSON.parse(cfg[k])); } catch (e) {}
      await DB.setCfg(k, 'claimed');
    }
  }
  res.json({ ok: true, items });
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
      const r = await runBackup(true);
      if (!r.ok) await say(chatId, '⚠️ پشتیبان‌گیری ناموفق بود: ' + (r.err || 'نامشخص'));
      return;
    }
    if (/^\/backupinfo/.test(text)) {
      const nextIn = lastBackupAt
        ? Math.max(0, Math.round((lastBackupAt + BACKUP_HOURS * 3600000 - Date.now()) / 60000))
        : null;
      await say(chatId,
        '💾 <b>وضعیت پشتیبان‌گیری</b>\n\n' +
        'خودکار: ' + (BACKUP_ON ? '✅ روشن' : '❌ خاموش') + '\n' +
        'هر ' + faNum(BACKUP_HOURS) + ' ساعت یک بار\n' +
        'آخرین نسخه: ' + (lastBackupAt
          ? (new Date(lastBackupAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
             + (lastBackupOk ? ' ✅' : ' ⚠️'))
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
  /* تسویهٔ مزایدهٔ هفتهٔ گذشته */
  try { if (!auctionOpen()) await settleAuction(weekNo()); }
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
  app.post('/api/__test_settle', async (req, res) => {
    const r = await settleAuction(weekNo());
    res.json({ ok: true, r });
  });
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
  const out = { db: pool ? 'postgres' : 'file', at: Date.now() };
  if (pool) {
    const u = await pool.query(`
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
    const o = await pool.query(`
      SELECT status, kind, COUNT(*) c, COALESCE(SUM(bakht),0) b
      FROM orders GROUP BY status, kind`);
    out.orders = o.rows.map(r => ({ status: r.status, kind: r.kind, n: +r.c, bakht: +r.b }));
    const rev = await pool.query(`
      SELECT kind, COUNT(*) n, COALESCE(SUM(bakht),0) b
      FROM orders WHERE status='approved' GROUP BY kind`);
    out.revenue = rev.rows.map(r => ({ kind: r.kind, n: +r.n, bakht: +r.b }));
    const daily = await pool.query(`
      SELECT to_char(created,'YYYY-MM-DD') d, COUNT(*) n,
             COALESCE(SUM(bakht),0) b
      FROM orders WHERE status='approved' AND created > NOW() - INTERVAL '14 days'
      GROUP BY d ORDER BY d DESC`);
    out.daily = daily.rows.map(r => ({ d: r.d, n: +r.n, bakht: +r.b }));
    const top = await pool.query(`
      SELECT id,name,bakht,spent,refs,gen,wealth FROM users
      ORDER BY spent DESC NULLS LAST LIMIT 10`);
    out.topSpenders = top.rows.map(r => ({
      id: r.id, name: r.name, bakht: r.bakht | 0, spent: r.spent | 0,
      refs: r.refs | 0, gen: r.gen | 0, wealth: Number(r.wealth) || 0 }));
    const inv = await pool.query(`
      SELECT id,name,refs FROM users WHERE refs>0 ORDER BY refs DESC LIMIT 10`);
    out.topInviters = inv.rows.map(r => ({ id: r.id, name: r.name, refs: r.refs | 0 }));
  } else {
    const arr = Object.values(mem.users); const now = Date.now();
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
    (mem.orders || []).forEach(o => {
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
  out.pinSet = !!ADMIN_PIN;
  out.botOk = !!BOT_TOKEN;
  out.admins = ADMIN_IDS.length;
  res.json({ ok: true, deep: out });
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
      await DB.upsertUser(id, { save: null }, false);
      await audit(id, 'admin-resetsave', 0, '', actor, ip);
      msg = 'ذخیره پاک شد'; break;
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
  add('دیتابیس', true, pool ? 'پستگرس متصل' : 'حالت فایل (داده با ری‌استارت پاک می‌شود)');
  if (pool) {
    try { const t0 = Date.now(); await pool.query('SELECT 1');
      add('پاسخ دیتابیس', true, (Date.now() - t0) + ' میلی‌ثانیه'); }
    catch (e) { add('پاسخ دیتابیس', false, e.message); }
  }
  add('توکن بات', !!BOT_TOKEN, BOT_TOKEN ? 'تنظیم شده' : 'تنظیم نشده');
  add('نام کاربری بات', !!BOT_USER_LIVE, BOT_USER_LIVE ? '@' + BOT_USER_LIVE : 'ناشناخته');
  add('آدرس سرور', !!SELF_URL, SELF_URL || 'تنظیم نشده — وب‌هوک کار نمی‌کند');
  add('رمز دوم مدیر', !!ADMIN_PIN, ADMIN_PIN ? 'فعال' : '⚠️ تنظیم نشده — امنیت پایین');
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
    const r = await runBackup(true);
    msg = r.ok ? ('پشتیبان ساخته و در تلگرام فرستاده شد ('
                  + Math.round(r.size / 1024) + ' کیلوبایت، '
                  + r.users + ' کاربر)')
               : ('پشتیبان‌گیری ناموفق: ' + (r.err || 'نامشخص'));
  } else if (act === 'purgeRejected') {
    if (pool) { const r = await pool.query("DELETE FROM orders WHERE status='rejected'");
      msg = (r.rowCount | 0) + ' سفارش ردشده پاک شد'; }
    else { const n = mem.orders.length;
      mem.orders = mem.orders.filter(o => o.status !== 'rejected'); fileSave();
      msg = (n - mem.orders.length) + ' سفارش ردشده پاک شد'; }
  } else return res.status(400).json({ ok: false, err: 'bad_act' });
  await audit(null, 'admin-maint', 0, act, actor, ip);
  res.json({ ok: true, msg });
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
  /* نسخهٔ فشرده را ترجیح بده — برای گوشی‌های ضعیف و اینترنت کند */
  if (f && tryGzip(req, res, f)) return;
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
    /* پشتیبان‌گیری خودکار */
    if (BOT_TOKEN && BACKUP_ON && ADMIN_IDS.length) {
      const ms = BACKUP_HOURS * 60 * 60 * 1000;
      setInterval(() => { runBackup(false); }, ms);
      /* یک نسخه کمی بعد از بالا آمدن، تا مطمئن شوی کار می‌کند */
      setTimeout(() => { runBackup(false); }, 90 * 1000);
      console.log('[backup] پشتیبان خودکار هر ' + BACKUP_HOURS + ' ساعت فعال شد');
    } else if (!ADMIN_IDS.length) {
      console.warn('[backup] ⚠️ ADMIN_IDS خالی است — پشتیبان ارسال نمی‌شود');
    }
  }));

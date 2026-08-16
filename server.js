/* ================================================================
   سرور ویت‌لایف
   کارها: احراز هویت تلگرام | ذخیرهٔ ابری | رتبه‌بندی | سفارش و رسید | پنل ادمین
   نکته: اگر دیتابیس نباشد، خودکار روی فایل کار می‌کند (برای شروع رایگان)
================================================================= */
const express = require('express');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ADMIN_IDS = String(process.env.ADMIN_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const DEV_MODE  = String(process.env.DEV_MODE || '') === '1';

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
  console.log('[db] پستگرس متصل شد');
}

/* ---------------- لایهٔ داده ---------------- */
const DB = {
  async getUser(id) {
    if (pool) {
      const r = await pool.query('SELECT * FROM users WHERE id=$1', [id]);
      return r.rows[0] || null;
    }
    return mem.users[id] || null;
  },
  async upsertUser(id, patch) {
    if (pool) {
      const cur = (await this.getUser(id)) || {};
      const u = Object.assign({ id, bakht: 0, gen: 1, score: 0, wealth: 0 }, cur, patch);
      await pool.query(
        `INSERT INTO users (id,name,bakht,save,wallet,score,wealth,gen,fam,banned,seen)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
         ON CONFLICT (id) DO UPDATE SET
           name=$2,bakht=$3,save=$4,wallet=$5,score=$6,wealth=$7,gen=$8,fam=$9,banned=$10,seen=NOW()`,
        [id, u.name || null, u.bakht | 0, u.save || null, u.wallet || null,
         u.score | 0, Math.round(u.wealth || 0), u.gen | 0, u.fam || null, !!u.banned]);
      return u;
    }
    const u = Object.assign({ id, bakht: 0, gen: 1, score: 0, wealth: 0 },
      mem.users[id] || {}, patch, { seen: Date.now() });
    mem.users[id] = u; fileSave();
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
        `INSERT INTO orders (uid,code,pack,bakht,receipt,status)
         VALUES ($1,$2,$3,$4,$5,'pending') RETURNING id`,
        [o.uid, o.code, o.pack, o.bakht | 0, o.receipt || null]);
      return r.rows[0].id;
    }
    const id = (mem.orders.length ? mem.orders[mem.orders.length - 1].id : 0) + 1;
    mem.orders.push(Object.assign({ id, status: 'pending', created: Date.now() }, o));
    if (mem.orders.length > 500) mem.orders.shift();
    fileSave();
    return id;
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
        'UPDATE orders SET status=$1 WHERE id=$2 RETURNING *', [status, id]);
      return r.rows[0] || null;
    }
    const o = mem.orders.find(x => x.id === (id | 0));
    if (o) { o.status = status; fileSave(); }
    return o || null;
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
    return { id: String(user.id), name: [user.first_name, user.last_name].filter(Boolean).join(' ') || 'بازیکن' };
  } catch (e) { return null; }
}
function auth(req, res, next) {
  const initData = req.get('X-TG-Init') || (req.body && req.body.initData) || '';
  let u = checkTelegram(initData);
  if (!u && DEV_MODE) {
    const dev = req.get('X-Dev-Id') || 'dev-user';
    u = { id: 'dev:' + dev, name: 'کاربر تست' };
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

/* ---------------- مسیرها ---------------- */
app.get('/api/health', (req, res) =>
  res.json({ ok: true, db: pool ? 'postgres' : 'file', time: Date.now() }));

app.post('/api/me', auth, async (req, res) => {
  const u = await DB.upsertUser(req.user.id, { name: req.user.name });
  if (u.banned) return res.status(403).json({ ok: false, err: 'banned' });
  res.json({ ok: true, user: { id: u.id, name: u.name, bakht: u.bakht | 0 },
             isAdmin: ADMIN_IDS.includes(String(req.user.id).replace(/^dev:/, '')) });
});

/* ذخیرهٔ ابری */
app.post('/api/save', auth, async (req, res) => {
  const b = req.body || {};
  const s = b.save, w = b.wallet;
  if (s && JSON.stringify(s).length > 900000)
    return res.status(413).json({ ok: false, err: 'too_big' });
  await DB.upsertUser(req.user.id, {
    save: s || null, wallet: w || null,
    wealth: Math.max(0, Math.min(9e14, Number(b.wealth) || 0)),
    score: Math.max(0, Math.min(1e7, Number(b.score) | 0)),
    gen: Math.max(1, Math.min(200, Number(b.gen) | 0 || 1)),
    fam: String(b.fam || '').slice(0, 40) || null,
    bakht: Math.max(0, Math.min(1e7, Number(b.bakht) | 0))
  });
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

/* سفارش و رسید */
app.post('/api/order', auth, async (req, res) => {
  const b = req.body || {};
  const rc = String(b.receipt || '');
  if (rc && !/^data:image\/(png|jpe?g|webp);base64,/.test(rc))
    return res.status(400).json({ ok: false, err: 'bad_image' });
  if (rc.length > 4000000) return res.status(413).json({ ok: false, err: 'image_too_big' });
  const id = await DB.addOrder({
    uid: req.user.id,
    code: String(b.code || '').slice(0, 40),
    pack: String(b.pack || '').slice(0, 20),
    bakht: Math.max(0, Math.min(100000, Number(b.bakht) | 0)),
    receipt: rc || null
  });
  res.json({ ok: true, id });
});
app.get('/api/paycfg', async (req, res) => {
  const c = await DB.getCfg();
  res.json({ ok: true, cfg: {
    card:  c.card  || '', sheba: c.sheba || '',
    owner: c.owner || '', bank:  c.bank  || '',
    tg:    c.tg    || '', on: c.on !== '0' } });
});

/* ---------------- پنل ادمین ---------------- */
app.post('/api/admin/orders', auth, adminOnly, async (req, res) => {
  const list = await DB.listOrders(req.body && req.body.status);
  res.json({ ok: true, orders: list });
});
app.post('/api/admin/order/:id', auth, adminOnly, async (req, res) => {
  const act = String((req.body && req.body.action) || '');
  const o = await DB.setOrder(req.params.id, act === 'approve' ? 'approved' : 'rejected');
  if (o && act === 'approve') {
    const u = await DB.getUser(o.uid);
    await DB.upsertUser(o.uid, { bakht: ((u && u.bakht) | 0) + (o.bakht | 0) });
  }
  res.json({ ok: true, order: o });
});
app.post('/api/admin/cfg', auth, adminOnly, async (req, res) => {
  const b = req.body || {};
  for (const k of ['card', 'sheba', 'owner', 'bank', 'tg', 'on'])
    if (b[k] !== undefined) await DB.setCfg(k, String(b[k]).slice(0, 120));
  res.json({ ok: true, cfg: await DB.getCfg() });
});
app.post('/api/admin/user', auth, adminOnly, async (req, res) => {
  const b = req.body || {};
  const id = String(b.id || '');
  if (!id) return res.status(400).json({ ok: false });
  const u = await DB.getUser(id);
  if (!u) return res.status(404).json({ ok: false, err: 'not_found' });
  const patch = {};
  if (b.addBakht !== undefined)
    patch.bakht = Math.max(0, (u.bakht | 0) + (Number(b.addBakht) | 0));
  if (b.banned !== undefined) patch.banned = !!b.banned;
  const nu = await DB.upsertUser(id, patch);
  res.json({ ok: true, user: { id: nu.id, name: nu.name, bakht: nu.bakht | 0, banned: !!nu.banned } });
});
app.post('/api/admin/stats', auth, adminOnly, async (req, res) => {
  let users = 0, bakht = 0, pending = 0;
  if (pool) {
    const a = await pool.query('SELECT COUNT(*) c, COALESCE(SUM(bakht),0) b FROM users');
    users = Number(a.rows[0].c); bakht = Number(a.rows[0].b);
    const p = await pool.query("SELECT COUNT(*) c FROM orders WHERE status='pending'");
    pending = Number(p.rows[0].c);
  } else {
    const arr = Object.values(mem.users);
    users = arr.length;
    bakht = arr.reduce((s, u) => s + (u.bakht | 0), 0);
    pending = mem.orders.filter(o => o.status === 'pending').length;
  }
  res.json({ ok: true, stats: { users, bakht, pending, db: pool ? 'postgres' : 'file' } });
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
  + '۲) فایل <code>waitlife.html</code> را بکش و رها کن<br>'
  + '۳) <b>اسمش را به <code>index.html</code> عوض کن</b><br>'
  + '۴) <code>Commit changes</code><br><br>'
  + 'همین یک فایل کافی است. نیازی به ساختن پوشه نیست.</div>'
  + '<div class="box" style="font-size:13px;color:#93a3b5">سرور در این مسیرها گشت:<br>'
  + '<code>public/index.html</code><br><code>index.html</code></div>'
  + '</body></html>');
});

/* ---------------- بیدار نگه داشتن ----------------
   سرویس‌های رایگان بعد از ۱۵ دقیقه بی‌کاری می‌خوابند.
   اگر SELF_URL را تنظیم کنی، سرور هر ۱۰ دقیقه به خودش سر می‌زند. */
const SELF_URL = process.env.SELF_URL || '';
if (SELF_URL) {
  setInterval(() => {
    const u = SELF_URL.replace(/\/+$/, '') + '/api/health';
    try {
      fetch(u).catch(() => {});
    } catch (e) {}
  }, 10 * 60 * 1000);
  console.log('[keepalive] فعال شد:', SELF_URL);
}

initDB()
  .catch(e => { console.error('[db] خطا، حالت فایل فعال شد:', e.message); fileLoad(); })
  .finally(() => app.listen(PORT, '0.0.0.0',
    () => {
      const f = findGame();
      console.log('[waitlife] روی پورت ' + PORT + ' بالا آمد');
      if (f) console.log('[game] فایل بازی پیدا شد:', f.replace(__dirname, '.'));
      else console.warn('[game] ⚠️ فایل بازی پیدا نشد — index.html را آپلود کن');
    }));

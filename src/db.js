/* ================================================================
   ویت‌لایف — لایهٔ داده
   پستگرس (نئون) یا فایل محلی | حساب ثروت و امتیاز سمت سرور | آمار
================================================================= */
const fs   = require('fs');
const path = require('path');
const { ROOT } = require('./config');

/* ---------------- ذخیره‌سازی ---------------- */
/* اگر DATABASE_URL باشد از پستگرس، وگرنه از فایل استفاده می‌شود */
const DB_URL = process.env.DATABASE_URL || '';
let pool = null;
const FILE = process.env.DATA_FILE || path.join(ROOT, 'data.json');
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


/* ---------------- مهر ریست جهان ----------------
   بعد از «ریست کامل جهان»، هر کلاینتی که هنوز ذخیرهٔ قدیمی دارد باید
   شناسایی و وادار به شروع تازه شود. مهر در cfg می‌ماند و اینجا ۳۰ ثانیه
   کش می‌شود تا هر ذخیره‌سازی یک کوئری اضافه نزند. */
const WRC = { v: 0, m: 'soft', at: 0 };
async function wrInfo() {
  if (WRC.at && Date.now() - WRC.at < 30000) return WRC;
  try {
    const c = await DB.getCfg();
    WRC.v = Number(c.wr || 0);
    WRC.m = c.wrmode === 'hard' ? 'hard' : 'soft';
  } catch (e) { /* دیتابیس در دسترس نیست — مهر قبلی معتبر می‌ماند */ }
  WRC.at = Date.now();
  return WRC;
}
function wrBust() { WRC.at = 0; }

/* pool و mem داخل ماژول دوباره مقدار می‌گیرند (اتصال به دیتابیس،
   بارگذاری فایل) — پس با getter صادر می‌شوند تا ماژول‌های دیگر
   همیشه مقدار زنده را ببینند. */
module.exports = {
  get pool() { return pool; },
  get mem()  { return mem; },
  DB,
  fileLoad, fileSave, initDB,
  wealthFromSave, scoreFromSave, statsSnapshot, WEALTH_CAP,
  wrInfo, wrBust
};

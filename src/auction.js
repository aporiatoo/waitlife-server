/* ================================================================
   ویت‌لایف — حراج هفتگی + ساعت جهان
   آیتم‌های لوکس | بلیط | رقیب‌های NPC | تسویهٔ خودکار
================================================================= */
const crypto = require('crypto');
const { auth } = require('./auth');
const { rateLimit } = require('./middleware');
const { audit, clientIP } = require('./util');
const { say, playBtn, faNum } = require('./telegram');
const db = require('./db');
const { DB } = db;

/* آبجکت صادراتی همین اول ساخته می‌شود تا ماژول‌های دیگر بدون
   دورِ نیازمندی (dependency cycle) بتوانند از توابعش استفاده کنند.
   createAuction موقع ساخت app صدا زده می‌شود و API را پر می‌کند. */
const API = {};
module.exports = API;

function createAuction(app) {
/* آغاز جهان — باید با مقدار داخل بازی یکی بماند. */
const WORLD_EPOCH = Date.UTC(2026, 7, 15, 0, 0, 0);
const WORLD_DAY = 86400000;
function worldTick() {
  const d = Math.floor((Date.now() - WORLD_EPOCH) / WORLD_DAY);
  return d < 0 ? 0 : d;
}
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
  if (db.pool) {
    const r = await db.pool.query(
      'SELECT uid,name,amount FROM bids WHERE week=$1 AND lot=$2 ORDER BY amount DESC, id ASC',
      [week, lot]);
    return r.rows;
  }
  db.mem.bids = db.mem.bids || {};
  const key = week + ':' + lot;
  return Object.values(db.mem.bids[key] || {}).sort((a, b) => b.amount - a.amount);
}
async function placeBid(week, lot, uid, name, amount){
  if (db.pool) {
    await db.pool.query(
      `INSERT INTO bids (week,lot,uid,name,amount) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (week,lot,uid) DO UPDATE SET amount=GREATEST(bids.amount,$5), at=NOW()`,
      [week, lot, uid, name, amount]);
    return;
  }
  db.mem.bids = db.mem.bids || {};
  const key = week + ':' + lot;
  db.mem.bids[key] = db.mem.bids[key] || {};
  const cur = db.mem.bids[key][uid];
  db.mem.bids[key][uid] = { uid, name, amount: Math.max(cur ? cur.amount : 0, amount) };
  db.fileSave();
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


  Object.assign(API, {
    worldTick, weekNo, auctionOpen, auctionClosesInMs,
    lotsOf, lotState, settleAuction,
    WORLD_EPOCH, WORLD_DAY,
    LOTS_PER_WEEK, TICKETS_PER_WEEK, TICKET_COST, AUCTION_ITEMS
  });
  return API;
}
API.createAuction = createAuction;

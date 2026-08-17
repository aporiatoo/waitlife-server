/* ================================================================
   تست‌های خودکار ویت‌لایف
   بدون نیاز به توکن بات یا دیتابیس — با حالت فایل و کاربر تستی.
   اجرا: npm test
================================================================= */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

/* محیط تست — باید قبل از require ماژول‌ها تنظیم شود */
process.env.DATA_FILE = path.join(os.tmpdir(), 'waitlife-test-' + process.pid + '.json');
process.env.DEV_MODE = '1';
delete process.env.DATABASE_URL;
delete process.env.BOT_TOKEN;

const db = require('../src/db');
const { createApp } = require('../src/app');

let server, base;

before(async () => {
  await db.initDB();
  const app = createApp();
  server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  base = 'http://127.0.0.1:' + server.address().port;
});

after(async () => {
  if (server) server.close();
  try { fs.unlinkSync(process.env.DATA_FILE); } catch (e) {}
});

async function api(method, p, body, headers) {
  const res = await fetch(base + p, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json', 'X-Dev-Id': 'test-user' }, headers || {}),
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await res.json().catch(() => null);
  return { status: res.status, j };
}

test('سلامت سرور', async () => {
  const { status, j } = await api('GET', '/api/health');
  assert.equal(status, 200);
  assert.equal(j.ok, true);
});

test('ورود کاربر و ساخت حساب', async () => {
  const { status, j } = await api('POST', '/api/me', {});
  assert.equal(status, 200);
  assert.equal(j.ok, true);
  assert.equal(j.user.id, 'dev:test-user');
  assert.equal(j.user.bakht, 0);
});

test('ذخیرهٔ ابری + درآمد بخت با سقف', async () => {
  const save = {
    name: 'تست', age: 22, cash: 1200, bank: 3000, savings: 500, loan: 100,
    assets: [{ v: 400 }], biz: { val: 200, years: 5 },
    port: { a: 10 }, mkt: { a: 150 }, happy: 80, smarts: 70,
    looks: 60, fame: 50, edu: 5, kids: 2, skills: { x: 30 },
    gen: 1, alive: true, country: 'ایران', city: 'تهران', job: { t: 'مهندس' }
  };
  const { status, j } = await api('POST', '/api/save', { save, earn: 60 });
  assert.equal(status, 200);
  assert.equal(j.ok, true);
  assert.equal(j.credited, 60);
  assert.equal(j.bakht, 60);
  /* سقف هر درخواست ۶۰ است و سقف روزانه ۲۲۰:
     ۳ درخواست کامل + یک درخواست ۴۰ تایی + صفر بعد از آن */
  const r2 = await api('POST', '/api/save', { save, earn: 60 });
  assert.equal(r2.j.credited, 60);
  const r3 = await api('POST', '/api/save', { save, earn: 60 });
  assert.equal(r3.j.credited, 60);
  const r4 = await api('POST', '/api/save', { save, earn: 60 });
  assert.equal(r4.j.credited, 40);
  const r5 = await api('POST', '/api/save', { save, earn: 60 });
  assert.equal(r5.j.credited, 0);
});

test('بارگذاری ذخیره از سرور', async () => {
  const { status, j } = await api('POST', '/api/load', {});
  assert.equal(status, 200);
  assert.equal(j.save.name, 'تست');
  assert.equal(j.save.country, 'ایران');
});

test('رتبه‌بندی جهانی', async () => {
  const { status, j } = await api('GET', '/api/top', null);
  assert.equal(status, 200);
  assert.ok(j.top.length >= 1);
  assert.equal(j.top[0].name, 'تست');
  assert.ok(j.top[0].wealth > 0);
});

test('جهان مشترک: ثبت روح و نمای جهان', async () => {
  const g = await api('POST', '/api/world/ghost', {
    name: 'روح', fam: 'تست', country: 'ایران', flag: '🇮🇷',
    gen: 1, age: 70, job: 'بازرگان', ribbon: 'ثروتمند'
  });
  assert.equal(g.status, 200);
  assert.equal(g.j.ok, true);

  const w = await api('GET', '/api/world', null);
  assert.equal(w.status, 200);
  assert.ok(w.j.stats.players >= 1);
  assert.ok(w.j.stats.lives >= 1);
});

test('حراج هفتگی: وضعیت، بلیط و پیشنهاد', async () => {
  const a = await api('POST', '/api/auction', {});
  assert.equal(a.status, 200);
  assert.equal(a.j.ok, true);
  assert.equal(a.j.lots.length, 5);
  assert.equal(typeof a.j.open, 'boolean');

  /* بلیط با بخت — موجودی ۲۲۰ است */
  const t = await api('POST', '/api/auction/ticket', {});
  assert.equal(t.status, 200);
  assert.equal(t.j.ok, true);
  assert.equal(t.j.tickets, 1);

  if (a.j.open) {
    const b = await api('POST', '/api/auction/bid', { lot: 0, amount: 999999 });
    assert.equal(b.status, 200);
    assert.equal(b.j.ok, true);
  }
});

test('فروشگاه: پیکربندی پرداخت و فاکتور استارز', async () => {
  const c = await api('GET', '/api/paycfg', null);
  assert.equal(c.status, 200);
  assert.equal(c.j.ok, true);

  /* بدون توکن بات، فاکتور ساخته نمی‌شود */
  const i = await api('POST', '/api/stars/invoice', { pack: 'p1' });
  assert.equal(i.j.ok, false);
  assert.equal(i.j.err, 'no_bot');
});

test('سفارش کارت‌به‌کارت: تصویر نامعتبر و سفارش معتبر', async () => {
  const bad = await api('POST', '/api/order', { pack: 'p1', code: '1', receipt: 'data:text/plain;base64,AAAA' });
  assert.equal(bad.j.ok, false);
  assert.equal(bad.j.err, 'bad_image');

  const ok = await api('POST', '/api/order', { pack: 'p1', code: '1234', receipt: '' });
  assert.equal(ok.j.ok, true);
  assert.ok(ok.j.id >= 1);
});

test('پنل ادمین: ورود، آمار، سلامت', async () => {
  const login = await api('POST', '/api/admin/login', {});
  assert.equal(login.status, 200);
  assert.equal(login.j.ok, true);
  assert.ok(login.j.session);

  const stats = await api('POST', '/api/admin/stats', {});
  assert.equal(stats.j.ok, true);
  assert.ok(stats.j.stats.users >= 1);

  const deep = await api('POST', '/api/admin/deep', {});
  assert.equal(deep.j.ok, true);
  assert.ok(deep.j.deep.users >= 1);

  const health = await api('POST', '/api/admin/health', {});
  assert.equal(health.j.ok, true);
  assert.ok(health.j.checks.length >= 5);
});

test('صفحهٔ بازی از public/ سرو می‌شود', async () => {
  const res = await fetch(base + '/');
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.ok(html.includes('ویت‌لایف'));
  assert.ok(html.length > 100000);
});

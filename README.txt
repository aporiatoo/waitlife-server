سرور ویت‌لایف
==============
این پوشه را کامل آپلود کن.

فایل‌ها:
  server.js         → مغز سرور (دست نزن)
  package.json      → فهرست وابستگی‌ها (دست نزن)
  render.yaml       → تنظیمات Render
  Procfile          → تنظیمات عمومی
  public/index.html → خود بازی

هر وقت بازی به‌روز شد، فقط public/index.html را عوض کن.

سه متغیر محیطی که باید در پنل Render بسازی:
  BOT_TOKEN     = توکنی که BotFather می‌دهد
  ADMIN_IDS     = عدد شناسهٔ تلگرام خودت
  DATABASE_URL  = آدرس اتصال دیتابیس نئون

و یکی اختیاری برای بیدار ماندن:
  SELF_URL      = آدرس سایت خودت

Build Command: npm install
Start Command: npm start

⚠️ مهم: بدون DATABASE_URL، اطلاعات روی فایل ذخیره می‌شود
و در سرویس رایگان Render هر بار ری‌استارت پاک می‌شود.

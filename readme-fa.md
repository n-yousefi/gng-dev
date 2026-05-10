# راهنمای سریع GIG Component Inspector

این افزونه برای پیدا کردن کامپوننت‌های Angular/GIG داخل صفحه و باز کردن فایل `.ts` آن‌ها در VS Code است.

## نصب

1. در Chrome به `chrome://extensions` بروید.
2. گزینه Developer mode را روشن کنید.
3. روی Load unpacked بزنید و پوشه افزونه را انتخاب کنید.
4. فایل `.env.sample` را به `.env` کپی کنید.
5. مسیر پوشه نهایی `ClientApp` را در `.env` تنظیم کنید:

```text
CLIENT_APP_ROOT=C:\Path\To\TotalSales\Gng.TotalSales.UI\GIG.App.Sl\ClientApp
```

6. اسکریپت ثبت Native Host را اجرا کنید:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\register-native-host.ps1
```

7. افزونه را در `chrome://extensions` Reload کنید.

## استفاده

1. صفحه مورد نظر را باز کنید.
2. DevTools را با `F12` باز کنید.
3. تب `GIG Components` را انتخاب کنید.
4. دکمه Refresh بالای پنل، کامپوننت‌های صفحه را اسکن می‌کند.
5. دکمه آیکون سبز/قرمز کنار جستجو، فایل `component-index.json` را دوباره می‌سازد.
6. با انتخاب هر کامپوننت، مسیر فایل و اطلاعات اصلی آن نمایش داده می‌شود.
7. دکمه کد کنار عنوان کامپوننت، فایل `.ts` را در VS Code باز می‌کند.

## منوی راست کلیک

گزینه `Find Component in GNG DevTools"` فقط وقتی DevTools و تب افزونه باز باشد می‌تواند همان کامپوننت را در پنل انتخاب کند.

کروم به افزونه‌ها اجازه نمی‌دهد DevTools را خودکار باز کنند یا به صورت خودکار به تب افزونه داخل DevTools بروند. بنابراین اگر DevTools بسته باشد، اول آن را دستی باز کنید و بعد تب `GIG Components` را انتخاب کنید.

# راهنمای سریع GIG Component Inspector

این افزونه برای inspect کردن کامپوننت‌های Angular/GIG داخل صفحه است. با آن می‌توانید کامپوننت‌های رندر شده را ببینید، کامپوننت‌های پروژه را از روی index پیدا کنید، و فایل `.ts` هر کامپوننت را مستقیم در VS Code باز کنید.

## نصب

1. در Chrome به `chrome://extensions` بروید.
2. گزینه `Developer mode` را روشن کنید.
3. روی `Load unpacked` بزنید و پوشه افزونه را انتخاب کنید.
4. فایل `.env.sample` را به `.env` کپی کنید.
5. مسیر پوشه نهایی `ClientApp` پروژه را در `.env` تنظیم کنید:

```text
CLIENT_APP_ROOT=C:\Path\To\TotalSales\Gng.TotalSales.UI\GIG.App.Sl\ClientApp
```

برای چند پروژه همزمان، به جای `CLIENT_APP_ROOT` تکی می‌توانید برای هر پروژه `BASE_URL` و `CLIENT_APP_ROOT` جدا تعریف کنید. افزونه بر اساس URL صفحه‌ای که داخل DevTools باز است، index همان پروژه را لود یا ایجاد می‌کند:

```text
PROJECT_TOTALSALES_NAME=TotalSales
PROJECT_TOTALSALES_BASE_URL=http://localhost:4202
PROJECT_TOTALSALES_CLIENT_APP_ROOT=C:\Path\To\TotalSales\Gng.TotalSales.UI\GIG.App.Sl\ClientApp

PROJECT_SFA_NAME=SFA
PROJECT_SFA_BASE_URL=http://localhost:4200
PROJECT_SFA_CLIENT_APP_ROOT=C:\Path\To\SFA\Gng.ORM.SFA.UI

PROJECT_SFAGENERAL_NAME=SFAGeneral
PROJECT_SFAGENERAL_BASE_URL=http://localhost:4201
PROJECT_SFAGENERAL_CLIENT_APP_ROOT=C:\Path\To\SFA\Gng.ORM.SFAGeneral.UI
```

اگر چند پروژه را همزمان اجرا می‌کنید، `BASE_URL` هر پروژه باید یکتا باشد. مثلا اگر SFA روی `4200` و SFAGeneral روی `4201` است، TotalSales را روی پورتی مثل `4202` اجرا کنید و همان را در `.env` بنویسید.

هر کلید `.env` باید یکتا باشد. برای instanceهای مختلف TotalSales از prefix جدا مثل `PROJECT_TOTALSALES1181_*` استفاده کنید؛ Native Host حالا کلید تکراری را با خطای واضح رد می‌کند تا پروژه اشتباه انتخاب نشود.

6. اسکریپت ثبت Native Host را اجرا کنید:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\register-native-host.ps1
```

این دستور فایل `native/com.gng.dev_indexer.json` را به صورت خودکار می‌سازد و مسیر آن را در Registry کروم ثبت می‌کند. این فایل را دستی تغییر ندهید و commit نکنید. بعد از تغییر معمولی `.env` معمولا نیازی به اجرای دوباره این دستور نیست، چون Native Host در هر درخواست `.env` را دوباره می‌خواند. فقط وقتی مسیر پوشه افزونه یا Extension ID تغییر کرد، دوباره اجرا کنید.

7. افزونه را در صفحه `chrome://extensions` دوباره `Reload` کنید.

## استفاده

1. صفحه مورد نظر را باز کنید.
2. DevTools را با `F12` باز کنید.
3. تب `GIG Components` را انتخاب کنید.
4. دکمه `Refresh` بالای پنل، کامپوننت‌های رندر شده در صفحه را لود می‌کند. البته این اتفاق بصورت خودکار در زمان لود شدن صفحه و تغییر در صفحه اتفاق می افتد و معمولا نیازی به رفرش دستی نیست.
5. آیکون سبز/قرمز کنار جستجو، کامپوننت ها را اسکن کرده و ایندکس را می‌سازد.
6. با انتخاب هر کامپوننت، اطلاعات اصلی، ویژگی ها و مسیر فایل آن نمایش داده می‌شود.
7. دکمه کد کنار عنوان کامپوننت، فایل `.ts` را در VS Code باز می‌کند.
8. برای پیدا کردن کامپوننت یک المنت، آن را در تب `Elements` انتخاب کنید و در پنل افزونه `Find $0` را بزنید.

فیلتر انتخاب‌شده، وضعیت Highlight و pinها برای هر پروژه در storage خود افزونه نگهداری می‌شوند. selectorهای تکراری دیگر بی‌صدا به یک فایل اشتباه وصل نمی‌شوند: اگر class زمان اجرا کافی باشد فایل درست انتخاب می‌شود و در حالت مبهم همه source candidateها نمایش داده می‌شوند. فایل‌های style و `*-column.service.ts` مرتبط نیز در Overview در دسترس‌اند و به عنوان کامپوننت جعلی داخل tree نشان داده نمی‌شوند.

## Performance

اسکن صفحه فقط hostهای مرتبط با کامپوننت را بررسی می‌کند و اطلاعات سنگین هر node تنها هنگام انتخاب آن خوانده می‌شود. وقتی پنل مخفی است watcher متوقف می‌شود؛ وقتی پنل باز است فقط mutationهای مرتبط یک refresh با فاصله حداقل دو ثانیه ایجاد می‌کنند. بنابراین پنل دیگر با interval کوتاه کل DOM و propertyهای Angular را پیوسته اسکن نمی‌کند.

## فیلتر کامپوننت‌ها

فیلتر `All` همه کامپوننت‌های پیدا شده در صفحه را نشان می‌دهد.

فیلتر `Components` یک نمای source-oriented است: کامپوننت‌های ایندکس‌شده پروژه را همراه containerهای مهمی که محل تعریف آن‌ها در template پروژه قابل تشخیص است نشان می‌دهد. برای کامپوننت‌های پروژه می‌توان فایل `.ts` را مستقیم در VS Code باز کرد.

این فیلتر containerهای مهم فریم‌ورک مثل `gig-modal` و dialog را نیز وقتی داخل یک کامپوننت پروژه باشند نشان می‌دهد. برای این موارد آیکون template، فایل HTML کامپوننت پروژه‌ای که modal را تعریف کرده باز می‌کند. مسیرهای فیلترشده خودکار expand می‌شوند تا یک modal یا فرم داخلی پشت parent بسته پنهان نماند.

فیلتر `GNG` کامپوننت‌های فریم‌ورکی مثل `gng-*`، `gig-*` و `gsm-*` را جدا می‌کند.

عنوان GNG در index ذخیره نمی‌شود. افزونه در زمان scan به صورت best-effort آن را از attributeهای HTML، inputهای runtime کامپوننت و عنوان render شده modal/dialog می‌خواند؛ بنابراین عنوان ترجمه‌شده‌ای که کاربر روی صفحه می‌بیند، در صورت قابل دسترس بودن، کنار selector نمایش داده می‌شود.

## منوی راست کلیک

گزینه `Find Component in GNG DevTools` برای پیدا کردن کامپوننت مربوط به المنتی است که روی آن راست کلیک کرده‌اید.

این گزینه وقتی بهترین نتیجه را می‌دهد که DevTools باز باشد و تب `GIG Components` را انتخاب کرده باشید. اگر کامپوننت در فیلتر فعلی پنهان باشد، افزونه به صورت خودکار فیلتر را روی `All` می‌برد و کامپوننت را انتخاب می‌کند.

کروم به افزونه‌ها اجازه نمی‌دهد DevTools را خودکار باز کنند یا به صورت خودکار به تب افزونه داخل DevTools بروند. بنابراین اگر DevTools بسته باشد، اول آن را دستی باز کنید و بعد تب `GIG Components` را انتخاب کنید.

## وقتی افزونه از Chrome ناپدید می‌شود

Chrome افزونه کند را به عنوان رفتار معمول uninstall نمی‌کند؛ اما profile اشتباه، disable reason، policy سازمانی، جابه‌جایی پوشه unpacked یا خراب شدن registration می‌تواند باعث شود کارت افزونه دیده نشود. برای بررسی read-only اجرا کنید:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\diagnose-install.ps1
```

برای خروجی قابل پردازش:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\diagnose-install.ps1 -Json
```

این doctor چیزی را تغییر نمی‌دهد؛ active Chrome profile، ثبت افزونه، source path، disable reasons، policyهای مرتبط و اتصال Native Host به Extension ID را گزارش می‌کند. اگر پوشه افزونه یا Extension ID تغییر کرده باشد، `register-native-host.ps1` را دوباره اجرا و سپس افزونه را در `chrome://extensions` با `Load unpacked` یا `Reload` ثبت کنید.

## فایل‌های محلی

این فایل‌ها مخصوص سیستم شما هستند و نباید commit شوند:

```text
.env
.index-cache/
component-index.json
native/com.gng.dev_indexer.json
```

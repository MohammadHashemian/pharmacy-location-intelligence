# نگاشت درخواست‌های صفحهٔ «نمایش ظرفیت شهر» — pharmacy.fda.gov.ir

پیمایش کامل صفحهٔ <https://pharmacy.fda.gov.ir/nemayeshZarfiatShahrSearch> و استخراج همهٔ
درخواست‌های شبکه‌ای آن. این سند مرجع پیاده‌سازی `src/fetch_zarfiat.py` و `src/db.py` است.

---

## 1) صفحهٔ میزبان (صفحهٔ گزارش)

| مورد | مقدار |
|---|---|
| URL | `https://pharmacy.fda.gov.ir/nemayeshZarfiatShahrSearch` |
| فریم‌ورک | AngularJS + RequireJS (`/App/main.js` → `/App/app.js`) + Kendo UI Grid |
| کنترلر | `/App/views/main/zarfiatKhali/nemayeshZarfiatShahrSearchController.js` |
| قالب | `/App/views/main/zarfiatKhali/nemayeshZarfiatShahrSearch.html` |

**نکتهٔ مسیریابی:** سرور برای هر مسیر ناموجود، صفحهٔ SPA (۲۲۶۶ بایت) را برمی‌گرداند
(مثلاً `/App/app` یا `/Scripts/...`). تشخیص فایل واقعی از روی حجم/محتوا انجام شد؛ فایل واقعی
اپ `‎/App/app.js` (۷۳۱ کیلوبایت) و کنترلر ۲۳ کیلوبایت است.

## 2) همهٔ درخواست‌های API این صفحه

| # | Endpoint | متد | پارامترها | نقش | وضعیت ما |
|---|---|---|---|---|---|
| 1 | `/app/api/Organization/GetDaneshgahiOrgans` | GET | — | فهرست دانشگاه‌های علوم پزشکی (کمبوی دانشگاه) | ❌ نشد (نیازمند نشست/دسترسی) |
| 2 | `/app/api/Darkhast/GetDateTimeNow` | GET | — | تاریخ/ساعت جاری سامانه | ❌ لازم نیست |
| 3 | `/app/api/Organization` | GET | paging (Kendo) | فهرست سازمان‌ها | ❌ لازم نیست |
| 4 | `/app/api/Organization/GetOstanByOrganizationId` | GET | `organizationId` | استانِ متناظر با دانشگاه | ❌ لازم نیست |
| 5 | `/app/api/DaneshgahMahdoudefaaliat/GetShahrestanbyOrganizationId` | GET | `ParentId` | شهرستان‌های یک دانشگاه (کمبوی زنجیره‌ای) | ❌ لازم نیست |
| 6 | **`/app/api/TaghsimatKeshvari/GetVaziatShowShahrestanAndOStanQueryAsync`** | **GET** | paging + sort + `filter` (Kendo) | **منبع اصلی دادهٔ گرید: یک ردیف برای هر شهر/روستا** | ✅ **استخراج کامل** |
| 7 | `/app/api/TaghsimatKeshvari/GetZarfiatKhaliShahrByShahrID` | GET | `shahrID`, `TedadRouzaneh`, `TedadShabanehRoozi` | پنجرهٔ «مشاهده ظرفیت خالی» یک شهر → آرایهٔ دو عضوی | ⚠️ روی سرور خطا می‌دهد (بند ۴) |

منابع جانبی احراز هویت در `app.js` (بی‌ربط به این گزارش):
`AuthenticateUrl/GetVersion|GetBCSEnabled|GetUrl|SetUrl`، `Cartable/GetCurrentUserRoles`،
`Login/GetAuthenticatedUser|IsUserAuthenticated`، `Shakhs/GetHixData`.

## 3) Endpoint اصلی به‌تفصیل

```
GET /app/api/TaghsimatKeshvari/GetVaziatShowShahrestanAndOStanQueryAsync
    ?take=5000&skip=0&page=1&pageSize=5000
    &sort[0][field]=ShahrID&sort[0][dir]=asc
Header: Accept: application/json, text/plain, */*
        Referer: https://pharmacy.fda.gov.ir/nemayeshZarfiatShahrSearch
```

پاسخ:

```json
{ "resultCode": 0,
  "data": { "count": 62524,
            "records": [ { "OstanID": 20, "ShahrID": 66793, "...": "..." } ] } }
```

یافته‌های تجربی مهم (اندازه‌گیری‌شده روی سرور زنده):

| موضوع | یافته |
|---|---|
| تعداد کل ردیف | **۶۲٫۵۲۴** (`data.count`، در همهٔ درخواست‌ها ثابت) |
| ترتیب پیش‌فرض | **غیرقطعی** — دو درخواست یکسان، ترتیب متفاوت می‌دهد ⇒ صفحه‌بندی با `skip` بدون `sort` داده را تکراری/ناقص می‌کند |
| `sort[0][field]=ShahrID&dir=asc` | **قطعی و پایدار** (دو بار تکرار ⇒ پاسخ یکسان) و `skip` روی آن درست کار می‌کند |
| اندازهٔ صفحه و زمان | `take=200`≈۸٫۵s، `500`≈۱۷s، `1000`≈۲۶s، `5000`≈۸۵s (تقریباً خطی) |
| کارایی | با `sort`، درخواست‌های کوچک سریع‌اند (۲–۴s)؛ بدون `sort`، حتی `take=5` هم کند/نامنظم بود |
| متد | فقط `GET`؛ درخواست `POST` پاسخ `405` می‌دهد |
| نام کنترلر | فقط `TaghsimatKeshvari` معتبر است (`TaghisimatKeshvari`/`TaqsimatKeshvari` → `404`) |

**استراتژی استخراج:** صفحه‌بندی با `take=5000`، `skip = 0, 5000, … 60000` و `sort` صعودی روی
`ShahrID` ⇒ ۱۳ درخواست. هر صفحه در `data/raw/zarfiat_pages/page_<skip>.json` ذخیره می‌شود و
اجرای مجدد از روی فایل‌های موجود ادامه می‌دهد (resumable).

## 4) Endpoint ظرفیت خالی یک شهر (پیاده‌سازی نشد)

`GET /app/api/TaghsimatKeshvari/GetZarfiatKhaliShahrByShahrID?shahrID=…&TedadRouzaneh=…&TedadShabanehRoozi=…`

وقتی پنجرهٔ «مشاهده ظرفیت خالی» باز می‌شود، کنترلر همین را صدا می‌زند و
`data = [ظرفیت خالی روزانه, ظرفیت خالی شبانه‌روزی]` را نمایش می‌دهد.
روی سرور زنده:

* `shahrID=-1` → `{"resultCode":0,"data":{"records":["1","1"]}}`
* هر `shahrID` واقعی (مثلاً ۱۳ تبریز یا ۸) → `resultCode:4` با پیام «بروز خطا در سیستم» و کد خطای
  منحصربه‌فرد ⇒ این سرویس بدون نشست کاربری/دسترسی مرتبط پاسخ نمی‌دهد.

به همین دلیل ظرفیت خالی در اپ از روی جمعیت و تعداد داروخانه **تخمین زده می‌شود**
(با ورودی قابل‌تغییر «نفر برای هر داروخانه») و ستون‌های منتشرشدهٔ `ZarfiatKhali*` نیز
بی‌کم‌وکاست ذخیره و نمایش داده می‌شوند (در گزارش عمومی سراسر صفرند — بند ۵).

## 5) کیفیت داده (بررسی‌شده روی دادهٔ زنده)

1. **دانه‌بندی واقعی = `ShahrID`.** هر شهر/روستا ممکن است چند ردیف داشته باشد (تا ۴ ردیف) که
   فقط در `OrganizationID` تفاوت دارند. تمام سنجه‌ها (`Jamiat`، `CountDaroukhaneh`،
   `EmtiazShahr`، `HadaghaleEmtiaz`، …) برای یک `ShahrID` عیناً یکسان‌اند و فقط
   `OrganizationID` (و `BakhsID`) فرق می‌کند ⇒ در پایگاه‌داده یک ردیف تحلیلی برای هر `ShahrID`
   ساخته می‌شود و نگاشت چند-به-چند شهر↔دانشگاه در جدول جدا نگه داشته می‌شود.
   در صفحهٔ اول ۵۰۰۰ ردیفی: ۴۲۸۳ `ShahrID` یکتا، ۵۶۷ ردیف تکراری.
2. **`Jamiat` متعلق به خودِ شهر/روستا است**، نه شهرستان: برای هر `ShahrID` یکتا، ولی در یک
   `ShahrestanID` مقادیر متفاوت دارد (۳۵۲ شهرستان از ۴۲۹ مورد، بیش از یک مقدار جمعیت).
   (مثال: «شهر تجريش» همان جمعیت تهران بزرگ را ندارد؛ ردیف‌های هم‌نام تهران از یک `ShahrID` می‌آیند.)
3. **`ZarfiatKhaliRozaneh` همیشه `null`** و `ZarfiatKhali*Sum` در همهٔ ۵۰۰۰ ردیف بررسی‌شده
   `0` است ⇒ گزارش عمومی ظرفیت خالی واقعی را افشا نمی‌کند. (`Zarib`, `SumEmtiaz`,
   `ShahrJamiatID`, `ShahrEmtiazID`, `TarikhEjra*` نیز `null` بودند.)
4. **`ZaribHaghighi`/`ZaribHoghoghi`** بیشتر عدد اعشاری‌اند ولی ۱۴۷ ردیف از ۵۰۰۰ رشته دارند
   (مثل `"inf"`) ⇒ در بارگذاری، مقدار رشته‌ای `NULL` می‌شود و ردیف خام دست‌نخورده می‌ماند.
5. **`HadaghaleEmtiaz`** پله‌ای است (۲۰۰۰، ۲۲۰۰، ۲۴۵۰، ۲۶۰۰، ۲۷۰۰) و با بزرگی/اهمیت شهر
   بالا می‌رود ⇒ معیار «سهولت ورود» در امتیازدهی.
6. حداکثر `skip` معتبر = `count − 1` (آزمایش `skip=62519` پنج ردیف آخر را با `ShahrID` تا ۷۰۹۲۷ داد).

## 5-۱) نتایج پس از استخراج کامل (هر ۱۳ صفحه، ۶۲٬۵۲۴ ردیف)

| سنجه | مقدار |
|---|---|
| ردیف خام | ۶۲٬۵۲۴ |
| `ShahrID` یکتا (دانه‌بندی تحلیلی) | **۴۸٬۴۲۳** — ۸٬۲۰۶ شهر + ۴۰٬۲۱۷ روستا |
| شهرستان / استان / بخش / دانشگاه | ۴۳۱ / ۳۱ / ۱٬۰۶۴ / ۵۵ |
| مجموع جمعیت | ۸۸٬۷۸۰٬۶۰۰ نفر |
| مجموع داروخانه (ح/ح‌ق) | ۱۸٬۸۰۱ |
| `ZarfiatKhaliRozanehSum` در سطح کشور | **۰** (ستون‌های ظرفیت خالی منتشر نمی‌شوند) |

### ردیف‌های معیوب که باید کنار گذاشته شوند (یافتهٔ عملیاتی)

| مورد | تعداد | مثال | اقدام |
|---|---|---|---|
| نام جای‌گیر بی‌حرف (`**`، `-`) با جمعیت کامل یک شهر | ۳ (`ShahrID` 69425, 70913, 70926) | `**` در شهرستان سنندج با جمعیت ۹۰۰٬۰۰۰ و ۱ داروخانه | `cities.name_junk=1` + حذف پیش‌فرض |
| جمعیت عیناً مشترک با آبادی دیگر | ۴ | تهران بزرگ / شهر تجريش (۸٬۱۵۴٬۰۵۱) و شهر گلستان/شهر گلستان (۲۵۲٬۷۳۰) | `city_stats.pop_shared_big>=2` + حذف پیش‌فرض |

بدون این دو گارد، صدر جدول «بهترین مکان» را ردیف‌های معیوب اشغال می‌کردند
(تجریش با ۸ میلیون جمعیت و ۱ داروخانه، سپس `**` با ۹۰۰ هزار جمعیت).
هر دو با تیک «کنار گذاشتن ردیف‌های مشکوک» قابل بازگردانی و مشاهده‌اند و در جدول برچسب هشدار می‌گیرند.

## 6) بازتولید

```bash
python src/fetch_zarfiat.py --transport playwright --take 5000   # ~۱۸ دقیقه، قابل توقف/ادامه
python src/load_db.py                                            # ساخت data/pharmacy.sqlite
```

# ركشتي 🛺

تطبيق طلب الركشات في السودان: الراكب بشوف أقرب الركشات، بيقترح سعره، السواقين بيقبلوا أو بيقدموا عروض، وبيتابع الركشة لحدي ما تصل، مع دردشة مباشرة بين الراكب والسواق.

## الستاك
- HTML/CSS/JS (بدون framework) — `www/index.html` + `www/app.js`
- Capacitor 6 (Android)
- Supabase: Auth، Postgres + PostGIS، Realtime، Storage
- Leaflet + OpenStreetMap (خرائط مجانية)
- GitHub Actions لبناء الـ APK

## المزايا
**الراكب:** تسجيل برقم الموبايل · خريطة بأقرب الركشات وزمن وصولها · اختيار الوجهة بالبحث أو بالضغط على الخريطة · سعر مقترح قابل للتعديل · استلام عروض السواقين وقبولها · تتبع لحظي للركشة · دردشة وإرسال موقع · اتصال · مشاركة الرحلة · تقييم · سجل المشاوير.

**السواق:** تسجيل ورفع المستندات · زر متاح/غير متاح · طلبات قريبة لحظياً · قبول أو اقتراح سعر · مراحل المشوار (في الطريق، وصلت، بدأ، انتهى) · الاتجاهات في خرائط جوجل · دخل الأسبوع · الاشتراك الشهري عبر بنكك.

## البناء
كل push على `main` بيبني APK تلقائياً. نزّله من تبويب **Actions ← آخر تشغيل ← Artifacts ← rickshawi-debug-apk**.

محلياً:
```bash
npm install
npx cap add android && node scripts/patch-android.js
npx @capacitor/assets generate --android
npm run build:debug
# android/app/build/outputs/apk/debug/app-debug.apk
```

### نسخة موقعة لجوجل بلاي (AAB)
أضف الـ secrets دي في الريبو (Settings ← Secrets ← Actions)، والـ workflow بيبني `app-release.aab` تلقائياً:
`KEYSTORE_BASE64` (`base64 -w0 release.keystore`)، `KEYSTORE_PASSWORD`، `KEY_ALIAS`، `KEY_PASSWORD`.

## Supabase
- المشروع: `rickshawi` — `https://gybdimrwofnvwpvtoikb.supabase.co`
- الـ migrations في `supabase/migrations/` (اتطبقت على المشروع).
- الإعدادات في `www/config.js`.

### خطوات لازمة مرة واحدة
1. **Authentication ← Providers ← Email**: اقفل **Confirm email** (التسجيل برقم الموبايل بيستعمل إيميل داخلي `249XXXXXXXXX@rickshawi.app`).
2. سجّل حسابك من التطبيق، وبعدها من **Table Editor ← profiles** غيّر `role` لـ `admin`.
3. عدّل جدول **app_settings**: رقم حساب بنكك، الاسم، سعر الاشتراك، الأجرة الأساسية وسعر الكيلو. خلّي `require_subscription = false` في فترة الإطلاق.

### إدارة السواقين (من لوحة Supabase)
- **قبول سواق:** جدول `drivers` ← غيّر `status` لـ `approved` (المستندات في Storage ← `driver-docs/<id>/`).
- **تفعيل اشتراك:** جدول `subscriptions` ← `status = active` و`starts_at = now()` و`ends_at = now() + 30 يوم` (الإيصال في `receipts/`).

## هيكل المشروع
```
www/            واجهة التطبيق (index.html, app.js, config.js)
scripts/        نسخ المكتبات + إعداد صلاحيات أندرويد
assets/         الأيقونة وشاشة البداية
supabase/       migrations قاعدة البيانات
.github/        workflow البناء
```

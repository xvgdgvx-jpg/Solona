# إعداد مراقبة خارجية (UptimeRobot) — إلزامي

## لماذا؟

Render قد يوقف الخدمة بعد فترة من عدم النشاط. لذلك لا يكفي الاعتماد على self-ping داخل الحاوية؛ يجب أن يأتي ping من خدمة خارجية مستقلة تستطيع إيقاظ الخدمة.

## الخطوات

### 1. التسجيل في UptimeRobot

افتح [UptimeRobot](https://uptimerobot.com)، وأنشئ حساباً مجانياً. لا يحتاج الحساب المجاني إلى بطاقة بنكية، ويدعم مراقبة HTTP(s) كل خمس دقائق وفق الخطة الحالية للخدمة.

### 2. إنشاء Monitor جديد

من لوحة التحكم اختر **Add New Monitor**، ثم استخدم القيم التالية:

| الحقل | القيمة |
|---|---|
| Monitor Type | HTTP(s) |
| Friendly Name | Solana Bot |
| URL | `https://solana-bot-v1-2mss.onrender.com/cron-ping` |
| Monitoring Interval | 5 minutes |
| Alert Contacts | البريد الإلكتروني المطلوب للتنبيهات |

إذا تغير عنوان Render، استبدل الرابط بعنوان الخدمة الحالي مع الإبقاء على المسار `/cron-ping`.

### 3. الحفظ

اضغط **Create Monitor**. سيبدأ UptimeRobot بإرسال طلبات خارجية تلقائياً كل خمس دقائق.

## التحقق

بعد نحو عشر دقائق، افتح Render ثم **Logs** وابحث عن السطر التالي:

```text
[cron] External ping received from ...
```

يمكن اختبار endpoint مباشرة بفتح:

```text
https://solana-bot-v1-2mss.onrender.com/cron-ping
```

ويُفترض أن يعيد JSON يتضمن `status: "awake"` ووقت التشغيل ووقت آخر نشاط.

## طبقات keep-alive داخل المشروع

يحتوي المشروع أيضاً على self-ping داخلي كل أربع دقائق إلى ثلاثة مسارات:

- `/ping`
- `/cron-ping`
- `/health`

ويبدأ أول self-ping بعد خمس ثوانٍ من تشغيل الخادم. كما يسجل البوت heartbeat كل 60 ثانية يتضمن uptime واستهلاك الذاكرة.

هذه الطبقات الداخلية احتياطية، ولا تستبدل المراقبة الخارجية؛ فإذا كانت الحاوية متوقفة فلن يستطيع الكود داخلها إيقاظ نفسه.

## بدائل

يمكن استخدام [Cron-job.org](https://cron-job.org)، أو [Freshping](https://freshping.io)، أو [Better Stack](https://betterstack.com) لإرسال طلب HTTP خارجي إلى `/cron-ping` كل خمس دقائق.

# إعداد مراقبة خارجية (UptimeRobot)

## لماذا؟

قد تُعلّق خدمة Render المجانية بعد فترة من عدم النشاط. المراقبة الخارجية ترسل طلبًا مستقلًا إلى الخدمة وتساعد على إبقائها متاحة.

## الإعداد

1. افتح [UptimeRobot](https://uptimerobot.com) وأنشئ HTTP(s) monitor.
2. استخدم الرابط:

```text
https://solana-bot-v1-2mss.onrender.com/cron-ping
```

3. اجعل الفترة خمس دقائق.
4. فعّل التنبيهات التي تريدها.

إذا تغير عنوان Render، استبدل اسم النطاق فقط مع إبقاء المسار `/cron-ping`.

## التحقق

يمكن اختبار endpoint مباشرة:

```text
https://solana-bot-v1-2mss.onrender.com/cron-ping
```

ويُفترض أن يعيد JSON بحالة الخدمة ووقت التشغيل وآخر نشاط. في سجلات Render ابحث عن:

```text
[cron] External ping received from ...
```

## بدائل

يمكن استخدام [Cron-job.org](https://cron-job.org)، أو [Freshping](https://freshping.io)، أو [Better Stack](https://betterstack.com) لإرسال HTTP request إلى `/cron-ping` كل خمس دقائق.

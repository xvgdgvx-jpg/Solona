# Solana DEX Trading Bot

بوت تيليجرام لمراقبة أزواج Solana عبر DexPaprika كل خمس ثوانٍ، ثم تطبيق فحوص اختيارية عبر GoPlus وSolana Tracker قبل التداول التجريبي عبر Jupiter.

## التشغيل

```bash
npm install
npm run check
npm start
```

المتغيرات المطلوبة: `TELEGRAM_BOT_TOKEN` و`HELIUS_RPC_URL` كـ RPC عام اختياري و`ENCRYPTION_KEY` بطول 64 رمزاً سداسياً و`ADMIN_TELEGRAM_ID`. مفاتيح GoPlus وSolana Tracker اختيارية، وعند غياب بيانات الفحص الاختياري تمر العملة ولا تتوقف دورة المراقبة.

التداول الحقيقي متوقف افتراضياً. لا تفعّله قبل اختبار الإعدادات والضوابط ومراجعة مخاطر المعاملات.

## التحقق

يتضمن `npm run check` فحص بناء جميع ملفات JavaScript، ويتحقق من عدم وجود مراجع للنظام القديم أو متغيرات بيئة محذوفة.

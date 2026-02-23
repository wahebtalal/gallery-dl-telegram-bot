# gallery-dl Telegram Bot

بوت تيليجرام لتحميل المحتوى تلقائيًا باستخدام `gallery-dl`.

## الفكرة
- ترسل رابط للبوت
- البوت يشغل `gallery-dl`
- يرسل الملفات الناتجة مباشرة في تيليجرام

## التشغيل المحلي
```bash
cp .env.example .env
# عدّل القيم داخل .env
python bot.py
```

## Dokploy
- Build Type: Dockerfile
- Dockerfile موجود وجاهز
- أضف متغيرات البيئة من `.env.example`

## Commands
- `/start`
- `/help`

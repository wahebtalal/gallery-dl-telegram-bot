import asyncio
import os
import shutil
import subprocess
import uuid
from pathlib import Path

from telegram import Update
from telegram.ext import Application, CommandHandler, ContextTypes, MessageHandler, filters

BOT_TOKEN = os.getenv("BOT_TOKEN", "")
DOWNLOAD_DIR = Path(os.getenv("DOWNLOAD_DIR", "./downloads"))
ALLOWED_USER_ID = int(os.getenv("ALLOWED_USER_ID", "0"))

API_ID = os.getenv("API_ID", "")
API_HASH = os.getenv("API_HASH", "")
STRING_SESSION = os.getenv("STRING_SESSION", "")

DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)


def is_url(text: str) -> bool:
    t = text.strip().lower()
    return t.startswith("http://") or t.startswith("https://")


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "اهلا 👋\nارسل اي رابط مدعوم، والبوت راح ينزله عبر gallery-dl ويرسله لك تلقائيًا."
    )


async def help_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "الاوامر:\n"
        "/start - تشغيل البوت\n"
        "/help - المساعدة\n\n"
        "ارسل رابط مباشر فقط."
    )


async def handle_text(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not update.message or not update.message.text:
        return

    user_id = update.effective_user.id if update.effective_user else 0
    if ALLOWED_USER_ID and user_id != ALLOWED_USER_ID:
        await update.message.reply_text("غير مصرح لك باستخدام هذا البوت.")
        return

    url = update.message.text.strip()
    if not is_url(url):
        await update.message.reply_text("ارسل رابط صحيح يبدأ بـ http أو https")
        return

    await update.message.reply_text("⏳ جاري التحميل عبر gallery-dl...")

    job_dir = DOWNLOAD_DIR / str(uuid.uuid4())
    job_dir.mkdir(parents=True, exist_ok=True)

    cmd = [
        "gallery-dl",
        "-D",
        str(job_dir),
        "--write-metadata",
        "--no-mtime",
        url,
    ]

    env = os.environ.copy()
    if API_ID:
        env["ID"] = API_ID
    if API_HASH:
        env["HASH"] = API_HASH
    if STRING_SESSION:
        env["STRING"] = STRING_SESSION

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        stdout, stderr = await proc.communicate()

        if proc.returncode != 0:
            msg = (stderr.decode("utf-8", "ignore") or stdout.decode("utf-8", "ignore"))[-1200:]
            await update.message.reply_text(f"❌ فشل التحميل:\n{msg}")
            shutil.rmtree(job_dir, ignore_errors=True)
            return

        files = [p for p in job_dir.rglob("*") if p.is_file()]
        files = [p for p in files if not p.name.endswith(".json")]

        if not files:
            await update.message.reply_text("تم التنفيذ لكن ما لقيت ملفات قابلة للإرسال.")
            shutil.rmtree(job_dir, ignore_errors=True)
            return

        sent = 0
        for f in files[:10]:
            size_mb = f.stat().st_size / (1024 * 1024)
            if size_mb > 49:
                await update.message.reply_text(f"⚠️ تخطيت ملف كبير: {f.name} ({size_mb:.1f}MB)")
                continue
            with open(f, "rb") as fp:
                await update.message.reply_document(fp, filename=f.name)
                sent += 1

        await update.message.reply_text(f"✅ تم. ارسلت {sent} ملف/ملفات.")

    except Exception as e:
        await update.message.reply_text(f"❌ خطأ داخلي: {e}")
    finally:
        shutil.rmtree(job_dir, ignore_errors=True)


if __name__ == "__main__":
    if not BOT_TOKEN:
        raise RuntimeError("BOT_TOKEN is required")

    app = Application.builder().token(BOT_TOKEN).build()
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("help", help_cmd))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_text))

    print("Bot started...")
    app.run_polling(drop_pending_updates=True)

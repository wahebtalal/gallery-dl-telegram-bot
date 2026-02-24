import os
import subprocess
import requests
from sqlalchemy.orm import Session
from .celery_app import celery_app
from .config import settings
from .db import SessionLocal
from .models import MediaItem, JobHistory


def _db() -> Session:
    return SessionLocal()


@celery_app.task(name="tasks.download_media")
def download_media(media_item_id: int):
    db = _db()
    try:
        item = db.query(MediaItem).filter(MediaItem.id == media_item_id).first()
        if not item:
            return
        item.status = "downloading"
        db.commit()

        os.makedirs(settings.media_root, exist_ok=True)
        output_template = os.path.join(settings.media_root, "%(title)s_%(id)s.%(ext)s")
        cmd = [settings.gallery_dl_binary, "-o", f"filename={output_template}", item.source_url]

        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            item.status = "failed"
            item.error_message = proc.stderr[:4000]
            db.add(JobHistory(media_item_id=item.id, action="download", status="failed", detail=item.error_message))
            db.commit()
            return

        # naive output parsing fallback
        out = (proc.stdout or "").strip().splitlines()
        guessed_file = None
        for line in reversed(out):
            if os.path.exists(line.strip()):
                guessed_file = line.strip()
                break

        if not guessed_file:
            candidates = sorted(
                [os.path.join(settings.media_root, f) for f in os.listdir(settings.media_root)],
                key=os.path.getmtime,
                reverse=True,
            )
            guessed_file = candidates[0] if candidates else None

        item.local_path = guessed_file
        item.filename = os.path.basename(guessed_file) if guessed_file else None
        item.status = "downloaded" if guessed_file else "failed"
        if not guessed_file:
            item.error_message = "Download finished but file not detected"
        db.add(JobHistory(media_item_id=item.id, action="download", status="ok" if guessed_file else "failed", detail=item.local_path or item.error_message))
        db.commit()
    finally:
        db.close()


@celery_app.task(name="tasks.send_to_telegram")
def send_to_telegram(media_item_id: int):
    db = _db()
    try:
        item = db.query(MediaItem).filter(MediaItem.id == media_item_id).first()
        if not item:
            return
        if not item.local_path or not os.path.exists(item.local_path):
            item.status = "send_failed"
            item.error_message = "File not found"
            db.add(JobHistory(media_item_id=item.id, action="send", status="failed", detail=item.error_message))
            db.commit()
            return

        token = settings.telegram_bot_token
        chat_id = settings.telegram_chat_id
        if not token or not chat_id:
            item.status = "send_failed"
            item.error_message = "Telegram config missing"
            db.add(JobHistory(media_item_id=item.id, action="send", status="failed", detail=item.error_message))
            db.commit()
            return

        url = f"https://api.telegram.org/bot{token}/sendDocument"
        with open(item.local_path, "rb") as f:
            resp = requests.post(url, data={"chat_id": chat_id}, files={"document": f}, timeout=120)

        if resp.ok and resp.json().get("ok"):
            result = resp.json().get("result", {})
            item.status = "sent"
            item.telegram_message_id = str(result.get("message_id"))
            item.error_message = None
            db.add(JobHistory(media_item_id=item.id, action="send", status="ok", detail=item.telegram_message_id))
        else:
            item.status = "send_failed"
            item.error_message = resp.text[:4000]
            db.add(JobHistory(media_item_id=item.id, action="send", status="failed", detail=item.error_message))
        db.commit()
    finally:
        db.close()

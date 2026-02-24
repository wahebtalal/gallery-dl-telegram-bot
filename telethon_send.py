import os
import sys
import json
import asyncio
import subprocess
from telethon import TelegramClient
from telethon.sessions import StringSession
from telethon.tl.types import DocumentAttributeVideo

API_ID = int(os.environ.get('API_ID', '0'))
API_HASH = os.environ.get('API_HASH', '')
STRING_SESSION = os.environ.get('STRING_SESSION', '')


def ffprobe_meta(file_path: str):
    try:
        p = subprocess.run([
            'ffprobe', '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=width,height:format=duration',
            '-of', 'json', file_path
        ], capture_output=True, text=True, check=False)
        if p.returncode != 0:
            return {}
        j = json.loads(p.stdout or '{}')
        s = (j.get('streams') or [{}])[0]
        d = int(round(float((j.get('format') or {}).get('duration', 0) or 0)))
        return {
            'width': int(s.get('width') or 720),
            'height': int(s.get('height') or 1280),
            'duration': d if d > 0 else 1,
        }
    except Exception:
        return {'width': 720, 'height': 1280, 'duration': 1}


async def main():
    if len(sys.argv) < 4:
        print('usage: telethon_send.py <chat_id> <file_path> <caption> [duration] [thumb]')
        return 2

    chat_id = int(sys.argv[1])
    file_path = sys.argv[2]
    caption = sys.argv[3]
    duration_arg = int(sys.argv[4]) if len(sys.argv) > 4 and sys.argv[4].isdigit() else None
    thumb = sys.argv[5] if len(sys.argv) > 5 and sys.argv[5] and os.path.exists(sys.argv[5]) else None

    if not API_ID or not API_HASH or not STRING_SESSION:
        print('missing API_ID/API_HASH/STRING_SESSION')
        return 3

    meta = ffprobe_meta(file_path)
    duration = duration_arg or meta.get('duration') or 1
    width = meta.get('width') or 720
    height = meta.get('height') or 1280

    async with TelegramClient(StringSession(STRING_SESSION), API_ID, API_HASH) as client:
        attrs = [DocumentAttributeVideo(duration=duration, w=width, h=height, supports_streaming=True)]
        await client.send_file(
            chat_id,
            file=file_path,
            caption=caption,
            force_document=False,
            supports_streaming=True,
            thumb=thumb,
            mime_type='video/mp4',
            attributes=attrs,
        )
    return 0


if __name__ == '__main__':
    raise SystemExit(asyncio.run(main()))

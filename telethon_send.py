import os
import sys
import asyncio
from telethon import TelegramClient
from telethon.sessions import StringSession
from telethon.tl.types import DocumentAttributeVideo

API_ID = int(os.environ.get('API_ID', '0'))
API_HASH = os.environ.get('API_HASH', '')
STRING_SESSION = os.environ.get('STRING_SESSION', '')

async def main():
    if len(sys.argv) < 4:
        print('usage: telethon_send.py <chat_id> <file_path> <caption> [duration] [thumb]')
        return 2

    chat_id = int(sys.argv[1])
    file_path = sys.argv[2]
    caption = sys.argv[3]
    duration = int(sys.argv[4]) if len(sys.argv) > 4 and sys.argv[4].isdigit() else None
    thumb = sys.argv[5] if len(sys.argv) > 5 and sys.argv[5] else None

    if not API_ID or not API_HASH or not STRING_SESSION:
        print('missing API_ID/API_HASH/STRING_SESSION')
        return 3

    async with TelegramClient(StringSession(STRING_SESSION), API_ID, API_HASH) as client:
        attrs = []
        if duration:
            attrs = [DocumentAttributeVideo(duration=duration, w=720, h=1280, supports_streaming=True)]

        await client.send_file(
            chat_id,
            file=file_path,
            caption=caption,
            force_document=False,
            supports_streaming=True,
            thumb=thumb,
            attributes=attrs if attrs else None,
        )
    return 0

if __name__ == '__main__':
    raise SystemExit(asyncio.run(main()))

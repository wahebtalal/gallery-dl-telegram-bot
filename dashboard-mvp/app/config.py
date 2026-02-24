import os
from dataclasses import dataclass
from dotenv import load_dotenv

load_dotenv()


@dataclass
class Settings:
    app_name: str = os.getenv("APP_NAME", "Telegram Media Dashboard MVP")
    secret_key: str = os.getenv("SECRET_KEY", "change-me")
    admin_username: str = os.getenv("ADMIN_USERNAME", "admin")
    admin_password_hash: str = os.getenv("ADMIN_PASSWORD_HASH", "")
    language_default: str = os.getenv("LANGUAGE_DEFAULT", "en")

    database_url: str = os.getenv(
        "DATABASE_URL", "postgresql+psycopg2://postgres:postgres@db:5432/media_dashboard"
    )
    redis_url: str = os.getenv("REDIS_URL", "redis://redis:6379/0")

    media_root: str = os.getenv("MEDIA_ROOT", "/data/media")
    gallery_dl_binary: str = os.getenv("GALLERY_DL_BINARY", "gallery-dl")

    telegram_bot_token: str = os.getenv("TELEGRAM_BOT_TOKEN", "")
    telegram_chat_id: str = os.getenv("TELEGRAM_CHAT_ID", "")


settings = Settings()

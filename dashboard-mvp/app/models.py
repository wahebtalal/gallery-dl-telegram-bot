from datetime import datetime
from sqlalchemy import Column, Integer, String, DateTime, Boolean, Text
from .db import Base


class MediaItem(Base):
    __tablename__ = "media_items"

    id = Column(Integer, primary_key=True, index=True)
    source_url = Column(Text, nullable=False)
    local_path = Column(Text, nullable=True)
    filename = Column(String(512), nullable=True)
    status = Column(String(50), nullable=False, default="queued")  # queued/downloading/downloaded/failed/sent/send_failed
    selected = Column(Boolean, default=False)
    error_message = Column(Text, nullable=True)
    telegram_message_id = Column(String(100), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class JobHistory(Base):
    __tablename__ = "job_history"

    id = Column(Integer, primary_key=True, index=True)
    media_item_id = Column(Integer, nullable=True)
    action = Column(String(64), nullable=False)  # download/send/retry
    status = Column(String(32), nullable=False)  # ok/failed
    detail = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

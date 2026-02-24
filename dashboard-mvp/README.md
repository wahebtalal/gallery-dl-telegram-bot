# Telegram Media Dashboard MVP

FastAPI + Celery + Redis + PostgreSQL dashboard to queue media downloads (via `gallery-dl`) and send selected files to Telegram.

## Features
- Username/password auth (single admin)
- URL submission page/endpoint
- Async media download task with Celery
- Media listing with pagination + status filter + URL search
- Select/deselect single + bulk select/deselect (filtered set)
- Send selected downloaded items to Telegram bot chat
- History/status page
- Retry failed sends
- Basic i18n toggle EN/AR
- MVP DB init using SQLAlchemy `create_all` on startup (no Alembic)

## Project Structure
```
app/
  main.py
  tasks.py
  models.py
  templates/
  static/
docker-compose.yml
Dockerfile
.env.example
```

## Quick Start (Docker)
1. Copy env:
   ```bash
   cp .env.example .env
   ```
2. Set values in `.env`:
   - `SECRET_KEY`
   - `ADMIN_PASSWORD_HASH`
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
3. Build and run:
   ```bash
   docker compose up --build
   ```
4. Open: `http://localhost:8000`

## Local Run (without Docker)
Requirements: Python 3.11+, PostgreSQL, Redis, `gallery-dl` installed.

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt gallery-dl
cp .env.example .env
uvicorn app.main:app --reload
```
In second terminal:
```bash
celery -A app.celery_app.celery_app worker --loglevel=info
```

## Security Notes (MVP)
- Uses session cookie auth and one admin account from env.
- Use strong `SECRET_KEY` and bcrypt password hash.
- Deploy behind HTTPS reverse proxy in production.
- Consider CSRF protection + RBAC + per-user auth in non-MVP versions.

## Telegram Bot Setup
- Create bot via BotFather
- Add bot to target chat/channel
- Use bot token in `TELEGRAM_BOT_TOKEN`
- Use target chat id in `TELEGRAM_CHAT_ID`

## Endpoints (high-level)
- `GET/POST /login`
- `GET /dashboard`
- `POST /submit`
- `POST /item/{id}/toggle`
- `POST /bulk/select`
- `POST /bulk/deselect`
- `POST /send-selected`
- `GET /history`
- `POST /retry-failed-sends`

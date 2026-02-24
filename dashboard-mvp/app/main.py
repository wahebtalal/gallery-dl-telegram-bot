from math import ceil
from fastapi import FastAPI, Request, Depends, Form
from fastapi.responses import RedirectResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.middleware.sessions import SessionMiddleware
from sqlalchemy.orm import Session

from .db import Base, engine, get_db
from .models import MediaItem, JobHistory
from .auth import authenticate, require_auth
from .celery_app import celery_app
from .tasks import download_media, send_to_telegram
from .config import settings
from .i18n import t

app = FastAPI(title=settings.app_name)
app.add_middleware(SessionMiddleware, secret_key=settings.secret_key)
app.mount("/static", StaticFiles(directory="app/static"), name="static")
templates = Jinja2Templates(directory="app/templates")


@app.on_event("startup")
def startup():
    Base.metadata.create_all(bind=engine)


@app.get("/")
def root(request: Request):
    if request.session.get("user"):
        return RedirectResponse(url="/dashboard", status_code=302)
    return RedirectResponse(url="/login", status_code=302)


@app.get("/login", response_class=HTMLResponse)
def login_page(request: Request):
    lang = request.session.get("lang", settings.language_default)
    return templates.TemplateResponse("login.html", {"request": request, "error": None, "lang": lang, "t": t})


@app.post("/login", response_class=HTMLResponse)
def login(request: Request, username: str = Form(...), password: str = Form(...)):
    lang = request.session.get("lang", settings.language_default)
    if authenticate(username, password):
        request.session["user"] = username
        return RedirectResponse(url="/dashboard", status_code=302)
    return templates.TemplateResponse("login.html", {"request": request, "error": "Invalid credentials", "lang": lang, "t": t})


@app.get("/logout")
def logout(request: Request):
    request.session.clear()
    return RedirectResponse(url="/login", status_code=302)


@app.get("/lang/{lang}")
def set_lang(request: Request, lang: str):
    request.session["lang"] = "ar" if lang == "ar" else "en"
    return RedirectResponse(url=request.headers.get("referer", "/dashboard"), status_code=302)


@app.get("/dashboard", response_class=HTMLResponse)
def dashboard(
    request: Request,
    page: int = 1,
    status: str = "all",
    q: str = "",
    db: Session = Depends(get_db),
):
    require_auth(request)
    lang = request.session.get("lang", settings.language_default)

    page_size = 10
    query = db.query(MediaItem)
    if status != "all":
        query = query.filter(MediaItem.status == status)
    if q:
        query = query.filter(MediaItem.source_url.ilike(f"%{q}%"))

    total = query.count()
    pages = max(1, ceil(total / page_size))
    items = (
        query.order_by(MediaItem.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )

    return templates.TemplateResponse(
        "dashboard.html",
        {
            "request": request,
            "items": items,
            "page": page,
            "pages": pages,
            "status": status,
            "q": q,
            "lang": lang,
            "t": t,
        },
    )


@app.post("/submit")
def submit_url(request: Request, source_url: str = Form(...), db: Session = Depends(get_db)):
    require_auth(request)
    item = MediaItem(source_url=source_url, status="queued")
    db.add(item)
    db.commit()
    db.refresh(item)
    download_media.delay(item.id)
    return RedirectResponse(url="/dashboard", status_code=302)


@app.post("/item/{item_id}/toggle")
def toggle_item(request: Request, item_id: int, db: Session = Depends(get_db)):
    require_auth(request)
    item = db.query(MediaItem).filter(MediaItem.id == item_id).first()
    if item:
        item.selected = not item.selected
        db.commit()
    return RedirectResponse(url=request.headers.get("referer", "/dashboard"), status_code=302)


@app.post("/bulk/select")
def bulk_select(request: Request, status: str = Form("all"), q: str = Form(""), db: Session = Depends(get_db)):
    require_auth(request)
    query = db.query(MediaItem)
    if status != "all":
        query = query.filter(MediaItem.status == status)
    if q:
        query = query.filter(MediaItem.source_url.ilike(f"%{q}%"))
    query.update({MediaItem.selected: True}, synchronize_session=False)
    db.commit()
    return RedirectResponse(url=request.headers.get("referer", "/dashboard"), status_code=302)


@app.post("/bulk/deselect")
def bulk_deselect(request: Request, status: str = Form("all"), q: str = Form(""), db: Session = Depends(get_db)):
    require_auth(request)
    query = db.query(MediaItem)
    if status != "all":
        query = query.filter(MediaItem.status == status)
    if q:
        query = query.filter(MediaItem.source_url.ilike(f"%{q}%"))
    query.update({MediaItem.selected: False}, synchronize_session=False)
    db.commit()
    return RedirectResponse(url=request.headers.get("referer", "/dashboard"), status_code=302)


@app.post("/send-selected")
def send_selected(request: Request, db: Session = Depends(get_db)):
    require_auth(request)
    items = db.query(MediaItem).filter(MediaItem.selected.is_(True), MediaItem.status.in_(["downloaded", "send_failed"])).all()
    for item in items:
        send_to_telegram.delay(item.id)
    return RedirectResponse(url="/history", status_code=302)


@app.get("/history", response_class=HTMLResponse)
def history(request: Request, page: int = 1, db: Session = Depends(get_db)):
    require_auth(request)
    lang = request.session.get("lang", settings.language_default)
    page_size = 20
    total = db.query(JobHistory).count()
    pages = max(1, ceil(total / page_size))
    rows = (
        db.query(JobHistory)
        .order_by(JobHistory.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    return templates.TemplateResponse("history.html", {"request": request, "rows": rows, "page": page, "pages": pages, "lang": lang, "t": t})


@app.post("/retry-failed-sends")
def retry_failed_sends(request: Request, db: Session = Depends(get_db)):
    require_auth(request)
    items = db.query(MediaItem).filter(MediaItem.status == "send_failed").all()
    for item in items:
        db.add(JobHistory(media_item_id=item.id, action="retry", status="ok", detail="Retry queued"))
        send_to_telegram.delay(item.id)
    db.commit()
    return RedirectResponse(url="/history", status_code=302)


@app.get("/health")
def health():
    return {"ok": True, "celery": str(celery_app.main)}

from passlib.context import CryptContext
from fastapi import Request, HTTPException
from .config import settings

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def verify_password(plain_password: str, hashed_password: str) -> bool:
    return pwd_context.verify(plain_password, hashed_password)


def get_password_hash(password: str) -> str:
    return pwd_context.hash(password)


def authenticate(username: str, password: str) -> bool:
    if username != settings.admin_username:
        return False
    if not settings.admin_password_hash:
        return False
    return verify_password(password, settings.admin_password_hash)


def require_auth(request: Request):
    if request.session.get("user") != settings.admin_username:
        raise HTTPException(status_code=401, detail="Unauthorized")

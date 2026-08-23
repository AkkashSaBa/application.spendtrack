from fastapi import FastAPI, APIRouter, Depends, HTTPException, status
from fastapi.responses import PlainTextResponse
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo import ReturnDocument
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
import bcrypt
import jwt
import os
import re
import secrets
import ipaddress
import logging
import httpx
from html import escape
from html.parser import HTMLParser
from urllib.parse import urlparse
from pathlib import Path
from pydantic import BaseModel, EmailStr, Field, field_validator
from typing import Any, List, Literal, Optional
import uuid
from datetime import datetime, timezone, timedelta


ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

# MongoDB connection
mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]
JWT_SECRET = os.environ['JWT_SECRET']
JWT_ALGORITHM = "HS256"
TOKEN_MINUTES = 60 * 24 * 7
RESET_TOKEN_MINUTES = 30
bearer = HTTPBearer(auto_error=False)

# Email (Emergent-managed Resend) constants
EMAIL_BASE_URL = "https://integrations.emergentagent.com"
EMAIL_KEY = os.environ["EMERGENT_EMAIL_KEY"]
EMAIL_FROM_NAME = os.environ["EMAIL_FROM_NAME"]
APP_URL = os.environ.get("APP_URL", "").rstrip("/")

USERNAME_PATTERN = re.compile(r"^[a-zA-Z0-9_.]{3,30}$")

logger = logging.getLogger(__name__)


def normalize_username(value: str) -> str:
    cleaned = value.strip().lower()
    if not USERNAME_PATTERN.match(cleaned):
        raise ValueError("Username must be 3-30 characters (letters, numbers, dot, underscore).")
    return cleaned


# Create the main app without a prefix
app = FastAPI()

# Create a router with the /api prefix
api_router = APIRouter(prefix="/api")


# Define Models
class StatusCheck(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    client_name: str
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

class StatusCheckCreate(BaseModel):
    client_name: str


class SignupInput(BaseModel):
    username: str = Field(min_length=3, max_length=30)
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: EmailStr) -> str:
        return str(value).strip().lower()

    @field_validator("username")
    @classmethod
    def validate_username(cls, value: str) -> str:
        return normalize_username(value)


class LoginInput(BaseModel):
    username: str = Field(min_length=3, max_length=30)
    password: str = Field(min_length=1, max_length=128)

    @field_validator("username")
    @classmethod
    def lower_username(cls, value: str) -> str:
        return value.strip().lower()


class ForgotPasswordInput(BaseModel):
    email: EmailStr

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: EmailStr) -> str:
        return str(value).strip().lower()


class ResetPasswordInput(BaseModel):
    token: str = Field(min_length=10, max_length=200)
    new_password: str = Field(min_length=8, max_length=128)


class ChangePasswordInput(BaseModel):
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=8, max_length=128)


class UserResponse(BaseModel):
    id: str
    username: str
    email: EmailStr


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int


class TransactionCreate(BaseModel):
    type: Literal["expense", "income", "savings"]
    amount: float = Field(gt=0)
    category: str = Field(min_length=1, max_length=40)
    note: Optional[str] = Field(default="", max_length=120)
    date: str = Field(min_length=10, max_length=10)
    goal_id: Optional[str] = Field(default=None, max_length=64)

    @field_validator("date")
    @classmethod
    def validate_date(cls, value: str) -> str:
        try:
            datetime.strptime(value, "%Y-%m-%d")
        except ValueError as exc:
            raise ValueError("date must be a valid YYYY-MM-DD date") from exc
        return value


class Transaction(TransactionCreate):
    id: str
    created_at: str


class BudgetUpsert(BaseModel):
    category: str = Field(min_length=1, max_length=40)
    monthly_limit: float = Field(gt=0)


class Budget(BaseModel):
    id: str
    category: str
    monthly_limit: float
    updated_at: str


class SavingsGoalCreate(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    target: float = Field(gt=0)
    target_date: Optional[str] = Field(default=None)

    @field_validator("target_date")
    @classmethod
    def validate_target_date(cls, value: Optional[str]) -> Optional[str]:
        if value in (None, ""):
            return None
        try:
            datetime.strptime(value, "%Y-%m-%d")
        except ValueError as exc:
            raise ValueError("target_date must be a valid YYYY-MM-DD date") from exc
        return value


class SavingsGoalUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=40)
    target: Optional[float] = Field(default=None, gt=0)
    target_date: Optional[str] = Field(default=None)
    celebrated: Optional[bool] = None

    @field_validator("target_date")
    @classmethod
    def validate_target_date(cls, value: Optional[str]) -> Optional[str]:
        if value in (None, ""):
            return value
        try:
            datetime.strptime(value, "%Y-%m-%d")
        except ValueError as exc:
            raise ValueError("target_date must be a valid YYYY-MM-DD date") from exc
        return value


class SavingsGoal(BaseModel):
    id: str
    name: str
    target: float
    target_date: Optional[str] = None
    celebrated: bool = False
    created_at: str
    updated_at: str


def create_token(user_id: str) -> str:
    now = datetime.now(timezone.utc)
    return jwt.encode(
        {"sub": user_id, "jti": str(uuid.uuid4()), "iat": now, "exp": now + timedelta(minutes=TOKEN_MINUTES)},
        JWT_SECRET,
        algorithm=JWT_ALGORITHM,
    )


def _to_user_response(doc: dict[str, Any]) -> UserResponse:
    return UserResponse(id=doc["id"], username=doc.get("username") or doc["email"].split("@", 1)[0], email=doc["email"])


async def _ensure_username(doc: dict[str, Any]) -> dict[str, Any]:
    """Migrate legacy users (email-only) by deriving a username from the email local-part."""
    if doc.get("username"):
        return doc
    base = re.sub(r"[^a-z0-9_.]", "", doc["email"].split("@", 1)[0].lower())[:30] or "user"
    if len(base) < 3:
        base = (base + "user")[:30]
    candidate = base
    suffix = 0
    while await db.users.find_one({"username": candidate}, {"_id": 0}):
        suffix += 1
        candidate = f"{base}{suffix}"[:30]
    await db.users.update_one({"id": doc["id"]}, {"$set": {"username": candidate}})
    doc["username"] = candidate
    return doc


async def current_user(credentials: HTTPAuthorizationCredentials | None = Depends(bearer)) -> dict[str, Any]:
    if not credentials or credentials.scheme.lower() != "bearer":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    try:
        payload = jwt.decode(credentials.credentials, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        user_id = payload.get("sub")
        if not user_id:
            raise ValueError("missing user")
    except (jwt.InvalidTokenError, ValueError):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired token")
    user = await db.users.find_one({"id": user_id}, {"_id": 0, "id": 1, "username": 1, "email": 1})
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User no longer exists")
    if await db.revoked_tokens.find_one({"token": credentials.credentials}, {"_id": 0}):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Session ended")
    await _ensure_username(user)
    return user


# ---------- Email guardrail gate (from playbook — do NOT weaken) ----------
_SHORTENERS = ("bit.ly", "tinyurl.com", "t.co", "is.gd", "cutt.ly", "goo.gl", "rebrand.ly")
_CRED_ASK = ("reply with your password", "reply with the code", "send your password", "cvv",
             "send us your password", "enter your password below", "confirm your card number",
             "your full card number", "seed phrase", "recovery phrase", "verify your card",
             "social security number", "confirm your bank details")
_HOSTISH = re.compile(r"\b(?:https?://)?((?:[a-z0-9-]+\.)+[a-z]{2,})", re.I)


def _host_ok(host: str) -> bool:
    if not host or "xn--" in host:
        return False
    try:
        ipaddress.ip_address(host)
        return False
    except ValueError:
        pass
    return not any(host == s or host.endswith("." + s) for s in _SHORTENERS)


def _same_site(shown: str, real: str) -> bool:
    return shown == real or real.endswith("." + shown) or shown.endswith("." + real)


class _EmailScan(HTMLParser):
    def __init__(self):
        super().__init__()
        self.tags, self.urls, self.anchors = set(), [], []
        self._href, self._text = None, []

    def handle_starttag(self, tag, attrs):
        self.tags.add(tag.lower())
        self.urls += [v for k, v in attrs if k.lower() in ("href", "src") and v]
        if tag.lower() == "a":
            self._href = dict((k.lower(), v) for k, v in attrs).get("href")
            self._text = []

    def handle_data(self, data):
        if self._href is not None:
            self._text.append(data)

    def handle_endtag(self, tag):
        if tag.lower() == "a" and self._href is not None:
            self.anchors.append((self._href, "".join(self._text)))
            self._href, self._text = None, []


def _assert_safe_email(subject: str, html: str) -> None:
    scan = _EmailScan(); scan.feed(html)
    if scan.tags & {"form", "input", "textarea", "select"}:
        raise ValueError("No forms or input fields in email (G2)")
    body = f"{subject}\n{html}".lower()
    for p in _CRED_ASK:
        if p in body:
            raise ValueError(f"Email asks the recipient for credentials: {p!r} (G2)")
    for url in scan.urls:
        low = url.strip().lower()
        if low.startswith(("mailto:", "tel:", "cid:", "#")):
            continue
        if not low.startswith("https://"):
            raise ValueError(f"Email links/assets must be absolute https: {url!r} (G3)")
        host = urlparse(low).hostname or ""
        if not _host_ok(host) or urlparse(low).username is not None:
            raise ValueError(f"Shortened, numeric-host or credential-bearing URL: {url!r} (G3)")
    for href, text in scan.anchors:
        real = urlparse(href.strip().lower()).hostname or ""
        if not real:
            continue
        for m in _HOSTISH.finditer(text):
            if not _same_site(m.group(1).lower(), real):
                raise ValueError(f"Anchor text {m.group(1)!r} ≠ real link host {real!r} (G3)")


async def send_email(*, to: str, subject: str, html: str) -> str | None:
    _assert_safe_email(subject, html)
    payload = {"to": [to], "subject": subject, "html": html, "from_name": EMAIL_FROM_NAME}
    try:
        async with httpx.AsyncClient(timeout=30) as http_client:
            resp = await http_client.post(
                f"{EMAIL_BASE_URL}/api/v1/email/send",
                headers={"X-Email-Key": EMAIL_KEY},
                json=payload,
            )
        resp.raise_for_status()
        return resp.json().get("id")
    except httpx.HTTPStatusError as e:
        logger.error(f"Email send failed: {e.response.status_code} {e.response.text}")
        raise HTTPException(status_code=502, detail="Failed to send email")
    except Exception as e:
        logger.error(f"Email send error: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to send email")


# Add your routes to the router instead of directly to app
@api_router.get("/")
async def root():
    return {"message": "Hello World"}


@api_router.post("/auth/signup", response_model=UserResponse, status_code=201)
async def signup(input: SignupInput):
    email = str(input.email)
    if await db.users.find_one({"email": email}, {"_id": 0}):
        raise HTTPException(status_code=409, detail="Email already registered")
    if await db.users.find_one({"username": input.username}, {"_id": 0}):
        raise HTTPException(status_code=409, detail="Username already taken")
    user = {
        "id": str(uuid.uuid4()),
        "username": input.username,
        "email": email,
        "password_hash": bcrypt.hashpw(input.password.encode(), bcrypt.gensalt()).decode(),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.users.insert_one(user)
    return _to_user_response(user)


@api_router.post("/auth/login", response_model=TokenResponse)
async def login(input: LoginInput):
    user = await db.users.find_one({"username": input.username}, {"_id": 0})
    valid = user and bcrypt.checkpw(input.password.encode(), user["password_hash"].encode())
    if not valid:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Incorrect username or password")
    return TokenResponse(access_token=create_token(user["id"]), expires_in=TOKEN_MINUTES * 60)


@api_router.get("/me", response_model=UserResponse)
async def me(user: dict[str, Any] = Depends(current_user)):
    return _to_user_response(user)


@api_router.post("/auth/logout")
async def logout(credentials: HTTPAuthorizationCredentials | None = Depends(bearer), user: dict[str, Any] = Depends(current_user)):
    if credentials:
        try:
            payload = jwt.decode(credentials.credentials, JWT_SECRET, algorithms=[JWT_ALGORITHM], options={"verify_exp": False})
            await db.revoked_tokens.update_one({"token": credentials.credentials}, {"$set": {"token": credentials.credentials, "expires_at": datetime.fromtimestamp(payload["exp"], tz=timezone.utc)}}, upsert=True)
        except (jwt.InvalidTokenError, KeyError):
            pass
    return {"ok": True, "user_id": user["id"]}


@api_router.post("/auth/forgot-password")
async def forgot_password(input: ForgotPasswordInput):
    """Always returns success (do not leak whether an email exists)."""
    email = str(input.email)
    user = await db.users.find_one({"email": email}, {"_id": 0})
    if user:
        raw = secrets.token_urlsafe(32)
        token_hash = bcrypt.hashpw(raw.encode(), bcrypt.gensalt()).decode()
        expires_at = datetime.now(timezone.utc) + timedelta(minutes=RESET_TOKEN_MINUTES)
        # invalidate any existing tokens for the user
        await db.password_resets.delete_many({"user_id": user["id"]})
        await db.password_resets.insert_one({
            "id": str(uuid.uuid4()),
            "user_id": user["id"],
            "token_hash": token_hash,
            "expires_at": expires_at,
            "used": False,
            "created_at": datetime.now(timezone.utc),
        })
        subject = f"Reset your {EMAIL_FROM_NAME} password"
        # Show token so user can copy-paste into the app (mobile deep link not available in preview)
        html = (
            f'<table role="presentation" width="100%"><tr><td style="padding:24px;font-family:Arial,sans-serif;color:#1C1C1E">'
            f'<h2 style="margin:0 0 12px">Reset your {escape(EMAIL_FROM_NAME)} password</h2>'
            f'<p>Hi {escape(user.get("username") or email.split("@",1)[0])},</p>'
            f'<p>Use the code below in the {escape(EMAIL_FROM_NAME)} app to set a new password. This code expires in {RESET_TOKEN_MINUTES} minutes and can be used once.</p>'
            f'<p style="font-size:18px;font-weight:700;letter-spacing:1px;background:#F3F3F0;padding:14px 18px;border-radius:8px;display:inline-block;font-family:monospace">{escape(raw)}</p>'
            f'<p style="font-size:12px;color:#888;margin-top:24px">If you did not request this, ignore this email. Sent by {escape(EMAIL_FROM_NAME)}. We will never ask for your password by email.</p>'
            f'</td></tr></table>'
        )
        try:
            await send_email(to=email, subject=subject, html=html)
        except HTTPException:
            logger.warning("Password reset email failed to send for %s", email)
    return {"ok": True, "message": "If an account exists for that email, a reset code was sent."}


@api_router.post("/auth/reset-password", response_model=TokenResponse)
async def reset_password(input: ResetPasswordInput):
    # Iterate active tokens because tokens are hashed at rest.
    now = datetime.now(timezone.utc)
    candidates = await db.password_resets.find(
        {"used": False, "expires_at": {"$gt": now}}, {"_id": 0}
    ).to_list(200)
    matched = None
    for doc in candidates:
        if bcrypt.checkpw(input.token.encode(), doc["token_hash"].encode()):
            matched = doc
            break
    if not matched:
        raise HTTPException(status_code=400, detail="Reset code is invalid or has expired")
    user = await db.users.find_one({"id": matched["user_id"]}, {"_id": 0})
    if not user:
        raise HTTPException(status_code=400, detail="Reset code is invalid or has expired")
    new_hash = bcrypt.hashpw(input.new_password.encode(), bcrypt.gensalt()).decode()
    await db.users.update_one({"id": user["id"]}, {"$set": {"password_hash": new_hash}})
    await db.password_resets.update_one({"id": matched["id"]}, {"$set": {"used": True, "used_at": now}})
    # Auto-sign in after reset
    return TokenResponse(access_token=create_token(user["id"]), expires_in=TOKEN_MINUTES * 60)


@api_router.post("/auth/change-password")
async def change_password(input: ChangePasswordInput, user: dict[str, Any] = Depends(current_user)):
    if input.current_password == input.new_password:
        raise HTTPException(status_code=400, detail="New password must be different from the current one")
    stored = await db.users.find_one({"id": user["id"]}, {"_id": 0, "password_hash": 1})
    if not stored or not bcrypt.checkpw(input.current_password.encode(), stored["password_hash"].encode()):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Current password is incorrect")
    new_hash = bcrypt.hashpw(input.new_password.encode(), bcrypt.gensalt()).decode()
    await db.users.update_one({"id": user["id"]}, {"$set": {"password_hash": new_hash}})
    return {"ok": True}


@api_router.post("/status", response_model=StatusCheck)
async def create_status_check(input: StatusCheckCreate):
    status_dict = input.dict()
    status_obj = StatusCheck(**status_dict)
    _ = await db.status_checks.insert_one(status_obj.dict())
    return status_obj

@api_router.get("/status", response_model=List[StatusCheck])
async def get_status_checks():
    status_checks = await db.status_checks.find({}, {"_id": 0}).to_list(1000)
    return [StatusCheck(**status_check) for status_check in status_checks]


@api_router.get("/transactions", response_model=List[Transaction])
async def get_transactions(user: dict[str, Any] = Depends(current_user)):
    docs = await db.transactions.find({"owner_id": user["id"]}, {"_id": 0, "owner_id": 0}).sort("date", -1).to_list(2000)
    return [Transaction(**doc) for doc in docs]


@api_router.get("/transactions/export", response_class=PlainTextResponse)
async def export_transactions(month: Optional[str] = None, user: dict[str, Any] = Depends(current_user)):
    query: dict[str, Any] = {"owner_id": user["id"]}
    if month:
        if not re.match(r"^\d{4}-\d{2}$", month):
            raise HTTPException(status_code=400, detail="month must be YYYY-MM")
        query["date"] = {"$regex": f"^{month}"}
    docs = await db.transactions.find(query, {"_id": 0, "owner_id": 0}).sort("date", -1).to_list(5000)
    lines = ["date,type,category,amount,note"]
    for d in docs:
        note = (d.get("note") or "").replace('"', '""')
        lines.append(f'{d["date"]},{d["type"]},{d["category"]},{d["amount"]},"{note}"')
    csv = "\n".join(lines) + "\n"
    return PlainTextResponse(content=csv, media_type="text/csv", headers={"Content-Disposition": f'attachment; filename="spendpulse-{month or "all"}.csv"'})


@api_router.post("/transactions", response_model=Transaction)
async def create_transaction(input: TransactionCreate, user: dict[str, Any] = Depends(current_user)):
    transaction = Transaction(
        id=str(uuid.uuid4()),
        created_at=datetime.now(timezone.utc).isoformat(),
        **input.model_dump(),
    )
    await db.transactions.insert_one({**transaction.model_dump(), "owner_id": user["id"]})
    return transaction


@api_router.put("/transactions/{transaction_id}", response_model=Transaction)
async def update_transaction(transaction_id: str, input: TransactionCreate, user: dict[str, Any] = Depends(current_user)):
    updated = await db.transactions.find_one_and_update(
        {"id": transaction_id, "owner_id": user["id"]},
        {"$set": input.model_dump()},
        return_document=ReturnDocument.AFTER,
        projection={"_id": 0},
    )
    if not updated:
        raise HTTPException(status_code=404, detail="Transaction not found")
    return Transaction(**updated)


@api_router.delete("/transactions/{transaction_id}")
async def delete_transaction(transaction_id: str, user: dict[str, Any] = Depends(current_user)):
    result = await db.transactions.delete_one({"id": transaction_id, "owner_id": user["id"]})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Transaction not found")
    return {"ok": True}


@api_router.get("/budgets", response_model=List[Budget])
async def get_budgets(user: dict[str, Any] = Depends(current_user)):
    docs = await db.budgets.find({"owner_id": user["id"]}, {"_id": 0, "owner_id": 0}).to_list(200)
    return [Budget(**doc) for doc in docs]


@api_router.put("/budgets", response_model=Budget)
async def upsert_budget(input: BudgetUpsert, user: dict[str, Any] = Depends(current_user)):
    now = datetime.now(timezone.utc).isoformat()
    updated = await db.budgets.find_one_and_update(
        {"owner_id": user["id"], "category": input.category},
        {
            "$set": {"monthly_limit": input.monthly_limit, "updated_at": now, "category": input.category},
            "$setOnInsert": {"id": str(uuid.uuid4()), "owner_id": user["id"]},
        },
        upsert=True,
        return_document=ReturnDocument.AFTER,
        projection={"_id": 0, "owner_id": 0},
    )
    return Budget(**updated)


@api_router.delete("/budgets/{category}")
async def delete_budget(category: str, user: dict[str, Any] = Depends(current_user)):
    result = await db.budgets.delete_one({"owner_id": user["id"], "category": category})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Budget not found")
    return {"ok": True}


@api_router.get("/savings-goals", response_model=List[SavingsGoal])
async def get_savings_goals(user: dict[str, Any] = Depends(current_user)):
    docs = await db.savings_goals.find({"owner_id": user["id"]}, {"_id": 0, "owner_id": 0}).sort("created_at", 1).to_list(100)
    goals = []
    for doc in docs:
        # Tolerate legacy goal docs created by the earlier single-goal endpoint.
        doc.setdefault("name", "Savings goal")
        doc.setdefault("celebrated", False)
        doc.setdefault("created_at", doc.get("updated_at") or datetime.now(timezone.utc).isoformat())
        doc.setdefault("updated_at", doc.get("created_at"))
        goals.append(SavingsGoal(**doc))
    return goals


@api_router.post("/savings-goals", response_model=SavingsGoal)
async def create_savings_goal(input: SavingsGoalCreate, user: dict[str, Any] = Depends(current_user)):
    now = datetime.now(timezone.utc).isoformat()
    goal = SavingsGoal(
        id=str(uuid.uuid4()),
        name=input.name,
        target=input.target,
        target_date=input.target_date,
        celebrated=False,
        created_at=now,
        updated_at=now,
    )
    await db.savings_goals.insert_one({**goal.model_dump(), "owner_id": user["id"]})
    return goal


@api_router.put("/savings-goals/{goal_id}", response_model=SavingsGoal)
async def update_savings_goal(goal_id: str, input: SavingsGoalUpdate, user: dict[str, Any] = Depends(current_user)):
    changes = input.model_dump(exclude_unset=True)
    changes["updated_at"] = datetime.now(timezone.utc).isoformat()
    updated = await db.savings_goals.find_one_and_update(
        {"id": goal_id, "owner_id": user["id"]},
        {"$set": changes},
        return_document=ReturnDocument.AFTER,
        projection={"_id": 0, "owner_id": 0},
    )
    if not updated:
        raise HTTPException(status_code=404, detail="Savings goal not found")
    return SavingsGoal(**updated)


@api_router.delete("/savings-goals/{goal_id}")
async def delete_savings_goal(goal_id: str, user: dict[str, Any] = Depends(current_user)):
    result = await db.savings_goals.delete_one({"id": goal_id, "owner_id": user["id"]})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Savings goal not found")
    # Unassign any savings transactions that pointed at this goal
    await db.transactions.update_many(
        {"owner_id": user["id"], "goal_id": goal_id},
        {"$set": {"goal_id": None}},
    )
    return {"ok": True}

# Include the router in the main app
app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)

@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()

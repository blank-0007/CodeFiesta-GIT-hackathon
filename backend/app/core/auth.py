"""Authentication & authorization.

`current_user` is a FastAPI dependency so the demo header scheme can be swapped for JWT
without touching routers. AUTH_MODE=demo reads the role from X-Demo-Role (default admin);
AUTH_MODE=jwt verifies an HS256 bearer token carrying {"sub", "name", "role"}.
"""

import base64
import hashlib
import hmac
import json
import time
from dataclasses import dataclass
from typing import Literal

from fastapi import Depends, Request

from app.core.config import get_settings
from app.core.errors import ApiError, forbidden

Role = Literal["admin", "accountant", "reviewer", "auditor"]
ROLES: tuple[Role, ...] = ("admin", "accountant", "reviewer", "auditor")

PERMISSIONS = (
    "run.create", "run.rerun", "run.finalize", "match.manual", "match.unmatch", "finding.decide",
    "rule.decide", "rule.toggle", "detector.configure", "report.generate", "audit.export",
    "settings.org", "settings.ai",
)

MATRIX: dict[str, set[str]] = {
    "admin": set(PERMISSIONS),
    "accountant": {
        "run.create", "run.rerun", "run.finalize", "match.manual", "match.unmatch",
        "finding.decide", "rule.decide", "rule.toggle", "report.generate",
    },
    "reviewer": {"finding.decide", "report.generate"},
    "auditor": {"report.generate", "audit.export"},
}

# Display names for the demo users (mirrors src/api/mocks/seed.ts USERS).
DEMO_USERS: dict[str, str] = {
    "admin": "Priya Sharma",
    "accountant": "Priya Sharma",
    "reviewer": "Ananya Iyer",
    "auditor": "Vikram Rao",
}
ESCALATION_USER = "Rahul Mehta"


@dataclass(frozen=True)
class User:
    name: str
    role: str
    ip: str | None = None

    def can(self, perm: str) -> bool:
        return perm in MATRIX.get(self.role, set())


def role_can(role: str, perm: str) -> bool:
    return perm in MATRIX.get(role, set())


def _client_ip(request: Request) -> str | None:
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else None


def _b64url_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _verify_jwt(token: str, secret: str) -> dict:
    try:
        header_b64, payload_b64, sig_b64 = token.split(".")
        header = json.loads(_b64url_decode(header_b64))
        if header.get("alg") != "HS256":
            raise ValueError("unsupported alg")
        expected = hmac.new(secret.encode(), f"{header_b64}.{payload_b64}".encode(), hashlib.sha256).digest()
        if not hmac.compare_digest(expected, _b64url_decode(sig_b64)):
            raise ValueError("bad signature")
        payload = json.loads(_b64url_decode(payload_b64))
        if "exp" in payload and time.time() > float(payload["exp"]):
            raise ValueError("expired")
        return payload
    except ValueError as e:
        raise ApiError(401, "unauthorized", f"Invalid token: {e}") from e
    except Exception as e:  # malformed token
        raise ApiError(401, "unauthorized", "Invalid token") from e


def current_user(request: Request) -> User:
    settings = get_settings()
    ip = _client_ip(request)
    if settings.auth_mode == "jwt":
        auth = request.headers.get("authorization", "")
        if not auth.lower().startswith("bearer "):
            raise ApiError(401, "unauthorized", "Missing bearer token")
        if not settings.jwt_secret:
            raise ApiError(500, "internal_error", "JWT_SECRET is not configured")
        claims = _verify_jwt(auth[7:].strip(), settings.jwt_secret.get_secret_value())
        role = claims.get("role", "auditor")
        if role not in ROLES:
            raise ApiError(403, "forbidden", f"Unknown role '{role}'")
        return User(name=claims.get("name") or claims.get("sub", "user"), role=role, ip=ip)
    role = (request.headers.get("x-demo-role") or "admin").strip().lower()
    if role not in ROLES:
        raise ApiError(403, "forbidden", f"Unknown role '{role}'")
    return User(name=DEMO_USERS[role], role=role, ip=ip)


def require(perm: str):
    """Dependency factory: `user: User = Depends(require("run.create"))`."""

    def dep(user: User = Depends(current_user)) -> User:
        if not user.can(perm):
            raise forbidden(user.role, perm)
        return user

    return dep

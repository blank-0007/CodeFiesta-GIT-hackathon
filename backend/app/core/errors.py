"""Uniform error bodies: always {"error": <code>, "detail": <string>}."""

import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

log = logging.getLogger("reconai")

_STATUS_CODES = {
    400: "bad_request",
    401: "unauthorized",
    403: "forbidden",
    404: "not_found",
    405: "method_not_allowed",
    409: "validation_error",
    422: "validation_error",
    429: "rate_limited",
    503: "upstream_unavailable",
}


class ApiError(Exception):
    """Raise from anywhere to return {"error": code, "detail": detail} with the given status."""

    def __init__(self, status: int, error: str, detail: str, body: dict | None = None):
        super().__init__(detail)
        self.status = status
        self.error = error
        self.detail = detail
        self.body = body  # optional full body override (e.g. failed UploadedFile)


def not_found(what: str) -> ApiError:
    return ApiError(404, "not_found", f"{what} not found")


def invalid(detail: str, status: int = 422) -> ApiError:
    return ApiError(status, "validation_error", detail)


def conflict(detail: str) -> ApiError:
    return ApiError(409, "validation_error", detail)


def forbidden(role: str, perm: str) -> ApiError:
    return ApiError(403, "forbidden", f"Role '{role}' cannot perform '{perm}'")


def _body(error: str, detail: object) -> dict:
    return {"error": error, "detail": detail if isinstance(detail, str) else str(detail)}


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(_: Request, exc: ApiError):
        return JSONResponse(exc.body if exc.body is not None else _body(exc.error, exc.detail), status_code=exc.status)

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_: Request, exc: StarletteHTTPException):
        code = _STATUS_CODES.get(exc.status_code, "error")
        detail = exc.detail if isinstance(exc.detail, str) else str(exc.detail)
        if exc.status_code == 404 and detail == "Not Found":
            detail = "Resource not found"
        return JSONResponse(_body(code, detail), status_code=exc.status_code, headers=getattr(exc, "headers", None))

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_: Request, exc: RequestValidationError):
        parts = []
        for e in exc.errors():
            loc = ".".join(str(x) for x in e.get("loc", ()) if x not in ("body", "query", "path"))
            parts.append(f"{loc}: {e.get('msg')}" if loc else str(e.get("msg")))
        return JSONResponse(_body("validation_error", "; ".join(parts) or "Invalid request"), status_code=422)

    @app.exception_handler(Exception)
    async def _unhandled(_: Request, exc: Exception):
        log.exception("Unhandled error", exc_info=exc)
        return JSONResponse(_body("internal_error", "An unexpected error occurred"), status_code=500)

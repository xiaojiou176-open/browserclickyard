from __future__ import annotations

from typing import Any

from fastapi import Header, HTTPException, Request, status
from pydantic import BaseModel


class ApiErrorResponse(BaseModel):
    detail: object | str | list[object]


COMMON_ERROR_RESPONSES: dict[int | str, dict[str, Any]] = {
    400: {"model": ApiErrorResponse},
    401: {"model": ApiErrorResponse},
    403: {"model": ApiErrorResponse},
    404: {"model": ApiErrorResponse},
    405: {"model": ApiErrorResponse},
    409: {"model": ApiErrorResponse},
    422: {"model": ApiErrorResponse},
    429: {"model": ApiErrorResponse},
    502: {"model": ApiErrorResponse},
    500: {"model": ApiErrorResponse},
    503: {"model": ApiErrorResponse},
}


def reject_unknown_query_params(request: Request, *, allowed: set[str] | frozenset[str]) -> None:
    unknown = sorted({key for key in request.query_params.keys() if key not in allowed})
    if unknown:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=f"unknown query params: {', '.join(unknown)}",
        )


def accept_cookie_header(cookie_header: str | None = Header(default=None, alias="Cookie")) -> None:
    del cookie_header

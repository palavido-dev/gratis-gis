# SPDX-License-Identifier: AGPL-3.0-or-later
"""Typed errors for portal calls.

The hierarchy mirrors the one the QGIS plugin's client has used in
production, so the two can converge on this package later without
callers rewriting their except blocks.

Every error carries the HTTP status and the portal's own message when
there is one. The portal writes user-facing messages deliberately
("This area is very large: 412 tiles..."), so surfacing them verbatim
is almost always more useful than anything a client could synthesize.
"""

from __future__ import annotations

from typing import Any, Optional


class PortalError(Exception):
    """Base class for every error raised by this client."""

    def __init__(
        self,
        message: str,
        *,
        status: Optional[int] = None,
        method: Optional[str] = None,
        path: Optional[str] = None,
        body: Any = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status = status
        self.method = method
        self.path = path
        self.body = body

    def __str__(self) -> str:
        where = f" ({self.method} {self.path})" if self.path else ""
        code = f" [{self.status}]" if self.status is not None else ""
        return f"{self.message}{code}{where}"


class AuthError(PortalError):
    """401 / 403. A bad, expired, revoked, or under-privileged key.

    Also raised when a read-only key attempts a write, which the
    portal answers with 403 and an explanatory message.
    """


class NotFoundError(PortalError):
    """404. The item, layer, or feature does not exist, or the caller
    cannot see it: the portal deliberately does not distinguish."""


class ValidationError(PortalError):
    """400 / 422. The request was understood and refused."""


class ConflictError(PortalError):
    """409. Usually an optimistic-concurrency failure on an item
    whose `updatedAt` moved under you."""


class RateLimitError(PortalError):
    """429. Includes `retry_after` seconds when the portal sent it."""

    def __init__(self, *args: Any, retry_after: Optional[float] = None, **kw: Any):
        super().__init__(*args, **kw)
        self.retry_after = retry_after

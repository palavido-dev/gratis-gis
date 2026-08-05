# SPDX-License-Identifier: AGPL-3.0-or-later
"""Python client for a GratisGIS portal.

    from gratisgis import GratisGIS

    gg = GratisGIS.from_env()
    for feature in gg.iter_features(layer_id, "parcels"):
        ...
"""

from .client import GratisGIS
from .errors import (
    AuthError,
    ConflictError,
    NotFoundError,
    PortalError,
    RateLimitError,
    ValidationError,
)

__version__ = "0.1.0"

__all__ = [
    "GratisGIS",
    "PortalError",
    "AuthError",
    "NotFoundError",
    "ValidationError",
    "ConflictError",
    "RateLimitError",
    "__version__",
]

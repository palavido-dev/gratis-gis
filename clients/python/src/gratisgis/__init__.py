# SPDX-License-Identifier: AGPL-3.0-or-later
"""Python client for a GratisGIS portal.

    from gratisgis import GratisGIS

    gg = GratisGIS.from_env()
    for feature in gg.iter_features(layer_id, "parcels"):
        ...
"""

from .client import (
    EXPORT_FORMATS,
    FIELD_TYPES,
    GEOMETRY_TYPES,
    ITEM_ACCESS,
    SHARE_PERMISSIONS,
    GratisGIS,
    __version__,
    field,
    layer,
)
from .errors import (
    AuthError,
    ConflictError,
    NotFoundError,
    PortalError,
    RateLimitError,
    ValidationError,
)

__all__ = [
    "GratisGIS",
    "field",
    "layer",
    "FIELD_TYPES",
    "GEOMETRY_TYPES",
    "EXPORT_FORMATS",
    "PortalError",
    "AuthError",
    "NotFoundError",
    "ValidationError",
    "ConflictError",
    "RateLimitError",
    "__version__",
]

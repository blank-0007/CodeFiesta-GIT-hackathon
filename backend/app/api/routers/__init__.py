from typing import Any

from fastapi import APIRouter


class Router(APIRouter):
    """Defaults every route to camelCase aliases and omits None fields (TS optional props)."""

    def add_api_route(self, path: str, endpoint: Any, **kwargs: Any) -> None:
        kwargs["response_model_by_alias"] = True
        kwargs["response_model_exclude_none"] = True
        super().add_api_route(path, endpoint, **kwargs)

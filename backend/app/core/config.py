"""Runtime configuration. Loaded only from the environment (and backend/.env) via pydantic-settings."""

from functools import lru_cache
from pathlib import Path

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=BACKEND_DIR / ".env", env_file_encoding="utf-8", extra="ignore")

    # SecretStr keeps the key out of repr()/logs; read it only via get_secret_value() in the agent client.
    gemini_api_key: SecretStr | None = None
    database_url: str = "sqlite:///./reconai.db"
    cors_origins: str = "http://localhost:5173"
    auth_mode: str = Field(default="demo", pattern="^(demo|jwt)$")
    public_base_url: str = "http://localhost:8000"
    data_dir: Path = BACKEND_DIR / "data"
    # JWT mode (see README): HS256 secret used to verify bearer tokens.
    jwt_secret: SecretStr | None = None
    # Test hook: run the pipeline inline instead of as a background task.
    inline_jobs: bool = False
    # Per-item AI timeout and global switch (the app works fully offline when AI is unavailable).
    ai_timeout_s: float = 45.0
    ai_concurrency: int = 2

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def upload_dir(self) -> Path:
        p = self.data_dir / "uploads"
        p.mkdir(parents=True, exist_ok=True)
        return p

    @property
    def has_gemini_key(self) -> bool:
        return bool(self.gemini_api_key and self.gemini_api_key.get_secret_value().strip())


@lru_cache
def get_settings() -> Settings:
    return Settings()

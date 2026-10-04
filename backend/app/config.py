import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    app_env: str
    database_url: str
    token_secret: str
    candidate_token_ttl_s: int = 900


def load_settings() -> Settings:
    app_env = os.getenv("APP_ENV", "dev")
    token_secret = os.getenv("TOKEN_SECRET")
    if app_env != "dev" and not token_secret:
        raise RuntimeError("TOKEN_SECRET is required outside dev")
    return Settings(
        app_env=app_env,
        database_url=os.getenv("DATABASE_URL", "postgresql://postgres:postgres@localhost:54322/agro"),
        token_secret=token_secret or "dev-token-secret",
    )


settings = load_settings()

import os
from dataclasses import dataclass

from advisor.env import load_dotenv

load_dotenv()


@dataclass(frozen=True)
class Settings:
    app_env: str
    database_url: str
    token_secret: str
    candidate_token_ttl_s: int = 900
    # Section 17: 3 min in demo (7 days real), retry every 2 min, 3 calls before SMS.
    followup_interval_s: int = 180
    followup_retry_s: int = 120
    followup_call_attempts: int = 3


def load_settings() -> Settings:
    app_env = os.getenv("APP_ENV", "dev")
    token_secret = os.getenv("TOKEN_SECRET")
    if app_env != "dev" and not token_secret:
        raise RuntimeError("TOKEN_SECRET is required outside dev")
    return Settings(
        app_env=app_env,
        database_url=os.getenv("DATABASE_URL", "postgresql://postgres:postgres@localhost:54322/agro"),
        token_secret=token_secret or "dev-token-secret",
        followup_interval_s=int(os.getenv("FOLLOWUP_INTERVAL_S", "180")),
        followup_retry_s=int(os.getenv("FOLLOWUP_RETRY_S", "120")),
        followup_call_attempts=int(os.getenv("FOLLOWUP_CALL_ATTEMPTS", "3")),
    )


settings = load_settings()

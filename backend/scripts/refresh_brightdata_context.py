"""Ejecuta Bright Data Scraper Studio e importa su resultado curado.

Uso:
  BRIGHT_DATA_API_KEY=... BRIGHT_DATA_COLLECTOR_ID=c_... \
    python -m backend.scripts.refresh_brightdata_context

La clave vive solo en el entorno. El resultado se guarda como ``unreviewed``;
una persona debe aprobarlo antes de que el asesor pueda consultarlo.
"""

from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path
from typing import Any

import httpx

from backend.scripts.import_brightdata_context import import_records, read_records


API_ROOT = "https://api.brightdata.com"
DEFAULT_URL = "https://publicaciones.cenicafe.org/index.php/infografias/article/view/2828"


def load_dotenv(path: Path = Path(".env")) -> None:
    """Carga pares KEY=VALUE mínimos para scripts locales, sin sustituir exports."""
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip().strip("\"'")
        if key and key.replace("_", "").isalnum():
            os.environ.setdefault(key, value)


def job_id_from(response: httpx.Response) -> str:
    """Bright Data puede devolver el job como JSON o como texto plano."""
    try:
        body: Any = response.json()
    except json.JSONDecodeError:
        body = response.text.strip()
    if isinstance(body, str) and body.startswith("j_"):
        return body
    if isinstance(body, dict):
        for key in ("collection_id", "job_id", "snapshot_id", "id"):
            value = body.get(key)
            if isinstance(value, str) and value:
                return value
    raise RuntimeError(f"Respuesta inesperada al iniciar Bright Data: {body!r}")


def records_from_payload(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict) and isinstance(payload.get("data"), list):
        return payload["data"]
    if isinstance(payload, dict) and {"url", "title", "content"}.issubset(payload):
        return [payload]
    raise RuntimeError("Bright Data terminó pero no devolvió registros con url, title y content")


def fetch_job(client: httpx.Client, job_id: str, *, timeout_seconds: int) -> list[dict[str, Any]]:
    """Espera y descarga un job ya iniciado, sin disparar otro."""
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        result = client.get(f"{API_ROOT}/dca/dataset", params={"id": job_id, "format": "json"})
        if result.status_code == 202:
            time.sleep(5)
            continue
        result.raise_for_status()
        try:
            return records_from_payload(result.json())
        except (json.JSONDecodeError, RuntimeError):
            if result.text.strip():
                raise
            time.sleep(5)
    raise TimeoutError(f"Bright Data no terminó en {timeout_seconds} segundos (job {job_id})")


def run_collector(api_key: str, collector_id: str, urls: list[str], *, timeout_seconds: int) -> list[dict[str, Any]]:
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    with httpx.Client(timeout=30.0, headers=headers) as client:
        trigger = client.post(f"{API_ROOT}/dca/trigger", params={"collector": collector_id, "queue_next": "1"},
                              json=[{"url": url} for url in urls])
        trigger.raise_for_status()
        job_id = job_id_from(trigger)
        print(f"Bright Data job iniciado: {job_id}")
        return fetch_job(client, job_id, timeout_seconds=timeout_seconds)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", action="append", dest="urls", default=[], help="URL permitida; repetible")
    parser.add_argument("--job-id", help="retoma un job de Bright Data existente; no inicia uno nuevo")
    parser.add_argument("--timeout-seconds", type=int, default=180)
    args = parser.parse_args()
    load_dotenv()
    api_key = os.getenv("BRIGHT_DATA_API_KEY")
    collector_id = os.getenv("BRIGHT_DATA_COLLECTOR_ID")
    if not api_key or not collector_id:
        raise SystemExit("Faltan BRIGHT_DATA_API_KEY o BRIGHT_DATA_COLLECTOR_ID en el entorno")

    if args.job_id:
        headers = {"Authorization": f"Bearer {api_key}"}
        with httpx.Client(timeout=30.0, headers=headers) as client:
            rows = fetch_job(client, args.job_id, timeout_seconds=args.timeout_seconds)
    else:
        rows = run_collector(api_key, collector_id, args.urls or [DEFAULT_URL],
                             timeout_seconds=args.timeout_seconds)
    # Reutiliza la misma validación estricta del importador sin guardar archivos temporales.
    from tempfile import NamedTemporaryFile
    with NamedTemporaryFile(mode="w", suffix=".json", encoding="utf-8") as temp:
        json.dump(rows, temp)
        temp.flush()
        records = read_records(Path(temp.name))
    db_url = os.getenv("DATABASE_URL", "postgresql://postgres:postgres@localhost:54322/agro")
    for source_id in import_records(records, db_url, threat_code="coffee_leaf_rust",
                                    region=None, data_type="management_guide"):
        print(f"Importado {source_id} como unreviewed")


if __name__ == "__main__":
    main()

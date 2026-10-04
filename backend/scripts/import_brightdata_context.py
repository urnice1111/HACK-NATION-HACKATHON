"""Importa resultados JSON de Bright Data a ``env.external_context``.

Bright Data se ejecuta fuera de una llamada del agricultor. Este script recibe el
JSON descargado desde un run exitoso y lo deja en estado ``unreviewed``: el
asesor nunca lo puede usar hasta que una persona lo revise y cambie ese estado.

Uso:
    DATABASE_URL=postgresql://... python -m backend.scripts.import_brightdata_context \
      --input-json ~/Downloads/brightdata.json --threat-code coffee_leaf_rust

No guarda API keys y rechaza dominios que el equipo no haya aprobado.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from collections.abc import Iterable
from pathlib import Path
from urllib.parse import urlparse

import psycopg


# Lista cerrada, aprobada para el MVP. Agregar una fuente requiere revisión del
# integrante 2, no solo cambiar el input de Bright Data.
APPROVED_HOSTS = {"publicaciones.cenicafe.org"}
MAX_CONTENT_CHARS = 20_000
MARKDOWN_LINK = re.compile(r"^\[[^\]]+\]\((https?://[^)]+)\)$")
# El asesor nunca debe recibir productos, fungicidas, dosis o calendarios de
# aplicación, aun si una fuente externa los incluye.
UNSAFE_GUIDANCE = re.compile(
    r"\b(fungicid\w*|aplicaci[oó]n|calendarios?\s+fijos?|\d+\s+d[ií]as)\b", re.IGNORECASE
)


def canonical_url(value: str) -> str:
    """Acepta una URL normal y normaliza el formato Markdown de algunas descargas."""
    value = value.strip()
    match = MARKDOWN_LINK.fullmatch(value)
    return match.group(1) if match else value


def read_records(path: Path) -> list[dict[str, str]]:
    """Lee JSON array, objeto único o NDJSON descargado por Bright Data."""
    raw = path.read_text(encoding="utf-8")
    try:
        decoded = json.loads(raw)
        rows: Iterable[object] = decoded if isinstance(decoded, list) else [decoded]
    except json.JSONDecodeError:
        rows = [json.loads(line) for line in raw.splitlines() if line.strip()]

    records: list[dict[str, str]] = []
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("Cada resultado de Bright Data debe ser un objeto JSON")
        url, title, content = row.get("url"), row.get("title"), row.get("content")
        if not all(isinstance(value, str) and value.strip() for value in (url, title, content)):
            raise ValueError("Cada resultado requiere url, title y content de texto no vacío")
        url = canonical_url(url)
        host = urlparse(url).hostname
        if host not in APPROVED_HOSTS:
            raise ValueError(f"Fuente no aprobada: {host!r}")
        if content.strip() == url.strip():
            raise ValueError("content no contiene texto extraído; parece ser la URL")
        if UNSAFE_GUIDANCE.search(content):
            raise ValueError("content contiene guía de aplicación o fungicidas; corrige el scraper antes de importarlo")
        records.append({"url": url.strip(), "title": title.strip(), "content": content.strip()[:MAX_CONTENT_CHARS]})
    if not records:
        raise ValueError("El archivo no contiene resultados")
    return records


def source_id_for(url: str) -> str:
    digest = hashlib.sha256(url.encode("utf-8")).hexdigest()[:12]
    return f"brightdata_cenicafe_{digest}"


def import_records(records: list[dict[str, str]], db_url: str, *, threat_code: str,
                   region: str | None, data_type: str) -> list[str]:
    """Persiste resultados ya validados; se comparte con el ejecutor automático."""
    source_ids: list[str] = []
    with psycopg.connect(db_url) as conn, conn.transaction():
        for record in records:
            source_id = source_id_for(record["url"])
            conn.execute(
                """
                insert into env.external_context
                  (source_id, url, title, retrieved_at, valid_until, region, data_type, content, quality_status, threat_code)
                values (%s, %s, %s, now(), now() + interval '90 days', %s, %s, %s, 'unreviewed', %s)
                on conflict (source_id) do update set
                  url = excluded.url, title = excluded.title, retrieved_at = excluded.retrieved_at,
                  valid_until = excluded.valid_until, region = excluded.region, data_type = excluded.data_type,
                  content = excluded.content, quality_status = 'unreviewed', threat_code = excluded.threat_code
                """,
                (source_id, record["url"], record["title"], region, data_type,
                 record["content"], threat_code),
            )
            source_ids.append(source_id)
    return source_ids


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--input-json", required=True, type=Path, help="JSON o NDJSON descargado desde Bright Data")
    parser.add_argument("--threat-code", default="coffee_leaf_rust")
    parser.add_argument("--region", default=None, help="null = contenido general, no específico de una región")
    parser.add_argument("--data-type", default="management_guide")
    args = parser.parse_args()

    records = read_records(args.input_json)
    db_url = os.getenv("DATABASE_URL", "postgresql://postgres:postgres@localhost:54322/agro")
    for source_id in import_records(records, db_url, threat_code=args.threat_code,
                                    region=args.region, data_type=args.data_type):
        print(f"Importado {source_id} como unreviewed")


if __name__ == "__main__":
    main()

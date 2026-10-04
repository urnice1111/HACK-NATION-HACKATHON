"""Evidencia real de las herramientas: nunca se inventa clima ni casos."""

from __future__ import annotations

import re
from typing import Any

from .contracts import DataUsed, Disposition, ResolvedCaseMention

_UNSAFE = re.compile(
    r"(?i)\b(fungicida|dosis|kilos?|litros?|caldo|bordel[eé]s|producto|gramos?|ppm)\b"
)
_LABELS = {
    "humidity_pct": "Humedad",
    "precip_mm": "Lluvia",
    "temp_mean_c": "Temperatura media",
    "temp_max_c": "Temperatura máxima",
    "temp_min_c": "Temperatura mínima",
}
_CULTURAL = {
    "remove_affected_leaves": "retirar y enterrar hojas afectadas",
    "regulate_shade": "regular la sombra",
    "nutrition": "cuidar la nutrición",
}


def data_used_from_queries(payloads: list[dict[str, Any]]) -> list[DataUsed]:
    """Solo consultas que realmente respondió /v1/environment/query."""
    used: list[DataUsed] = []
    for body in payloads:
        query_id = body.get("query_id")
        if not query_id or "results" not in body:
            continue
        used.append(
            DataUsed(
                query_id=str(query_id),
                summary=summarize_env(body),
                data_freshness=str(body.get("data_freshness") or "unknown"),
                dataset_ids=[str(item) for item in body.get("dataset_ids") or []],
            )
        )
    return used


def summarize_env(payload: dict[str, Any]) -> str:
    parts: list[str] = []
    for row in payload.get("results") or []:
        code = str(row.get("code") or "")
        label = _LABELS.get(code, code or "variable")
        value = row.get("value")
        unit = row.get("unit") or ""
        if value is None:
            parts.append(f"{label} sin dato suficiente")
            continue
        text = f"{label} {value}{unit}"
        ratio = row.get("anomaly_ratio")
        if isinstance(ratio, (int, float)):
            if ratio > 1.05:
                text += " por encima de lo normal"
            elif ratio < 0.95:
                text += " por debajo de lo normal"
        parts.append(text)
    return "; ".join(parts) or "Consulta ambiental sin resultados"


def mentions_from_search(
    results: list[dict[str, Any]],
    model_mentions: list[ResolvedCaseMention],
    disposition: Disposition,
) -> list[ResolvedCaseMention]:
    """Solo IDs devueltos por la búsqueda y con protocolo aprobado. Sin producto ni dosis."""
    allowed = {
        str(item["resolution_id"]): item
        for item in results
        if item.get("resolution_id") and item.get("matches_protocol") is True
    }
    mentions: list[ResolvedCaseMention] = []
    seen: set[str] = set()
    for mention in model_mentions:
        item = allowed.get(mention.resolution_id)
        if item is None or mention.resolution_id in seen:
            continue
        mentions.append(_safe_mention(item, mention.summary_for_speech))
        seen.add(mention.resolution_id)
    if not mentions and disposition == Disposition.advise and allowed:
        chosen = _preferred(list(allowed.values()), results)
        if chosen is not None:
            mentions.append(_safe_mention(chosen, None))
    return mentions


def _preferred(allowed: list[dict[str, Any]], original: list[dict[str, Any]]) -> dict[str, Any] | None:
    allowed_ids = {str(item["resolution_id"]) for item in allowed if item.get("resolution_id")}
    for item in original:
        if item.get("verification") == "verified" and str(item.get("resolution_id")) in allowed_ids:
            return item
    for item in original:
        if item.get("matches_protocol") is True and item.get("resolution_id"):
            return item
    return allowed[0] if allowed else None


def _safe_mention(item: dict[str, Any], proposed: str | None) -> ResolvedCaseMention:
    speech = proposed if proposed and not _UNSAFE.search(proposed) else cultural_speech(item)
    if _UNSAFE.search(speech):
        speech = cultural_speech(item)
    return ResolvedCaseMention(
        resolution_id=str(item["resolution_id"]),
        summary_for_speech=speech,
        verification=str(item.get("verification") or "farmer_reported"),
    )


def cultural_speech(item: dict[str, Any]) -> str:
    codes = item.get("solution_codes") or []
    practices = [_CULTURAL[code] for code in codes if code in _CULTURAL]
    if not practices:
        practices = ["prácticas culturales del protocolo"]
    joined = " y ".join(practices)
    if item.get("verification") == "farmer_reported":
        suffix = " Lo contó el agricultor; no está verificado por un agrónomo."
    else:
        suffix = " Es experiencia de otro agricultor, no una recomendación validada."
    return f"En una parcela parecida de la zona, un agricultor contó que mejoró al {joined}.{suffix}"

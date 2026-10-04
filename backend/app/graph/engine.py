"""Graph recalculation: edges -> per-plot features -> risk model -> risk_evaluations.

Rules (INSTRUCTIONS.md sections 5.2, 6 and 17, hypothetical until reviewed with the advisor):
- Edge between plots <= 10 km, nearest 5 per plot, stored once with source < target.
- exposure_strength = exp(-d / 5 km) only when an end has an active case; similarity alone never creates exposure.
- Exposure features use neighbours' active cases, never their computed priority.
"""

import logging
import math
from dataclasses import dataclass

from psycopg import Connection
from psycopg.types.json import Jsonb

from backend.app.graph.risk import apply_artifact
from contracts.enums import EventType
from contracts.models import RiskModelArtifact

log = logging.getLogger("graph")

RULE_VERSION = "edges-v1-hypothetical"
MAX_DISTANCE_KM = 10.0
MAX_NEIGHBORS = 5
EXPOSURE_DECAY_KM = 5.0
# Scale of each env feature for similarity (one "typical difference").
ENV_SIMILARITY_SCALES = {"humidity_mean_14d": 8.0, "rain_anomaly_30d": 0.4, "temp_optimal_days_14d": 4.0}

REASONS = {
    "direct_active_reports": "Reporte directo activo",
    "neighbor_source_exposure": "Vecina de parcelas con caso activo",
    "humidity_mean_14d": "Humedad por encima de lo normal",
    "rain_anomaly_30d": "Lluvia por encima de lo normal",
    "temp_optimal_days_14d": "Temperaturas favorables para la roya",
}


@dataclass
class Edge:
    source: str
    target: str
    distance_km: float
    environment_similarity: float | None
    exposure_strength: float | None
    missing_features: list[str]


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    lat1, lon1, lat2, lon2 = map(math.radians, (lat1, lon1, lat2, lon2))
    a = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * 6371.0 * math.asin(math.sqrt(a))


def environment_similarity(a: dict, b: dict) -> tuple[float | None, list[str]]:
    missing = sorted(f for f in ENV_SIMILARITY_SCALES if a.get(f) is None or b.get(f) is None)
    if missing:
        return None, missing
    dist = math.sqrt(sum(((a[f] - b[f]) / s) ** 2 for f, s in ENV_SIMILARITY_SCALES.items()))
    return round(max(0.0, 1 - dist / (2 * math.sqrt(len(ENV_SIMILARITY_SCALES)))), 4), []


def build_edges(plots: list[dict], env: dict[str, dict], active_plots: set[str]) -> list[Edge]:
    pairs: dict[tuple[str, str], float] = {}
    for p in plots:
        near = sorted(
            (haversine_km(p["latitude"], p["longitude"], q["latitude"], q["longitude"]), q["id"])
            for q in plots if q["id"] != p["id"]
        )
        for dist, qid in [n for n in near if n[0] <= MAX_DISTANCE_KM][:MAX_NEIGHBORS]:
            pairs[tuple(sorted((p["id"], qid)))] = dist

    edges = []
    for (a, b), dist in sorted(pairs.items()):
        similarity, missing = environment_similarity(env.get(a, {}), env.get(b, {}))
        has_source = a in active_plots or b in active_plots
        edges.append(Edge(
            source=a, target=b, distance_km=round(dist, 2), environment_similarity=similarity,
            exposure_strength=round(math.exp(-dist / EXPOSURE_DECAY_KM), 4) if has_source else None,
            missing_features=missing,
        ))
    return edges


def load_env_summaries(conn: Connection) -> dict[str, dict]:
    """plot_id -> {features, data_freshness}. Missing env schema means no summaries, not an error."""
    if conn.execute("select to_regclass('env.plot_summary') as t").fetchone()["t"] is None:
        return {}
    rows = conn.execute(
        """
        select distinct on (plot_id) plot_id, features, data_freshness
        from env.plot_summary order by plot_id, computed_at desc
        """
    ).fetchall()
    return {r["plot_id"]: r for r in rows}


def recalculate(conn: Connection, threat_code: str) -> dict:
    """Rebuilds edges and re-evaluates every plot for one threat. Returns the plots whose evaluation changed."""
    with conn.transaction():
        conn.execute("select pg_advisory_xact_lock(hashtext(%s))", (f"graph:{threat_code}",))

        plots = conn.execute("select id, latitude, longitude, is_demo from plots order by id").fetchall()
        summaries = load_env_summaries(conn)
        env = {pid: s["features"] for pid, s in summaries.items()}
        active = {
            r["plot_id"]: r
            for r in conn.execute(
                """
                select c.plot_id, c.id as case_id,
                       coalesce(array_agg(r.id order by r.received_at) filter (where r.id is not null), '{}') as report_ids
                from cases c left join reports r on r.case_id = c.id
                where c.threat_code = %s and c.status <> 'resolved'
                group by c.plot_id, c.id
                """,
                (threat_code,),
            ).fetchall()
        }

        edges = build_edges(plots, env, set(active))
        demo_plots = {p["id"] for p in plots if p["is_demo"]}
        conn.execute("delete from edges where threat_code = %s and rule_version = %s", (threat_code, RULE_VERSION))
        for e in edges:
            conn.execute(
                """
                insert into edges (id, is_demo, source_plot_id, target_plot_id, threat_code, distance_km,
                                   environment_similarity, exposure_type, exposure_strength, missing_features, rule_version)
                values (%s, %s, %s, %s, %s, %s, %s, 'proximity', %s, %s, %s)
                """,
                (f"edge_{e.source}_{e.target}", e.source in demo_plots and e.target in demo_plots, e.source, e.target,
                 threat_code, e.distance_km, e.environment_similarity, e.exposure_strength, e.missing_features,
                 RULE_VERSION),
            )

        model = conn.execute(
            "select model_version, artifact from risk_models where threat_code = %s and status = 'active'",
            (threat_code,),
        ).fetchone()
        artifact = RiskModelArtifact.model_validate(model["artifact"]) if model else None

        changed = []
        for plot in plots:
            if evaluate_plot(conn, plot, threat_code, env, summaries, active, edges, artifact):
                changed.append(plot["id"])

        version = conn.execute(
            """
            insert into graph_versions (threat_code, version) values (%s, 1)
            on conflict (threat_code) do update set version = graph_versions.version + 1, updated_at = now()
            returning version
            """,
            (threat_code,),
        ).fetchone()["version"]

    log.info("graph recalculated threat=%s version=%d edges=%d changed=%s",
             threat_code, version, len(edges), changed)
    return {"threat_code": threat_code, "graph_version": version, "changed_plot_ids": changed}


def evaluate_plot(conn, plot, threat_code, env, summaries, active, edges, artifact) -> bool:
    pid = plot["id"]
    neighbor_cases = []
    exposure = 0.0
    for e in edges:
        if pid not in (e.source, e.target):
            continue
        other = e.target if e.source == pid else e.source
        if other in active and e.exposure_strength is not None:
            exposure += e.exposure_strength
            neighbor_cases.append(active[other]["case_id"])

    plot_env = env.get(pid, {})
    inputs = {
        "humidity_mean_14d": plot_env.get("humidity_mean_14d"),
        "rain_anomaly_30d": plot_env.get("rain_anomaly_30d"),
        "temp_optimal_days_14d": plot_env.get("temp_optimal_days_14d"),
        "neighbor_source_exposure": round(exposure, 4),
        "direct_active_reports": 1 if pid in active else 0,
    }

    if artifact is None:
        score, priority, contributions, reasons = None, "unknown", [], ["Sin modelo de riesgo activo"]
        model_version, heuristic = None, True
    else:
        result = apply_artifact(artifact, inputs)
        score, priority, contributions = result.score, result.priority, result.contributions
        model_version, heuristic = artifact.model_version, artifact.heuristic
        if result.missing_features:
            reasons = [f"Faltan datos: {', '.join(result.missing_features)}"]
        else:
            reasons = [REASONS[name] for name, value in contributions if value > 0 and name in REASONS]

    source_case_ids = ([active[pid]["case_id"]] if pid in active else []) + sorted(set(neighbor_cases))
    previous = conn.execute(
        """
        select score, inspection_priority, feature_vector, source_case_ids, model_version
        from risk_evaluations where plot_id = %s and threat_code = %s
        order by created_at desc limit 1
        """,
        (pid, threat_code),
    ).fetchone()
    if previous and (previous["score"], previous["inspection_priority"], previous["feature_vector"],
                     sorted(previous["source_case_ids"]), previous["model_version"]) == (
            score, priority, inputs, sorted(source_case_ids), model_version):
        return False

    evaluation_id = conn.execute(
        """
        insert into risk_evaluations (is_demo, plot_id, threat_code, score, inspection_priority, feature_vector,
                                      contributions, reasons, evidence_report_ids, source_case_ids, model_version,
                                      heuristic, data_freshness)
        values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        returning id
        """,
        (plot["is_demo"], pid, threat_code, score, priority, Jsonb(inputs),
         Jsonb([{"feature": n, "value": v} for n, v in contributions]), reasons,
         list(active[pid]["report_ids"]) if pid in active else [], source_case_ids, model_version, heuristic,
         summaries[pid]["data_freshness"] if pid in summaries else "unknown"),
    ).fetchone()["id"]

    conn.execute(
        """
        insert into outbox_events (is_demo, event_type, aggregate_id, payload)
        values (%s, %s, %s, %s)
        """,
        (plot["is_demo"], EventType.risk_updated, evaluation_id,
         Jsonb({"plot_id": pid, "threat_code": threat_code, "risk_evaluation_id": evaluation_id,
                "inspection_priority": priority,
                "previous_priority": previous["inspection_priority"] if previous else None})),
    )
    return True

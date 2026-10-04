"""Carga NASA POWER al esquema env y precalcula env.plot_summary (dueño: integrante 4).

Pasos: lee las parcelas de public.plots, ubica cada una en su celda de la malla de NASA POWER
(MERRA-2, 0.5° x 0.625°), descarga la serie diaria y la climatología 2001-2020 de cada celda,
llena daily_observations, climatology, variable_catalog y plot_cell_map, calcula las
características de plot_summary y emite env.summary_refreshed.

Uso:
    DATABASE_URL=postgresql://... python -m backend.scripts.load_nasa_power [--days 120] [--offline]

Las respuestas crudas se guardan en --cache-dir, así que --offline recarga sin internet
lo último que se descargó.
"""

import argparse
import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

DATASET_ID = "nasa_power_daily_v2"
API = "https://power.larc.nasa.gov/api/temporal"
FILL_VALUE = -999.0

# Malla nativa de meteorología de POWER (MERRA-2 / GEOS-IT).
LAT_STEP, LON_STEP = 0.5, 0.625

# Región de la demo (sección 17) con margen. Una parcela fuera de este recuadro no se mapea:
# env_query devuelve null con cobertura cero en vez de usar una celda lejana.
REGION = {"lat_min": 18.5, "lat_max": 20.2, "lon_min": -97.6, "lon_max": -96.2}

# Parámetro de POWER -> (variable_code, etiqueta, unidad, agregaciones permitidas).
# Sin daily/weekly: EnvResult.value es un escalar y el contrato v2 no tiene campo para series.
VARIABLES = {
    "PRECTOTCORR": ("precip_mm", "Precipitación diaria", "mm", ["sum", "mean", "min", "max"]),
    "RH2M": ("humidity_pct", "Humedad relativa media a 2 m", "%", ["mean", "min", "max"]),
    "T2M": ("temp_mean_c", "Temperatura media a 2 m", "°C", ["mean", "min", "max"]),
    "T2M_MAX": ("temp_max_c", "Temperatura máxima a 2 m", "°C", ["mean", "min", "max"]),
    "T2M_MIN": ("temp_min_c", "Temperatura mínima a 2 m", "°C", ["mean", "min", "max"]),
}
MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]

# Rango de temperatura media favorable para la roya (sección 17, etiquetas sintéticas).
RUST_TEMP_RANGE_C = (21.0, 25.0)
FRESH_MAX_AGE_DAYS = 7
MIN_COVERAGE = 0.8


def snap_to_cell(lat: float, lon: float) -> tuple[float, float]:
    return round(round(lat / LAT_STEP) * LAT_STEP, 3), round(round(lon / LON_STEP) * LON_STEP, 3)


def cell_id_for(lat: float, lon: float) -> str:
    return f"power_{lat:+.3f}_{lon:+.3f}"


def in_region(lat: float, lon: float) -> bool:
    return REGION["lat_min"] <= lat <= REGION["lat_max"] and REGION["lon_min"] <= lon <= REGION["lon_max"]


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    lat1, lon1, lat2, lon2 = map(math.radians, (lat1, lon1, lat2, lon2))
    a = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * 6371.0 * math.asin(math.sqrt(a))


def fetch_json(url: str, cache_file: Path, offline: bool) -> dict:
    if offline:
        if not cache_file.exists():
            raise SystemExit(f"--offline sin caché: falta {cache_file}")
        return json.loads(cache_file.read_text())
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=60) as resp:
                body = json.load(resp)
            cache_file.parent.mkdir(parents=True, exist_ok=True)
            cache_file.write_text(json.dumps(body))
            return body
        except Exception as exc:  # red intermitente: reintentar y luego caer a la caché
            print(f"  intento {attempt + 1} falló: {exc}", file=sys.stderr)
            time.sleep(2 * (attempt + 1))
    if cache_file.exists():
        print(f"  usando caché {cache_file}", file=sys.stderr)
        return json.loads(cache_file.read_text())
    raise SystemExit(f"No se pudo descargar {url}")


def power_url(kind: str, lat: float, lon: float, **extra: str) -> str:
    params = {"parameters": ",".join(VARIABLES), "community": "AG",
              "latitude": lat, "longitude": lon, "format": "JSON", **extra}
    return f"{API}/{kind}/point?{urllib.parse.urlencode(params)}"


def parse_daily(body: dict) -> dict[str, dict[date, float]]:
    """POWER param -> {fecha: valor}, sin los días de relleno (-999)."""
    out: dict[str, dict[date, float]] = {}
    for param, series in body["properties"]["parameter"].items():
        out[param] = {datetime.strptime(k, "%Y%m%d").date(): v for k, v in series.items() if v != FILL_VALUE}
    return out


def window(series: dict[date, float], end: date, days: int) -> list[tuple[date, float]]:
    start = end - timedelta(days=days - 1)
    return [(d, v) for d, v in series.items() if start <= d <= end]


def compute_features(daily: dict[str, dict[date, float]], normals: dict[str, dict[int, float]],
                     end: date) -> dict:
    """Características que consume el grafo y el modelo. null si la cobertura no alcanza."""
    rh = window(daily.get("RH2M", {}), end, 14)
    t = window(daily.get("T2M", {}), end, 14)
    rain = window(daily.get("PRECTOTCORR", {}), end, 30)

    humidity = round(sum(v for _, v in rh) / len(rh), 2) if len(rh) >= 14 * MIN_COVERAGE else None
    lo, hi = RUST_TEMP_RANGE_C
    optimal_days = sum(lo <= v <= hi for _, v in t) if len(t) >= 14 * MIN_COVERAGE else None

    rain_anomaly = None
    rain_normals = normals.get("PRECTOTCORR", {})
    if len(rain) >= 30 * MIN_COVERAGE and rain_normals:
        expected = sum(rain_normals[d.month] for d, _ in rain)  # normal de los mismos días con dato
        if expected > 0:
            rain_anomaly = round(sum(v for _, v in rain) / expected, 2)

    return {
        "humidity_mean_14d": humidity,
        "rain_anomaly_30d": rain_anomaly,
        "temp_optimal_days_14d": optimal_days,
        "dataset_ids": [DATASET_ID],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--days", type=int, default=120, help="días de historia diaria a cargar")
    parser.add_argument("--cache-dir", type=Path, default=Path("backend/data/nasa_power"))
    parser.add_argument("--offline", action="store_true", help="usar solo la caché local")
    args = parser.parse_args()

    db_url = os.getenv("DATABASE_URL", "postgresql://postgres:postgres@localhost:54322/agro")
    today = datetime.now(timezone.utc).date()
    start, end = today - timedelta(days=args.days), today - timedelta(days=1)

    with psycopg.connect(db_url, row_factory=dict_row) as conn:
        plots = conn.execute("select id, latitude, longitude, is_demo from public.plots order by id").fetchall()
        if not plots:
            raise SystemExit("public.plots está vacío: carga primero las parcelas (backend/seed/demo_seed.sql). "
                             "No uses reset_db.sh contra Supabase: borra el esquema public.")

        # Parcela -> celda. Las que están fuera de la región quedan sin mapa (cobertura cero).
        cells: dict[str, tuple[float, float]] = {}
        plot_cell: dict[str, tuple[str, float]] = {}
        for p in plots:
            if not in_region(p["latitude"], p["longitude"]):
                print(f"{p['id']}: fuera de la región, sin celda")
                continue
            lat, lon = snap_to_cell(p["latitude"], p["longitude"])
            cid = cell_id_for(lat, lon)
            cells[cid] = (lat, lon)
            plot_cell[p["id"]] = (cid, round(haversine_km(p["latitude"], p["longitude"], lat, lon), 2))

        daily: dict[str, dict[str, dict[date, float]]] = {}
        normals: dict[str, dict[str, dict[int, float]]] = {}
        for cid, (lat, lon) in sorted(cells.items()):
            print(f"Descargando {cid} ...")
            body = fetch_json(
                power_url("daily", lat, lon, start=start.strftime("%Y%m%d"), end=end.strftime("%Y%m%d")),
                args.cache_dir / f"{cid}_daily.json", args.offline)
            daily[cid] = parse_daily(body)
            clim = fetch_json(power_url("climatology", lat, lon), args.cache_dir / f"{cid}_climatology.json",
                              args.offline)
            normals[cid] = {
                param: {i + 1: series[m] for i, m in enumerate(MONTHS) if series.get(m, FILL_VALUE) != FILL_VALUE}
                for param, series in clim["properties"]["parameter"].items()
            }

        all_dates = [d for c in daily.values() for s in c.values() for d in s]
        coverage_start, coverage_end = (min(all_dates), max(all_dates)) if all_dates else (None, None)

        with conn.transaction():
            conn.execute(
                """
                insert into env.datasets (dataset_id, name, source, license, loaded_at, is_demo, notes)
                values (%s, %s, %s, %s, now(), false, %s)
                on conflict (dataset_id) do update set loaded_at = now(), notes = excluded.notes
                """,
                (DATASET_ID, "NASA POWER Daily (AG community)", "https://power.larc.nasa.gov/",
                 "NASA open data, sin restricciones de uso; citar NASA LaRC POWER Project",
                 "Malla ~50 km (0.5° x 0.625°): no capta el microclima de cada parcela (sombra, altitud, ladera). "
                 "Normales: climatología POWER 2001-2020. Datos con 1-3 días de retraso."),
            )
            for cid, (lat, lon) in cells.items():
                conn.execute(
                    """
                    insert into env.grid_cells (cell_id, latitude, longitude, dataset_id) values (%s, %s, %s, %s)
                    on conflict (cell_id) do nothing
                    """,
                    (cid, lat, lon, DATASET_ID),
                )
            with conn.cursor() as cur:
                cur.executemany(
                    """
                    insert into env.daily_observations (cell_id, date, variable_code, value, dataset_id)
                    values (%s, %s, %s, %s, %s)
                    on conflict (cell_id, variable_code, date) do update set value = excluded.value
                    """,
                    [(cid, d, VARIABLES[param][0], v, DATASET_ID)
                     for cid, by_param in daily.items() for param, series in by_param.items()
                     if param in VARIABLES for d, v in series.items()],
                )
                cur.executemany(
                    """
                    insert into env.climatology (cell_id, variable_code, month, mean, std)
                    values (%s, %s, %s, %s, null)
                    on conflict (cell_id, variable_code, month) do update set mean = excluded.mean
                    """,
                    [(cid, VARIABLES[param][0], month, mean)
                     for cid, by_param in normals.items() for param, series in by_param.items()
                     if param in VARIABLES for month, mean in series.items()],
                )
            for param, (code, label, unit, aggs) in VARIABLES.items():
                conn.execute(
                    """
                    insert into env.variable_catalog (variable_code, label, unit, description, temporal_resolution,
                      coverage_start, coverage_end, allowed_aggregations, dataset_id)
                    values (%s, %s, %s, %s, 'daily', %s, %s, %s, %s)
                    on conflict (variable_code) do update set label = excluded.label, unit = excluded.unit,
                      description = excluded.description, coverage_start = excluded.coverage_start,
                      coverage_end = excluded.coverage_end, allowed_aggregations = excluded.allowed_aggregations
                    """,
                    (code, label, unit, f"NASA POWER {param}, celda de ~50 km; normales 2001-2020",
                     coverage_start, coverage_end, aggs, DATASET_ID),
                )

            plot_ids = [p["id"] for p in plots]
            conn.execute("delete from env.plot_cell_map where plot_id = any(%s)", (plot_ids,))
            for pid, (cid, dist) in plot_cell.items():
                conn.execute("insert into env.plot_cell_map (plot_id, cell_id, distance_km) values (%s, %s, %s)",
                             (pid, cid, dist))

            # Un resumen por parcela mapeada; las de fuera de región quedan sin resumen (prioridad unknown).
            computed_at = datetime.now(timezone.utc)
            latest_dates = []
            for pid, (cid, _) in sorted(plot_cell.items()):
                cell_daily = daily[cid]
                dates = set.intersection(*(set(s) for s in cell_daily.values())) if cell_daily else set()
                if dates:
                    last = max(dates)
                    latest_dates.append(last)
                    features = compute_features(cell_daily, normals[cid], last)
                    freshness = "fresh" if (today - last).days <= FRESH_MAX_AGE_DAYS else "stale"
                else:
                    features = {"humidity_mean_14d": None, "rain_anomaly_30d": None,
                                "temp_optimal_days_14d": None, "dataset_ids": [DATASET_ID]}
                    freshness = "unknown"
                conn.execute(
                    "insert into env.plot_summary (plot_id, computed_at, features, data_freshness) values (%s, %s, %s, %s)",
                    (pid, computed_at, Jsonb(features), freshness),
                )
                print(f"{pid}: {cid} {features} {freshness}")

            if conn.execute("select to_regclass('public.outbox_events') as t").fetchone()["t"] is not None:
                conn.execute(
                    "insert into public.outbox_events (is_demo, event_type, aggregate_id, payload) values (%s, %s, %s, %s)",
                    (all(p["is_demo"] for p in plots), "env.summary_refreshed", "env.plot_summary", Jsonb({
                        "plot_ids": sorted(plot_cell),
                        "computed_at": computed_at.isoformat(),
                        "latest_data_date": max(latest_dates).isoformat() if latest_dates else None,
                        "dataset_ids": [DATASET_ID],
                    })),
                )

    print(f"Listo: {len(cells)} celdas, {len(plot_cell)}/{len(plots)} parcelas con resumen.")


if __name__ == "__main__":
    main()

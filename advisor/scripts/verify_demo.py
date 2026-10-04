"""Verificación live del asesor real (no corre en CI)."""

from __future__ import annotations

import json
import os
import statistics
import time
import uuid

import httpx

from advisor.env import load_dotenv

load_dotenv()

BASE = os.getenv("ADVISOR_BACKEND_BASE_URL", "http://127.0.0.1:8000").rstrip("/")


def ask_payload(session_id: str, *, answers: list[dict] | None = None) -> dict:
    return {
        "schema_version": "2.0",
        "session_id": session_id,
        "plot_id": "plot_demo_01",
        "language": "es",
        "observation": {
            "observed_at": None,
            "symptoms": ["manchas amarillas en hojas"],
            "user_statement": "Tengo manchas amarillas en las hojas",
            "measurements": [],
            "answers": answers or [],
            "completeness": "partial" if not answers else "sufficient",
        },
        "asked_need_codes": [item["need_code"] for item in (answers or [])],
        "plot_context": {"crop": "coffee"},
        "is_demo": True,
    }


def advise_payload(session_id: str) -> dict:
    body = ask_payload(
        session_id,
        answers=[{
            "need_code": "leaf_underside",
            "value": "polvo naranja o amarillo",
            "raw_text": "polvo naranja o amarillo",
            "unknown": False,
        }],
    )
    body["plot_id"] = "plot_demo_02"
    return body


def main() -> None:
    client = httpx.Client(timeout=20.0)
    health = client.get(f"{BASE}/health")
    health.raise_for_status()

    session_ask = f"session_live_ask_{uuid.uuid4().hex[:8]}"
    t0 = time.perf_counter()
    ask = client.post(f"{BASE}/v1/assessments", json=ask_payload(session_ask))
    ask_s = time.perf_counter() - t0
    print("ASK_STATUS", ask.status_code, f"{ask_s:.2f}s")
    print(json.dumps(ask.json(), ensure_ascii=False, indent=2))
    if ask.status_code != 200:
        raise SystemExit("ask_more failed")

    session_adv = f"session_live_adv_{uuid.uuid4().hex[:8]}"
    t0 = time.perf_counter()
    advise = client.post(f"{BASE}/v1/assessments", json=advise_payload(session_adv))
    adv_s = time.perf_counter() - t0
    print("ADVISE_STATUS", advise.status_code, f"{adv_s:.2f}s")
    print(json.dumps(advise.json(), ensure_ascii=False, indent=2))
    if advise.status_code != 200:
        raise SystemExit("advise failed")

    report = client.post(
        f"{BASE}/v1/reports",
        headers={"Idempotency-Key": f"live-{advise.json()['assessment_id']}"},
        json={
            "schema_version": "2.0",
            "session_id": session_adv,
            "plot_id": "plot_demo_02",
            "channel": "voice",
            "symptoms": ["manchas amarillas en hojas"],
            "user_statement": "Tengo manchas amarillas en las hojas",
            "completeness": "sufficient",
            "assessment_id": advise.json()["assessment_id"],
            "is_demo": True,
        },
    )
    print("REPORT_STATUS", report.status_code, report.text[:300])
    followups = client.get(f"{BASE}/v1/followups").json()["followups"]
    match = next(item for item in followups if item["plot_id"] == "plot_demo_02")
    print("GUIDANCE_GIVEN", match["case_summary"].get("guidance_given"))

    times = [ask_s, adv_s]
    payloads = [ask_payload(f"session_lat_ask_{i}") for i in range(4)] + [
        advise_payload(f"session_lat_adv_{i}") for i in range(4)
    ]
    for payload in payloads:
        t0 = time.perf_counter()
        resp = client.post(f"{BASE}/v1/assessments", json=payload)
        elapsed = time.perf_counter() - t0
        times.append(elapsed)
        print(f"LAT {elapsed:.2f}s {resp.status_code} {resp.json().get('disposition') if resp.status_code==200 else resp.text[:80]}")
    times.sort()
    def pct(p: float) -> float:
        idx = min(len(times) - 1, max(0, round((p / 100) * (len(times) - 1))))
        return times[idx]
    print(f"N={len(times)} p50={pct(50):.2f}s p95={pct(95):.2f}s mean={statistics.mean(times):.2f}s max={times[-1]:.2f}s")
    print("VERIFY_DONE")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Entrena la regresión lineal explicable y exporta el artefacto para dev 3."""

from __future__ import annotations

import argparse
import csv
import json
import random
from datetime import UTC, datetime
from pathlib import Path
from statistics import fmean, pstdev

FEATURES = ("rain_anomaly_30d", "temp_max_mean_14d", "humidity_mean_14d", "extreme_heat_days_14d", "direct_active_reports", "neighbor_source_exposure", "nearest_source_distance_km", "resolved_cases_last_90d")
REQUIRED_FEATURES = {"rain_anomaly_30d", "humidity_mean_14d", "direct_active_reports", "neighbor_source_exposure"}


def load_rows(path: Path) -> list[dict[str, float]]:
    with path.open(newline="", encoding="utf-8") as file:
        rows = [{key: float(value) for key, value in row.items()} for row in csv.DictReader(file)]
    if len(rows) < 4:
        raise ValueError("Se requieren al menos 4 filas")
    missing = set(FEATURES).union({"target"}) - set(rows[0])
    if missing:
        raise ValueError(f"Faltan columnas: {', '.join(sorted(missing))}")
    return rows


def split_rows(rows: list[dict[str, float]], seed: int = 42) -> tuple[list[dict[str, float]], list[dict[str, float]]]:
    shuffled = rows.copy()
    random.Random(seed).shuffle(shuffled)
    cutoff = max(2, round(len(shuffled) * 0.8))
    return shuffled[:cutoff], shuffled[cutoff:]


def solve(matrix: list[list[float]], vector: list[float]) -> list[float]:
    size = len(vector)
    augmented = [matrix[index][:] + [vector[index]] for index in range(size)]
    for pivot in range(size):
        best = max(range(pivot, size), key=lambda row: abs(augmented[row][pivot]))
        if abs(augmented[best][pivot]) < 1e-12:
            raise ValueError("Matriz singular; se necesitan datos más variados")
        augmented[pivot], augmented[best] = augmented[best], augmented[pivot]
        divisor = augmented[pivot][pivot]
        augmented[pivot] = [value / divisor for value in augmented[pivot]]
        for row in range(size):
            if row != pivot:
                factor = augmented[row][pivot]
                augmented[row] = [value - factor * base for value, base in zip(augmented[row], augmented[pivot])]
    return [row[-1] for row in augmented]


def fit(train: list[dict[str, float]]) -> tuple[float, dict[str, float], dict[str, float], dict[str, float]]:
    means = {feature: fmean(row[feature] for row in train) for feature in FEATURES}
    stds = {feature: max(pstdev(row[feature] for row in train), 1e-6) for feature in FEATURES}
    design = [[1.0] + [(row[name] - means[name]) / stds[name] for name in FEATURES] for row in train]
    target = [row["target"] for row in train]
    width = len(FEATURES) + 1
    gram = [[sum(row[i] * row[j] for row in design) + (1e-6 if i == j and i else 0.0) for j in range(width)] for i in range(width)]
    rhs = [sum(row[i] * value for row, value in zip(design, target)) for i in range(width)]
    coefficients = solve(gram, rhs)
    return coefficients[0], dict(zip(FEATURES, coefficients[1:])), means, stds


def score(row: dict[str, float], intercept: float, coefficients: dict[str, float], means: dict[str, float], stds: dict[str, float]) -> float:
    raw = intercept + sum(coefficients[name] * (row[name] - means[name]) / stds[name] for name in FEATURES)
    return min(1.0, max(0.0, raw))


def priority(value: float) -> str:
    return "high" if value >= 0.70 else "medium" if value >= 0.40 else "low"


def build_artifact(rows: list[dict[str, float]], version: str) -> dict:
    train, test = split_rows(rows)
    intercept, coefficients, means, stds = fit(train)
    actual = [row["target"] for row in test]
    predicted = [score(row, intercept, coefficients, means, stds) for row in test]
    mae = fmean(abs(value - estimate) for value, estimate in zip(actual, predicted))
    total = sum((value - fmean(actual)) ** 2 for value in actual)
    r2 = 1 - sum((value - estimate) ** 2 for value, estimate in zip(actual, predicted)) / total if total else 0.0
    vectors = [{"input": {name: row[name] for name in FEATURES}, "expected_score": round(score(row, intercept, coefficients, means, stds), 8), "expected_priority": priority(score(row, intercept, coefficients, means, stds))} for row in test[:3]]
    return {"model_id": "risk_linear", "model_version": version, "threat_code": "coffee_leaf_rust", "target": "rust_pressure_index: presión esperada de roya en 30 días", "trained_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"), "features": [{"name": name, "mean": means[name], "std": stds[name], "coef": coefficients[name], "required": name in REQUIRED_FEATURES} for name in FEATURES], "intercept": intercept, "score_range": [0, 1], "cutoffs": {"medium": 0.40, "high": 0.70}, "metrics": {"mae": mae, "r2": r2, "n_train": len(train), "n_test": len(test)}, "labels_are_synthetic": True, "heuristic": False, "test_vectors": vectors}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--version", default="1.0.0")
    args = parser.parse_args()
    artifact = build_artifact(load_rows(args.input), args.version)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(artifact, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()

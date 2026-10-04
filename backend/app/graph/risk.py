"""Applies the risk model artifact (INSTRUCTIONS.md section 5.2):
score = intercept + sum(coef * (x - mean) / std), clipped to score_range, compared with cutoffs.
"""

from dataclasses import dataclass, field

from contracts.models import RiskModelArtifact


@dataclass
class RiskResult:
    score: float | None
    priority: str
    contributions: list[tuple[str, float]] = field(default_factory=list)  # top 3 by magnitude
    missing_features: list[str] = field(default_factory=list)


def apply_artifact(artifact: RiskModelArtifact, inputs: dict[str, float | None]) -> RiskResult:
    missing = [f.name for f in artifact.features if f.required and inputs.get(f.name) is None]
    if missing:
        return RiskResult(score=None, priority="unknown", missing_features=missing)

    contributions = [
        (f.name, f.coef * (inputs[f.name] - f.mean) / f.std)
        for f in artifact.features
        if inputs.get(f.name) is not None
    ]
    low, high = artifact.score_range
    score = round(min(max(artifact.intercept + sum(v for _, v in contributions), low), high), 4)

    if score >= artifact.cutoffs.high:
        priority = "high"
    elif score >= artifact.cutoffs.medium:
        priority = "medium"
    else:
        priority = "low"

    top = sorted(contributions, key=lambda c: abs(c[1]), reverse=True)[:3]
    return RiskResult(score=score, priority=priority, contributions=[(n, round(v, 4)) for n, v in top])


def check_test_vectors(artifact: RiskModelArtifact, tolerance: float = 1e-3) -> list[str]:
    """Returns the failures; an artifact is only activated when this is empty."""
    failures = []
    for i, vector in enumerate(artifact.test_vectors):
        result = apply_artifact(artifact, vector.input)
        if result.priority != vector.expected_priority:
            failures.append(f"vector {i}: priority {result.priority} != {vector.expected_priority}")
        elif vector.expected_score is not None and abs(result.score - vector.expected_score) > tolerance:
            failures.append(f"vector {i}: score {result.score} != {vector.expected_score}")
    return failures

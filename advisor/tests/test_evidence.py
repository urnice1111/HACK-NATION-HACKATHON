from advisor.contracts import Disposition, ResolvedCaseMention
from advisor.evidence import cultural_speech, data_used_from_queries, mentions_from_search, summarize_env


def test_data_used_comes_only_from_real_env_payloads() -> None:
    used = data_used_from_queries(
        [
            {
                "query_id": "q_real_01",
                "data_freshness": "fresh",
                "dataset_ids": ["dataset_nasa_power"],
                "results": [
                    {"code": "humidity_pct", "value": 88.0, "unit": "%", "anomaly_ratio": 1.2},
                    {"code": "precip_mm", "value": 42.0, "unit": "mm", "anomaly_ratio": 0.8},
                ],
            },
            {"error": {"code": "dependency_timeout"}},
            {"query_id": "ignored"},
        ]
    )
    assert len(used) == 1
    assert used[0].query_id == "q_real_01"
    assert used[0].dataset_ids == ["dataset_nasa_power"]
    assert "por encima de lo normal" in used[0].summary
    assert "por debajo de lo normal" in used[0].summary


def test_summarize_env_declares_missing_values() -> None:
    summary = summarize_env({"results": [{"code": "humidity_pct", "value": None, "unit": "%"}]})
    assert "sin dato suficiente" in summary


def test_mentions_drop_invented_and_unapproved_ids() -> None:
    results = [
        {
            "resolution_id": "resolution_demo_01",
            "matches_protocol": True,
            "verification": "verified",
            "solution_codes": ["remove_affected_leaves"],
        },
        {
            "resolution_id": "resolution_demo_03",
            "matches_protocol": False,
            "verification": "farmer_reported",
            "solution_codes": ["copper_fungicide"],
        },
    ]
    invented = [
        ResolvedCaseMention(
            resolution_id="resolution_inventada",
            summary_for_speech="inventado",
            verification="verified",
        ),
        ResolvedCaseMention(
            resolution_id="resolution_demo_03",
            summary_for_speech="caldo bordelés 3 kilos",
            verification="farmer_reported",
        ),
    ]
    mentions = mentions_from_search(results, invented, Disposition.advise)
    assert [item.resolution_id for item in mentions] == ["resolution_demo_01"]
    assert "kilos" not in mentions[0].summary_for_speech
    assert "bordelés" not in mentions[0].summary_for_speech


def test_advise_adds_protocol_mention_when_model_omits_it() -> None:
    results = [
        {
            "resolution_id": "resolution_demo_02",
            "matches_protocol": True,
            "verification": "farmer_reported",
            "solution_codes": ["remove_affected_leaves", "regulate_shade"],
        }
    ]
    mentions = mentions_from_search(results, [], Disposition.advise)
    assert mentions[0].resolution_id == "resolution_demo_02"
    assert "retirar y enterrar" in mentions[0].summary_for_speech
    assert "sombra" in mentions[0].summary_for_speech


def test_ask_more_does_not_inject_mentions() -> None:
    results = [
        {
            "resolution_id": "resolution_demo_01",
            "matches_protocol": True,
            "verification": "verified",
            "solution_codes": ["remove_affected_leaves"],
        }
    ]
    assert mentions_from_search(results, [], Disposition.ask_more) == []


def test_cultural_speech_never_includes_product() -> None:
    speech = cultural_speech(
        {
            "resolution_id": "resolution_demo_03",
            "verification": "farmer_reported",
            "solution_codes": ["copper_fungicide"],
        }
    )
    assert "caldo" not in speech.lower()
    assert "kilos" not in speech

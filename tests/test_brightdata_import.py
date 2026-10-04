import json

import pytest

from backend.scripts.import_brightdata_context import read_records, source_id_for
from backend.scripts.refresh_brightdata_context import job_id_from, load_dotenv, records_from_payload


def test_read_records_accepts_brightdata_json(tmp_path):
    output = tmp_path / "result.json"
    output.write_text(json.dumps([{
        "url": "https://publicaciones.cenicafe.org/index.php/infografias/article/view/2828",
        "title": "Roya del cafeto",
        "content": "Texto técnico extraído de la página.",
    }]))

    records = read_records(output)
    assert records[0]["title"] == "Roya del cafeto"
    assert source_id_for(records[0]["url"]).startswith("brightdata_cenicafe_")


def test_read_records_rejects_unapproved_host_and_url_as_content(tmp_path):
    output = tmp_path / "bad.json"
    output.write_text(json.dumps({
        "url": "https://example.com/page",
        "title": "x",
        "content": "https://example.com/page",
    }))

    with pytest.raises(ValueError, match="Fuente no aprobada"):
        read_records(output)


def test_read_records_normalizes_markdown_url_and_rejects_fungicide_guidance(tmp_path):
    output = tmp_path / "unsafe.json"
    url = "https://publicaciones.cenicafe.org/index.php/infografias/article/view/2828"
    output.write_text(json.dumps({
        "url": f"[{url}]({url})",
        "title": "Roya del cafeto",
        "content": "Se recomienda aplicación de fungicidas cada 60 días.",
    }))

    with pytest.raises(ValueError, match="fungicidas"):
        read_records(output)


def test_brightdata_response_helpers_accept_expected_job_and_records():
    class Response:
        text = ""

        def json(self):
            return {"collection_id": "j_brightdata_test"}

    assert job_id_from(Response()) == "j_brightdata_test"
    assert records_from_payload({"data": [{"url": "x"}]}) == [{"url": "x"}]


def test_load_dotenv_does_not_override_exported_value(tmp_path, monkeypatch):
    env_file = tmp_path / ".env"
    env_file.write_text("BRIGHT_DATA_COLLECTOR_ID=c_from_file\n# comentario\n")
    monkeypatch.delenv("BRIGHT_DATA_COLLECTOR_ID", raising=False)
    load_dotenv(env_file)
    assert __import__("os").environ["BRIGHT_DATA_COLLECTOR_ID"] == "c_from_file"
    monkeypatch.setenv("BRIGHT_DATA_COLLECTOR_ID", "c_exported")
    load_dotenv(env_file)
    assert __import__("os").environ["BRIGHT_DATA_COLLECTOR_ID"] == "c_exported"

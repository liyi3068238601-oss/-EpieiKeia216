"""Read model metadata from the user-selected gateway; no generation requests."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from time import monotonic
from urllib.parse import urlsplit

import httpx
import yaml


def main(output: Path) -> int:
    runtime_root = Path(r"C:\Users\liyi\.dsh")
    settings = yaml.safe_load((runtime_root / "settings.yaml").read_text(encoding="utf-8-sig"))
    provider = settings["llm-pi-ai"]["providers"]["a7877"]
    model = settings["agent-default-model"]["model"]
    credentials = yaml.safe_load((runtime_root / ".credentials.yaml").read_text(encoding="utf-8-sig"))
    key = credentials.get("refs", {}).get(provider["apiKeyEnv"])
    if not isinstance(key, str) or not key.startswith("sk-"):
        raise RuntimeError("Configured credential is not a supported literal API key; no request sent")
    base_url = provider["baseURL"].rstrip("/")
    endpoint = urlsplit(base_url)
    started = monotonic()
    report = {"date": "2026-10-01", "method": "GET", "path": endpoint.path + "/models",
              "provider": "7877", "hostname": endpoint.hostname, "model_calls": 0,
              "configured_model": model, "credential_values_recorded": False}
    try:
        response = httpx.get(base_url + "/models", headers={"Authorization": "Bearer " + key},
                             timeout=25, follow_redirects=False)
        report["http_status"] = response.status_code
        report["response_sha256"] = hashlib.sha256(response.content).hexdigest()
        if response.status_code == 200:
            data = response.json().get("data", [])
            names = [entry.get("id") for entry in data if isinstance(entry, dict)]
            configured = {entry["id"] for entry in provider.get("models", [])}
            report["advertised_model_count"] = len(names)
            report["configured_models_advertised"] = [name for name in names if name in configured]
            report["selected_model_advertised"] = model in names
            report["availability_scope"] = "metadata only; generation and runtime integration not tested"
        else:
            report["availability_scope"] = "metadata request failed; no generation attempted"
    except Exception as error:
        report["error_type"] = type(error).__name__
    finally:
        key = None
    report["elapsed_seconds"] = round(monotonic() - started, 3)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=True))
    return 0 if report.get("http_status") == 200 and report.get("selected_model_advertised") else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    raise SystemExit(main(args.output))

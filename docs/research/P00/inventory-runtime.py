"""Read-only, allowlisted runtime/model metadata; never emits credential values."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from urllib.parse import urlsplit

import yaml


def hostname(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    try:
        return urlsplit(value).hostname
    except ValueError:
        return None


def inventory() -> dict:
    result = {"date": "2026-10-01", "read_only": True, "model_calls": 0,
              "availability_not_tested": True, "providers": [], "errors": []}
    zcode = Path(r"C:\Users\liyi\.zcode\v2\config.json")
    try:
        data = json.loads(zcode.read_text(encoding="utf-8-sig"))
        for provider_id, provider in data.get("provider", {}).items():
            options = provider.get("options", {})
            models = provider.get("models", {})
            result["providers"].append({
                "runtime": "zcode", "metadata_source": str(zcode),
                "provider_id": provider_id, "name": provider.get("name"),
                "enabled": provider.get("enabled", True), "kind": provider.get("kind"),
                "endpoint_host": hostname(options.get("baseURL") or options.get("baseUrl")),
                "credential_present_in_options": bool(options.get("apiKey") or options.get("api_key")),
                "model_ids": list(models) if isinstance(models, dict) else
                    [model.get("id") for model in models if isinstance(model, dict)],
            })
    except Exception as error:
        result["errors"].append({"path": str(zcode), "error_type": type(error).__name__})
    dsh = Path(r"C:\Users\liyi\.dsh\settings.yaml")
    try:
        data = yaml.safe_load(dsh.read_text(encoding="utf-8-sig")) or {}
        result["dsh_default_model"] = data.get("agent-default-model")
        for provider_id, provider in data.get("llm-pi-ai", {}).get("providers", {}).items():
            result["providers"].append({
                "runtime": "dsh", "metadata_source": str(dsh),
                "provider_id": provider_id, "name": provider.get("displayName"),
                "endpoint_host": hostname(provider.get("baseURL")),
                "credential_environment_name": provider.get("apiKeyEnv"), "api": provider.get("api"),
                "models": [{key: model.get(key) for key in
                    ("id", "name", "contextWindow", "maxTokens", "input")}
                    for model in provider.get("models", [])],
            })
    except Exception as error:
        result["errors"].append({"path": str(dsh), "error_type": type(error).__name__})
    result["locations"] = [{"path": path, "exists": Path(path).exists()} for path in (
        r"E:\Xiadie\Xiadie\Xiadie-next", r"E:\Xiadie\Xiadie-next",
        r"D:\ZCode", r"D:\Deepseek Harness\deepseek-harness",
        r"C:\Users\liyi\.zcode", r"C:\Users\liyi\.dsh", r"F:\test\dsh-comfyui-ctl",
    )]
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    text = json.dumps(inventory(), ensure_ascii=False, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text + "\n", encoding="utf-8")
    else:
        print(text)

"""P03 owned loopback relay mapped from the accepted P01 transport.

Only Read target/content assertions and the failure reply differ. P01 remains
unchanged; Native Read results are inspected before a synthetic reply is sent.
"""
from __future__ import annotations
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import threading
import time

def configure(harness):
    for name in ("TITLE_SIDECAR_SOURCE", "HarnessError", "scenario_prompt",
                 "summarize_request_shape", "SYNTHETIC_KEY", "CLIENT_DISCONNECT_ERRORS",
                 "KNOWN_CLIENT_DISCONNECT_CODES", "write_json"):
        globals()[name] = getattr(harness, name)

class MockRelay:
    """One per UI scenario; only a dynamic 127.0.0.1 listener exists."""

    def read_native_title_system_prompt(self) -> str:
        source = TITLE_SIDECAR_SOURCE.read_text(encoding="utf-8")
        match = re.search(r"const SESSION_TITLE_SYSTEM_PROMPT = `([^`]*)`;", source, re.DOTALL)
        if match is None or "${" in match.group(1):
            raise HarnessError("pinned_title_prompt_unavailable")
        return match.group(1)

    def has_native_title_messages(self, body: dict) -> bool:
        messages = body.get("messages")
        if not isinstance(messages, list) or len(messages) != 2:
            return False
        system, user = messages
        return (
            isinstance(system, dict) and system.get("role") == "system"
            and system.get("content") == self.title_system_prompt
            and isinstance(user, dict) and user.get("role") == "user"
            and user.get("content") == scenario_prompt("disabled_native")
        )

    def wait_for_cancel_observation(self, timeout_seconds: float = 2.0) -> bool:
        deadline = time.monotonic() + timeout_seconds
        expected = {"schema": "p01-u10-cancel-observed/v1", "scenario_id": "cancel_recovery",
                    "action": "clicked-native-stop-button"}
        while time.monotonic() < deadline:
            try:
                if json.loads(self.cancel_observed_file.read_text(encoding="utf-8")) == expected:
                    return True
            except (OSError, json.JSONDecodeError):
                pass
            time.sleep(0.02)
        return False

    def __init__(self, scenario_id: str, output: Path, workspace: Path, expected_post_count: int, offline: bool = False):
        self.scenario_id = scenario_id
        self.output = output
        self.workspace = workspace
        self.memory_target: str | None = None
        self.expected_post_count = expected_post_count
        self.offline = offline
        self.records: list[dict] = []
        self.lock = threading.Lock()
        self.server: ThreadingHTTPServer | None = None
        self.title_system_prompt = self.read_native_title_system_prompt()
        self.cancel_observed_file = output / "cancel-observed.json"

        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                return

            def send_body(self, status: int, content_type: str, payload: bytes):
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Cache-Control", "no-store")
                self.send_header("Connection", "close")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                try:
                    self.wfile.write(payload)
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def do_GET(self):
                if self.path == "/v1/models":
                    payload = {"object": "list", "data": [
                        {"id": "deepseek-flash", "object": "model", "owned_by": "p01-u10"},
                        {"id": "deepseek-v4-pro", "object": "model", "owned_by": "p01-u10"},
                    ]}
                    self.send_body(200, "application/json", json.dumps(payload).encode())
                else:
                    self.send_body(404, "application/json", b'{"error":{"message":"P01 route denied"}}')

            def do_POST(self):
                if self.path != "/v1/chat/completions":
                    self.send_body(404, "application/json", b'{"error":{"message":"P01 route denied"}}')
                    return
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                    if length <= 0 or length > 1024 * 1024:
                        raise HarnessError("request_size_invalid")
                    body_bytes = self.rfile.read(length)
                    body = json.loads(body_bytes)
                    if not isinstance(body, dict):
                        raise HarnessError("request_body_invalid")
                except Exception:
                    with outer.lock:
                        outer.records.append({"request_index": len(outer.records) + 1, "accepted": False,
                                              "reason": "invalid_request", "status": 400})
                    self.send_body(400, "application/json", b'{"error":{"message":"P01 request denied"}}')
                    return

                with outer.lock:
                    index = len(outer.records) + 1
                    record = {
                        "request_index": index,
                        "accepted": False,
                        "request_sha256": hashlib.sha256(body_bytes).hexdigest(),
                        "request_bytes": len(body_bytes),
                        "request_shape": summarize_request_shape(body),
                        "model": body.get("model") if isinstance(body.get("model"), str) else None,
                        "stream": body.get("stream") is True,
                        "auth_present": bool(self.headers.get("Authorization")),
                        "synthetic_auth_only": self.headers.get("Authorization") == f"Bearer {SYNTHETIC_KEY}",
                        "messages_count": len(body.get("messages", [])) if isinstance(body.get("messages"), list) else None,
                        "tool_names": sorted({
                            tool.get("function", {}).get("name")
                            for tool in body.get("tools", [])
                            if isinstance(tool, dict) and isinstance(tool.get("function"), dict)
                            and isinstance(tool["function"].get("name"), str)
                        }) if isinstance(body.get("tools"), list) else [],
                        "assistant_tool_call_ids": [],
                        "tool_result_ids": [],
                        "upstream_attempted": False,
                        "auxiliary_title": outer.has_native_title_messages(body),
                    }
                    outer.records.append(record)

                try:
                    self.validate_request(body, record, index)
                    if outer.offline:
                        record.update({"accepted": True, "status": 503, "offline_reject": True})
                        self.send_body(503, "application/json", b'{"error":{"message":"P01 offline mock refusal"}}')
                        return
                    if outer.scenario_id == "no_key":
                        raise HarnessError("no_key_request_must_be_refused_before_relay")
                    if outer.scenario_id == "pro_denied":
                        raise HarnessError("unqualified_pro_request_must_be_refused_before_relay")
                    record["accepted"] = True
                    record["status"] = 200
                    if record["auxiliary_title"]:
                        title_response = {
                            "id": "chatcmpl-p01-u10-title",
                            "object": "chat.completion",
                            "created": 1,
                            "model": "deepseek-flash",
                            "choices": [{
                                "index": 0,
                                "message": {"role": "assistant", "content": '{"title":"U10 原生 UI 测试"}'},
                                "finish_reason": "stop",
                            }],
                            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
                        }
                        self.send_body(200, "application/json", json.dumps(title_response, ensure_ascii=False).encode("utf-8"))
                    else:
                        self.send_sse(index, record)
                except CLIENT_DISCONNECT_ERRORS as error:
                    error_code = getattr(error, "winerror", None)
                    if not isinstance(error_code, int):
                        error_code = getattr(error, "errno", None)
                    if not isinstance(error_code, int):
                        error_code = None
                    cancel_confirmed = (
                        outer.scenario_id == "cancel_recovery" and index == 1
                        and record.get("partial_stream_sent") is True
                        and type(error) in CLIENT_DISCONNECT_ERRORS
                        and error_code in KNOWN_CLIENT_DISCONNECT_CODES
                        and outer.wait_for_cancel_observation()
                    )
                    if cancel_confirmed:
                        record.update({
                            "accepted": True,
                            "status": 200,
                            "client_cancelled": True,
                            "cancel_confirmation": {
                                "source": "native-stop-ui-action",
                                "exception_type": type(error).__name__,
                                "exception_code": error_code,
                            },
                        })
                    else:
                        record.update({"accepted": False, "status": 500,
                                       "reason": "unconfirmed_client_disconnect",
                                       "transport_error_type": type(error).__name__,
                                       "transport_error_code": error_code})
                        try:
                            self.send_body(500, "application/json", b'{"error":{"message":"P01 relay failure"}}')
                        except CLIENT_DISCONNECT_ERRORS:
                            pass
                except HarnessError as error:
                    record.update({"accepted": False, "status": 400, "reason": error.args[0] if error.args and re.fullmatch(r"[a-z0-9_]+", str(error.args[0])) else "request_policy_denied"})
                    self.send_body(400, "application/json", b'{"error":{"message":"P01 evaluation stopped"}}')
                except Exception:
                    record.update({"accepted": False, "status": 500, "reason": "relay_internal_failure"})
                    self.send_body(500, "application/json", b'{"error":{"message":"P01 relay failure"}}')

            def validate_request(self, body: dict, record: dict, index: int):
                if SYNTHETIC_KEY.encode() in json.dumps(body, ensure_ascii=False).encode():
                    raise HarnessError("synthetic_key_in_request_body")
                if outer.scenario_id not in {"no_key", "pro_denied"} and not record["synthetic_auth_only"]:
                    raise HarnessError("synthetic_auth_header_mismatch")
                messages = body.get("messages")
                if not isinstance(messages, list):
                    raise HarnessError("messages_missing")
                if record.get("auxiliary_title"):
                    if outer.scenario_id != "disabled_native" or index != 2:
                        raise HarnessError("unexpected_auxiliary_title_request")
                    stream_is_non_streaming = "stream" not in body or body.get("stream") is False
                    tools_are_empty = "tools" not in body or body.get("tools") == []
                    tool_choice_is_none_or_absent = (
                        "tool_choice" not in body or body.get("tool_choice") == "none"
                    )
                    if (body.get("model") != "deepseek-flash" or not stream_is_non_streaming
                            or not tools_are_empty or not tool_choice_is_none_or_absent):
                        raise HarnessError("auxiliary_title_request_shape_mismatch")
                    record["request_kind"] = "auxiliary_title"
                    return
                if body.get("model") != "deepseek-flash" or body.get("stream") is not True:
                    raise HarnessError("model_or_stream_mismatch")
                record["request_kind"] = "conversation"
                tool_calls = []
                tool_results = []
                for message in messages:
                    if not isinstance(message, dict):
                        continue
                    if message.get("role") == "assistant" and isinstance(message.get("tool_calls"), list):
                        for call in message["tool_calls"]:
                            if not isinstance(call, dict):
                                continue
                            function = call.get("function") if isinstance(call.get("function"), dict) else {}
                            tool_calls.append({"id": call.get("id"), "name": function.get("name"), "arguments": function.get("arguments")})
                    if message.get("role") == "tool":
                        tool_results.append({"id": message.get("tool_call_id"), "content": message.get("content")})
                record["assistant_tool_call_ids"] = [call["id"] for call in tool_calls if isinstance(call.get("id"), str)]
                record["tool_result_ids"] = [item["id"] for item in tool_results if isinstance(item.get("id"), str)]
                if outer.scenario_id in {"read_success", "read_failure"} and index == 1:
                    if "Read" not in record["tool_names"]:
                        raise HarnessError("read_tool_not_offered")
                    if tool_calls or tool_results:
                        raise HarnessError("unexpected_prior_tool_transcript")
                elif outer.scenario_id in {"read_success", "read_failure"} and index == 2:
                    matching = [call for call in tool_calls if call.get("name") == "Read"]
                    if len(matching) != 1 or len(tool_results) != 1:
                        raise HarnessError("read_continuation_not_correlated")
                    call = matching[0]
                    if not isinstance(call.get("id"), str) or call["id"] != tool_results[0].get("id"):
                        raise HarnessError("read_tool_call_id_mismatch")
                    try:
                        args = json.loads(call.get("arguments", ""))
                    except (TypeError, json.JSONDecodeError) as error:
                        raise HarnessError("read_arguments_invalid") from error
                    if outer.memory_target is None:
                        raise HarnessError("p03_memory_target_missing")
                    if not isinstance(args, dict) or args.get("file_path") != outer.memory_target:
                        raise HarnessError("read_target_mismatch")
                    record["correlated_tool_call_id"] = call["id"]
                    record["tool_result_sha256"] = hashlib.sha256(str(tool_results[0].get("content", "")).encode()).hexdigest()
                    content = str(tool_results[0].get("content", ""))
                    record["tool_result_success_shape"] = bool(content)
                    record["p03_marker_present"] = "P03_ONLY_READ_VALUE orchid-42" in content
                    record["p03_unselected_marker_present"] = "P03_UNSELECTED_READ_VALUE" in content
                    record["p03_permission_denied"] = "permission_denied" in content or "READ_NOT_ADMITTED" in content
                    if outer.scenario_id == "read_success" and not record["p03_marker_present"]:
                        raise HarnessError("p03_native_memory_content_missing")
                    if outer.scenario_id == "read_failure" and (record["p03_marker_present"] or record["p03_unselected_marker_present"] or not record["p03_permission_denied"]):
                        raise HarnessError("p03_unselected_memory_not_denied")
                if index > outer.expected_post_count:
                    raise HarnessError("unexpected_extra_model_request")

            def frame(self, delta: dict, finish_reason: str | None = None) -> bytes:
                frame = {"id": f"p01-u10-{outer.scenario_id}", "object": "chat.completion.chunk",
                         "created": 1, "model": "deepseek-flash",
                         "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}]}
                return ("data: " + json.dumps(frame, ensure_ascii=False) + "\n\n").encode("utf-8")

            def send_sse(self, index: int, record: dict):
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "close")
                self.end_headers()
                if outer.scenario_id in {"read_success", "read_failure"} and index == 1:
                    call_id = f"p01-u10-{outer.scenario_id}-read"
                    if outer.memory_target is None:
                        raise HarnessError("p03_memory_target_missing")
                    target = outer.memory_target
                    arguments = json.dumps({"file_path": target})
                    first = {"index": 0, "id": call_id, "type": "function",
                             "function": {"name": "Read", "arguments": arguments}}
                    self.wfile.write(self.frame({"role": "assistant", "tool_calls": [first]}))
                    self.wfile.flush()
                    self.wfile.write(self.frame({}, "tool_calls"))
                    self.wfile.write(b"data: [DONE]\n\n")
                    self.wfile.flush()
                    record = outer.records[index - 1]
                    record["tool_call_id"] = call_id
                    record["tool_target"] = target
                    return
                if outer.scenario_id == "cancel_recovery" and index == 1:
                    self.wfile.write(self.frame({"role": "assistant", "content": "这是一条尚未完成的本地测试回复"}))
                    self.wfile.flush()
                    record["partial_stream_sent"] = True
                    for _ in range(120):
                        time.sleep(0.25)
                        self.wfile.write(b": keepalive\n\n")
                        self.wfile.flush()
                    record = outer.records[index - 1]
                    record["stream_completed_without_cancel"] = True
                    self.wfile.write(self.frame({}, "stop"))
                    self.wfile.write(b"data: [DONE]\n\n")
                    self.wfile.flush()
                    return
                text = {
                    "success": "你好，我是遐蝶。我们可以慢慢聊。",
                    "read_success": "读到的标记是 orchid-42。",
                    "read_failure": "未获准读取该主题，这一步未完成，我没有读到文件内容。",
                    "cancel_recovery": "已恢复。",
                    "disabled_native": "原生模型路径已通过本地测试。",
                    "no_dsh": "本地运行正常，没有启动 DSH。",
                    "offline": "",
                }.get(outer.scenario_id)
                if not isinstance(text, str):
                    raise HarnessError("scenario_response_missing")
                self.wfile.write(self.frame({"role": "assistant"}))
                if text:
                    self.wfile.write(self.frame({"content": text}))
                self.wfile.write(self.frame({}, "stop"))
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, name=f"p01-u10-{scenario_id}", daemon=True)
        self.thread.start()

    @property
    def origin(self) -> str:
        assert self.server is not None
        return f"http://127.0.0.1:{self.server.server_port}"

    def stop(self) -> None:
        if self.server is not None:
            self.server.shutdown()
            self.server.server_close()
            self.thread.join(timeout=3)

    def save_records(self) -> None:
        write_json(self.output / "relay-requests.json", self.records)

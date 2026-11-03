"""The gateway's vision route: a local Qwen3-VL server beside the cluster
models, queued one request at a time and never sent the cluster key.

Run by tests/run.sh with `python3 -m unittest discover -s tests -p '*_test.py'`.
"""

import hashlib
import http.client
import importlib.util
import json
import os
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KEY = "sk-tellico-vision-test"


class FakeVision(BaseHTTPRequestHandler):
    seen = []

    def log_message(self, *args):
        pass

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        FakeVision.seen.append((self.path, dict(self.headers), json.loads(body)))
        reply = json.dumps({
            "choices": [{"message": {"role": "assistant", "content": "A red square."}}],
            "usage": {"prompt_tokens": 300, "completion_tokens": 5},
        }).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(reply)))
        self.end_headers()
        self.wfile.write(reply)


def serve(handler):
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


VISION = serve(FakeVision)
KEYS = tempfile.NamedTemporaryFile("w", suffix=".keys", delete=False)
KEYS.write("%s tester\n" % hashlib.sha256(KEY.encode()).hexdigest())
KEYS.close()


def load_gateway():
    os.environ["TELLICO_GATEWAY_KEYS"] = KEYS.name
    os.environ["TELLICO_GATEWAY_VISION"] = "qwen3-vl-8b=127.0.0.1:%d" % VISION.server_address[1]
    try:
        spec = importlib.util.spec_from_file_location(
            "tellico_gateway_vision", os.path.join(ROOT, "gateway", "tellico_gateway.py")
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        del os.environ["TELLICO_GATEWAY_VISION"]


G = load_gateway()
GATEWAY = serve(G.Handler)


def request(method, path, payload=None):
    conn = http.client.HTTPConnection(*GATEWAY.server_address, timeout=10)
    body = json.dumps(payload).encode() if payload is not None else None
    headers = {"Authorization": "Bearer " + KEY}
    if body is not None:
        headers.update({"Content-Type": "application/json", "Content-Length": str(len(body))})
    conn.request(method, path, body=body, headers=headers)
    response = conn.getresponse()
    data = json.loads(response.read() or b"{}")
    conn.close()
    return response.status, data


def ask(**extra):
    payload = {
        "model": "qwen3-vl-8b",
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": "What is this?"},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}},
        ]}],
    }
    payload.update(extra)
    return payload


class VisionRoute(unittest.TestCase):
    def setUp(self):
        FakeVision.seen.clear()

    def test_forwards_to_the_vision_server_without_the_cluster_key(self):
        status, data = request("POST", "/v1/chat/completions", ask())
        self.assertEqual(status, 200)
        self.assertEqual(data["choices"][0]["message"]["content"], "A red square.")
        path, headers, body = FakeVision.seen[-1]
        self.assertEqual(path, "/v1/chat/completions")
        self.assertNotIn("Authorization", headers)
        self.assertEqual(body["model"], "qwen3-vl-8b")
        self.assertEqual(body["messages"][0]["content"][1]["type"], "image_url")

    def test_still_needs_a_gateway_key(self):
        conn = http.client.HTTPConnection(*GATEWAY.server_address, timeout=10)
        body = json.dumps(ask()).encode()
        conn.request("POST", "/v1/chat/completions", body=body,
                     headers={"Content-Type": "application/json", "Content-Length": str(len(body))})
        response = conn.getresponse()
        response.read()
        conn.close()
        self.assertEqual(response.status, 401)
        self.assertEqual(FakeVision.seen, [])

    def test_listed_with_its_own_context(self):
        status, data = request("GET", "/v1/models")
        self.assertEqual(status, 200)
        entry = next(m for m in data["data"] if m["id"] == "qwen3-vl-8b")
        self.assertEqual(entry["context_length"], 8192)
        self.assertEqual(entry["status"], "up")

    def test_only_chat_completions_and_no_node_pin(self):
        for path in ("/v1/embeddings", "/v1/node0/chat/completions"):
            status, _ = request("POST", path, ask())
            self.assertEqual(status, 400, path)
        self.assertEqual(FakeVision.seen, [])

    def test_busy_vision_slot_answers_429(self):
        old = G.VISION_QUEUE_TIMEOUT
        G.VISION_QUEUE_TIMEOUT = 0
        G.VISION_SLOTS.acquire()
        try:
            status, data = request("POST", "/v1/chat/completions", ask())
        finally:
            G.VISION_SLOTS.release()
            G.VISION_QUEUE_TIMEOUT = old
        self.assertEqual(status, 429)
        self.assertEqual(data["error"]["type"], "rate_limit_error")
        self.assertEqual(FakeVision.seen, [])

    def test_unknown_model_lists_the_vision_model(self):
        status, data = request("POST", "/v1/chat/completions", ask(model="nope"))
        self.assertEqual(status, 404)
        self.assertIn("qwen3-vl-8b", data["error"]["message"])


class ParseVision(unittest.TestCase):
    def test_empty_is_off(self):
        self.assertIsNone(G.parse_vision(""))

    def test_parses(self):
        self.assertEqual(G.parse_vision("v=127.0.0.1:18190"), ("v", "127.0.0.1", 18190))

    def test_rejects_a_bad_spec_and_a_clash_with_a_cluster_model(self):
        for spec in ("v=127.0.0.1", "=127.0.0.1:1", "%s=127.0.0.1:1" % G.MODEL):
            with self.assertRaises(SystemExit, msg=spec):
                G.parse_vision(spec)


if __name__ == "__main__":
    unittest.main()

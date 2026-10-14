"""Offline tests for relay/tellico_relay.py: the store, sign-in, isolation and
the HTTP surface, with no network beyond loopback and no OpenCode."""

import hashlib
import http.client
import json
import os
import queue
import shutil
import stat
import sys
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "relay"))

import tellico_relay as relay  # noqa: E402

with open(os.path.join(ROOT, "tests/fixtures/relay-ops.json"), encoding="utf-8") as handle:
    CONFORMANCE = json.load(handle)

HOST_A = {"id": "host-aaaaaaaa", "machine": "laptop", "kind": "tui"}
HOST_B = {"id": "host-bbbbbbbb", "machine": "desk", "kind": "vscode"}


def session_op(sid, **fields):
    return {"op": "session", "sessionID": sid, "session": fields}


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.store = relay.Store()

    def test_conformance_fixture(self):
        """The relay reaches the recorded state from ops of real 2.0.26 events,
        and emits exactly the ops the phone's reducer is tested against."""
        q = self.store.subscribe("alice")
        self.store.apply("alice", "host-aaaaaaaa", CONFORMANCE["ops"])
        emitted = []
        while not q.empty():
            kind, payload = q.get_nowait()
            if kind == "op":
                emitted.append(payload)
        self.assertEqual(emitted, CONFORMANCE["normalized"])
        for sid, expected in CONFORMANCE["expected"].items():
            view = self.store.session_view("alice", sid)
            self.assertEqual(view["messages"], expected["messages"], sid)
            self.assertEqual(view["session"]["status"], expected["meta"]["status"])

    def test_replaying_history_and_live_ops_does_not_duplicate(self):
        ops = CONFORMANCE["ops"]
        self.store.apply("alice", "host-aaaaaaaa", ops)
        once = {sid: self.store.session_view("alice", sid)["messages"] for sid in CONFORMANCE["expected"]}
        self.store.apply("alice", "host-aaaaaaaa", ops)
        twice = {sid: self.store.session_view("alice", sid)["messages"] for sid in CONFORMANCE["expected"]}
        self.assertEqual(once, twice)

    def test_users_are_isolated(self):
        self.store.touch_host("alice", HOST_A)
        self.store.apply("alice", HOST_A["id"], [session_op("ses_alice1", title="mine")])
        self.assertEqual([s["id"] for s in self.store.state("alice")["sessions"]], ["ses_alice1"])
        self.assertEqual(self.store.state("bob")["sessions"], [])
        self.assertIsNone(self.store.session_view("bob", "ses_alice1"))
        command, error = self.store.queue_command("bob", "ses_alice1", "prompt", "hijack")
        self.assertIsNone(command)
        self.assertEqual(error, "No such session.")

    def test_invalid_ops_and_unknown_fields_are_dropped(self):
        applied = self.store.apply("alice", HOST_A["id"], [
            {"op": "session", "sessionID": "not-a-session", "session": {"title": "x"}},
            {"op": "append", "sessionID": "ses_ok", "messageID": "../etc", "key": "text:0", "kind": "text", "text": "x"},
            {"op": "append", "sessionID": "ses_ok", "messageID": "msg_1", "key": "<script>", "kind": "text", "text": "x"},
            {"op": "append", "sessionID": "ses_ok", "messageID": "msg_1", "key": "tool:a", "kind": "tool", "text": "x"},
            {"op": "status", "sessionID": "ses_ok", "status": "pwned"},
            {"op": "shell", "sessionID": "ses_ok"},
            "not an op",
        ])
        self.assertEqual(applied, 0)
        self.store.apply("alice", HOST_A["id"], [session_op("ses_ok", title="t", evil="x", tokens=True, updated=True, created=5)])
        meta = self.store.state("alice")["sessions"][0]
        self.assertNotIn("evil", meta)
        self.assertNotIn("tokens", meta)  # a bool is not a dict
        self.assertNotEqual(meta["updated"], True)  # nor a number
        self.assertEqual(meta["created"], 5)

    def test_a_resumed_session_moves_to_its_new_host(self):
        self.store.touch_host("alice", HOST_A)
        self.store.touch_host("alice", HOST_B)
        self.store.apply("alice", HOST_A["id"], [session_op("ses_x")])
        self.store.apply("alice", HOST_B["id"], [session_op("ses_x")])
        self.assertEqual(self.store.state("alice")["sessions"][0]["hostId"], HOST_B["id"])
        command, _ = self.store.queue_command("alice", "ses_x", "interrupt")
        self.assertEqual(self.store.take_commands("alice", HOST_A["id"], 0), [])
        self.assertEqual([c["id"] for c in self.store.take_commands("alice", HOST_B["id"], 0)], [command])

    def test_commands_need_an_online_host_and_fail_back_when_not_taken(self):
        self.store.apply("alice", HOST_A["id"], [session_op("ses_x")])
        _, error = self.store.queue_command("alice", "ses_x", "prompt", "hi")
        self.assertIn("offline", error)

        self.store.touch_host("alice", HOST_A)
        q = self.store.subscribe("alice")
        command, error = self.store.queue_command("alice", "ses_x", "prompt", "hi")
        self.assertIsNone(error)
        self.store.users["alice"].pending[command] = (time.time() - 3600, HOST_A["id"], "ses_x", "prompt")
        self.store.sweep()
        results = [p for k, p in iter(lambda: q.get_nowait() if not q.empty() else (None, None), (None, None)) if k == "command"]
        self.assertEqual(results[0]["id"], command)
        self.assertFalse(results[0]["ok"])
        self.assertEqual(self.store.take_commands("alice", HOST_A["id"], 0), [])

    def test_results_reach_the_phone(self):
        self.store.touch_host("alice", HOST_A)
        self.store.apply("alice", HOST_A["id"], [session_op("ses_x")])
        q = self.store.subscribe("alice")
        command, _ = self.store.queue_command("alice", "ses_x", "prompt", "hi")
        self.store.report_results("alice", [{"id": command, "ok": True}, {"id": "cmd_unknown", "ok": True}])
        results = []
        while not q.empty():
            kind, payload = q.get_nowait()
            if kind == "command":
                results.append(payload)
        self.assertEqual(results, [{"id": command, "sessionID": "ses_x", "type": "prompt", "ok": True}])

    def test_take_commands_waits_for_a_command(self):
        self.store.touch_host("alice", HOST_A)
        self.store.apply("alice", HOST_A["id"], [session_op("ses_x")])
        got = []
        worker = threading.Thread(target=lambda: got.extend(self.store.take_commands("alice", HOST_A["id"], 5)))
        worker.start()
        time.sleep(0.2)
        self.store.queue_command("alice", "ses_x", "interrupt")
        worker.join(3)
        self.assertEqual([c["type"] for c in got], ["interrupt"])

    def test_hosts_go_offline_when_silent(self):
        self.store.touch_host("alice", HOST_A)
        self.store.users["alice"].hosts[HOST_A["id"]]["lastSeen"] -= relay.HOST_TIMEOUT + 1
        self.store.sweep()
        self.assertFalse(self.store.state("alice")["hosts"][0]["online"])

    def test_caps(self):
        ops = [{"op": "message", "sessionID": "ses_x", "message": {"id": "msg_%05d" % i, "role": "user", "text": "t"}}
               for i in range(relay.MAX_MESSAGES + 50)]
        self.store.apply("alice", HOST_A["id"], ops)
        messages = self.store.session_view("alice", "ses_x")["messages"]
        self.assertEqual(len(messages), relay.MAX_MESSAGES)
        self.assertEqual(messages[-1]["id"], "msg_%05d" % (relay.MAX_MESSAGES + 49))

        self.store.apply("alice", HOST_A["id"], [session_op("ses_run", status="running")])
        self.store.apply("alice", HOST_A["id"], [session_op("ses_n%04d" % i) for i in range(relay.MAX_SESSIONS_PER_USER + 5)])
        sessions = {s["id"] for s in self.store.state("alice")["sessions"]}
        self.assertEqual(len(sessions), relay.MAX_SESSIONS_PER_USER)
        self.assertIn("ses_run", sessions)  # a generating session is never evicted


class TokenTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir)
        self.path = os.path.join(self.dir, "tokens")

    def test_tokens_survive_a_restart_and_are_stored_hashed(self):
        token = relay.Tokens(self.path).issue("alice", "d" * 64)
        self.assertEqual(stat.S_IMODE(os.stat(self.path).st_mode), 0o600)
        with open(self.path, encoding="utf-8") as handle:
            self.assertNotIn(token, handle.read())
        self.assertEqual(relay.Tokens(self.path).resolve(token)[0], "alice")

    def test_revoke_and_expiry(self):
        tokens = relay.Tokens(self.path)
        token = tokens.issue("alice", "d" * 64)
        tokens.revoke(token)
        self.assertIsNone(relay.Tokens(self.path).resolve(token))
        other = tokens.issue("alice", "d" * 64)
        digest = hashlib.sha256(other.encode()).hexdigest()
        user, key, _ = tokens._entries[digest]
        tokens._entries[digest] = (user, key, time.time() - 1)
        self.assertIsNone(tokens.resolve(other))


class HttpTests(unittest.TestCase):
    """The real handler on an ephemeral loopback port."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir)
        self.keys_path = os.path.join(self.dir, "keys")
        self.alice_key = "sk-tellico-alice-0123456789"
        self.bob_key = "sk-tellico-bob-0123456789"
        self.write_keys(alice=self.alice_key, bob=self.bob_key)
        web = os.path.join(ROOT, "relay/web")
        self.relay = relay.Relay(relay.Keys(self.keys_path), relay.Tokens(os.path.join(self.dir, "tokens")), web)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), relay.make_handler(self.relay))
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.port = self.server.server_address[1]

    def write_keys(self, **users):
        with open(self.keys_path, "w", encoding="utf-8") as handle:
            handle.write("# test\n")
            for name, key in users.items():
                handle.write("%s %s 2\n" % (hashlib.sha256(key.encode()).hexdigest(), name))
        # The loader keys its cache on mtime; make every rewrite visible.
        future = time.time() + len(users) + (getattr(self, "_bump", 0))
        self._bump = getattr(self, "_bump", 0) + 1
        os.utime(self.keys_path, (future, future))

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        data = json.dumps(body).encode() if body is not None else None
        hdrs = dict(headers or {})
        if data is not None:
            hdrs.setdefault("Content-Type", "application/json")
        conn.request(method, path, body=data, headers=hdrs)
        resp = conn.getresponse()
        raw = resp.read()
        conn.close()
        try:
            payload = json.loads(raw) if raw else None
        except ValueError:
            payload = raw
        return resp.status, payload, resp.headers

    def login(self, key, ip=None):
        headers = {"X-Tellico": "1"}
        if ip:
            headers["X-Forwarded-For"] = ip
        status, payload, headers = self.request("POST", "/tellico/api/login", {"key": key}, headers)
        cookie = (headers.get("Set-Cookie") or "").split(";")[0]
        return status, payload, cookie, headers.get("Set-Cookie") or ""

    def test_sign_in_sets_a_locked_down_cookie(self):
        status, payload, cookie, raw = self.login(self.alice_key)
        self.assertEqual(status, 200)
        self.assertEqual(payload, {"user": "alice"})
        for flag in ("HttpOnly", "SameSite=Strict", "Secure", "Path=/tellico"):
            self.assertIn(flag, raw)
        status, payload, _ = self.request("GET", "/tellico/api/me", headers={"Cookie": cookie})
        self.assertEqual((status, payload), (200, {"user": "alice"}))

    def test_wrong_key_and_missing_cookie_are_refused(self):
        self.assertEqual(self.login("sk-tellico-nope")[0], 401)
        self.assertEqual(self.request("GET", "/tellico/api/state")[0], 401)
        self.assertEqual(self.request("GET", "/tellico/api/state", headers={"Cookie": "tellico_relay=forged"})[0], 401)

    def test_writes_need_the_app_header(self):
        status, _, _ = self.request("POST", "/tellico/api/login", {"key": self.alice_key})
        self.assertEqual(status, 403)
        _, _, cookie, _ = self.login(self.alice_key)
        status, _, _ = self.request("POST", "/tellico/api/session/ses_x/prompt", {"text": "hi"}, {"Cookie": cookie})
        self.assertEqual(status, 403)

    def test_repeated_failures_are_rate_limited_per_client(self):
        for _ in range(relay.LOGIN_FAILURES):
            self.assertEqual(self.login("sk-tellico-guess", ip="203.0.113.7")[0], 401)
        self.assertEqual(self.login(self.alice_key, ip="203.0.113.7")[0], 429)
        self.assertEqual(self.login(self.alice_key, ip="203.0.113.8")[0], 200)

    def test_revoking_the_key_signs_out_the_phone_and_the_plugin(self):
        _, _, cookie, _ = self.login(self.alice_key)
        self.write_keys(bob=self.bob_key)
        self.assertEqual(self.request("GET", "/tellico/api/me", headers={"Cookie": cookie})[0], 401)
        status, _, _ = self.request("POST", "/tellico/agent/publish", {"host": HOST_A, "ops": []},
                                    {"Authorization": "Bearer " + self.alice_key})
        self.assertEqual(status, 401)

    def test_agent_publish_poll_and_phone_prompt(self):
        auth = {"Authorization": "Bearer " + self.alice_key}
        status, reply, _ = self.request("POST", "/tellico/agent/publish",
                                        {"host": HOST_A, "epoch": None, "ops": [session_op("ses_live", title="live one")]}, auth)
        self.assertEqual(status, 200)
        self.assertFalse(reply["resync"])
        epoch = reply["epoch"]

        _, _, cookie, _ = self.login(self.alice_key)
        phone = {"Cookie": cookie, "X-Tellico": "1"}
        _, state, _ = self.request("GET", "/tellico/api/state", headers=phone)
        self.assertEqual([s["title"] for s in state["sessions"]], ["live one"])
        self.assertTrue(state["sessions"][0]["online"])

        status, queued, _ = self.request("POST", "/tellico/api/session/ses_live/prompt", {"text": "go"}, phone)
        self.assertEqual(status, 202)
        status, polled, _ = self.request("POST", "/tellico/agent/poll", {"host": HOST_A, "epoch": epoch, "wait": 1}, auth)
        self.assertEqual(polled["commands"], [{"id": queued["commandID"], "type": "prompt", "sessionID": "ses_live", "text": "go"}])

        # Bob's key cannot pick up Alice's commands, even naming her host.
        self.request("POST", "/tellico/api/session/ses_live/interrupt", {}, phone)
        _, bob_poll, _ = self.request("POST", "/tellico/agent/poll", {"host": HOST_A, "epoch": epoch, "wait": 0},
                                      {"Authorization": "Bearer " + self.bob_key})
        self.assertEqual(bob_poll["commands"], [])

    def test_a_stale_epoch_asks_the_plugin_to_resync(self):
        auth = {"Authorization": "Bearer " + self.alice_key}
        _, reply, _ = self.request("POST", "/tellico/agent/publish", {"host": HOST_A, "epoch": "old", "ops": []}, auth)
        self.assertTrue(reply["resync"])

    def test_prompts_are_bounded(self):
        _, _, cookie, _ = self.login(self.alice_key)
        phone = {"Cookie": cookie, "X-Tellico": "1"}
        self.assertEqual(self.request("POST", "/tellico/api/session/ses_x/prompt", {"text": "  "}, phone)[0], 400)
        self.assertEqual(self.request("POST", "/tellico/api/session/ses_x/prompt", {"text": "x" * (relay.MAX_PROMPT + 1)}, phone)[0], 413)
        self.assertEqual(self.request("POST", "/tellico/api/session/ses_x/rm", {}, phone)[0], 404)

    def test_static_files_carry_a_strict_policy_and_paths_cannot_escape(self):
        status, body, headers = self.request("GET", "/tellico/")
        self.assertEqual(status, 200)
        self.assertIn(b"<title>Tellico</title>", body)
        self.assertIn("script-src 'self'", headers["Content-Security-Policy"])
        self.assertEqual(headers["X-Frame-Options"], "DENY")
        for sneaky in ("/tellico/../tellico_relay.py", "/tellico/%2e%2e/tellico_relay.py", "/tellico/.hidden"):
            status, body, _ = self.request("GET", sneaky)
            self.assertNotIn(b"import ", body if isinstance(body, bytes) else b"", sneaky)
        status, _, headers = self.request("GET", "/tellico/manifest.webmanifest")
        self.assertEqual(headers["Content-Type"], "application/manifest+json")
        self.assertEqual(self.request("GET", "/v1/models")[0], 404)

    def test_event_stream_greets_with_the_epoch(self):
        _, _, cookie, _ = self.login(self.alice_key)
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request("GET", "/tellico/api/events", headers={"Cookie": cookie})
        resp = conn.getresponse()
        self.assertEqual(resp.headers["Content-Type"], "text/event-stream")
        first = resp.read1(4096).decode()
        self.assertIn("event: hello", first)
        self.assertIn(self.relay.store.epoch, first)
        conn.close()


if __name__ == "__main__":
    unittest.main()

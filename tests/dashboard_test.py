"""The dashboard's parsing, storage and queries, and the gateway usage it reads.

Run by tests/run.sh with `python3 -m unittest discover -s tests -p '*_test.py'`.
"""

import importlib.util
import io
import os
import tempfile
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, os.path.join(ROOT, path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


os.environ.setdefault("TELLICO_GATEWAY_KEYS", os.path.join(ROOT, "tests", "no-such-keys"))
DASH = load("tellico_dashboard", "dashboard/tellico_dashboard.py")
GATEWAY = load("tellico_gateway_for_dashboard", "gateway/tellico_gateway.py")

OLD_LINE = ("2026-10-14T22:43:25+0000 user=befikir model=qwen3.8-27b-gsq-iq3s node=node1 "
            "status=200 queued=0.0s dur=2.7s stream=1 in=- out=-")
NEW_LINE = ("2026-10-15T01:00:00+0000 user=alice model=qwen3.8-27b-gsq-iq3s node=node0 status=200 "
            "queued=1.5s dur=9.0s stream=1 in=90000 out=500 role=worker cache=80000 pms=12000 "
            "gms=4000 draft=700 acc=400 finish=stop gone=0")
CLOSING_CHUNK = (
    b'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'
    b'data: {"choices":[{"finish_reason":"stop","index":0,"delta":{}}],"timings":{"cache_n":3,'
    b'"prompt_n":14,"prompt_ms":229.1,"predicted_n":2,"predicted_ms":62.8,"draft_n":7,'
    b'"draft_n_accepted":1}}\n\ndata: [DONE]\n\n'
)


class GatewayUsage(unittest.TestCase):
    def test_a_streams_closing_timings_become_usage(self):
        usage = GATEWAY.usage_from_body(CLOSING_CHUNK)
        self.assertEqual(usage, {"prompt_tokens": 17, "completion_tokens": 2, "cache": 3,
                                 "prompt_ms": 229, "gen_ms": 63, "draft": 7, "accepted": 1,
                                 "finish": "stop"})

    def test_a_reported_usage_wins_and_garbage_gives_nothing(self):
        body = (b'{"choices":[{"finish_reason":"length"}],"usage":{"prompt_tokens":5,'
                b'"completion_tokens":9},"timings":{"cache_n":0,"prompt_n":4,"predicted_n":8}}')
        usage = GATEWAY.usage_from_body(body)
        self.assertEqual((usage["prompt_tokens"], usage["completion_tokens"], usage["finish"]), (5, 9, "length"))
        self.assertEqual(GATEWAY.usage_from_body(b"not json at all"), {})

    def test_the_new_log_line_is_still_read_by_the_old_parser(self):
        monitor = load("tellico_monitor_for_dashboard", "gateway/tellico_monitor.py")
        match = monitor.REQUEST_LINE.search(NEW_LINE)
        self.assertEqual((match.group("prompt"), match.group("completion")), ("90000", "500"))


class Parsing(unittest.TestCase):
    def test_old_and_new_request_lines(self):
        kind, old = DASH.parse_line(OLD_LINE)
        self.assertEqual((kind, old["user"], old["prompt"], old["role"]), ("request", "befikir", None, None))
        kind, new = DASH.parse_line(NEW_LINE)
        self.assertEqual((new["prompt"], new["cache"], new["completion"], new["role"], new["finish"]),
                         (90000, 80000, 500, "worker", "stop"))

    def test_rejections_and_other_lines(self):
        self.assertEqual(DASH.parse_line("x user=bob model=q rejected: no healthy node"),
                         ("rejection", {"user": "bob", "why": "no healthy node"}))
        self.assertIsNone(DASH.parse_line("listening on http://127.0.0.1:4000"))

    def test_counters_survive_a_server_restart(self):
        name = "llamacpp:tokens_predicted_total"
        self.assertEqual(DASH.counter_deltas({name: 10.0}, {name: 25.0})["d_gen"], 15.0)
        self.assertEqual(DASH.counter_deltas({name: 900.0}, {name: 40.0})["d_gen"], 40.0)

    def test_slurm_time_left(self):
        self.assertEqual(DASH.parse_left("1-02:03:04"), 93784)
        self.assertEqual(DASH.parse_left("23:59:00"), 86340)
        self.assertEqual(DASH.parse_left("59:00"), 3540)
        self.assertIsNone(DASH.parse_left("INVALID"))


class Queries(unittest.TestCase):
    def setUp(self):
        self.now = time.time()
        self.db = DASH.connect(":memory:")
        DASH.store_lines(self.db, [(self.now - 100, NEW_LINE), (self.now - 90, OLD_LINE),
                                   (self.now - 50, "user=bob model=q rejected: queued 120s without a slot")])
        for i in range(6):
            self.db.execute("INSERT INTO samples VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                            (self.now - 60 + i * 10, "node0", 1, 1, 2, 0, 5000, 10.0,
                             100, 900, 120, 0.1, 1.0, 70, 40))

    def test_history_buckets_rates_from_counter_increases(self):
        series = [b for b in DASH.history(self.db, "1h", self.now)["nodes"]["node0"] if b]
        self.assertTrue(series)
        bucket = series[-1]
        self.assertAlmostEqual(bucket["genTps"], 12.0)
        self.assertAlmostEqual(bucket["genSpeed"], 120.0)
        self.assertAlmostEqual(bucket["cacheHit"], 0.9)

    def test_usage_per_user(self):
        users = {u["user"]: u for u in DASH.usage(self.db, "24h", self.now)["users"]}
        alice = users["alice"]
        self.assertEqual((alice["requests"], alice["prompt"], alice["cache"], alice["completion"]),
                         (1, 90000, 80000, 500))
        self.assertAlmostEqual(alice["genSpeed"], 125.0)
        self.assertEqual(users["befikir"]["metered"], 0)
        self.assertEqual(users["bob"]["rejected"], 1)

    def test_report_renders(self):
        out = io.StringIO()
        DASH.report(self.db, "24h", out)
        text = out.getvalue()
        self.assertIn("alice", text)
        self.assertIn("node0", text)

    def test_prune_drops_history_past_retention(self):
        self.db.execute("INSERT INTO requests (ts, user) VALUES (?, 'old')",
                        (self.now - (DASH.RETENTION_DAYS + 1) * 86400,))
        DASH.prune(self.db, ":memory:", self.now)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM requests WHERE user='old'").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM requests").fetchone()[0], 2)


class Server(unittest.TestCase):
    def test_it_refuses_a_non_loopback_bind(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = dict(os.environ, TELLICO_DASHBOARD_BIND="0.0.0.0", TELLICO_DASHBOARD_STATE_DIR=tmp,
                       TELLICO_DASHBOARD_COLLECT="0", XDG_CONFIG_HOME=tmp)
            import subprocess
            import sys
            result = subprocess.run([sys.executable, os.path.join(ROOT, "dashboard/tellico_dashboard.py")],
                                    env=env, capture_output=True, text=True, timeout=20)
            self.assertEqual(result.returncode, 2)
            self.assertIn("refusing", result.stdout)


if __name__ == "__main__":
    unittest.main()

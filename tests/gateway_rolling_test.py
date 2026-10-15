"""The gateway across a rolling Slurm handover: pins fall back, nodes near
their walltime drain, and a short outage is waited out instead of failed.

Run by tests/run.sh with `python3 -m unittest discover -s tests -p '*_test.py'`.
"""

import importlib.util
import os
import threading
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_gateway():
    os.environ.setdefault("TELLICO_GATEWAY_KEYS", os.path.join(ROOT, "tests", "no-such-keys"))
    spec = importlib.util.spec_from_file_location(
        "tellico_gateway_rolling", os.path.join(ROOT, "gateway", "tellico_gateway.py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


G = load_gateway()
NODES = [("node0", "127.0.0.1", 1), ("node1", "127.0.0.1", 2)]


def pool(up=("node0", "node1")):
    p = G.Pool(NODES, 3)
    for label, _, _ in NODES:
        p._healthy[label] = label in up
    return p


class Fallback(unittest.TestCase):
    def test_pin_holds_while_its_node_is_up(self):
        p = pool()
        label, _ = p.acquire("u", 3, ["node1"], 1, fallback=["node0"])
        self.assertEqual(label, "node1")

    def test_pin_falls_back_when_its_node_is_down(self):
        p = pool(up=("node0",))
        label, _ = p.acquire("u", 3, ["node1"], 1, fallback=["node0"])
        self.assertEqual(label, "node0")

    def test_strict_pin_without_fallback(self):
        old = G.OUTAGE_WAIT
        G.OUTAGE_WAIT = 0
        try:
            p = pool(up=("node0",))
            self.assertEqual(p.acquire("u", 3, ["node1"], 1), (None, "unavailable"))
        finally:
            G.OUTAGE_WAIT = old


class Draining(unittest.TestCase):
    def test_draining_node_takes_nothing_new_while_another_can(self):
        p = pool()
        p.set_ends({"node0": time.time() + 60, "node1": time.time() + 40000})
        for _ in range(3):
            label, _ = p.acquire("u%d" % _, 3, ["node0", "node1"], 1)
            self.assertEqual(label, "node1")

    def test_pin_on_draining_node_moves(self):
        p = pool()
        p.set_ends({"node1": time.time() + 60})
        label, _ = p.acquire("u", 3, ["node1"], 1, fallback=["node0"])
        self.assertEqual(label, "node0")

    def test_draining_node_still_beats_nothing(self):
        p = pool(up=("node0",))
        p.set_ends({"node0": time.time() + 60})
        label, _ = p.acquire("u", 3, ["node0", "node1"], 1)
        self.assertEqual(label, "node0")

    def test_snapshot_reports_draining(self):
        p = pool()
        p.set_ends({"node0": time.time() + 60})
        nodes = p.snapshot()["nodes"]
        self.assertTrue(nodes["node0"]["draining"])
        self.assertFalse(nodes["node1"]["draining"])


class Outage(unittest.TestCase):
    def test_request_waits_for_a_node_to_return(self):
        p = pool(up=())
        threading.Timer(0.3, p.set_health, args=("node1", True)).start()
        label, queued = p.acquire("u", 3, ["node0", "node1"], 5)
        self.assertEqual(label, "node1")
        self.assertGreater(queued, 0.2)

    def test_outage_wait_is_bounded(self):
        old = G.OUTAGE_WAIT
        G.OUTAGE_WAIT = 0.3
        try:
            started = time.monotonic()
            self.assertEqual(pool(up=()).acquire("u", 3, ["node0"], 5), (None, "unavailable"))
            self.assertLess(time.monotonic() - started, 2)
        finally:
            G.OUTAGE_WAIT = old


class Squeue(unittest.TestCase):
    def test_expand_nodelist(self):
        self.assertEqual(G.expand_nodelist("tellico-compute[0-1]"), ["tellico-compute0", "tellico-compute1"])
        self.assertEqual(G.expand_nodelist("tellico-compute1"), ["tellico-compute1"])
        self.assertEqual(G.expand_nodelist("n[01-02,5],m"), ["n01", "n02", "n5", "m"])

    def test_parse_left(self):
        self.assertEqual(G.parse_left("1-02:03:04"), 93784)
        self.assertEqual(G.parse_left("7:04:42"), 25482)
        self.assertEqual(G.parse_left("03:04"), 184)
        self.assertIsNone(G.parse_left("INVALID"))

    def test_job_ends_maps_hosts_and_keeps_the_soonest(self):
        hosts = {"tellico-compute0": "node0", "tellico-compute1": "node1"}
        ends = G.job_ends("tellico-compute[0-1]|10:00\ntellico-compute1|05:00\n", hosts, now=1000)
        self.assertEqual(ends, {"node0": 1600, "node1": 1300})


if __name__ == "__main__":
    unittest.main()

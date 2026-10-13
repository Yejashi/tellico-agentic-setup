"""SmoothStream: stalls and bursts upstream must not reach the reader.

Run by tests/run.sh with `python3 -m unittest discover -s tests -p '*_test.py'`.
"""

import importlib.util
import os
import threading
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_gateway():
    # The module builds its key store and node pool at import, so point both
    # at paths that need not exist.
    os.environ.setdefault("TELLICO_GATEWAY_KEYS", os.path.join(ROOT, "tests", "no-such-keys"))
    spec = importlib.util.spec_from_file_location(
        "tellico_gateway", os.path.join(ROOT, "gateway", "tellico_gateway.py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


GATEWAY = load_gateway()


def event(i, kind="content"):
    if kind == "tool":
        return b'data: {"choices":[{"delta":{"tool_calls":[{"index":0}]}}]}\n\n'
    return b'data: {"choices":[{"delta":{"content":"t%d "}}]}\n\n' % i


class FakeUpstream:
    """read1() replaying a schedule of (delay_before, bytes)."""

    def __init__(self, schedule):
        self._schedule = list(schedule)
        self._lock = threading.Lock()

    def read1(self, _n):
        with self._lock:
            if not self._schedule:
                return b""
            delay, data = self._schedule.pop(0)
        time.sleep(delay)
        return data


def bursty(total, burst=5, every=0.05, stall_every=2.0, stall=0.8):
    """Speculative-decoding-like bursts with a prompt-chunk stall every few s."""
    schedule, t, i = [], 0.0, 0
    next_stall = stall_every
    while i < total:
        delay = every
        if t >= next_stall:
            delay += stall
            next_stall += stall_every + stall
        t += delay
        chunk = b"".join(event(i + k) for k in range(min(burst, total - i)))
        i += burst
        # Split one burst across two reads, mid-event, as TCP may.
        schedule.append((delay, chunk[:37]))
        schedule.append((0.0, chunk[37:]))
    return schedule


def run(stream):
    out, stamps = [], []
    for chunk in stream.events():
        out.append(chunk)
        stamps.append(time.monotonic())
    return out, stamps


class SmoothStreamTest(unittest.TestCase):
    def test_stalls_are_absorbed_and_bytes_preserved(self):
        schedule = bursty(total=300)
        expected = b"".join(data for _, data in schedule)
        upstream = FakeUpstream(schedule)
        started = time.monotonic()
        out, stamps = run(GATEWAY.SmoothStream(upstream.read1, 1.0))
        self.assertEqual(b"".join(out), expected)
        self.assertEqual(len(out), 300, "one event per write")
        # The first token waits for the buffer and no longer.
        self.assertLess(stamps[0] - started, schedule[0][0] + 1.0 + 0.2)
        gaps = [b - a for a, b in zip(stamps, stamps[1:])]
        # Upstream freezes for 0.8 s every 2 s; the reader must not see it.
        self.assertLess(max(gaps), 0.25, "max gap %.3fs" % max(gaps))
        # Output does not fall behind: total is upstream time plus the buffer.
        upstream_time = sum(d for d, _ in schedule)
        self.assertLess(stamps[-1] - started, upstream_time + 1.5)

    def test_tool_calls_flush_and_pass_through(self):
        schedule = [(0.0, event(0)), (0.05, event(1)), (0.05, event(2, "tool"))]
        schedule += [(0.02, event(3 + k, "tool")) for k in range(5)]
        upstream = FakeUpstream(schedule)
        started = time.monotonic()
        out, stamps = run(GATEWAY.SmoothStream(upstream.read1, 1.0))
        self.assertEqual(b"".join(out), b"".join(d for _, d in schedule))
        # No pre-buffer once a tool call shows up: done right after upstream.
        self.assertLess(stamps[-1] - started, 0.5)

    def test_zero_delay_is_pass_through(self):
        schedule = bursty(total=40)
        upstream = FakeUpstream(schedule)
        started = time.monotonic()
        out, stamps = run(GATEWAY.SmoothStream(upstream.read1, 0))
        self.assertEqual(b"".join(out), b"".join(d for _, d in schedule))
        self.assertLess(stamps[-1] - started, sum(d for d, _ in schedule) + 0.2)

    def test_upstream_error_after_partial_output_is_raised(self):
        class Broken:
            calls = 0

            def read1(self, _n):
                self.calls += 1
                if self.calls == 1:
                    return event(0)
                raise ConnectionResetError("upstream went away")

        out = []
        with self.assertRaises(ConnectionResetError):
            for chunk in GATEWAY.SmoothStream(Broken().read1, 0.2).events():
                out.append(chunk)
        self.assertEqual(out, [event(0)])


if __name__ == "__main__":
    unittest.main()

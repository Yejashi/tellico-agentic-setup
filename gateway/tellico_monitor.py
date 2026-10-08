#!/usr/bin/env python3
"""Live view of who is using the Tellico models and how hard.

Three sources, because no single one sees everything:

  * each llama.cpp server's /metrics and /slots, which is ground truth for
    load and includes sessions that never touch the gateway;
  * the gateway's state file, for exact per-user concurrency right now;
  * the gateway's journal, for per-user history, waits and rejections.

Anything unavailable is left out rather than guessed at, so this still works
on a device that has the tunnel but no gateway.

Standard library only, like the gateway itself.
"""

import argparse
import http.client
import json
import os
import re
import shutil
import subprocess
import sys
import time

CONFIG_HOME = os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")
GATEWAY_ENV = os.path.join(CONFIG_HOME, "tellico-gateway/gateway.env")
CLIENT_ENV = os.path.join(CONFIG_HOME, "tellico-qwen/client.env")

RESET = "\033[0m"
BOLD = "\033[1m"
DIM = "\033[2m"
RED = "\033[31m"
YELLOW = "\033[33m"
GREEN = "\033[32m"
CYAN = "\033[36m"

# One completed request, as the gateway logs it.
REQUEST_LINE = re.compile(
    r"user=(?P<user>\S+)\s+model=(?P<model>\S+)\s+node=(?P<node>\S+)\s+"
    r"status=(?P<status>\d+)\s+queued=(?P<queued>[\d.]+)s\s+dur=(?P<dur>[\d.]+)s\s+"
    r"stream=(?P<stream>\d)\s+in=(?P<prompt>\S+)\s+out=(?P<completion>\S+)"
)
REJECT_LINE = re.compile(r"user=(?P<user>\S+)\s+model=(?P<model>\S+)\s+rejected:\s+(?P<why>.+)")


def read_shell_env(path):
    """Read KEY="value" lines from an installed env file."""
    values = {}
    try:
        with open(path, "r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                values[key.strip()] = value.strip().strip("'\"")
    except OSError:
        pass
    return values


class Config:
    def __init__(self):
        gateway = read_shell_env(GATEWAY_ENV)
        client = read_shell_env(CLIENT_ENV)

        self.has_gateway = bool(gateway)
        self.key_file = os.path.expanduser(
            gateway.get("TELLICO_GATEWAY_UPSTREAM_KEY")
            or os.path.join(CONFIG_HOME, "tellico-qwen/api-key")
        )
        self.max_inflight = int(gateway.get("TELLICO_GATEWAY_MAX_INFLIGHT") or 0)

        spec = gateway.get("TELLICO_GATEWAY_NODES")
        if not spec:
            port0 = client.get("TELLICO_QWEN_PORT0") or "18080"
            port1 = client.get("TELLICO_QWEN_PORT1") or "18081"
            spec = "node0=127.0.0.1:%s node1=127.0.0.1:%s" % (port0, port1)
        self.nodes = []
        for item in spec.split():
            label, _, address = item.partition("=")
            host, _, port = address.rpartition(":")
            if label and host and port.isdigit():
                self.nodes.append((label, host, int(port)))

        runtime = gateway.get("TELLICO_GATEWAY_RUNTIME") or os.path.join(
            os.environ.get("XDG_RUNTIME_DIR") or os.path.expanduser("~/.cache"),
            "tellico-gateway",
        )
        self.state_path = os.path.join(os.path.expanduser(runtime), "state.json")
        self.ssh_host = client.get("TELLICO_SSH_HOST") or "tellico"
        self.service_user = os.environ.get("TELLICO_SERVICE_USER") or "bbogale"
        self.job_name = os.environ.get("TELLICO_JOB_NAME") or "qwen38-api"
        self.is_gateway_client = (client.get("TELLICO_MODE") or "tunnel") == "gateway"

    def upstream_key(self):
        try:
            with open(self.key_file, "r", encoding="utf-8") as handle:
                return handle.read().strip()
        except OSError:
            return None


def get_json(host, port, path, key, timeout=4):
    conn = None
    try:
        conn = http.client.HTTPConnection(host, port, timeout=timeout)
        headers = {"Authorization": "Bearer " + key} if key else {}
        conn.request("GET", path, headers=headers)
        response = conn.getresponse()
        body = response.read()
        if response.status != 200:
            return None
        return json.loads(body)
    except (OSError, http.client.HTTPException, ValueError):
        return None
    finally:
        if conn is not None:
            conn.close()


def get_metrics(host, port, key, timeout=4):
    """Prometheus text to {name: float}. Labelled series keep their braces."""
    conn = None
    try:
        conn = http.client.HTTPConnection(host, port, timeout=timeout)
        headers = {"Authorization": "Bearer " + key} if key else {}
        conn.request("GET", "/metrics", headers=headers)
        response = conn.getresponse()
        body = response.read().decode("utf-8", "replace")
        if response.status != 200:
            return None
    except (OSError, http.client.HTTPException):
        return None
    finally:
        if conn is not None:
            conn.close()

    metrics = {}
    for line in body.splitlines():
        if not line or line.startswith("#"):
            continue
        name, _, value = line.rpartition(" ")
        try:
            metrics[name.strip()] = float(value)
        except ValueError:
            continue
    return metrics


def read_state(path, max_age=10.0):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            state = json.load(handle)
    except (OSError, ValueError):
        return None
    # A stale file means the gateway died; better to show nothing than a lie.
    if time.time() - float(state.get("time") or 0) > max_age:
        return None
    return state


def read_journal(window):
    """Completed requests and rejections from the gateway's journal."""
    try:
        output = subprocess.run(
            [
                "journalctl", "--user", "-u", "tellico-gateway.service",
                "--since", "-" + window, "-o", "cat", "--no-pager",
            ],
            capture_output=True, text=True, timeout=15, check=False,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return [], []

    requests, rejections = [], []
    for line in output.splitlines():
        match = REQUEST_LINE.search(line)
        if match:
            record = match.groupdict()
            record["status"] = int(record["status"])
            record["queued"] = float(record["queued"])
            record["dur"] = float(record["dur"])
            for field in ("prompt", "completion"):
                try:
                    record[field] = int(record[field])
                except ValueError:
                    record[field] = 0
            requests.append(record)
            continue
        match = REJECT_LINE.search(line)
        if match:
            rejections.append(match.groupdict())
    return requests, rejections


_allocation_cache = {"when": 0.0, "value": None}


def read_allocation(config, every=60.0):
    """Remaining walltime for the service job, via squeue. Cached; optional."""
    now = time.monotonic()
    if now - _allocation_cache["when"] < every:
        return _allocation_cache["value"]
    _allocation_cache["when"] = now

    value = None
    if shutil.which("ssh"):
        try:
            result = subprocess.run(
                [
                    "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8",
                    config.ssh_host,
                    "squeue -h -u %s -n %s -o '%%i %%L %%T'"
                    % (config.service_user, config.job_name),
                ],
                capture_output=True, text=True, timeout=20, check=False,
            )
            line = result.stdout.strip().splitlines()
            if line:
                fields = line[0].split()
                if len(fields) >= 3:
                    value = {"job": fields[0], "left": fields[1], "state": fields[2]}
        except (OSError, subprocess.SubprocessError):
            value = None

    _allocation_cache["value"] = value
    return value


def percentile(values, fraction):
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, int(round(fraction * (len(ordered) - 1)))))
    return ordered[index]


def bar(fraction, width=10):
    filled = int(round(max(0.0, min(1.0, fraction)) * width))
    return "#" * filled + "." * (width - filled)


def collect(config):
    """One full sample from every available source."""
    key = config.upstream_key()
    sample = {
        "time": time.time(),
        "key": key is not None,
        "nodes": [],
        "state": read_state(config.state_path) if config.has_gateway else None,
        "allocation": read_allocation(config),
    }

    for label, host, port in config.nodes:
        metrics = get_metrics(host, port, key)
        slots = get_json(host, port, "/slots", key)
        node = {"label": label, "up": metrics is not None, "slots": [], "deferred": 0}

        if metrics:
            node["processing"] = int(metrics.get("llamacpp:requests_processing") or 0)
            node["deferred"] = int(metrics.get("llamacpp:requests_deferred") or 0)
            node["gen_rate"] = metrics.get("llamacpp:predicted_tokens_seconds") or 0.0
            node["prompt_rate"] = metrics.get("llamacpp:prompt_tokens_seconds") or 0.0
            node["tokens_out"] = metrics.get("llamacpp:tokens_predicted_total") or 0.0
            node["longest"] = int(metrics.get("llamacpp:n_tokens_max") or 0)
            drafted = metrics.get("llamacpp:spec_decode_num_draft_tokens_total") or 0.0
            accepted = metrics.get("llamacpp:spec_decode_num_accepted_tokens_total") or 0.0
            node["spec_accept"] = (accepted / drafted) if drafted else None
            cached = metrics.get("llamacpp:prompt_tokens_cached_total") or 0.0
            fresh = metrics.get("llamacpp:prompt_tokens_total") or 0.0
            node["cache_hit"] = (cached / (cached + fresh)) if (cached + fresh) else None

        if isinstance(slots, list):
            for slot in slots:
                # n_prompt_tokens is the prompt alone; the sequence occupying
                # the KV cache is that plus whatever has been generated.
                decoded = 0
                next_token = slot.get("next_token")
                if isinstance(next_token, list) and next_token:
                    decoded = int(next_token[0].get("n_decoded") or 0)
                elif isinstance(next_token, dict):
                    decoded = int(next_token.get("n_decoded") or 0)
                node["slots"].append(
                    {
                        "id": slot.get("id"),
                        "busy": bool(slot.get("is_processing")),
                        "used": int(slot.get("n_prompt_tokens") or 0) + decoded,
                        "ctx": int(slot.get("n_ctx") or 0),
                    }
                )
        sample["nodes"].append(node)

    return sample


def render(sample, config, requests, rejections, window):
    out = []
    stamp = time.strftime("%H:%M:%S", time.localtime(sample["time"]))

    busy = sum(1 for n in sample["nodes"] for s in n["slots"] if s["busy"])
    total_slots = sum(len(n["slots"]) for n in sample["nodes"])
    deferred = sum(n["deferred"] for n in sample["nodes"])
    up = [n for n in sample["nodes"] if n["up"]]

    out.append("%sTellico models%s   %s%s   window %s%s"
               % (BOLD, RESET, DIM, stamp, window, RESET))
    out.append("")

    if not up:
        out.append("  %sNo model server is reachable.%s" % (RED, RESET))
        if config.is_gateway_client:
            out.append("  This device talks to the gateway, so check: ./doctor.sh")
        else:
            out.append("  The Slurm allocation has probably ended.")
        return "\n".join(out)

    # --- capacity -----------------------------------------------------------
    allocation = sample["allocation"]
    alloc_text = ""
    if allocation:
        alloc_text = "   job %s, %s left" % (allocation["job"], allocation["left"])
    colour = RED if total_slots and busy >= total_slots else (
        YELLOW if busy else GREEN)
    out.append("  %-10s %s%d of %d slots busy%s  %s%s"
               % ("CLUSTER", colour, busy, total_slots, RESET,
                  bar(busy / total_slots if total_slots else 0), alloc_text))
    if deferred:
        out.append("  %-10s %s%d request(s) queued inside the servers%s"
                   % ("", RED, deferred, RESET))

    for node in sample["nodes"]:
        if not node["up"]:
            out.append("  %-10s %sdown%s" % ("  " + node["label"], RED, RESET))
            continue
        node_busy = sum(1 for s in node["slots"] if s["busy"])
        pieces = ["%d/%d busy" % (node_busy, len(node["slots"]))]
        if node_busy:
            pieces.append("gen %5.1f tok/s" % node["gen_rate"])
            pieces.append("prompt %6.1f tok/s" % node["prompt_rate"])
        used = []
        for slot in node["slots"]:
            if not (slot["busy"] and slot["ctx"]):
                continue
            share = 100.0 * slot["used"] / slot["ctx"]
            # Round-to-zero would read as "empty" on a slot that is working.
            shown = "<1%" if 0 < share < 1 else "%d%%" % round(share)
            used.append("%s (%.1fk)" % (shown, slot["used"] / 1000.0))
        if used:
            pieces.append("ctx " + ", ".join(used))
        out.append("  %-10s %s" % ("  " + node["label"], "   ".join(pieces)))

    # --- who ----------------------------------------------------------------
    out.append("")
    state = sample["state"]
    if state:
        cap = state.get("max_inflight") or config.max_inflight
        active = state.get("inflight") or 0
        colour = RED if cap and active >= cap else (YELLOW if active else GREEN)
        out.append("  %-10s %s%d in flight of %d%s   %d user(s) active now"
                   % ("GATEWAY", colour, active, cap, RESET,
                      len(state.get("users") or {})))
    elif config.has_gateway:
        out.append("  %-10s %snot running%s" % ("GATEWAY", RED, RESET))
    else:
        out.append("  %-10s %sno gateway on this host%s" % ("GATEWAY", DIM, RESET))

    per_user = {}
    for record in requests:
        entry = per_user.setdefault(
            record["user"],
            {"n": 0, "errors": 0, "waits": [], "durs": [], "out": 0, "nodes": set()},
        )
        entry["n"] += 1
        entry["waits"].append(record["queued"])
        entry["durs"].append(record["dur"])
        entry["out"] += record["completion"]
        entry["nodes"].add(record["node"])
        if record["status"] >= 400:
            entry["errors"] += 1
    for record in rejections:
        entry = per_user.setdefault(
            record["user"],
            {"n": 0, "errors": 0, "waits": [], "durs": [], "out": 0, "nodes": set()},
        )
        entry["errors"] += 1

    live_users = (state or {}).get("users") or {}
    if per_user or live_users:
        out.append("")
        out.append("  %s%-14s %5s %6s %8s %8s %9s %6s%s"
                   % (DIM, "USER", "NOW", "REQ", "MED WAIT", "P95 WAIT",
                      "TOK OUT", "ERRS", RESET))
        rows = sorted(
            set(per_user) | set(live_users),
            key=lambda u: (-(live_users.get(u, 0)), -per_user.get(u, {}).get("n", 0), u),
        )
        for user in rows:
            entry = per_user.get(
                user, {"n": 0, "errors": 0, "waits": [], "durs": [], "out": 0}
            )
            now = live_users.get(user, 0)
            median = percentile(entry["waits"], 0.5)
            p95 = percentile(entry["waits"], 0.95)
            errs = entry["errors"]
            out.append("  %-14s %5s %6d %8s %8s %9s %s%6d%s"
                       % (user[:14],
                          ("%d" % now) if now else "-",
                          entry["n"],
                          ("%.1fs" % median) if median is not None else "-",
                          ("%.1fs" % p95) if p95 is not None else "-",
                          "{:,}".format(entry["out"]),
                          RED if errs else "", errs, RESET if errs else ""))

    # Load the gateway cannot account for is somebody on a tunnel.
    gateway_inflight = (state or {}).get("inflight", 0) if state else 0
    direct = busy - gateway_inflight
    if direct > 0:
        out.append("")
        out.append("  %-10s %d slot(s) in use by session(s) not going through the "
                   "gateway" % ("DIRECT", direct))
        out.append("  %-10s %s(an opencode-tellico tunnel user, or the operator)%s"
                   % ("", DIM, RESET))

    # --- stress -------------------------------------------------------------
    waits = [r["queued"] for r in requests]
    worst_wait = percentile(waits, 0.95)
    throttled = sum(1 for r in requests if r["status"] in (429, 503))
    throttled += len(rejections)

    verdicts = []
    if deferred:
        verdicts.append("%sservers are queueing (%d deferred)%s" % (RED, deferred, RESET))
    if total_slots and busy >= total_slots:
        verdicts.append("%severy slot busy%s" % (RED, RESET))
    if throttled:
        verdicts.append("%s%d request(s) turned away in the window%s"
                        % (RED, throttled, RESET))
    if worst_wait is not None and worst_wait >= 10:
        verdicts.append("%sp95 queue wait %.0fs%s" % (YELLOW, worst_wait, RESET))
    if len(up) < len(sample["nodes"]):
        verdicts.append("%sonly %d of %d nodes up%s"
                        % (RED, len(up), len(sample["nodes"]), RESET))

    out.append("")
    if verdicts:
        out.append("  %-10s %s" % ("STRESS", "; ".join(verdicts)))
    else:
        out.append("  %-10s %shealthy -- room to spare%s" % ("STRESS", GREEN, RESET))

    efficiency = []
    for node in sample["nodes"]:
        if node.get("spec_accept") is not None:
            efficiency.append("%s spec %d%%" % (node["label"],
                                                round(100 * node["spec_accept"])))
        if node.get("cache_hit") is not None:
            efficiency.append("cache %d%%" % round(100 * node["cache_hit"]))
    if efficiency:
        out.append("  %-10s %s%s%s" % ("", DIM, "   ".join(efficiency), RESET))

    return "\n".join(out)


def main():
    parser = argparse.ArgumentParser(
        description="Live view of Tellico model usage and load.")
    parser.add_argument("--once", action="store_true",
                        help="print one snapshot and exit")
    parser.add_argument("--window", default="15min",
                        help="history window for per-user stats (default: 15min)")
    parser.add_argument("--interval", type=float, default=2.0,
                        help="refresh seconds (default: 2)")
    args = parser.parse_args()

    config = Config()
    if not config.nodes:
        raise SystemExit("tellico-monitor: no nodes configured; is the client installed?")

    history_at = 0.0
    requests, rejections = [], []
    try:
        while True:
            sample = collect(config)
            # The journal is the expensive source; it does not need 2s freshness.
            if time.monotonic() - history_at > 10 or args.once:
                requests, rejections = read_journal(args.window)
                history_at = time.monotonic()

            frame = render(sample, config, requests, rejections, args.window)
            if args.once:
                print(frame)
                return
            sys.stdout.write("\033[H\033[2J" + frame + "\n\n")
            sys.stdout.write("  %sCtrl-C to quit%s\n" % (DIM, RESET))
            sys.stdout.flush()
            time.sleep(args.interval)
    except KeyboardInterrupt:
        sys.stdout.write("\n")


if __name__ == "__main__":
    main()

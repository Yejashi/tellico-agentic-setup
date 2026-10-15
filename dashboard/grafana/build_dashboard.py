#!/usr/bin/env python3
"""Writes tellico.json, the Grafana dashboard over the dashboard's SQLite history.

Run it after changing a panel:  python3 dashboard/grafana/build_dashboard.py

Every query runs against tellico_dashboard.py's tables (samples, gateway,
requests, rejections, job) through the frser-sqlite-datasource plugin, whose
"time" columns are Unix seconds. $__from/$__to (ms) bound the range and
$__interval_ms sets the bucket, so every panel follows the picker.
"""

import json
import os

DS = {"type": "frser-sqlite-datasource", "uid": "tellico-sqlite"}
NODES = ("node0", "node1")
# The plugin (4.0.6) has no $__unixEpochFrom(); $__from and $__to are
# Grafana's own range, in milliseconds.
RANGE = "ts >= $__from / 1000.0 AND ts < $__to / 1000.0"
# Bucket start, in seconds, at Grafana's chosen interval (never below 10 s,
# the sample period).
BUCKET = "CAST(ts / MAX(10, $__interval_ms / 1000) AS INTEGER) * MAX(10, $__interval_ms / 1000)"

panels = []
_id = [0]


def query(sql, ref="A", fmt="table"):
    return {"refId": ref, "datasource": DS, "queryType": fmt, "queryText": sql, "rawQueryText": sql,
            "timeColumns": ["time"]}


def panel(kind, title, grid, targets, description="", unit=None, decimals=None, options=None,
          overrides=None, custom=None, thresholds=None, transformations=None, mappings=None,
          minimum=None, maximum=None, color=None):
    _id[0] += 1
    defaults = {"custom": custom or {}}
    if unit:
        defaults["unit"] = unit
    if decimals is not None:
        defaults["decimals"] = decimals
    if minimum is not None:
        defaults["min"] = minimum
    if maximum is not None:
        defaults["max"] = maximum
    if thresholds:
        defaults["thresholds"] = {"mode": "absolute", "steps": thresholds}
    if mappings:
        defaults["mappings"] = mappings
    defaults["color"] = color or {"mode": "palette-classic"}
    item = {
        "id": _id[0], "type": kind, "title": title, "description": description,
        "gridPos": dict(zip(("x", "y", "w", "h"), grid)), "datasource": DS,
        "targets": targets, "options": options or {},
        "fieldConfig": {"defaults": defaults, "overrides": overrides or []},
    }
    if transformations:
        item["transformations"] = transformations
    panels.append(item)


def row(title, y):
    _id[0] += 1
    panels.append({"id": _id[0], "type": "row", "title": title, "collapsed": False,
                   "gridPos": {"x": 0, "y": y, "w": 24, "h": 1}, "panels": []})


def per_node(expression):
    """One column per node, so no transformation is needed."""
    return ", ".join("%s AS %s" % (expression.replace("{node}", n), n) for n in NODES)


def node_ratio(numerator, denominator):
    return per_node(
        "SUM(CASE WHEN node = '{node}' THEN %s END) * 1.0 / NULLIF(SUM(CASE WHEN node = '{node}' THEN %s END), 0)"
        % (numerator, denominator))


def node_avg(column):
    return per_node("AVG(CASE WHEN node = '{node}' THEN %s END)" % column)


def timeseries_options(stack=False, bars=False, fill=18):
    custom = {"drawStyle": "bars" if bars else "line", "lineWidth": 2, "fillOpacity": 70 if bars else fill,
              "gradientMode": "opacity", "showPoints": "never", "spanNulls": 60000,
              "lineInterpolation": "smooth", "axisSoftMin": 0}
    if stack:
        custom["stacking"] = {"mode": "normal", "group": "A"}
    options = {"legend": {"displayMode": "list", "placement": "bottom", "showLegend": True},
               "tooltip": {"mode": "multi", "sort": "desc"}}
    return custom, options


STAT_OPTIONS = {"reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False},
                "colorMode": "value", "graphMode": "area",
                "justifyMode": "center", "textMode": "value_and_name", "wideLayout": True}


def stat(title, grid, sql, unit=None, description="", decimals=None, thresholds=None, mappings=None,
         calcs=("lastNotNull",), graph=True, color=None):
    options = dict(STAT_OPTIONS)
    options["reduceOptions"] = {"calcs": list(calcs), "fields": "", "values": False}
    options["graphMode"] = "area" if graph else "none"
    panel("stat", title, grid, [query(sql)], description, unit, decimals, options,
          thresholds=thresholds or [{"color": "#8ab8ff", "value": None}], mappings=mappings,
          color=color or {"mode": "thresholds"})

RED, ORANGE, GREEN, BLUE = "#f2495c", "#ff9830", "#73bf69", "#8ab8ff"
NOW = "CAST(strftime('%s', 'now') AS INTEGER)"

# --- right now ---------------------------------------------------------------
# These show the present whatever range is picked: the value is the newest
# sample and the sparkline the last hour.
RECENT = "ts > %s - 3600" % NOW
row("Right now", 0)
stat("Nodes up", (0, 1, 3, 4),
     "SELECT COUNT(DISTINCT node) AS \"nodes up\" FROM samples WHERE up = 1 AND ts > %s - 60" % NOW,
     description="Nodes whose llama.cpp server answered in the last minute.", graph=False,
     thresholds=[{"color": RED, "value": None}, {"color": ORANGE, "value": 1}, {"color": GREEN, "value": 2}])
stat("Next handover in", (3, 1, 4, 4),
     "SELECT ts AS time, MIN(\"left\") AS \"next handover\" FROM job WHERE %s AND state = 'RUNNING' "
     "AND \"left\" IS NOT NULL GROUP BY ts ORDER BY ts" % RECENT,
     unit="dtdurations",
     description="Walltime left on the service job that ends soonest. Each node runs its own job and "
                 "queues its successor, so at zero that node restarts (under a minute) while the "
                 "other serves; the gateway stops sending it new requests 10 minutes before.",
     thresholds=[{"color": GREEN, "value": None}])
stat("Busy slots", (7, 1, 4, 4),
     "SELECT ts AS time, SUM(busy) AS \"busy of 4\" FROM samples WHERE %s GROUP BY ts ORDER BY ts" % RECENT,
     description="Slots generating or reading a prompt, both nodes together (4 in all).",
     thresholds=[{"color": GREEN, "value": None}, {"color": ORANGE, "value": 3}, {"color": RED, "value": 4}])
stat("Context held", (11, 1, 5, 4),
     "SELECT ts AS time, SUM(used) AS tokens FROM samples WHERE %s GROUP BY ts ORDER BY ts" % RECENT,
     unit="short", description="Tokens held in the slots' KV caches, both nodes (each slot holds up to 131,072).")
stat("Gateway in flight", (16, 1, 4, 4),
     "SELECT ts AS time, inflight AS \"in flight\" FROM gateway WHERE %s ORDER BY ts" % RECENT,
     description="Requests the gateway is running now (its cap is 3 of the 4 slots).")
stat("Leads waiting", (20, 1, 4, 4),
     "SELECT ts AS time, waiting AS waiting FROM gateway WHERE %s ORDER BY ts" % RECENT,
     description="Lead requests queued at the gateway for a free slot.",
     thresholds=[{"color": GREEN, "value": None}, {"color": ORANGE, "value": 1}, {"color": RED, "value": 3}])

# --- the selected range ------------------------------------------------------
row("Selected range", 5)
TOTALS = [
    ("Requests", "SELECT COUNT(*) AS requests FROM requests WHERE %s", None, None),
    ("Users", "SELECT COUNT(DISTINCT user) AS users FROM requests WHERE %s", None, None),
    ("Tokens generated", "SELECT SUM(completion) AS tokens FROM requests WHERE %s", "short", None),
    ("Prompt tokens", "SELECT SUM(prompt) AS tokens FROM requests WHERE %s", "short", None),
    ("Prompt cache hit", "SELECT SUM(cache) * 1.0 / NULLIF(SUM(CASE WHEN cache IS NOT NULL THEN prompt END), 0) AS hit "
     "FROM requests WHERE %s",
     "percentunit", 0),
    ("Generation speed", "SELECT SUM(CASE WHEN gms > 0 THEN completion END) * 1000.0 / NULLIF(SUM(CASE WHEN gms > 0 THEN gms END), 0) "
     "AS \"tok/s\" FROM requests WHERE %s",
     "short", 1),
    ("Avg time to first token", "SELECT AVG(queued + pms / 1000.0) AS ttft FROM requests "
     "WHERE %s AND stream = 1 AND pms IS NOT NULL", "s", 1),
    ("Errors + rejections", "SELECT (SELECT COUNT(*) FROM requests WHERE %s AND status >= 400) + "
     "(SELECT COUNT(*) FROM rejections WHERE %s) AS failed", None, None),
]
for i, (title, sql, unit, decimals) in enumerate(TOTALS):
    text = sql % ((RANGE,) * sql.count("%s"))
    stat(title, (i * 3, 6, 3, 4), text, unit=unit, decimals=decimals, graph=False,
         thresholds=[{"color": GREEN, "value": None}, {"color": RED, "value": 1}]
         if title.startswith("Errors") else [{"color": BLUE, "value": None}],
         description="Over the time range picked at the top right. Token counts cover gateway requests "
                     "logged since metering began (2026-10-15).")

# --- throughput --------------------------------------------------------------
row("Throughput", 10)
custom, options = timeseries_options()
panel("timeseries", "Generation throughput (tokens/s, all slots)", (0, 11, 12, 8),
      [query("SELECT %s AS time, %s FROM samples WHERE %s GROUP BY 1 ORDER BY 1"
             % (BUCKET, node_ratio("d_gen", "secs"), RANGE))],
      "Tokens each node generated per second of wall time: what it delivered, all slots together.",
      unit="short", custom=custom, options=options)
panel("timeseries", "Prompt processing (tokens/s)", (12, 11, 12, 8),
      [query("SELECT %s AS time, %s FROM samples WHERE %s GROUP BY 1 ORDER BY 1"
             % (BUCKET, node_ratio("d_prompt", "secs"), RANGE))],
      "Prompt tokens each node actually read per second of wall time (cache hits excluded).",
      unit="short", custom=custom, options=options)
panel("timeseries", "Generation speed while working (tokens/s)", (0, 19, 8, 8),
      [query("SELECT %s AS time, %s FROM samples WHERE %s GROUP BY 1 ORDER BY 1"
             % (BUCKET, node_ratio("d_gen", "d_gen_s"), RANGE))],
      "Generated tokens per second of generation time: the speed one reader sees.",
      unit="short", custom=custom, options=options)
panel("timeseries", "Prompt read speed while working (tokens/s)", (8, 19, 8, 8),
      [query("SELECT %s AS time, %s FROM samples WHERE %s GROUP BY 1 ORDER BY 1"
             % (BUCKET, node_ratio("d_prompt", "d_prompt_s"), RANGE))],
      "Prompt tokens per second of prompt-processing time.",
      unit="short", custom=custom, options=options)
panel("timeseries", "Speculative draft acceptance", (16, 19, 8, 8),
      [query("SELECT %s AS time, %s FROM samples WHERE %s GROUP BY 1 ORDER BY 1"
             % (BUCKET, node_ratio("d_acc", "d_draft"), RANGE))],
      "Share of DFlash draft tokens the model accepted. Higher means faster generation.",
      unit="percentunit", custom=custom, options=options, minimum=0, maximum=1)

# --- capacity ----------------------------------------------------------------
row("Capacity", 27)
panel("timeseries", "Busy slots", (0, 28, 8, 8),
      [query("SELECT %s AS time, %s FROM samples WHERE %s GROUP BY 1 ORDER BY 1"
             % (BUCKET, node_avg("busy"), RANGE))],
      "Average busy slots per node (2 per node).", unit="short", custom=custom, options=options,
      minimum=0, maximum=2)
panel("timeseries", "Context held in KV cache (tokens)", (8, 28, 8, 8),
      [query("SELECT %s AS time, %s FROM samples WHERE %s GROUP BY 1 ORDER BY 1"
             % (BUCKET, node_avg("used"), RANGE))],
      "Tokens in each node's slots. A slot holds up to 131,072.", unit="short", custom=custom, options=options)
panel("timeseries", "Prompt cache hit rate", (16, 28, 8, 8),
      [query("SELECT %s AS time, %s FROM samples WHERE %s GROUP BY 1 ORDER BY 1"
             % (BUCKET, node_ratio("d_cached", "(d_cached + d_prompt)"), RANGE))],
      "Share of prompt tokens reused from a slot's cache instead of being read again.",
      unit="percentunit", custom=custom, options=options, minimum=0, maximum=1)
panel("timeseries", "Gateway concurrency", (0, 36, 12, 8),
      [query("SELECT %s AS time, AVG(inflight) AS \"in flight\", AVG(workers) AS workers, "
             "MAX(waiting) AS \"leads waiting\", MAX(max) AS cap FROM gateway WHERE %s GROUP BY 1 ORDER BY 1"
             % (BUCKET, RANGE))],
      "Requests the gateway is running, how many are workers, and leads queued for a slot.",
      unit="short", custom=custom, options=options,
      overrides=[{"matcher": {"id": "byName", "options": "cap"},
                  "properties": [{"id": "custom.lineStyle", "value": {"fill": "dash", "dash": [8, 6]}},
                                 {"id": "custom.fillOpacity", "value": 0},
                                 {"id": "color", "value": {"mode": "fixed", "fixedColor": "#808080"}}]}])
panel("timeseries", "Node availability", (12, 36, 6, 8),
      [query("SELECT %s AS time, %s FROM samples WHERE %s GROUP BY 1 ORDER BY 1"
             % (BUCKET, node_avg("up"), RANGE))],
      "Share of samples in which each node's server answered.", unit="percentunit",
      custom=custom, options=options, minimum=0, maximum=1)
panel("timeseries", "Requests waiting at the server", (18, 36, 6, 8),
      [query("SELECT %s AS time, %s FROM samples WHERE %s GROUP BY 1 ORDER BY 1"
             % (BUCKET, per_node("MAX(CASE WHEN node = '{node}' THEN deferred END)"), RANGE))],
      "Requests llama.cpp deferred because every slot was busy (tunnel users included).",
      unit="short", custom=custom, options=options)

# --- users -------------------------------------------------------------------
row("Users", 44)
BY_USER = [{"id": "partitionByValues", "options": {"fields": ["user"], "keepFields": False}}]
bar_custom, bar_options = timeseries_options(stack=True, bars=True)
panel("timeseries", "Tokens generated, by user", (0, 45, 12, 8),
      [query("SELECT %s AS time, user, SUM(completion) AS tokens FROM requests "
             "WHERE %s AND completion IS NOT NULL GROUP BY 1, 2 ORDER BY 1" % (BUCKET, RANGE))],
      "Output tokens per interval, stacked by gateway user.", unit="short",
      custom=bar_custom, options=bar_options, transformations=BY_USER)
panel("timeseries", "Requests, by user", (12, 45, 12, 8),
      [query("SELECT %s AS time, user, COUNT(*) AS requests FROM requests "
             "WHERE %s GROUP BY 1, 2 ORDER BY 1" % (BUCKET, RANGE))],
      "Model requests per interval (each agent step is one), stacked by gateway user.", unit="short",
      custom=bar_custom, options=bar_options, transformations=BY_USER)

USAGE_SQL = """
SELECT user AS "User",
  COUNT(*) AS "Requests",
  SUM(role = 'lead') AS "Lead",
  SUM(role = 'worker') AS "Worker",
  SUM(status >= 400) AS "Errors",
  SUM(prompt) AS "Tokens in",
  SUM(cache) AS "Cached",
  SUM(completion) AS "Tokens out",
  SUM(cache) * 1.0 / NULLIF(SUM(CASE WHEN cache IS NOT NULL THEN prompt END), 0) AS "Cache hit",
  SUM(CASE WHEN gms > 0 THEN completion END) * 1000.0 / NULLIF(SUM(CASE WHEN gms > 0 THEN gms END), 0) AS "Gen tok/s",
  AVG(CASE WHEN stream = 1 AND pms IS NOT NULL THEN queued + pms / 1000.0 END) AS "Avg first token",
  AVG(dur) AS "Avg duration",
  MAX(dur) AS "Longest",
  AVG(queued) AS "Avg queue",
  SUM(gone) AS "Abandoned"
FROM requests WHERE %s GROUP BY user ORDER BY "Tokens out" DESC, "Requests" DESC
""" % RANGE


def column(name, **props):
    return {"matcher": {"id": "byName", "options": name},
            "properties": [{"id": key, "value": value} for key, value in props.items()]}


GAUGE = {"type": "gauge", "mode": "lcd"}
panel("table", "Usage by user", (0, 53, 24, 9), [query(USAGE_SQL)],
      "Everything each gateway user did in the range. Token columns count only requests logged "
      "since metering began; requests before that count in Requests alone.",
      custom={"align": "auto", "cellOptions": {"type": "auto"}},
      options={"showHeader": True, "cellHeight": "sm", "sortBy": [{"displayName": "Tokens out", "desc": True}]},
      overrides=[
          column("Tokens in", unit="short"), column("Cached", unit="short"),
          column("Tokens out", unit="short", **{"custom.cellOptions": GAUGE, "color": {"mode": "continuous-BlPu"}}),
          column("Cache hit", unit="percentunit", decimals=0, min=0, max=1,
                 **{"custom.cellOptions": GAUGE, "color": {"mode": "continuous-RdYlGr"}}),
          column("Gen tok/s", decimals=1), column("Avg first token", unit="s", decimals=1),
          column("Avg duration", unit="s", decimals=1), column("Longest", unit="s", decimals=0),
          column("Avg queue", unit="s", decimals=1),
          column("Errors", **{"custom.cellOptions": {"type": "color-text"}, "thresholds": {
              "mode": "absolute", "steps": [{"color": GREEN, "value": None}, {"color": RED, "value": 1}]}}),
      ])
panel("timeseries", "Tokens per day, by user", (0, 62, 12, 8),
      [query("SELECT CAST(ts / 86400 AS INTEGER) * 86400 AS time, user, SUM(prompt) AS \"in\", "
             "SUM(completion) AS \"out\" FROM requests WHERE %s AND prompt IS NOT NULL "
             "GROUP BY 1, 2 ORDER BY 1" % RANGE)],
      "Prompt and output tokens per UTC day.", unit="short",
      custom=bar_custom, options=bar_options, transformations=BY_USER)
latency_custom, latency_options = timeseries_options(fill=8)
panel("timeseries", "Latency", (12, 62, 12, 8),
      [query("SELECT %s AS time, AVG(dur) AS \"avg duration\", MAX(dur) AS \"longest\", "
             "AVG(CASE WHEN stream = 1 AND pms IS NOT NULL THEN queued + pms / 1000.0 END) AS \"avg first token\", "
             "AVG(queued) AS \"avg queue\" FROM requests WHERE %s GROUP BY 1 ORDER BY 1" % (BUCKET, RANGE))],
      "How long requests took end to end, waited for a slot, and took to start streaming.",
      unit="s", custom=latency_custom, options=latency_options)

# --- requests ----------------------------------------------------------------
row("Requests", 70)
PIE = {"reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": True},
       "pieType": "donut", "displayLabels": ["percent"],
       "legend": {"displayMode": "table", "placement": "right", "showLegend": True, "values": ["value"]},
       "tooltip": {"mode": "single"}}
panel("piechart", "How replies ended", (0, 71, 6, 8),
      [query("SELECT COALESCE(finish, 'not recorded') AS finish, COUNT(*) AS requests FROM requests "
             "WHERE %s GROUP BY 1 ORDER BY 2 DESC" % RANGE)],
      "stop: finished. tool_calls: handed a step to a tool. length: hit the output cap.",
      options=PIE)
panel("piechart", "Requests by node", (6, 71, 6, 8),
      [query("SELECT node, COUNT(*) AS requests FROM requests WHERE %s GROUP BY 1 ORDER BY 1" % RANGE)],
      "Where the gateway sent requests.", options=PIE)
panel("barchart", "Busiest hours (VM local time)", (12, 71, 12, 8),
      [query("SELECT strftime('%%H', ts, 'unixepoch', 'localtime') AS hour, COUNT(*) AS requests "
             "FROM requests WHERE %s GROUP BY 1 ORDER BY 1" % RANGE)],
      "Requests by hour of day over the range.", unit="short",
      options={"xField": "hour", "orientation": "vertical", "showValue": "never", "barWidth": 0.8,
               "legend": {"showLegend": False}, "tooltip": {"mode": "single"}},
      custom={"fillOpacity": 80, "gradientMode": "hue", "lineWidth": 0},
      color={"mode": "continuous-BlPu"})
panel("timeseries", "Errors and rejections", (0, 79, 8, 8),
      [query("SELECT %s AS time, SUM(status >= 400) AS errors FROM requests WHERE %s GROUP BY 1 ORDER BY 1"
             % (BUCKET, RANGE), "A"),
       query("SELECT %s AS time, COUNT(*) AS rejected FROM rejections WHERE %s GROUP BY 1 ORDER BY 1"
             % (BUCKET, RANGE), "B")],
      "Failed requests, and requests the gateway turned away (no node up, or no slot in time).",
      unit="short", custom=bar_custom, options=bar_options)
panel("table", "Recent requests", (8, 79, 16, 8),
      [query("SELECT ts AS time, user, node, role, status, queued AS queue, dur AS duration, prompt AS \"in\", "
             "cache AS cached, completion AS \"out\", finish, gone AS abandoned FROM requests WHERE %s "
             "ORDER BY ts DESC LIMIT 300" % RANGE)],
      "The latest requests in the range, newest first.",
      custom={"align": "auto", "cellOptions": {"type": "auto"}},
      options={"showHeader": True, "cellHeight": "sm"},
      overrides=[column("queue", unit="s", decimals=1), column("duration", unit="s", decimals=1),
                 column("in", unit="short"), column("cached", unit="short"), column("out", unit="short"),
                 column("status", **{"custom.cellOptions": {"type": "color-text"}, "thresholds": {
                     "mode": "absolute", "steps": [{"color": GREEN, "value": None}, {"color": RED, "value": 400}]}})])

DASHBOARD = {
    "uid": "tellico",
    "title": "Tellico",
    "description": "State and use of the Tellico models: nodes, slots, gateway, users and requests.",
    "tags": ["tellico", "llm"],
    "timezone": "browser",
    "editable": True,
    "graphTooltip": 1,
    "refresh": "30s",
    "time": {"from": "now-24h", "to": "now"},
    "timepicker": {"refresh_intervals": ["10s", "30s", "1m", "5m", "15m"]},
    "schemaVersion": 39,
    "version": 1,
    "panels": panels,
}

if __name__ == "__main__":
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tellico.json")
    with open(out, "w", encoding="utf-8") as handle:
        json.dump(DASHBOARD, handle, indent=1)
        handle.write("\n")
    print("wrote %s (%d panels)" % (out, sum(1 for p in panels if p["type"] != "row")))

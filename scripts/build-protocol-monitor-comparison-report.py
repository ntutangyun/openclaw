#!/usr/bin/env python3
"""Compare Protocol Monitor HTML reports from N runs and emit a single HTML
summary with min/max/mean/stdev/range for every monitored metric.

Usage: python3 build-protocol-monitor-comparison-report.py <out.html> <report1.html> [report2.html ...]
"""

from __future__ import annotations

import json
import os
import re
import statistics
import sys
from dataclasses import dataclass
from html import escape
from typing import Any


# ---------------------------------------------------------------------------
# Snapshot extraction
# ---------------------------------------------------------------------------

SNAPSHOT_RE = re.compile(
    r'<script[^>]*id="__openclaw_pm_snapshot__"[^>]*>(.*?)</script>',
    re.S,
)


def extract_snapshot(html_path: str) -> dict[str, Any]:
    with open(html_path, encoding="utf-8") as f:
        html = f.read()
    m = SNAPSHOT_RE.search(html)
    if not m:
        raise RuntimeError(f"no snapshot in {html_path}")
    raw = m.group(1).replace(r"<\/", "</")
    return json.loads(raw)


# ---------------------------------------------------------------------------
# Per-snapshot metric derivation
# ---------------------------------------------------------------------------

THROUGHPUT_BUCKET_MS = 2000


def bytes_per_sec_samples(buckets: list[list[int]]) -> list[float]:
    """Convert bucket [[ts, bytes], ...] → bytes/sec values."""
    return [bytes_ / THROUGHPUT_BUCKET_MS * 1000 for _ts, bytes_ in buckets]


def build_latency_stats(values: list[float]) -> dict[str, float | int | None]:
    n = len(values)
    if n == 0:
        return {"count": 0, "avgMs": None, "p50Ms": None, "p95Ms": None, "peakMs": None}
    s = sorted(values)
    return {
        "count": n,
        "avgMs": sum(s) / n,
        "p50Ms": s[n // 2],
        "p95Ms": s[int(n * 0.95)] if int(n * 0.95) < n else s[-1],
        "peakMs": s[-1],
    }


def compute_ws_latency(traces: list[dict[str, Any]], source: str) -> list[float]:
    out: list[float] = []
    for t in traces:
        if t.get("source") != source:
            continue
        if t.get("target") != "gateway":
            continue
        lat = t.get("oneWayLatencyMs")
        if isinstance(lat, (int, float)):
            out.append(float(lat))
    return out


def derive(snap: dict[str, Any]) -> dict[str, float | int | None]:
    """Return flat {metric_name: value} for one snapshot."""
    metrics: dict[str, float | int | None] = {}

    # -------------------- Usage Overview --------------------
    ut = snap.get("usageTotals") or {}
    ua = snap.get("usageAggregates") or {}
    sessions = snap.get("usageSessions") or []

    msg = ua.get("messages") or {}
    tools = ua.get("tools") or {}

    msg_total = int(msg.get("total", 0) or 0)
    metrics["UsageOverview.Messages.Total"] = msg_total
    metrics["UsageOverview.Messages.User"] = int(msg.get("user", 0) or 0)
    metrics["UsageOverview.Messages.Assistant"] = int(msg.get("assistant", 0) or 0)

    metrics["UsageOverview.ToolCalls.Total"] = int(tools.get("totalCalls", 0) or 0)
    metrics["UsageOverview.ToolCalls.Unique"] = int(tools.get("uniqueTools", 0) or 0)
    metrics["UsageOverview.ToolCalls.Results"] = int(msg.get("toolResults", 0) or 0)

    errors = int(msg.get("errors", 0) or 0)
    metrics["UsageOverview.ErrorRate.Count"] = errors
    metrics["UsageOverview.ErrorRate.Percent"] = (
        errors / msg_total * 100 if msg_total > 0 else 0.0
    )

    input_tokens = int(ut.get("input", 0) or 0)
    output_tokens = int(ut.get("output", 0) or 0)
    cache_read = int(ut.get("cacheRead", 0) or 0)
    cache_write = int(ut.get("cacheWrite", 0) or 0)
    total_tokens = int(ut.get("totalTokens", 0) or 0)
    total_cost = float(ut.get("totalCost", 0) or 0.0)

    metrics["UsageOverview.Tokens.Input"] = input_tokens
    metrics["UsageOverview.Tokens.Output"] = output_tokens
    metrics["UsageOverview.Tokens.CacheRead"] = cache_read
    metrics["UsageOverview.Tokens.CacheWrite"] = cache_write
    metrics["UsageOverview.Tokens.Total"] = total_tokens

    cache_base = input_tokens + cache_read
    metrics["UsageOverview.CacheHitRate.Percent"] = (
        cache_read / cache_base * 100 if cache_base > 0 else 0.0
    )

    metrics["UsageOverview.AvgTokensPerMsg"] = (
        total_tokens / msg_total if msg_total > 0 else 0
    )

    metrics["UsageOverview.TotalCost.USD"] = total_cost
    metrics["UsageOverview.TotalCost.PerMessageUSD"] = (
        total_cost / msg_total if msg_total > 0 else 0.0
    )

    # Throughput: sum of session.usage.durationMs
    duration_sum_ms = 0.0
    duration_count = 0
    for s in sessions:
        u = s.get("usage") or {}
        d = u.get("durationMs")
        if isinstance(d, (int, float)) and d > 0:
            duration_sum_ms += float(d)
            duration_count += 1
    metrics["UsageOverview.Throughput.ActiveDurationMs"] = duration_sum_ms
    metrics["UsageOverview.Throughput.SessionCount"] = duration_count
    metrics["UsageOverview.Throughput.TokensPerMin"] = (
        total_tokens / (duration_sum_ms / 60_000) if duration_sum_ms > 0 else 0.0
    )

    # -------------------- Network accumulator --------------------
    net = (snap.get("latencyCaches") or {}).get("network") or {}
    metrics["Session.NetworkTotalBytesIn"] = int(net.get("totalBytesIn", 0) or 0)
    metrics["Session.NetworkTotalBytesOut"] = int(net.get("totalBytesOut", 0) or 0)

    route_map = {
        "Operator->Gateway": ("operatorGateway", "forward"),
        "Gateway->Operator": ("operatorGateway", "reverse"),
        "Gateway->Node": ("gatewayNode", "forward"),
        "Node->Gateway": ("gatewayNode", "reverse"),
        "Agent->Model": ("agentLlm", "forward"),
        "Model->Agent": ("agentLlm", "reverse"),
    }

    for prefix, (route_key, side) in route_map.items():
        route = net.get(route_key) or {}
        buckets: list[list[int]] = route.get(side) or []
        bps = bytes_per_sec_samples(buckets)
        total = sum(b for _, b in buckets)
        metrics[f"{prefix}.Throughput.BucketCount"] = len(buckets)
        metrics[f"{prefix}.Throughput.PeakBytesPerSec"] = max(bps) if bps else 0
        metrics[f"{prefix}.Throughput.AverageBytesPerSec"] = (
            sum(bps) / len(bps) if bps else 0
        )
        metrics[f"{prefix}.Throughput.TotalBytes"] = total

    # -------------------- Agent->Model Requests --------------------
    req = net.get("requests") or {}
    req_total = int(req.get("total", 0) or 0)
    req_total_size = int(req.get("totalSize", 0) or 0)
    metrics["Agent->Model.Requests.Total"] = req_total
    metrics["Agent->Model.Requests.PeakPayloadBytes"] = int(req.get("peakSize", 0) or 0)
    metrics["Agent->Model.Requests.AvgPayloadBytes"] = (
        req_total_size / req_total if req_total > 0 else 0
    )
    metrics["Agent->Model.Requests.LatestPayloadBytes"] = int(
        req.get("latestSize", 0) or 0
    )

    # -------------------- Model->Agent Responses --------------------
    res = net.get("responses") or {}
    res_total = int(res.get("total", 0) or 0)
    res_total_size = int(res.get("totalSize", 0) or 0)
    res_first = res.get("firstTs")
    res_last = res.get("lastTs")
    metrics["Model->Agent.Responses.TotalSSEEvents"] = res_total
    metrics["Model->Agent.Responses.PeakPayloadBytes"] = int(res.get("peakSize", 0) or 0)
    metrics["Model->Agent.Responses.AvgPayloadBytes"] = (
        res_total_size / res_total if res_total > 0 else 0
    )
    eps: float | None
    if (
        isinstance(res_first, (int, float))
        and isinstance(res_last, (int, float))
        and res_last > res_first
    ):
        eps = res_total / ((res_last - res_first) / 1000)
    else:
        eps = None
    metrics["Model->Agent.Responses.AvgEventsPerSec"] = eps

    # -------------------- Latency caches --------------------
    lc = snap.get("latencyCaches") or {}
    ttft = [s["latencyMs"] for s in (lc.get("ttft") or []) if "latencyMs" in s]
    gen = [s["latencyMs"] for s in (lc.get("gen") or []) if "latencyMs" in s]
    traces = snap.get("traces") or []
    op_lat = compute_ws_latency(traces, "operator")
    node_lat = compute_ws_latency(traces, "node")

    for prefix, samples in (
        ("Agent->Model.TTFT", ttft),
        ("Model->Agent.Generation", gen),
        ("Operator->Gateway.OneWayLatency", op_lat),
        ("Node->Gateway.OneWayLatency", node_lat),
    ):
        st = build_latency_stats(samples)
        metrics[f"{prefix}.Count"] = st["count"]
        metrics[f"{prefix}.AvgMs"] = st["avgMs"]
        metrics[f"{prefix}.p50Ms"] = st["p50Ms"]
        metrics[f"{prefix}.p95Ms"] = st["p95Ms"]
        metrics[f"{prefix}.PeakMs"] = st["peakMs"]

    return metrics


# ---------------------------------------------------------------------------
# Aggregation
# ---------------------------------------------------------------------------


@dataclass
class Stats:
    values: list[float]

    @property
    def usable(self) -> list[float]:
        return [v for v in self.values if v is not None]

    def mean(self) -> float | None:
        u = self.usable
        return sum(u) / len(u) if u else None

    def min(self) -> float | None:
        u = self.usable
        return min(u) if u else None

    def max(self) -> float | None:
        u = self.usable
        return max(u) if u else None

    def stdev(self) -> float | None:
        u = self.usable
        return statistics.pstdev(u) if len(u) >= 2 else 0.0 if u else None

    def cov(self) -> float | None:
        """Coefficient of variation as a percentage; None if mean == 0."""
        m = self.mean()
        if m is None or m == 0:
            return None
        sd = self.stdev()
        return sd / m * 100 if sd is not None else None


# ---------------------------------------------------------------------------
# Formatting
# ---------------------------------------------------------------------------


def fmt_bytes(b: float | None) -> str:
    if b is None:
        return "—"
    b = float(b)
    if b < 1024:
        return f"{b:.0f} B"
    if b < 1024 * 1024:
        return f"{b / 1024:.2f} KB"
    if b < 1024 * 1024 * 1024:
        return f"{b / (1024 * 1024):.2f} MB"
    return f"{b / (1024**3):.2f} GB"


def fmt_bps(b: float | None) -> str:
    if b is None:
        return "—"
    return f"{fmt_bytes(b)}/s"


def fmt_ms(v: float | None) -> str:
    if v is None:
        return "—"
    if v < 1000:
        return f"{v:.0f} ms"
    if v < 60_000:
        return f"{v / 1000:.2f} s"
    m = int(v // 60000)
    s = (v - m * 60000) / 1000
    return f"{m}m {s:.1f}s"


def fmt_int(v: float | None) -> str:
    if v is None:
        return "—"
    return f"{int(round(v)):,}"


def fmt_float(v: float | None, digits: int = 2) -> str:
    if v is None:
        return "—"
    return f"{v:.{digits}f}"


def fmt_pct(v: float | None) -> str:
    if v is None:
        return "—"
    return f"{v:.2f}%"


def fmt_usd(v: float | None) -> str:
    if v is None:
        return "—"
    return f"${v:.4f}"


# Formatters per metric suffix / keyword
def fmt_for(metric: str, value: float | None) -> str:
    if value is None:
        return "—"
    m = metric
    if m.endswith(".Percent") or "HitRate" in m or "ErrorRate" in m:
        return fmt_pct(value)
    if m.endswith(".USD") or m.endswith(".PerMessageUSD"):
        return fmt_usd(value)
    if m.endswith(".PeakBytesPerSec") or m.endswith(".AverageBytesPerSec"):
        return fmt_bps(value)
    if (
        m.endswith(".TotalBytes")
        or m.endswith("BytesIn")
        or m.endswith("BytesOut")
        or m.endswith("PayloadBytes")
    ):
        return fmt_bytes(value)
    if m.endswith(".AvgMs") or m.endswith(".p50Ms") or m.endswith(".p95Ms") or m.endswith(".PeakMs"):
        return fmt_ms(value)
    if m.endswith(".ActiveDurationMs"):
        return fmt_ms(value)
    if m.endswith(".TokensPerMin"):
        return fmt_float(value, 1) + " tok/min"
    if m.endswith(".AvgEventsPerSec"):
        return f"{value:.2f} /s"
    if m.endswith(".AvgTokensPerMsg") or m.endswith(".Tokens.Input") or m.endswith(".Tokens.Output") \
            or m.endswith(".Tokens.CacheRead") or m.endswith(".Tokens.CacheWrite") \
            or m.endswith(".Tokens.Total"):
        return fmt_int(value)
    # default integer
    return fmt_int(value)


# ---------------------------------------------------------------------------
# Sections (display ordering + labels)
# ---------------------------------------------------------------------------

SECTIONS: list[tuple[str, list[str]]] = [
    (
        "Usage Overview",
        [
            "UsageOverview.Messages.Total",
            "UsageOverview.Messages.User",
            "UsageOverview.Messages.Assistant",
            "UsageOverview.Throughput.TokensPerMin",
            "UsageOverview.Throughput.ActiveDurationMs",
            "UsageOverview.Throughput.SessionCount",
            "UsageOverview.ToolCalls.Total",
            "UsageOverview.ToolCalls.Unique",
            "UsageOverview.ToolCalls.Results",
            "UsageOverview.AvgTokensPerMsg",
            "UsageOverview.CacheHitRate.Percent",
            "UsageOverview.ErrorRate.Percent",
            "UsageOverview.ErrorRate.Count",
            "UsageOverview.TotalCost.USD",
            "UsageOverview.TotalCost.PerMessageUSD",
            "UsageOverview.Tokens.Input",
            "UsageOverview.Tokens.Output",
            "UsageOverview.Tokens.CacheRead",
            "UsageOverview.Tokens.CacheWrite",
            "UsageOverview.Tokens.Total",
        ],
    ),
    (
        "Session-wide Network Totals",
        [
            "Session.NetworkTotalBytesIn",
            "Session.NetworkTotalBytesOut",
        ],
    ),
    (
        "Operator → Gateway",
        [
            "Operator->Gateway.Throughput.PeakBytesPerSec",
            "Operator->Gateway.Throughput.AverageBytesPerSec",
            "Operator->Gateway.Throughput.TotalBytes",
            "Operator->Gateway.Throughput.BucketCount",
            "Operator->Gateway.OneWayLatency.Count",
            "Operator->Gateway.OneWayLatency.AvgMs",
            "Operator->Gateway.OneWayLatency.p50Ms",
            "Operator->Gateway.OneWayLatency.p95Ms",
            "Operator->Gateway.OneWayLatency.PeakMs",
        ],
    ),
    (
        "Gateway → Operator",
        [
            "Gateway->Operator.Throughput.PeakBytesPerSec",
            "Gateway->Operator.Throughput.AverageBytesPerSec",
            "Gateway->Operator.Throughput.TotalBytes",
            "Gateway->Operator.Throughput.BucketCount",
        ],
    ),
    (
        "Gateway → Node",
        [
            "Gateway->Node.Throughput.PeakBytesPerSec",
            "Gateway->Node.Throughput.AverageBytesPerSec",
            "Gateway->Node.Throughput.TotalBytes",
            "Gateway->Node.Throughput.BucketCount",
        ],
    ),
    (
        "Node → Gateway",
        [
            "Node->Gateway.Throughput.PeakBytesPerSec",
            "Node->Gateway.Throughput.AverageBytesPerSec",
            "Node->Gateway.Throughput.TotalBytes",
            "Node->Gateway.Throughput.BucketCount",
            "Node->Gateway.OneWayLatency.Count",
            "Node->Gateway.OneWayLatency.AvgMs",
            "Node->Gateway.OneWayLatency.p50Ms",
            "Node->Gateway.OneWayLatency.p95Ms",
            "Node->Gateway.OneWayLatency.PeakMs",
        ],
    ),
    (
        "Agent → Model",
        [
            "Agent->Model.Throughput.PeakBytesPerSec",
            "Agent->Model.Throughput.AverageBytesPerSec",
            "Agent->Model.Throughput.TotalBytes",
            "Agent->Model.Throughput.BucketCount",
            "Agent->Model.Requests.Total",
            "Agent->Model.Requests.PeakPayloadBytes",
            "Agent->Model.Requests.AvgPayloadBytes",
            "Agent->Model.Requests.LatestPayloadBytes",
            "Agent->Model.TTFT.Count",
            "Agent->Model.TTFT.AvgMs",
            "Agent->Model.TTFT.p50Ms",
            "Agent->Model.TTFT.p95Ms",
            "Agent->Model.TTFT.PeakMs",
        ],
    ),
    (
        "Model → Agent",
        [
            "Model->Agent.Throughput.PeakBytesPerSec",
            "Model->Agent.Throughput.AverageBytesPerSec",
            "Model->Agent.Throughput.TotalBytes",
            "Model->Agent.Throughput.BucketCount",
            "Model->Agent.Responses.TotalSSEEvents",
            "Model->Agent.Responses.AvgEventsPerSec",
            "Model->Agent.Responses.PeakPayloadBytes",
            "Model->Agent.Responses.AvgPayloadBytes",
            "Model->Agent.Generation.Count",
            "Model->Agent.Generation.AvgMs",
            "Model->Agent.Generation.p50Ms",
            "Model->Agent.Generation.p95Ms",
            "Model->Agent.Generation.PeakMs",
        ],
    ),
]


# ---------------------------------------------------------------------------
# HTML rendering
# ---------------------------------------------------------------------------

CSS = """
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', 'PingFang SC',
    'Helvetica Neue', Arial, sans-serif;
  background: #0f172a;
  color: #e2e8f0;
  padding: 24px 28px 64px;
  line-height: 1.45;
}
h1 { margin: 0 0 4px; color: #fde68a; }
h2 { margin: 28px 0 10px; color: #93c5fd; font-size: 16px; border-bottom: 1px solid #334155; padding-bottom: 4px; }
.meta { color: #94a3b8; font-size: 12px; margin-bottom: 12px; }
table { border-collapse: collapse; width: 100%; font-size: 12px; margin-bottom: 8px; background: #1e293b; }
th, td {
  border: 1px solid #334155;
  padding: 6px 9px;
  text-align: right;
  vertical-align: top;
  white-space: nowrap;
}
th { background: #0b1220; color: #e2e8f0; font-weight: 600; text-align: center; position: sticky; top: 0; }
td.metric, th.metric { text-align: left; font-family: 'JetBrains Mono', 'Fira Code', Menlo, monospace; color: #fcd34d; max-width: 340px; white-space: normal; }
td.zero { color: #64748b; }
td.stdev-high { color: #fca5a5; }
td.stdev-mid { color: #fde68a; }
td.stdev-low { color: #bbf7d0; }
tr:nth-child(even) td { background: #182033; }
.legend { font-size: 11px; color: #94a3b8; margin: 4px 0 14px; }
.summary-note { margin-top: 20px; font-size: 12px; color: #cbd5e1; max-width: 860px; line-height: 1.55; }
.summary-note strong { color: #fde68a; }
code { background: #0b1220; padding: 1px 5px; border-radius: 3px; font-size: 11px; }
"""


def classify_cov(cov: float | None) -> str:
    if cov is None:
        return ""
    if cov < 15:
        return "stdev-low"
    if cov < 40:
        return "stdev-mid"
    return "stdev-high"


def render_html(
    run_names: list[str],
    run_metrics: list[dict[str, float | int | None]],
    captured_iso: list[str],
) -> str:
    out: list[str] = []
    out.append("<!doctype html><html lang='en'><head><meta charset='utf-8'>")
    n = len(run_names)
    out.append(
        f"<title>Protocol Monitor · {n}-run comparison (gpt-5.4 basic-template ai/ml)</title>"
    )
    out.append(f"<style>{CSS}</style></head><body>")
    out.append(
        f"<h1>Protocol Monitor · {n}-Run Comparison</h1>"
        f"<div class='meta'>gpt-5.4-basic-template ai/ml task · 同一任务重复 {n} 次,"
        f"对比每个监控指标的分布。每行显示 {n} 次运行的原始值、min/max/mean、"
        "标准差 (σ) 和变异系数 (CV = σ/mean)。CV 越高说明越不稳定。</div>"
    )
    out.append(
        "<div class='legend'>CV 颜色:"
        "<span style='color:#bbf7d0'>&lt;15% 稳定</span> · "
        "<span style='color:#fde68a'>15–40% 一般</span> · "
        "<span style='color:#fca5a5'>≥40% 不稳定</span> · "
        "— 表示缺失值(如 session 里没有该方向的流量)</div>"
    )

    # Header table: run labels + capturedAt
    out.append("<h2>Run Timestamps</h2>")
    out.append("<table><tr><th class='metric'>Run</th><th>Captured At (UTC)</th></tr>")
    for name, iso in zip(run_names, captured_iso, strict=False):
        out.append(f"<tr><td class='metric'>{escape(name)}</td><td>{escape(iso)}</td></tr>")
    out.append("</table>")

    for section_title, metric_keys in SECTIONS:
        out.append(f"<h2>{escape(section_title)}</h2>")
        # Header row
        out.append("<table><thead><tr>")
        out.append("<th class='metric'>Metric</th>")
        for name in run_names:
            out.append(f"<th>{escape(name)}</th>")
        out.append("<th>Min</th><th>Mean</th><th>Max</th><th>σ</th><th>CV</th>")
        out.append("</tr></thead><tbody>")

        for mkey in metric_keys:
            vals_raw = [rm.get(mkey) for rm in run_metrics]
            # Normalize to floats for stats (skip None)
            numeric: list[float] = []
            for v in vals_raw:
                if v is None:
                    continue
                try:
                    numeric.append(float(v))
                except (TypeError, ValueError):
                    pass
            stats = Stats(numeric)
            vmin = stats.min()
            vmean = stats.mean()
            vmax = stats.max()
            vstd = stats.stdev()
            vcov = stats.cov()
            cov_cls = classify_cov(vcov)

            out.append(f"<tr><td class='metric'>{escape(mkey)}</td>")
            for v in vals_raw:
                zero_cls = " class='zero'" if (v == 0 or v is None) else ""
                out.append(f"<td{zero_cls}>{escape(fmt_for(mkey, v))}</td>")
            out.append(f"<td>{escape(fmt_for(mkey, vmin))}</td>")
            out.append(f"<td>{escape(fmt_for(mkey, vmean))}</td>")
            out.append(f"<td>{escape(fmt_for(mkey, vmax))}</td>")
            out.append(f"<td>{escape(fmt_for(mkey, vstd))}</td>")
            out.append(
                f"<td class='{cov_cls}'>{escape(fmt_pct(vcov))}</td>"
            )
            out.append("</tr>")

        out.append("</tbody></table>")

    # Summary note
    out.append(
        "<div class='summary-note'>"
        "<strong>如何解读</strong>:同一任务(gpt-5.4-basic-template ai/ml)"
        "重复执行 5 次,正常应当看到 Usage Overview 和 Requests/Responses 累计值"
        "相对稳定(CV &lt; 15%),TTFT 与 Generation 分布会因 model provider 抖动而"
        "有一定波动(CV 15–40% 为常态);Throughput peak/bps 受 burst 时机影响,"
        "CV 偏高(&gt; 40%)也属正常,主要关注 total bytes 与 bucket 数的一致性。"
        "<br><br><strong>用途</strong>:用来识别"
        "(1) 哪些指标运行稳定、可作为 benchmark baseline;"
        "(2) 哪些指标抖动大、可能需要重复采样或更稳的计数方法;"
        "(3) 个别 run 是否偏离 mean 过远(outlier,可能是环境问题,需要排查)。"
        "</div></body></html>"
    )
    return "".join(out)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print(__doc__, file=sys.stderr)
        return 2
    out_path = argv[1]
    inputs = argv[2:]

    run_names: list[str] = []
    run_metrics: list[dict[str, float | int | None]] = []
    captured_iso: list[str] = []

    import datetime

    for p in inputs:
        snap = extract_snapshot(p)
        metrics = derive(snap)
        # Run name: parent-of-parent folder (e.g. gpt-5.4-basic-template_ai_ml_v2)
        abs_p = os.path.abspath(p)
        parts = abs_p.split(os.sep)
        # .../gpt-5.4-basic-template_ai_ml_vN/openclaw_workspace/protocol-monitor-*.html
        name = parts[-3] if len(parts) >= 3 else os.path.basename(p)
        run_names.append(name.replace("gpt-5.4-basic-template_ai_ml_", "run_"))
        run_metrics.append(metrics)
        ts = snap.get("capturedAt")
        if isinstance(ts, (int, float)):
            captured_iso.append(
                datetime.datetime.fromtimestamp(ts / 1000, tz=datetime.timezone.utc).isoformat(
                    timespec="seconds"
                )
            )
        else:
            captured_iso.append("?")

    html = render_html(run_names, run_metrics, captured_iso)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"Wrote {out_path}  ({len(run_names)} runs, {len(run_metrics[0])} metrics each)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

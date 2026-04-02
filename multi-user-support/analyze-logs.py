#!/usr/bin/env python3
"""
OpenClaw Log Analyzer — generates a self-contained HTML report from exported logs.

Usage:
    python3 analyze-logs.py <export-dir> [-o report.html]

Reads all log files from a manage.sh export-logs directory and produces
an interactive HTML report with:
  - Unified vertical sequence diagram of all events by timestamp
  - Filter checkboxes per log type, severity, component
  - Statistics dashboard (cost, tokens, latency, error counts)
"""

import json
import os
import re
import sys
import html as html_mod
from datetime import datetime, timezone
from pathlib import Path
from collections import defaultdict

# ── Parse helpers ────────────────────────────────────────────────

def parse_iso(ts_str):
    """Parse ISO-8601 timestamp string to epoch ms."""
    if not ts_str:
        return None
    try:
        ts_str = ts_str.replace("+00:00", "+0000").replace("Z", "+0000")
        # Handle "2026-03-18T12:00:42.877+0000"
        if "+" in ts_str[10:]:
            base, tz = ts_str.rsplit("+", 1)
        elif ts_str[10:].count("-") >= 1:
            base, tz = ts_str.rsplit("-", 1)
            if len(tz) == 4:
                pass  # timezone offset
            else:
                base = ts_str
                tz = None
        else:
            base = ts_str
            tz = None

        # Parse the base
        for fmt in ("%Y-%m-%dT%H:%M:%S.%f", "%Y-%m-%dT%H:%M:%S"):
            try:
                dt = datetime.strptime(base, fmt).replace(tzinfo=timezone.utc)
                return int(dt.timestamp() * 1000)
            except ValueError:
                continue
    except Exception:
        pass
    return None


def short_id(full_id):
    """Shorten a UUID to first 8 chars."""
    if not full_id:
        return ""
    return str(full_id)[:8]


# ── Event model ──────────────────────────────────────────────────

class Event:
    """A unified event for the timeline."""
    __slots__ = ("ts", "source", "category", "level", "summary",
                 "from_comp", "to_comp", "detail", "cost", "tokens_in",
                 "tokens_out", "duration_ms", "raw")

    def __init__(self, ts, source, category, level, summary,
                 from_comp="", to_comp="", detail="", cost=0,
                 tokens_in=0, tokens_out=0, duration_ms=0, raw=None):
        self.ts = ts
        self.source = source          # log file type
        self.category = category      # sub-category for filtering
        self.level = level            # info/warn/error/debug
        self.summary = summary        # one-line display
        self.from_comp = from_comp    # sequence diagram: source component
        self.to_comp = to_comp        # sequence diagram: target component
        self.detail = detail          # expandable detail
        self.cost = cost
        self.tokens_in = tokens_in
        self.tokens_out = tokens_out
        self.duration_ms = duration_ms
        self.raw = raw

    def to_dict(self):
        return {
            "ts": self.ts,
            "source": self.source,
            "category": self.category,
            "level": self.level,
            "summary": self.summary,
            "from": self.from_comp,
            "to": self.to_comp,
            "detail": self.detail,
            "cost": self.cost,
            "tokensIn": self.tokens_in,
            "tokensOut": self.tokens_out,
            "durationMs": self.duration_ms,
        }


# ── Parsers ──────────────────────────────────────────────────────

def parse_docker_stdout(path):
    """Parse docker-stdout.log (JSON lines from gateway console + plain text)."""
    events = []
    if not path.exists():
        return events
    with open(path, "r", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                # Plain text line (e.g. "Registered plugin command: ...")
                events.append(Event(
                    ts=0, source="docker-stdout", category="plain",
                    level="info", summary=line[:200],
                    from_comp="gateway", to_comp="",
                ))
                continue

            ts = parse_iso(obj.get("time"))
            if ts is None:
                continue
            level = obj.get("level", "info")
            subsystem = obj.get("subsystem", "")
            message = obj.get("message", "")

            # Determine components for sequence diagram
            from_comp, to_comp = "gateway", ""
            cat = "gateway"

            if "gateway/ws" in subsystem:
                cat = "websocket"
                # Parse direction from message
                if message.startswith("←"):
                    from_comp, to_comp = "client", "gateway"
                elif message.startswith("→"):
                    from_comp, to_comp = "gateway", "client"

                # Extract method and duration
                dur_match = re.search(r'(\d+)ms', message)
                dur = int(dur_match.group(1)) if dur_match else 0

                events.append(Event(
                    ts=ts, source="docker-stdout", category=cat,
                    level=level, summary=message[:200],
                    from_comp=from_comp, to_comp=to_comp,
                    duration_ms=dur,
                    detail=json.dumps(obj, indent=2, default=str),
                ))
            elif "agent" in subsystem:
                cat = "agent"
                from_comp = "agent"
                events.append(Event(
                    ts=ts, source="docker-stdout", category=cat,
                    level=level, summary=f"[{subsystem}] {message[:180]}",
                    from_comp=from_comp, to_comp=to_comp,
                    detail=json.dumps(obj, indent=2, default=str),
                ))
            else:
                events.append(Event(
                    ts=ts, source="docker-stdout", category=cat,
                    level=level, summary=f"[{subsystem}] {message[:180]}",
                    from_comp=from_comp, to_comp=to_comp,
                    detail=json.dumps(obj, indent=2, default=str),
                ))
    return events


def parse_gateway_log(path):
    """Parse gateway.log (tslog JSONL with _meta)."""
    events = []
    if not path.exists():
        return events
    with open(path, "r", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue

            ts = parse_iso(obj.get("time"))
            if ts is None:
                continue

            meta = obj.get("_meta", {})
            level_name = meta.get("logLevelName", "INFO").lower()
            # The subsystem is in key "0", message in key "1"
            subsystem_raw = obj.get("0", "")
            message = str(obj.get("1", ""))

            # Try to extract subsystem from the JSON-encoded string
            subsystem = ""
            try:
                sub_obj = json.loads(subsystem_raw)
                subsystem = sub_obj.get("subsystem", "")
            except (json.JSONDecodeError, TypeError):
                subsystem = subsystem_raw

            from_comp, to_comp = "gateway", ""
            cat = "gateway-file"

            if "gateway/ws" in subsystem:
                cat = "websocket"
                if message.startswith("←"):
                    from_comp, to_comp = "client", "gateway"
                elif message.startswith("→"):
                    from_comp, to_comp = "gateway", "client"

            events.append(Event(
                ts=ts, source="gateway-log", category=cat,
                level=level_name, summary=f"[{subsystem}] {message[:180]}",
                from_comp=from_comp, to_comp=to_comp,
                detail=json.dumps(obj, indent=2, default=str),
            ))
    return events


def parse_session_transcripts(sessions_dir):
    """Parse session *.jsonl files."""
    events = []
    if not sessions_dir.exists():
        return events
    for f in sorted(sessions_dir.glob("*.jsonl")):
        with open(f, "r", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue

                ts = parse_iso(obj.get("timestamp"))
                if ts is None:
                    continue

                entry_type = obj.get("type", "")

                if entry_type == "session":
                    events.append(Event(
                        ts=ts, source="session", category="session-lifecycle",
                        level="info",
                        summary=f"Session started: {short_id(obj.get('id'))}",
                        from_comp="gateway", to_comp="agent",
                    ))

                elif entry_type == "model_change":
                    provider = obj.get("provider", "")
                    model = obj.get("modelId", "")
                    events.append(Event(
                        ts=ts, source="session", category="session-lifecycle",
                        level="info",
                        summary=f"Model change: {provider}/{model}",
                        from_comp="agent", to_comp="llm-api",
                    ))

                elif entry_type == "thinking_level_change":
                    events.append(Event(
                        ts=ts, source="session", category="session-lifecycle",
                        level="info",
                        summary=f"Thinking level: {obj.get('thinkingLevel', '?')}",
                        from_comp="agent", to_comp="",
                    ))

                elif entry_type == "message":
                    msg = obj.get("message", {})
                    role = msg.get("role", "?")
                    content = msg.get("content", [])
                    usage = msg.get("usage", {})
                    cost_obj = usage.get("cost", {})
                    cost = cost_obj.get("total", 0) if isinstance(cost_obj, dict) else 0
                    tokens_in = usage.get("input", 0) or 0
                    tokens_out = usage.get("output", 0) or 0
                    cache_read = usage.get("cacheRead", 0) or 0
                    stop_reason = msg.get("stopReason", "")

                    block_types = [b.get("type", "?") for b in content]
                    tool_names = [b.get("name", "") for b in content if b.get("type") in ("toolCall", "toolUse")]

                    # Determine components
                    if role == "user":
                        from_comp, to_comp = "client", "agent"
                        cat = "user-message"
                        # Extract short text preview
                        text_blocks = [b.get("text", "") for b in content if b.get("type") == "text"]
                        preview = (text_blocks[0][:120] if text_blocks else "").replace("\n", " ")
                        summary = f"User: {preview}"
                    elif role == "assistant":
                        from_comp, to_comp = "llm-api", "agent"
                        cat = "assistant-message"
                        if tool_names:
                            summary = f"Assistant: call {', '.join(tool_names)}"
                            if stop_reason:
                                summary += f" (stop={stop_reason})"
                        else:
                            text_blocks = [b.get("text", "") for b in content if b.get("type") == "text"]
                            preview = (text_blocks[0][:120] if text_blocks else "").replace("\n", " ")
                            summary = f"Assistant: {preview}"
                    elif role == "toolResult":
                        from_comp, to_comp = "agent", "agent"
                        cat = "tool-result"
                        tool_name = msg.get("toolName", "")
                        is_error = msg.get("isError", False)
                        text_blocks = [b.get("text", "") for b in content if b.get("type") == "text"]
                        preview = (text_blocks[0][:100] if text_blocks else "").replace("\n", " ")
                        summary = f"Tool result ({tool_name}): {'ERROR: ' if is_error else ''}{preview}"
                    else:
                        from_comp, to_comp = "agent", ""
                        cat = "other-message"
                        summary = f"{role}: {block_types}"

                    # Build detail with content preview (truncated)
                    detail_parts = [f"role: {role}", f"blocks: {block_types}"]
                    if tool_names:
                        detail_parts.append(f"tools: {tool_names}")
                    if usage:
                        detail_parts.append(f"tokens: in={tokens_in} out={tokens_out} cache_read={cache_read}")
                        detail_parts.append(f"cost: ${cost:.6f}")
                    if stop_reason:
                        detail_parts.append(f"stopReason: {stop_reason}")
                    # Add text content preview
                    for b in content:
                        if b.get("type") == "text":
                            detail_parts.append(f"text: {b['text'][:500]}")
                        elif b.get("type") in ("toolCall", "toolUse"):
                            args_str = json.dumps(b.get("arguments", {}), default=str)[:300]
                            detail_parts.append(f"toolCall: {b.get('name','')}({args_str})")

                    events.append(Event(
                        ts=ts, source="session", category=cat,
                        level="error" if (role == "toolResult" and msg.get("isError")) else "info",
                        summary=summary,
                        from_comp=from_comp, to_comp=to_comp,
                        cost=cost or 0,
                        tokens_in=tokens_in,
                        tokens_out=tokens_out,
                        detail="\n".join(detail_parts),
                    ))

                elif entry_type == "custom":
                    custom_type = obj.get("customType", "")
                    events.append(Event(
                        ts=ts, source="session", category="session-lifecycle",
                        level="info",
                        summary=f"Custom: {custom_type}",
                        from_comp="agent", to_comp="",
                        detail=json.dumps(obj.get("data", {}), indent=2, default=str),
                    ))
    return events


def parse_raw_stream(path):
    """Parse raw-stream.jsonl (LLM streaming events)."""
    events = []
    if not path.exists():
        return events
    with open(path, "r", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue

            ts = obj.get("ts")
            if isinstance(ts, str):
                ts = parse_iso(ts)
            elif isinstance(ts, (int, float)):
                ts = int(ts)
            else:
                continue

            evt_type = obj.get("evtType", obj.get("event", "?"))
            run_id = short_id(obj.get("runId", ""))

            # Collapse deltas — only emit start/stop/non-delta events
            if "delta" in evt_type and evt_type not in ("thinking_start", "thinking_stop"):
                continue

            summary = f"Stream: {evt_type}"
            if run_id:
                summary += f" run={run_id}"
            delta = obj.get("delta", "")
            if delta:
                summary += f" \"{delta[:60]}\""

            events.append(Event(
                ts=ts, source="raw-stream", category="llm-stream",
                level="debug",
                summary=summary,
                from_comp="llm-api", to_comp="agent",
                detail=json.dumps(obj, indent=2, default=str),
            ))
    return events


def parse_cache_trace(path):
    """Parse cache-trace.jsonl."""
    events = []
    if not path.exists():
        return events
    with open(path, "r", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue

            ts = parse_iso(obj.get("ts"))
            if ts is None:
                continue

            stage = obj.get("stage", "?")
            seq = obj.get("seq", 0)
            model = obj.get("modelId", "")
            provider = obj.get("provider", "")
            msg_count = obj.get("messageCount", 0)
            session_id = short_id(obj.get("sessionId", ""))

            summary = f"Cache [{seq}] {stage}"
            if model:
                summary += f" model={provider}/{model}"
            summary += f" msgs={msg_count}"

            # Include prompt preview in detail if present
            detail_parts = [f"stage: {stage}", f"seq: {seq}"]
            prompt = obj.get("prompt", "")
            if prompt:
                detail_parts.append(f"prompt: {prompt[:300]}")
            note = obj.get("note", "")
            if note:
                detail_parts.append(f"note: {note}")

            events.append(Event(
                ts=ts, source="cache-trace", category="cache",
                level="debug",
                summary=summary,
                from_comp="agent", to_comp="llm-api",
                detail="\n".join(detail_parts),
            ))
    return events


# ── Statistics ───────────────────────────────────────────────────

def compute_stats(events):
    """Compute summary statistics from all events."""
    stats = {
        "total_events": len(events),
        "by_source": defaultdict(int),
        "by_category": defaultdict(int),
        "by_level": defaultdict(int),
        "total_cost": 0.0,
        "total_tokens_in": 0,
        "total_tokens_out": 0,
        "llm_calls": 0,
        "tool_calls": [],
        "errors": 0,
        "ws_requests": 0,
        "ws_avg_latency_ms": 0,
        "time_range_start": None,
        "time_range_end": None,
        "user_messages": 0,
        "assistant_messages": 0,
        "cost_per_message": [],
    }

    ws_latencies = []

    for e in events:
        if e.ts and e.ts > 0:
            if stats["time_range_start"] is None or e.ts < stats["time_range_start"]:
                stats["time_range_start"] = e.ts
            if stats["time_range_end"] is None or e.ts > stats["time_range_end"]:
                stats["time_range_end"] = e.ts

        stats["by_source"][e.source] += 1
        stats["by_category"][e.category] += 1
        stats["by_level"][e.level] += 1

        if e.level in ("error", "fatal"):
            stats["errors"] += 1

        if e.cost and e.cost > 0:
            stats["total_cost"] += e.cost
            stats["cost_per_message"].append(e.cost)
            stats["llm_calls"] += 1

        stats["total_tokens_in"] += (e.tokens_in or 0)
        stats["total_tokens_out"] += (e.tokens_out or 0)

        if e.category == "user-message":
            stats["user_messages"] += 1
        elif e.category == "assistant-message":
            stats["assistant_messages"] += 1

        if e.category == "tool-result":
            # Extract tool name from summary
            m = re.search(r'Tool result \((\w+)\)', e.summary)
            if m:
                stats["tool_calls"].append(m.group(1))

        if e.category == "websocket" and e.duration_ms > 0:
            ws_latencies.append(e.duration_ms)
            stats["ws_requests"] += 1

    if ws_latencies:
        stats["ws_avg_latency_ms"] = sum(ws_latencies) / len(ws_latencies)

    # Count tool calls
    tool_counts = defaultdict(int)
    for t in stats["tool_calls"]:
        tool_counts[t] += 1
    stats["tool_call_counts"] = dict(sorted(tool_counts.items(), key=lambda x: -x[1]))

    return stats


# ── HTML Generation ──────────────────────────────────────────────

def generate_html(events, stats, export_dir):
    """Generate self-contained HTML report."""

    # Sort events by timestamp
    events_with_ts = [e for e in events if e.ts and e.ts > 0]
    events_with_ts.sort(key=lambda e: e.ts)

    events_json = json.dumps([e.to_dict() for e in events_with_ts], default=str)

    # Collect unique sources and categories for filters
    sources = sorted(set(e.source for e in events_with_ts))
    categories = sorted(set(e.category for e in events_with_ts))
    levels = sorted(set(e.level for e in events_with_ts))

    # Components for sequence diagram columns
    components = ["client", "gateway", "agent", "llm-api"]

    time_start = stats.get("time_range_start", 0)
    time_end = stats.get("time_range_end", 0)
    duration_s = (time_end - time_start) / 1000 if time_start and time_end else 0

    def fmt_ts(ms):
        if not ms:
            return "N/A"
        return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

    tool_counts_json = json.dumps(stats.get("tool_call_counts", {}))

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>OpenClaw Log Report — {html_mod.escape(str(export_dir))}</title>
<style>
:root {{
  --bg: #0d1117; --bg2: #161b22; --bg3: #21262d;
  --fg: #c9d1d9; --fg2: #8b949e; --fg3: #484f58;
  --blue: #58a6ff; --green: #3fb950; --yellow: #d29922;
  --red: #f85149; --purple: #bc8cff; --orange: #f0883e;
  --cyan: #39d2c0;
}}
* {{ margin: 0; padding: 0; box-sizing: border-box; }}
body {{ background: var(--bg); color: var(--fg); font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace; font-size: 13px; }}
a {{ color: var(--blue); }}

/* ── Header ── */
.header {{ background: var(--bg2); border-bottom: 1px solid var(--bg3); padding: 16px 24px; }}
.header h1 {{ font-size: 18px; font-weight: 600; color: var(--fg); margin-bottom: 4px; }}
.header .meta {{ color: var(--fg2); font-size: 12px; }}

/* ── Stats Dashboard ── */
.stats {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; padding: 16px 24px; }}
.stat-card {{ background: var(--bg2); border: 1px solid var(--bg3); border-radius: 8px; padding: 14px 16px; }}
.stat-card .label {{ color: var(--fg2); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }}
.stat-card .value {{ font-size: 22px; font-weight: 700; }}
.stat-card .sub {{ color: var(--fg2); font-size: 11px; margin-top: 2px; }}
.cost {{ color: var(--green); }}
.tokens {{ color: var(--cyan); }}
.errors {{ color: var(--red); }}
.messages {{ color: var(--blue); }}
.ws {{ color: var(--purple); }}
.duration {{ color: var(--orange); }}

/* ── Charts row ── */
.charts {{ display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding: 0 24px 16px; }}
.chart-card {{ background: var(--bg2); border: 1px solid var(--bg3); border-radius: 8px; padding: 14px 16px; }}
.chart-card h3 {{ font-size: 12px; color: var(--fg2); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 10px; }}
.bar-row {{ display: flex; align-items: center; margin-bottom: 4px; }}
.bar-label {{ width: 120px; font-size: 11px; color: var(--fg2); text-align: right; padding-right: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }}
.bar {{ height: 16px; border-radius: 3px; min-width: 2px; transition: width 0.3s; }}
.bar-value {{ font-size: 11px; color: var(--fg2); padding-left: 6px; }}

/* ── Filters ── */
.filters {{ background: var(--bg2); border-bottom: 1px solid var(--bg3); padding: 12px 24px; display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; position: sticky; top: 0; z-index: 100; }}
.filter-group {{ display: flex; flex-direction: column; gap: 4px; }}
.filter-group .title {{ font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--fg3); }}
.filter-group .options {{ display: flex; flex-wrap: wrap; gap: 4px; }}
.filter-chip {{ display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border-radius: 12px; font-size: 11px; cursor: pointer; border: 1px solid var(--bg3); background: var(--bg); color: var(--fg2); user-select: none; transition: all 0.15s; }}
.filter-chip:hover {{ border-color: var(--fg3); }}
.filter-chip.active {{ background: var(--blue); color: #fff; border-color: var(--blue); }}
.filter-chip .count {{ opacity: 0.6; }}
.filter-actions {{ display: flex; gap: 6px; align-items: flex-end; }}
.filter-actions button {{ padding: 3px 10px; border-radius: 12px; font-size: 11px; cursor: pointer; border: 1px solid var(--bg3); background: var(--bg); color: var(--fg2); font-family: inherit; }}
.filter-actions button:hover {{ border-color: var(--fg3); }}
.search-box {{ padding: 4px 10px; border-radius: 12px; font-size: 12px; border: 1px solid var(--bg3); background: var(--bg); color: var(--fg); font-family: inherit; width: 220px; }}
.search-box:focus {{ outline: none; border-color: var(--blue); }}
.filtered-stats {{ color: var(--fg2); font-size: 11px; padding: 0 24px 8px; }}

/* ── Sequence Diagram ── */
.sequence {{ padding: 0 24px 24px; }}
.seq-header {{ display: grid; grid-template-columns: 100px 1fr; position: sticky; top: 52px; z-index: 99; background: var(--bg); padding: 8px 0; border-bottom: 2px solid var(--bg3); }}
.seq-columns {{ display: grid; grid-template-columns: repeat(4, 1fr); text-align: center; }}
.seq-col-label {{ font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; padding: 6px; color: var(--fg2); }}
.seq-col-label:nth-child(1) {{ color: var(--blue); }}
.seq-col-label:nth-child(2) {{ color: var(--green); }}
.seq-col-label:nth-child(3) {{ color: var(--purple); }}
.seq-col-label:nth-child(4) {{ color: var(--orange); }}

.seq-row {{ display: grid; grid-template-columns: 100px 1fr; min-height: 28px; border-bottom: 1px solid var(--bg2); position: relative; }}
.seq-row:hover {{ background: var(--bg2); }}
.seq-row.level-error {{ background: rgba(248,81,73,0.08); }}
.seq-row.level-warn {{ background: rgba(210,153,34,0.06); }}
.seq-ts {{ font-size: 10px; color: var(--fg3); padding: 5px 8px 5px 0; text-align: right; white-space: nowrap; }}
.seq-diagram {{ display: grid; grid-template-columns: repeat(4, 1fr); position: relative; }}
.seq-lane {{ position: relative; display: flex; justify-content: center; }}
.seq-lane::before {{ content: ''; position: absolute; top: 0; bottom: 0; left: 50%; width: 1px; background: var(--bg3); }}

/* Arrow rendering */
.seq-arrow {{ position: absolute; top: 50%; height: 2px; z-index: 2; }}
.seq-arrow .line {{ height: 2px; width: 100%; }}
.seq-arrow .head {{ position: absolute; top: -4px; width: 0; height: 0; border-top: 5px solid transparent; border-bottom: 5px solid transparent; }}
.seq-arrow.right .head {{ right: -1px; border-left: 8px solid; }}
.seq-arrow.left .head {{ left: -1px; border-right: 8px solid; }}

.seq-dot {{ width: 8px; height: 8px; border-radius: 50%; position: absolute; top: 50%; transform: translateY(-50%); z-index: 3; }}

.seq-label {{ position: absolute; top: 50%; transform: translateY(-50%); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 600px; padding: 2px 6px; border-radius: 3px; z-index: 4; cursor: pointer; }}
.seq-label:hover {{ white-space: normal; max-width: none; background: var(--bg2); box-shadow: 0 2px 8px rgba(0,0,0,0.4); }}

/* Source colors */
.src-docker-stdout {{ --src-color: var(--green); }}
.src-gateway-log {{ --src-color: var(--cyan); }}
.src-session {{ --src-color: var(--blue); }}
.src-raw-stream {{ --src-color: var(--orange); }}
.src-cache-trace {{ --src-color: var(--purple); }}

.seq-arrow .line {{ background: var(--src-color); }}
.seq-arrow .head {{ border-left-color: var(--src-color); border-right-color: var(--src-color); }}
.seq-dot {{ background: var(--src-color); }}
.seq-label {{ color: var(--src-color); }}

/* Detail panel */
.detail-panel {{ display: none; position: fixed; top: 60px; right: 16px; width: 500px; max-height: calc(100vh - 80px); background: var(--bg2); border: 1px solid var(--bg3); border-radius: 8px; overflow: auto; z-index: 200; padding: 16px; box-shadow: 0 4px 24px rgba(0,0,0,0.5); }}
.detail-panel.open {{ display: block; }}
.detail-panel .close {{ position: absolute; top: 8px; right: 12px; cursor: pointer; color: var(--fg2); font-size: 18px; }}
.detail-panel h3 {{ font-size: 13px; color: var(--fg); margin-bottom: 8px; }}
.detail-panel pre {{ font-size: 11px; color: var(--fg2); white-space: pre-wrap; word-break: break-all; }}
.detail-panel .meta-row {{ display: flex; gap: 12px; margin-bottom: 6px; font-size: 11px; }}
.detail-panel .meta-key {{ color: var(--fg3); }}
.detail-panel .meta-val {{ color: var(--fg); }}
</style>
</head>
<body>
<div class="header">
  <h1>OpenClaw Log Report</h1>
  <div class="meta">
    Export: {html_mod.escape(str(export_dir))} |
    Range: {fmt_ts(time_start)} &mdash; {fmt_ts(time_end)} ({duration_s:.1f}s) |
    Total events: {len(events_with_ts):,}
  </div>
</div>

<!-- Stats Dashboard -->
<div class="stats">
  <div class="stat-card">
    <div class="label">Total Cost</div>
    <div class="value cost">${stats['total_cost']:.4f}</div>
    <div class="sub">{stats['llm_calls']} LLM calls</div>
  </div>
  <div class="stat-card">
    <div class="label">Tokens</div>
    <div class="value tokens">{stats['total_tokens_in'] + stats['total_tokens_out']:,}</div>
    <div class="sub">In: {stats['total_tokens_in']:,} | Out: {stats['total_tokens_out']:,}</div>
  </div>
  <div class="stat-card">
    <div class="label">Messages</div>
    <div class="value messages">{stats['user_messages'] + stats['assistant_messages']}</div>
    <div class="sub">User: {stats['user_messages']} | Assistant: {stats['assistant_messages']}</div>
  </div>
  <div class="stat-card">
    <div class="label">Errors</div>
    <div class="value errors">{stats['errors']}</div>
    <div class="sub">Across all log sources</div>
  </div>
  <div class="stat-card">
    <div class="label">WebSocket RPCs</div>
    <div class="value ws">{stats['ws_requests']}</div>
    <div class="sub">Avg latency: {stats['ws_avg_latency_ms']:.0f}ms</div>
  </div>
  <div class="stat-card">
    <div class="label">Duration</div>
    <div class="value duration">{duration_s:.1f}s</div>
    <div class="sub">{fmt_ts(time_start)}</div>
  </div>
</div>

<!-- Charts -->
<div class="charts">
  <div class="chart-card">
    <h3>Events by Source</h3>
    <div id="chart-sources"></div>
  </div>
  <div class="chart-card">
    <h3>Tool Calls</h3>
    <div id="chart-tools"></div>
  </div>
</div>

<!-- Filters -->
<div class="filters" id="filters">
  <div class="filter-group">
    <div class="title">Source</div>
    <div class="options" id="filter-source"></div>
  </div>
  <div class="filter-group">
    <div class="title">Category</div>
    <div class="options" id="filter-category"></div>
  </div>
  <div class="filter-group">
    <div class="title">Level</div>
    <div class="options" id="filter-level"></div>
  </div>
  <div class="filter-group">
    <div class="title">Search</div>
    <div class="options"><input type="text" class="search-box" id="search" placeholder="Filter by text..."></div>
  </div>
  <div class="filter-actions">
    <button onclick="selectAll()">All</button>
    <button onclick="selectNone()">None</button>
  </div>
</div>
<div class="filtered-stats" id="filtered-stats"></div>

<!-- Sequence Diagram -->
<div class="sequence">
  <div class="seq-header">
    <div style="font-size:10px;color:var(--fg3);text-align:right;padding-right:8px;">TIME</div>
    <div class="seq-columns">
      <div class="seq-col-label">Client</div>
      <div class="seq-col-label">Gateway</div>
      <div class="seq-col-label">Agent</div>
      <div class="seq-col-label">LLM API</div>
    </div>
  </div>
  <div id="timeline"></div>
</div>

<!-- Detail Panel -->
<div class="detail-panel" id="detail">
  <span class="close" onclick="closeDetail()">&times;</span>
  <h3 id="detail-title"></h3>
  <div id="detail-meta"></div>
  <pre id="detail-body"></pre>
</div>

<script>
const EVENTS = {events_json};
const COMPONENTS = {json.dumps(components)};
const TOOL_COUNTS = {tool_counts_json};
const SOURCE_COUNTS = {json.dumps(dict(stats['by_source']))};

const compIdx = {{}};
COMPONENTS.forEach((c, i) => compIdx[c] = i);

// ── Build charts ──
function buildBarChart(containerId, data, color) {{
  const el = document.getElementById(containerId);
  const max = Math.max(...Object.values(data), 1);
  let html = '';
  for (const [label, count] of Object.entries(data)) {{
    const pct = (count / max * 100).toFixed(1);
    html += `<div class="bar-row">
      <div class="bar-label">${{label}}</div>
      <div class="bar" style="width:${{pct}}%;background:${{color}}"></div>
      <div class="bar-value">${{count}}</div>
    </div>`;
  }}
  el.innerHTML = html || '<div style="color:var(--fg3)">No data</div>';
}}
buildBarChart('chart-sources', SOURCE_COUNTS, 'var(--green)');
buildBarChart('chart-tools', TOOL_COUNTS, 'var(--purple)');

// ── Filters ──
const activeSources = new Set({json.dumps(sources)});
const activeCategories = new Set({json.dumps(categories)});
const activeLevels = new Set({json.dumps(levels)});

function buildFilterChips(containerId, items, activeSet, countMap) {{
  const el = document.getElementById(containerId);
  el.innerHTML = '';
  for (const item of items) {{
    const chip = document.createElement('span');
    chip.className = 'filter-chip' + (activeSet.has(item) ? ' active' : '');
    const cnt = countMap[item] || 0;
    chip.innerHTML = `${{item}} <span class="count">(${{cnt}})</span>`;
    chip.onclick = () => {{
      if (activeSet.has(item)) activeSet.delete(item); else activeSet.add(item);
      chip.classList.toggle('active');
      renderTimeline();
    }};
    el.appendChild(chip);
  }}
}}

const sourceCounts = {{}};
const categoryCounts = {{}};
const levelCounts = {{}};
EVENTS.forEach(e => {{
  sourceCounts[e.source] = (sourceCounts[e.source] || 0) + 1;
  categoryCounts[e.category] = (categoryCounts[e.category] || 0) + 1;
  levelCounts[e.level] = (levelCounts[e.level] || 0) + 1;
}});

buildFilterChips('filter-source', {json.dumps(sources)}, activeSources, sourceCounts);
buildFilterChips('filter-category', {json.dumps(categories)}, activeCategories, categoryCounts);
buildFilterChips('filter-level', {json.dumps(levels)}, activeLevels, levelCounts);

function selectAll() {{
  {json.dumps(sources)}.forEach(s => activeSources.add(s));
  {json.dumps(categories)}.forEach(c => activeCategories.add(c));
  {json.dumps(levels)}.forEach(l => activeLevels.add(l));
  rebuildChips(); renderTimeline();
}}
function selectNone() {{
  activeSources.clear(); activeCategories.clear(); activeLevels.clear();
  rebuildChips(); renderTimeline();
}}
function rebuildChips() {{
  buildFilterChips('filter-source', {json.dumps(sources)}, activeSources, sourceCounts);
  buildFilterChips('filter-category', {json.dumps(categories)}, activeCategories, categoryCounts);
  buildFilterChips('filter-level', {json.dumps(levels)}, activeLevels, levelCounts);
}}

document.getElementById('search').addEventListener('input', () => renderTimeline());

// ── Render timeline ──
function fmtTime(ms) {{
  const d = new Date(ms);
  return d.toISOString().slice(11, 23);
}}

function escHtml(s) {{
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}}

function renderTimeline() {{
  const search = document.getElementById('search').value.toLowerCase();
  const filtered = EVENTS.filter(e =>
    activeSources.has(e.source) &&
    activeCategories.has(e.category) &&
    activeLevels.has(e.level) &&
    (!search || e.summary.toLowerCase().includes(search) || (e.detail && e.detail.toLowerCase().includes(search)))
  );

  // Update filtered stats
  let fCost = 0, fTokIn = 0, fTokOut = 0, fErr = 0;
  filtered.forEach(e => {{
    fCost += e.cost || 0;
    fTokIn += e.tokensIn || 0;
    fTokOut += e.tokensOut || 0;
    if (e.level === 'error' || e.level === 'fatal') fErr++;
  }});
  document.getElementById('filtered-stats').textContent =
    `Showing ${{filtered.length.toLocaleString()}} of ${{EVENTS.length.toLocaleString()}} events | Cost: $${{fCost.toFixed(4)}} | Tokens: ${{(fTokIn+fTokOut).toLocaleString()}} | Errors: ${{fErr}}`;

  const container = document.getElementById('timeline');

  // Virtual scroll: only render visible rows
  const ROW_H = 28;
  const totalH = filtered.length * ROW_H;

  // Simple approach: render all (works fine up to ~10k events)
  if (filtered.length > 5000) {{
    container.innerHTML = `<div style="padding:20px;color:var(--fg2)">${{filtered.length.toLocaleString()}} events — narrow filters to render timeline</div>`;
    return;
  }}

  let html = '';
  for (let i = 0; i < filtered.length; i++) {{
    const e = filtered[i];
    const srcClass = 'src-' + e.source;
    const fi = compIdx[e.from] ?? -1;
    const ti = compIdx[e.to] ?? -1;

    html += `<div class="seq-row level-${{e.level}} ${{srcClass}}" onclick="showDetail(${{i}})" data-idx="${{i}}">`;
    html += `<div class="seq-ts">${{fmtTime(e.ts)}}</div>`;
    html += `<div class="seq-diagram">`;

    // Draw lanes
    for (let c = 0; c < 4; c++) {{
      html += `<div class="seq-lane">`;
      if (fi >= 0 && ti >= 0 && fi !== ti) {{
        // Arrow between two components
        const left = Math.min(fi, ti);
        const right = Math.max(fi, ti);
        if (c === left) {{
          const span = right - left;
          const dir = fi < ti ? 'right' : 'left';
          html += `<div class="seq-arrow ${{dir}} ${{srcClass}}" style="left:50%;width:calc(${{span * 100}}% - 8px);">`;
          html += `<div class="line"></div><div class="head"></div></div>`;
          // Label centered on arrow
          const labelLeft = `calc(${{span * 50}}% - 150px)`;
          html += `<div class="seq-label ${{srcClass}}" style="left:${{labelLeft}};max-width:300px;" title="${{escHtml(e.summary)}}">${{escHtml(e.summary.substring(0, 100))}}</div>`;
        }}
      }} else if (fi >= 0 && c === fi) {{
        // Dot on single component
        html += `<div class="seq-dot ${{srcClass}}"></div>`;
        html += `<div class="seq-label ${{srcClass}}" style="left:calc(50% + 8px);" title="${{escHtml(e.summary)}}">${{escHtml(e.summary.substring(0, 100))}}</div>`;
      }}
      html += `</div>`;
    }}
    html += `</div></div>`;
  }}
  container.innerHTML = html;

  // Store filtered for detail panel
  window._filtered = filtered;
}}

function showDetail(idx) {{
  const e = window._filtered[idx];
  if (!e) return;
  document.getElementById('detail-title').textContent = e.summary;
  let meta = `<div class="meta-row"><span class="meta-key">Time:</span><span class="meta-val">${{new Date(e.ts).toISOString()}}</span></div>`;
  meta += `<div class="meta-row"><span class="meta-key">Source:</span><span class="meta-val">${{e.source}}</span></div>`;
  meta += `<div class="meta-row"><span class="meta-key">Category:</span><span class="meta-val">${{e.category}}</span></div>`;
  meta += `<div class="meta-row"><span class="meta-key">Level:</span><span class="meta-val">${{e.level}}</span></div>`;
  meta += `<div class="meta-row"><span class="meta-key">Flow:</span><span class="meta-val">${{e.from || '?'}} &rarr; ${{e.to || '?'}}</span></div>`;
  if (e.cost) meta += `<div class="meta-row"><span class="meta-key">Cost:</span><span class="meta-val">$${{e.cost.toFixed(6)}}</span></div>`;
  if (e.tokensIn || e.tokensOut) meta += `<div class="meta-row"><span class="meta-key">Tokens:</span><span class="meta-val">in=${{e.tokensIn}} out=${{e.tokensOut}}</span></div>`;
  if (e.durationMs) meta += `<div class="meta-row"><span class="meta-key">Duration:</span><span class="meta-val">${{e.durationMs}}ms</span></div>`;
  document.getElementById('detail-meta').innerHTML = meta;
  document.getElementById('detail-body').textContent = e.detail || '(no detail)';
  document.getElementById('detail').classList.add('open');
}}
function closeDetail() {{ document.getElementById('detail').classList.remove('open'); }}
document.addEventListener('keydown', e => {{ if (e.key === 'Escape') closeDetail(); }});

// Initial render
renderTimeline();
</script>
</body>
</html>"""


# ── Main ─────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <export-dir> [-o output.html]", file=sys.stderr)
        sys.exit(1)

    export_dir = Path(sys.argv[1])
    if not export_dir.is_dir():
        print(f"Error: {export_dir} is not a directory", file=sys.stderr)
        sys.exit(1)

    output_path = export_dir / "report.html"
    if "-o" in sys.argv:
        idx = sys.argv.index("-o")
        if idx + 1 < len(sys.argv):
            output_path = Path(sys.argv[idx + 1])

    print(f"Parsing logs from {export_dir}...")

    # Parse all log sources
    all_events = []
    all_events.extend(parse_docker_stdout(export_dir / "docker-stdout.log"))
    all_events.extend(parse_gateway_log(export_dir / "gateway.log"))
    all_events.extend(parse_session_transcripts(export_dir / "sessions"))
    all_events.extend(parse_raw_stream(export_dir / "raw-stream.jsonl"))
    all_events.extend(parse_cache_trace(export_dir / "cache-trace.jsonl"))

    print(f"  Parsed {len(all_events):,} total events")

    # Compute stats
    stats = compute_stats(all_events)

    # Generate HTML
    html_content = generate_html(all_events, stats, export_dir)
    with open(output_path, "w") as f:
        f.write(html_content)

    print(f"  Report written to {output_path}")
    print(f"  Cost: ${stats['total_cost']:.4f} | Tokens: {stats['total_tokens_in'] + stats['total_tokens_out']:,} | Events: {len(all_events):,}")


if __name__ == "__main__":
    main()

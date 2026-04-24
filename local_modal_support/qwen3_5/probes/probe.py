#!/usr/bin/env python3
"""
Direct Ollama /api/chat probe for qwen3.5:4b.

Builds a minimal-but-faithful agent system prompt and sends a user message
straight to the Ollama server, bypassing the OpenClaw gateway. Use this to
isolate "is it the model or is it the harness?" without a full rebuild loop.

Usage:
  probe.py <scenario_dir> [--user-msg TEXT] [--ollama URL]
      [--model MODEL] [--output DIR] [--seed INT] [--no-think]

A scenario directory has:
  system.txt          # the whole system prompt (verbatim, UTF-8)
  user.txt            # default user message (can be overridden by --user-msg)
  tools.json          # optional: array of Ollama tool definitions
  seed_messages.json  # optional: array of prior messages to inject AFTER system
                      # (e.g. to force-present a prior toolResult)

Output: prints a concise summary to stdout and writes the full chat request
and response to <output>/run_<timestamp>.json.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys
import time
import urllib.request
import urllib.error


def load_scenario(d: pathlib.Path):
    if not d.is_dir():
        sys.exit(f"scenario dir not found: {d}")
    system = (d / "system.txt").read_text(encoding="utf-8")
    user_default = (d / "user.txt").read_text(encoding="utf-8").strip()
    tools = []
    tools_path = d / "tools.json"
    if tools_path.exists():
        tools = json.loads(tools_path.read_text(encoding="utf-8"))
    seed_messages = []
    seed_path = d / "seed_messages.json"
    if seed_path.exists():
        seed_messages = json.loads(seed_path.read_text(encoding="utf-8"))
    return system, user_default, tools, seed_messages


def post_chat(url: str, payload: dict, timeout: int = 300):
    req = urllib.request.Request(
        url.rstrip("/") + "/api/chat",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def summarize(resp: dict) -> str:
    msg = resp.get("message", {}) or {}
    role = msg.get("role", "?")
    content = (msg.get("content", "") or "").strip()
    thinking = (msg.get("thinking", "") or "").strip()
    tool_calls = msg.get("tool_calls") or []
    lines = []
    lines.append(f"role={role}")
    lines.append(f"done_reason={resp.get('done_reason', '?')}")
    if thinking:
        lines.append(f"thinking ({len(thinking)} chars): {thinking[:400]}")
    if content:
        lines.append(f"content ({len(content)} chars): {content[:400]}")
    if tool_calls:
        for i, tc in enumerate(tool_calls):
            fn = tc.get("function") or {}
            name = fn.get("name", "?")
            args = fn.get("arguments")
            args_str = json.dumps(args) if isinstance(args, (dict, list)) else str(args)
            lines.append(f"tool_call[{i}] name={name} args={args_str[:500]}")
    if not thinking and not content and not tool_calls:
        lines.append("(no content, no thinking, no tool_calls — empty response)")
    return "\n".join(lines)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("scenario", type=pathlib.Path)
    p.add_argument("--user-msg", type=str, default=None, help="override user.txt")
    p.add_argument("--ollama", type=str, default="http://172.23.32.1:11434")
    p.add_argument("--model", type=str, default="qwen3.5:4b")
    p.add_argument("--output", type=pathlib.Path,
                   default=pathlib.Path(__file__).parent / "results")
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--no-think", action="store_true",
                   help="set think=false (default true, matches agent config)")
    p.add_argument("--temperature", type=float, default=0.6)
    p.add_argument("--ctx", type=int, default=32768,
                   help="num_ctx; smaller values load faster on Jetson")
    args = p.parse_args()

    system, user_default, tools, seed_messages = load_scenario(args.scenario)
    user_msg = args.user_msg if args.user_msg is not None else user_default

    messages = [{"role": "system", "content": system}]
    messages.extend(seed_messages)
    messages.append({"role": "user", "content": user_msg})

    payload = {
        "model": args.model,
        "messages": messages,
        "stream": False,
        "think": not args.no_think,
        "keep_alive": "30m",
        "options": {
            "temperature": args.temperature,
            "seed": args.seed,
            "num_ctx": args.ctx,
        },
    }
    if tools:
        payload["tools"] = tools

    args.output.mkdir(parents=True, exist_ok=True)
    ts = int(time.time())
    run_tag = f"{args.scenario.name}_{ts}"
    req_path = args.output / f"{run_tag}.request.json"
    resp_path = args.output / f"{run_tag}.response.json"
    req_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    print(f"→ POST {args.ollama}/api/chat")
    print(f"  scenario: {args.scenario}")
    print(f"  model:    {args.model}")
    print(f"  system:   {len(system)} chars, tools={len(tools)}, "
          f"seed_messages={len(seed_messages)}")
    print(f"  user:     {user_msg[:120]}{'...' if len(user_msg) > 120 else ''}")
    t0 = time.time()
    try:
        resp = post_chat(args.ollama, payload)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        sys.exit(f"HTTP {e.code}: {body[:500]}")
    except Exception as e:
        sys.exit(f"request failed: {e}")
    dt = time.time() - t0
    resp_path.write_text(json.dumps(resp, indent=2), encoding="utf-8")

    print(f"← {dt:.1f}s  saved {resp_path.name}")
    print("---")
    print(summarize(resp))


if __name__ == "__main__":
    main()

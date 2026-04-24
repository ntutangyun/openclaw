# qwen3.5:4b direct-to-Ollama probes

Bypass the OpenClaw gateway and drive qwen3.5:4b with the **exact same system
prompt** it sees in production. Purpose: isolate "is it the model or is it the
harness?" without a docker rebuild loop each time.

## Files

- `probe.py` — sends `/api/chat` to Ollama with a scenario's `system.txt`,
  `user.txt`, `tools.json`, and optional `seed_messages.json`. Writes request +
  response to `results/`.
- `ollama_tap.py` — one-shot reverse proxy that captures the first `/api/chat`
  body the gateway sends, then transparently forwards it. Useful when the
  `cache-trace.jsonl` route below is not available.
- `scenarios/` — one dir per experiment (`system.txt`, `user.txt`, `tools.json`).

## Getting the real system prompt

The simpler route avoids the proxy entirely. The gateway container has
`OPENCLAW_CACHE_TRACE_*` env vars set, which persist every outbound request
to `/home/node/.openclaw/logs/cache-trace.jsonl`. Each `stream:context` record
contains `system`, `messages`, `model`, and `options` — the full payload the
gateway hands to the ollama adapter:

```bash
docker cp openclaw-tangyun-gateway:/home/node/.openclaw/logs/cache-trace.jsonl \
  /tmp/cache-trace.jsonl
python3 -c "
import json
for line in open('/tmp/cache-trace.jsonl'):
    r = json.loads(line)
    if r.get('stage') == 'stream:context' and r.get('runId','').startswith('<runId-prefix>'):
        open('/tmp/real_system.txt','w').write(r['system'])
        json.dump(r['messages'], open('/tmp/real_msgs.json','w'), indent=2)
        break"
```

Find the runId for the turn you care about in the gateway log:

```
docker logs openclaw-tangyun-gateway 2>&1 | grep 'embedded run start'
```

## Usage

```bash
# Default: Ollama at http://172.23.32.1:11434 (WSL), model qwen3.5:4b, seed 42.
python3 probe.py scenarios/A_mixed_paths

# Override user message inline (handy for A/B comparisons).
python3 probe.py scenarios/D_real_prompt --user-msg "what skill applies?"

# Different seed. For stability sweeps, loop in bash:
for s in 42 7 99 1337 2025; do
  python3 probe.py scenarios/D_real_prompt --seed $s 2>&1 | tail -5
done
```

## Scenario results (2026-04-24, qwen3.5:4b, think=true, temp=0.6)

Each scenario asks: _"generate a basic meeting report from the 802.11 AIML SC
docs in C:\Users\capyb\Desktop\openclaw_workspace on CapybaraHome"_ — the same
message that stalled the live session `e8839808-...`.

| Scenario                                                                         | Prompt                             | First tool call: skill path correct?                                                                        |
| -------------------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| A — minimal (4.3k), mixed `~/` + `/app/skills/` paths                            | 7 bundled + 1 workspace            | **5/5 correct** (`~/...workspace/skills/...`)                                                               |
| D — real 32k prompt, mixed paths                                                 | 7 bundled + 1 workspace            | **1/5 correct** — 4/5 substitute `/app/skills/ieee-meeting-report/SKILL.md`                                 |
| B — real 32k prompt, expanded `~/` → `/home/node/`                               | 7 bundled + 1 workspace (absolute) | **1/5 correct** — 4/5 still substitute `/app/skills/...`                                                    |
| E — real 32k prompt, bundled skills stripped                                     | 1 workspace only                   | **2/5 correct** read; 3/5 skip skill read and act on description alone                                      |
| F — real 32k prompt, ALL skills rehosted under `/home/node/...workspace/skills/` | 8 workspace (uniform root)         | **4/5 correct** (`/home/node/...workspace/skills/ieee-meeting-report/SKILL.md`); 1/5 skipped the skill read |

## What this isolates

- Pattern-matching on the **majority template** is the root cause. Evidence:
  - Scenario B (uniform absolute paths, but 7/8 still rooted at `/app/skills/`)
    → 1/5 correct, same as the baseline D. Absoluteness alone does not help.
  - Scenario F (8/8 rooted at `/home/node/...workspace/skills/`) → 4/5
    correct, no wrong-path substitutions. Flipping the majority flips the
    outcome.
    So the model is generalizing the template shape that 6–7 of the 8
    `<location>` tags share and overwriting the outlier's actual value.
    Neither `~/` expansion nor absolute-vs-compact spelling matters independently;
    what matters is whether the outlier shares a root with the majority.
- The `src/agents/system-prompt.ts:165-166` anti-hallucination pin ("Do not
  guess `/app/skills/...`, copy character-for-character", "on ENOENT, re-examine
  the `<location>` string and retry, do NOT abandon the skill") is being
  ignored. 4B params isn't enough instruction-following headroom at this
  prompt size.
- The ~28k of extra prompt content between scenarios A and D pushes the model
  over the edge. Length matters independently of content.
- Removing bundled skills (scenario E) fixes the path error but introduces a
  new failure: 3/5 runs skip reading the SKILL.md entirely and act on the
  description alone. So "just disable bundled skills for local-model users"
  is half a fix.

## Practical implications for qwen3.5:4b

- **Do not** deploy qwen3.5:4b against a prompt that advertises workspace
  skills alongside bundled skills with different path roots. The model reliably
  picks the majority template.
- **Do not** expect `<location>` character-for-character fidelity from this
  model at 32k context. Either shrink the prompt (drop bundled skills from the
  `<available_skills>` block for local-model configs) or canonicalize all
  skill paths to absolute form _and_ re-test.
- Even with path fixes the skill-reading rate is ~40% — qwen3.5:4b will still
  need a nudge path (current no-tool-call nudge) to catch "skipped the skill
  read" stalls. The nudge's `lastToolError` short-circuit is the blocker
  observed in live session `e8839808-...` run `eca32d60-...`.

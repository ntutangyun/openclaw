# Supporting the qwen3.5 family in OpenClaw — field notes

Written **2026-04-24**, picking up from where the gemma4:e4b field notes
(`local_modal_support/gemma4_e4b/README.md`) leave off. The task is the
same — generating an IEEE 802.11 AIML SC "Basic Meeting Participation
Report" on a Jetson Orin 32 GB with a local Ollama model — and many of
the same mechanisms apply. This note only covers what is _new or
different_ about the qwen3.5 path.

---

## TL;DR

1. `qwen3.5:9b` on this Jetson is **not** viable. Native context is
   **256 K**, and OpenClaw's Ollama stream adapter pre-allocates the
   full KV cache at load (`num_ctx = model.contextWindow`). At 256 K
   that allocation alone takes **~160 s** on Orin — past the 120 s LLM
   idle watchdog, so turn 1 never produces a first token.
2. `qwen3.5:4b` (3.2 GB) initially looked workable — turn 1 succeeds,
   ~14 tool calls succeed — but after the meeting template is read the
   prompt crosses ~25 K tokens and the rescue-ladder retries keep
   evicting the model from Ollama's runner. Cold-reload + large-prompt
   eval + system pressure ends up >120 s on retry. Two back-to-back
   idle timeouts → task surface-errors.
3. **Moving to `qwen3.5:0.8b`** (tiny KV cache, ~1–2 GB footprint even
   at 256 K) sidesteps the eviction-and-cold-reload loop. Anything
   under ~1 GB stays resident across the whole session.
4. Two knobs moved in the harness to make this safe by default:
   - **`agents.defaults.llm.idleTimeoutSeconds = 300`** (was 120).
     `ensure_llm_idle_timeout` in `manage.sh` backfills this into every
     existing user's `openclaw.json` on start/restart, matching the
     `ensure_tools_deny` pattern.
   - **`OPENCLAW_OLLAMA_CTX_CAP` default changed to 0** (no clamp).
     With the idle watchdog raised to 300 s, the native context window
     is usable again for models whose KV cache actually fits. The env
     var is still available to opt into a clamp on tighter hosts.

---

## Timeline

### Run A — qwen3.5:9b, cannot generate a first response

Config written by `sync-ollama`: `contextWindow = 262144`, as returned
by `/api/show`.

Gateway log:

```
03:53:28 embedded run start   provider=ollama model=qwen3.5:9b
03:53:52 prompt start         systemPromptChars=32051 requestSize=57538
03:55:52 [llm-idle-timeout]   produced no reply; retrying same model
03:55:54 prompt start         (retry)
03:57:54 failover decision    surface_error reason=timeout
```

Both attempts hit the watchdog at exactly 120 s with zero tokens
produced. Direct probe confirmed the cause:

| `num_ctx`          | Cold-load time               | Outcome        |
| ------------------ | ---------------------------- | -------------- |
| default (4 K)      | 44 s                         | ok             |
| 16384              | 21 s (first chunk)           | ok             |
| 131072 (128 K)     | ~18 s                        | ok             |
| **262144 (256 K)** | **159 s of `load_duration`** | watchdog fires |

Ollama allocates the full KV buffer up-front, and 256 K × the qwen3.5
architecture just doesn't happen in 120 s on this Orin.

### Run B — qwen3.5:4b, stalls after template read

With `contextWindow` clamped to 131072, qwen3.5:4b got much further:

- Turn 1 completed in 59 s (cold load + small reply).
- 14 tool calls over ~4 minutes: skill SKILL.md read, `fetch_workspace`
  pull, `extract_all`, `ls`, reads of 5 extracted source documents,
  template read, chart generation, polling, template re-read.
- After the second template read (07:23:26), the next inference was a
  104 KB prompt (`requestSize=104546, messageCount=34, toolCount=12`).
- At 07:25:26 the 120 s watchdog fired with **zero** output tokens.
- Rescue-ladder retry at 07:25:29; one more tool call succeeded at
  07:26:37; then the 104 KB prompt timed out again at 07:29:18.

The warm-model probe is the decisive one. Right after the run:

```
WARM qwen3.5:4b @ num_ctx=131072 @ 100 KB / ~13 K tokens:
  load:       270 ms
  prompt_eval: 678 ms  (12,980 tokens)
  eval:        330 ms  (5 tokens)
  TOTAL:       1.4 s
```

When the model is resident in VRAM, it has no trouble with this prompt.
The timeouts happened because Ollama had **evicted the model** between
requests (`/api/ps` was empty immediately after each timeout) and
cold-reload + 26 K-token prompt eval + memory pressure from the
half-freed prior allocation pushed past 120 s.

Why did the model evict? Two plausible factors stacked:

- The first 120 s abort left Ollama's runner in a half-torn-down state;
  the retry arriving immediately forced a reload.
- The 4B model plus full KV cache at 128 K is ~11 GB resident. Under
  any extra pressure (gateway memory, another process, swap churn) the
  runner can fall out of steady state between turns.

### Run C — qwen3.5:0.8b, intended path

Footprint is small enough (estimated ~1.5 GB including KV cache at
256 K) that eviction should never happen during a session, and the
raised 300 s idle watchdog absorbs any cold-reload that does.

This section is a placeholder for measurements from the first clean run
on 0.8b. Fill in when available.

---

## What changed in the harness

Two commits land with this note:

- `local_modal_support`: this README.
- `multi-user-support`: `manage.sh`
  - `ensure_llm_idle_timeout` helper (idempotent, mirrors
    `ensure_tools_deny`). Writes
    `agents.defaults.llm.idleTimeoutSeconds = 300` into each user's
    `openclaw.json` on `start` / `restart` / `start-all` / `node-ask-off`
    if the key isn't already set. Honors
    `OPENCLAW_LLM_IDLE_TIMEOUT_SECONDS` for an override.
  - `OPENCLAW_OLLAMA_CTX_CAP` default flipped from `131072` to `0`
    (no cap). The clamp remains available for opt-in on constrained
    hosts, but the primary line of defense is now the 300 s watchdog.

### Why the idle watchdog, not the clamp

The upstream `DEFAULT_LLM_IDLE_TIMEOUT_SECONDS = 120` lives in
`src/config/agent-timeout-defaults.ts`. It was calibrated for cloud
providers where "no token in 120 s" means something has gone wrong.
Self-hosted Ollama on a memory-constrained host regularly needs that
long just to cold-reload a multi-GB model after a prior abort, before
even starting prompt eval on a history-rich turn. The right fix is to
raise the watchdog for self-hosted, not to shrink every model's
context window.

300 s is a round number that covers:

- 4B/9B cold load under memory pressure (~40–90 s observed)
- Prompt eval on 20–30 K tokens (~30–60 s)
- Headroom for one thinking-stream stall before the first `content`
  token

Beyond 300 s and we're masking a real problem, so this is not meant to
be a dial to keep turning.

### Why we kept `OPENCLAW_OLLAMA_CTX_CAP`

Some hosts genuinely cannot fit the native KV cache — Jetson Nano, 8 GB
desktops, etc. The env var lets those hosts opt into a clamp without
reverting the mechanism. Default-off avoids penalizing users whose
hosts are perfectly capable of the larger cache.

---

## Operational checklist for a fresh qwen3.5 model

1. `ollama pull qwen3.5:<variant>` on the host.
2. `./manage.sh sync-ollama <user>` — writes the provider config,
   auto-detects native `context_length`, no clamp by default.
3. `./manage.sh restart <user>` — this fires both
   `ensure_tools_deny` and `ensure_llm_idle_timeout`.
4. Verify inside the container:
   ```
   docker exec openclaw-<user>-gateway \
     cat /home/node/.openclaw/openclaw.json \
     | jq '.agents.defaults.llm.idleTimeoutSeconds,
           .models.providers.ollama.models[]
             | {id, contextWindow, maxTokens}'
   ```
5. First turn will be slow (cold load). Subsequent turns should be
   sub-second to first token if the model stays resident. If a turn
   suddenly spikes back to a multi-second wait, check
   `curl -s localhost:11434/api/ps` — if empty, Ollama evicted.

---

## Open items

- Measure a full clean run on qwen3.5:0.8b end-to-end (turn count,
  prompt size trajectory, whether the meeting report actually fills).
  Fill in the **Run C** section above.
- Consider passing `keep_alive: "30m"` from the Ollama stream adapter
  (`dist/stream-C0ViseAA.js:425` at time of writing) so Ollama doesn't
  evict between turns on smaller hosts. Currently OpenClaw relies on
  Ollama's default (5 min).
- If a turn's prompt genuinely exceeds the model's ability, the fix is
  still skill-side (tighter SKILL.md, fewer redundant reads) rather
  than further harness tuning.

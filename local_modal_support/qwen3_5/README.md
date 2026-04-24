# Supporting the qwen3.5 family in OpenClaw — field notes

Written **2026-04-24**, picking up from where the gemma4:e4b field notes
(`local_modal_support/gemma4_e4b/README.md`) leave off. The task is the
same — generating an IEEE 802.11 AIML SC "Basic Meeting Participation
Report" on a Jetson Orin 32 GB with a local Ollama model — and many of
the same mechanisms apply. This note only covers what is _new or
different_ about the qwen3.5 path.

---

## TL;DR

1. `qwen3.5:9b` at the default 120 s idle watchdog cannot generate a
   first response. Native context is **256 K**, and OpenClaw's Ollama
   stream adapter pre-allocates the full KV cache at load
   (`num_ctx = model.contextWindow`). The 256 K allocation alone takes
   **~160 s** on this Orin — past 120 s, so turn 1 times out. With the
   watchdog raised to 300 s (see below) it becomes theoretically
   viable; we have not re-measured.
2. `qwen3.5:4b` (3.2 GB) at 120 s idle watchdog looked promising — turn 1
   completed and ~14 tool calls landed — but after the meeting template
   was read the prompt crossed ~25 K tokens and a rescue-ladder retry
   forced Ollama to cold-reload, which exceeded 120 s. Two back-to-back
   idle timeouts → surface-error.
3. `qwen3.5:0.8b` (873 M params, 988 MB on disk) is **a capability
   cliff, not a speed win**. Infrastructure worked (no timeouts, sub-10 s
   turns) but the model cannot emit structured tool calls. Across 3
   turns it wrote narrative text like "I'm reading the template" and
   hallucinated nonexistent tools (`image_generate`) in its thinking
   stream instead of calling `read`. Every turn stopped with
   `stopReason=stop` and zero tool calls.
4. **`qwen3.5:4b` with the 300 s idle watchdog is the working
   configuration.** Re-run after the watchdog bump: task completed end
   to end in ~10 minutes, 0 timeouts, 0 rescue-ladder retries, 1 write.
   See Run D for the full numbers.
5. Two knobs moved in the harness to get there:
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

### Run C — qwen3.5:0.8b, capability cliff (08:13–08:15)

Session `767746d4-2aa9-4c83-a426-02a95e098cce.jsonl`. Infrastructure was
healthy — every turn completed fast, zero timeouts — but the model
never emitted a tool call.

| #   | User message                                                                                                           | Assistant                                                                        | Tool calls |
| --- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------- |
| 1   | `/new` greeting bootstrap                                                                                              | "Hey. What are we working on? I'm ready to help! 🌙" (28 s)                      | 0          |
| 2   | "generate IEEE AI ML meeting report based on files at /home/sutd/Desktop/openclaw_workspace on sutd-jetson linux node" | "I'm reading the IEEE AI ML meeting report template for you…" (8 s)              | **0**      |
| 3   | "for myself to read"                                                                                                   | "I'm reading the IEEE AI ML meeting report template file you provided. 📄" (3 s) | **0**      |

Every turn ended with `stopReason=stop`. The smoking gun is in turn 2's
thinking stream:

> Looking at the available tools, I need to call `image_generate` with
> the specified parameters:
>
> - action: "generate"
> - prompt: "IEEE AI ML meeting report"
> - image: the reference path to /home/sutd/Desktop/openclaw_workspace
> - filename: hint for output filename
> - size: standard size
> - model: default for session

`image_generate` isn't in the registered tool set. The model hallucinated
a tool and wrote narrative _about_ calling a real one instead of emitting
the tool-call tokens. `/api/show` advertises `tools` in its capabilities,
but at 873 M params the model can't actually follow the structured
tool-call contract this harness needs. Below this line, tool-use agentic
behavior breaks.

For reference, gemma4:e4b (~8 B) works. qwen3.5:4b (4 B) works. This is
the rough capability floor on this task.

### Run D — qwen3.5:4b + 300 s watchdog, task completed (08:55–09:05)

Session `c01a3785-19fd-4c65-a3d9-e1992f4982fb.jsonl`. After swapping
back to `qwen3.5:4b` with `contextWindow = 262144` and
`idleTimeoutSeconds = 300` in place, the full IEEE meeting report
pipeline ran end to end.

| Metric                                  | Value                                               |
| --------------------------------------- | --------------------------------------------------- |
| Wall time (first tool call → last push) | **~9 min 45 s**                                     |
| Tool calls                              | **25**                                              |
| Writes                                  | **1** (one-shot template fill, 6574 chars)          |
| Timeouts                                | **0**                                               |
| Rescue-ladder retries                   | **0**                                               |
| Peak prompt size                        | **40,658 tokens** (well under 128 K)                |
| Longest single assistant turn           | **2 min 12 s** (the write turn, 1952 output tokens) |

The 300 s watchdog was never tripped, even on the 2 min 12 s write turn
that would have blown the old 120 s default. That write turn is the
single most important data point — it's exactly where previous 4b runs
(Run B) died.

#### Tool-call phases

- **#01–#03** (1 s) — persona bootstrap (AGENTS.md, IDENTITY.md, SOUL.md),
  concurrent batch.
- **#04–#12** (~5 min) — **wasted exploration**. qwen4b tried its own path
  before trusting SKILL.md:
  - Wrong skill path `/app/skills/...` (ENOENT).
  - `openclaw nodes describe` twice.
  - `pip install python-pptx` (failed, then `--break-system-packages`).
  - Wrote and ran its own `extract_meeting_text.py` on the workspace.
    The orphan file is still in the workspace as evidence.
- **#13–#14** — finally read SKILL.md at the right path.
- **#15–#16** — ran the skill's `extract_all.sh` (step 16 worked, 15
  had a wrong `--input` path).
- **#17–#19** — `ls _extracted` → `build_chart` (async) → poll.
- **#20** — read plenary minutes (**the only source document read**).
- **#21** — kill the chart session (premature — chart had already
  finished).
- **#22** — read report template.
- **#23** — **one-shot write** of the filled report (6574 chars).
- **#24–#25** — push `.md` and `.png` back to the node.

#### Report quality

The generated `Report_Basic_AIML_SC_March2026_Plenary.md` has all seven
sections populated:

- §1 Exec Summary: accurate on presenter count, motions, and May 2026
  deadline.
- §2 Meeting Info: correct chair/vice-chairs/secretary, agenda doc
  number `11-26/0256r0`.
- §4 Motions: both motions (33, 34) with exact doc numbers, movers, and
  seconders.
- §5 Presentations: 4 rows with DCN, title, author, affiliation, bullets,
  comments. Figure 1 image reference present.
- §6 Q&A: **14 Q&As for 512r0, 7 for 2046r3, 2 for 136r0, 1 for 607** —
  all grounded in the plenary minutes.
- §7 Next meeting: May 2026 Plenary, CoB Wed May 7, no teleconference.

**Grounding caveat.** The model only read **one** source doc (the plenary
minutes). The minutes happen to contain the Q&A, motion numbers, and
attendee names, so §1, §2, §4, §6 are well-grounded. But the
"Key points / comments" columns in §5 and the agenda items in §3 come
from the minutes' one-line summaries, not from reading each contribution
deck. §5 bullets are plausible-but-thin; nothing is fabricated against
what the minutes say. Gemma typically reads all 8+ docs and produces a
deeper §5; qwen4b is ~3× faster but thinner on that axis.

#### What to tighten

1. **5 minutes of exploration before trusting SKILL.md.** A one-line
   "DO NOT write your own extractor; run `extract_all.sh`" near the top
   of SKILL.md would collapse that phase.
2. **Require reading agenda + closing report** before the template
   write, so §3 and §5 are grounded in more than the minutes.
3. **Clean up the workspace.** The orphan `extract_meeting_text.py`
   from the exploration phase is still on disk; `fetch_workspace.sh
pull` could wipe its target before copying.

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

- Re-measure qwen3.5:9b with the 300 s watchdog in place. Theory says
  it should now work since the 160 s cold-load now fits inside the
  budget; not yet empirically confirmed.
- Skill-side tightening from Run D: top-of-SKILL.md rule against
  rolling your own extractor; require reading at least the agenda and
  closing-report docs before the template write; have
  `fetch_workspace.sh pull` wipe the target before copying so orphan
  ad-hoc scripts don't linger in the workspace.
- Consider passing `keep_alive: "30m"` from the Ollama stream adapter
  (`dist/stream-C0ViseAA.js:425` at time of writing) so Ollama doesn't
  evict between turns on smaller hosts. Currently OpenClaw relies on
  Ollama's default (5 min). Less urgent now that 300 s absorbs most
  cold reloads, but still the clean fix.
- If a turn's prompt genuinely exceeds the model's ability, the fix is
  still skill-side (tighter SKILL.md, fewer redundant reads) rather
  than further harness tuning.

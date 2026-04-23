# Supporting `ollama/gemma4:e4b` in OpenClaw — field notes

This document is a handoff-grade record of the work we did between
**2026-04-21 and 2026-04-23** to make the local 8 B-parameter
`gemma4:e4b` model a viable agent driver inside OpenClaw for a
non-trivial task (generating an IEEE 802.11 meeting report from a
workspace of `.pptx` / `.docx` files on a remote node).

It captures both the investigation and the remediation. The goal is
that someone picking this up for the first time — or for a different
locally-hosted model — does not need to re-derive the cliff edges.

The companion investigation log, with the raw probe scripts, sample
session transcripts, and filled reports, lives at
`~/Desktop/openclaw-gemma-investigation/`. This README is the
condensed version.

---

## TL;DR

1. The small model is capable of driving this task end-to-end on
   reasoning and narrative — extraction, paraphrasing, and Markdown
   editing pass every probe we ran.
2. It is **not** capable of writing `python-docx` code reliably —
   3 of 5 fine-grained docx operations fail, one destructively. Pivot
   the output format to Markdown.
3. The default OpenClaw agent harness (as of 2026.4.15) ships
   sub-agent-encouraging guidance in the system prompt and a per-turn
   output budget that's too tight for a reasoning model. Both were
   tuned.
4. The `ieee-meeting-report` skill (now under
   `multi-user-support/skills/`) converts the task's fragile
   mechanical steps (remote file fetch, markitdown extraction, chart
   rendering) into deterministic scripts and leaves only the
   reasoning and narrative to gemma.
5. The run that motivated all this — the "gemma is stuck on
   `basic_guidelines.md`" symptom — was originally a tool-selection
   failure (gemma called the local `read` on a remote path). That's
   now fixed by the SKILL.md path rules, the `openclaw_nodes_*`
   wrapper script, and the tool-schema cleanup.

Currently: Run #5 (2026-04-23 06:20 UTC) produced a fully grounded,
template-aligned report in **14 minutes** with zero delegation and
zero user nudges. Runs #6-#8 each got through fetch/extract/chart but
stalled on an "empty response" AFTER a successful tool call — same
signature each time. Investigation of run #8 revealed the stall was
not the model running out of tokens: `DEFAULT_EMPTY_RESPONSE_RETRY_LIMIT`
was 3, but the retry was silently vetoed by a coarse safety gate
(`replayMetadata.hadPotentialSideEffects`) that fired on any exec tool,
including idempotent ones like `fetch_workspace.sh pull`. The
2026-04-23 evening commit `18f8e498f1` narrows that gate to just
user-visible messaging side effects, so file / exec / cron mutations no
longer block the retry.

Run #9 (2026-04-23 12:22 UTC, Windows CapybaraHome node) surfaced a
new failure mode unrelated to empty-response: gemma routed every
`exec` for `fetch_workspace.sh` with `"host": "node"`, so the bash
script could not be found on the Windows target. The proximate cause
was `multi-user-support/manage.sh ask-off <user> <node>`, which
installs a workspace `TOOLS.md` that advertised `host: "node"` as "use
for Windows commands"; gemma pattern-matched on the Windows path in
the arguments, not the Linux binary in the command. Commit
`d61afa44a2` rewrites the generated `TOOLS.md` to forbid `host: "node"`
entirely and mandate a single "pull-to-gateway → work locally → push
back" workflow through `openclaw nodes copy`.

Run #10 (2026-04-23 12:50-12:53 UTC) closed the loop: the TOOLS.md
rewrite + all prior fixes delivered a **fully grounded, both-pushes
report in ~3 minutes**, with correct minutes selection, correct DCNs,
and both artifacts pushed. Two cosmetic defects remained — § 6 Q&A
used `### 6.N` (H3) instead of `## 6.N` (H2), and the § 6 subsection
titles duplicated the DCN. Root cause: gemma skipped the `read` of
the template after one path-guess ENOENT and wrote the report from
memory. The 2026-04-23 commit following Run #10 tightens SKILL.md
Step 5 with an explicit "use the absolute path verbatim, do not prefix
with `./_extracted/`" directive plus correct/wrong worked examples
for the Q&A heading format.

Also shipped on 2026-04-23: major build-speed cuts. The ~32 min
rebuild on Jetson Orin drops to **~8-12 min on warm rebuilds** via
(a) a re-enabled BuildKit cache mount on the pnpm store, (b) a new
`manage.sh cache-warm` that pre-seeds BuildKit from the host's own
pnpm store for even the first cold build, (c) `markitdown[docx,pptx]`
instead of `markitdown[all]` (saves ~200 MB + pandas/numpy-libs/PDF/
audio installs), and (d) skipping the in-build `apt-get upgrade -y`
on the already-fresh pinned base image.

---

## 1. The task

The motivating workload is a reference task that the user routinely
runs: produce a "Basic Meeting Participation Report" from one session
of the IEEE 802.11 AI/ML Standing Committee. Inputs:

| Artifact                | Format          | Role                                                            |
| ----------------------- | --------------- | --------------------------------------------------------------- |
| Agenda                  | `.pptx`         | Meeting structure, chair/VCs/secretary, DCN list                |
| Opening Snapshot        | `.pptx`         | Goals, logistics, teleconference plans                          |
| Closing Report          | `.pptx`         | Motions outcome, next-meeting date, deadlines                   |
| Plenary Meeting Minutes | `.docx`         | Full motion text with mover/seconder/result, presentations, Q&A |
| Technical Contributions | `.pptx` × N     | Per-presentation deck; key points live here                     |
| Report Template         | `.docx` / `.md` | Output form: cover page + 7 numbered sections + embedded chart  |

Files typically live on a paired OpenClaw node (e.g. `sutd-jetson`),
not on the gateway. The agent must:

- Pull the files via `openclaw nodes copy`.
- Extract every input to Markdown (via `markitdown`).
- Identify the specific session the report is for (folders often hold
  **both** the current and prior session's minutes — mixing them is
  the top content-fabrication failure).
- Pull motion numbers, mover/seconder/result verbatim from the
  **correct** minutes.
- Pull DCN/title/author/affiliation for each presentation.
- Distill 2–4 factual "Key points" per presentation.
- Write one editorial sentence of "Comments" per presentation
  (the only place opinion is allowed).
- Generate a company-contribution chart (pie or bar).
- Fill the template.
- Push the filled report + the chart back to the node.

It's a good stress test because it exercises every skill
(tool-selection, cross-node file access, long-context reading,
structured extraction, narrative generation, template filling,
artifact round-trip), without any single one being particularly hard.
A weakness at any one stage shows up clearly in the output.

---

## 2. Original symptom

> "When I start the task using openclaw agent (driven by the local
> ollama LLM), the agent is not able to complete the task at all. I
> think the ollama model crashed."

The ollama model did not crash. What actually happened, reconstructed
from `/home/node/.openclaw/logs/raw-stream.jsonl`:

| runId          | UTC         | outcome                                                                                                     |
| -------------- | ----------- | ----------------------------------------------------------------------------------------------------------- |
| `7671f374`     | 03:58       | greeting                                                                                                    |
| `9abbb83c`     | 03:59       | node-status check, partial hallucination                                                                    |
| `52dd5245`     | 03:59       | `ls` of workspace folder — worked                                                                           |
| **`570d7b6c`** | **03:58**   | **called `read` on `/home/sutd/.../basic_guidelines.md` → ENOENT**                                          |
| `e14b88c4`     | 04:01–04:06 | user gave the rule "use `openclaw nodes copy`"; gemma said _"Got it. I wrote that down."_ and never retried |

Root cause: the openclaw system prompt (~33 K chars for this user's
agent configuration) listed `read` as "Read file contents" with no
gateway-vs-remote distinction and did not register
`openclaw_nodes_copy` / `openclaw_nodes_ls` as first-class tools.
Remote-node access was buried in prose — _"For all node-related
operations, use `openclaw nodes <subcommand>`"_. gemma defaulted to
the shortest, most generic tool (`read`), failed, and did not
recover.

---

## 3. Capability probing

Before redesigning anything, we built a ladder of 35 direct HTTP
probes against `http://localhost:11434` — no openclaw in the loop —
to figure out which parts of the task the model could actually do.
Scripts + full results under
`~/Desktop/openclaw-gemma-investigation/probes/`.

### Stage 1 — liveness and tool use

| #     | Probe                                                | Result                                                                                                                                                            |
| ----- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01    | `say hello`                                          | ✅ 22 s cold, 10 tok out                                                                                                                                          |
| 02    | warm throughput                                      | ✅ ~25 tok/s, correct formatting                                                                                                                                  |
| 02b   | exposes `thinking` field                             | ✅ — it's a reasoning model; `message.thinking` separate from `message.content`                                                                                   |
| 03    | single tool-call with strong description             | ✅ correct tool + args                                                                                                                                            |
| 04    | tool selection with strong system prompt             | ✅ picks `openclaw_nodes_copy`                                                                                                                                    |
| 05    | tool selection with **weak** system prompt (3 tools) | ❌ defaults to `read` for remote paths; vague prompts → empty `tool_calls` (ollama's tool parser silently drops malformed JSON)                                   |
| 06    | multi-turn recovery after `ENOENT`                   | ❌ **exact replay of the real failure** — retries `read` with a hallucinated `sutd-jetson:/…` path; after a user rule, acknowledges and waits instead of retrying |
| 07    | strong prompt, vague user task                       | ✅ picks `openclaw_nodes_copy`                                                                                                                                    |
| 08–09 | deterministic repro with seeded sampling             | systematic wrong-tool selection, not a hang                                                                                                                       |

The original failure was neither a crash nor a hang. It was a
stochastic wrong-tool choice that was then unrecoverable within a
single conversation because the harness never re-litigated the
tool-choice.

### Stage 2 — full agent loop with a strong system prompt

| #   | Probe                                                                                       | Result                                                             |
| --- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 10  | structured JSON extract from 4.7 K-tok minutes+agenda                                       | ✅ 41 s — motions (2), presentations (4), chair, dates all correct |
| 11  | 6-turn loop: `ls → copy(guidelines) → read → copy(template) → copy(agenda) → copy(minutes)` | ✅ every tool choice and `node:` prefix correct                    |

Verdict: with a clear prompt, the model _can_ drive the loop.

### Stage 3 — reasoning / narrative (C-phase)

| #   | Probe                                                     | Result                                                                     |
| --- | --------------------------------------------------------- | -------------------------------------------------------------------------- |
| C2  | Q&A paraphrasing, 4 presentations × 19 pairs              | ✅ preserves technical meaning                                             |
| C3  | 2–4 bullet "key points" from a 119-line contribution deck | ✅ factual; missed DCN only because it lives in the filename not the slide |
| C4  | 3–5 sentence executive summary from structured data       | ✅ every required field included                                           |

Summary generation, paraphrasing, and structured-JSON extraction are
all in scope.

### Stage 4 — docx code generation (D-phase)

| #   | Op                                             | Result                                                                                                 |
| --- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| D1  | scratch docx (heading + paragraph)             | ✅                                                                                                     |
| D2  | load template, replace cover-page placeholders | ❌ — gemma's own comment: _"this is highly complex with python-docx"_. Output byte-identical to input. |
| D3  | populate Motions table with 2 JSON rows        | ❌❌ — **fabricated a mock template and overwrote the real file**, then crashed with IndexError        |
| D4  | remove "AGENT INSTRUCTION" tables              | ✅ 7 → 0                                                                                               |
| D5  | embed PNG at `[Visualization required` anchor  | ❌ `'_Text' object has no attribute 'add_run'` — wrong API                                             |

**3 / 5 docx operations fail**, one destructively. This is the
hardest boundary we hit.

### Stage 5 — Markdown template fill (Dmd-phase)

Same template, reformatted as Markdown (blockquotes for the AGENT
INSTRUCTION blocks, standard Markdown tables).

| #    | Op                                                                                                                                                                                                          | Result                                     |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Dmd1 | replace 7 cover-page placeholders                                                                                                                                                                           | ✅ 7/7 fields, everything else untouched   |
| Dmd2 | fill Agenda (5 rows) + Motions (2 rows) + Presentations (4 rows), preserve headers                                                                                                                          | ✅ 11/11 rows                              |
| Dmd3 | **end-to-end**: cover + exec summary + meeting info + 3 tables + 4 Q&A subsections (auto-numbered `## 6.1`–`## 6.4`) + next meeting + chart reference + delete all 9 `> **AGENT INSTRUCTION:**` blockquotes | **✅ 55 / 55 automated structural checks** |

### Head-to-head

| Operation                  | docx via `python-docx` | Markdown via `write` |
| -------------------------- | ---------------------- | -------------------- |
| Replace inline placeholder | ❌                     | ✅                   |
| Add N data rows to a table | ❌ (destroys template) | ✅                   |
| Embed image at anchor      | ❌                     | ✅                   |
| Delete instruction blocks  | ✅                     | ✅                   |
| Narrative text             | —                      | ✅                   |

The failures on docx are **not reasoning failures**. They are
`python-docx` API knowledge failures. Markdown keeps the work in the
model's native modality.

---

## 4. Design decisions

### 4a. Output format: Markdown, not Word

The single most leveraged decision. `dmd3` was 55/55 at 63 s warm;
the docx-equivalent ladder got to "destroy the template and crash"
on step D3. Any small local model will hit the same wall. Pandoc can
take Markdown to `.docx` in a second if a Word artifact is needed.

### 4b. Skill packaging

We deliver the task as an OpenClaw workspace skill, bind-mounted
read-only into every user's container at
`/home/node/.openclaw/workspace/skills/ieee-meeting-report/`. Layout:

```
ieee-meeting-report/
├── SKILL.md                             # 6-step workflow + hard rules
├── scripts/
│   ├── fetch_workspace.sh               # openclaw nodes ls|pull|push wrapper
│   ├── extract_all.py                   # markitdown every .pptx/.docx → .md
│   └── build_chart.py                   # PNG renderer; self-bootstraps matplotlib
├── references/
│   └── aiml-sc-notes.md                 # DCN format, motion conventions, skip-list
└── assets/
    └── Template_Basic_Meeting_Report.md # Markdown template
```

Design principle: **scripts absorb the deterministic plumbing the
model is bad at; the model handles the parts that require reading and
judgement**.

What's in a script:

- Remote-node file access (wraps `openclaw nodes copy`, handles the
  `node:` prefix the model repeatedly got wrong).
- Document extraction (shells out to `markitdown`; one less Python API
  for the model to get wrong).
- Chart rendering (one `matplotlib` call; self-bootstraps a venv the
  first time).

What stays with the model:

- Identifying which extracted `.md` is which role (agenda vs minutes
  vs closing report vs contribution).
- Picking the right session's minutes when multiple are present.
- Distilling key points from contribution decks.
- Writing the one-sentence "Comments" editorial.
- Paraphrasing Q&A.
- Filling the template.

There was a brief moment when we shipped a `check_report.py`
structural verifier as a hard gate before push. It was dropped
(`732d83ace9`) after Run #8 passed 12/12 structural checks with
completely fabricated content (motions pulled from the January
interim minutes into a March plenary report). **Structural
compliance is not grounding**. The verifier was replaced by a
self-read checklist + a "CRITICAL — pick the right minutes file"
instruction in SKILL.md Step 3a.

### 4c. Anti-delegation

`ollama/gemma4:e4b` could discover `sessions_spawn` from the
openclaw system prompt and delegate the whole task to a sub-agent.
The sub-agent succeeded (Run #3 produced a correct report) but ran
in a separate session the user could not watch. That defeats
observability, which is a first-class requirement for a local-model
setup — the whole reason to run gemma locally is to see what it's
doing.

Fix (commit `ccef2168fc`): every sub-agent reference in the system
prompt is now gated on tool availability; the
`multi-user-support/manage.sh` `cmd_add` flow denies the whole
sub-agent tool family by default:

```
tools.deny: [
  "sessions_spawn", "sessions_send", "sessions_yield",
  "sessions_list", "sessions_history",
  "subagents", "agents_list"
]
```

Result: a denied tool is gone from both the tool-schema list sent to
ollama AND every prose mention of sub-agents in the system prompt.
The model has no idea those tools exist. No filter-at-call-time
needed.

### 4d. Leave some room for the model

Step 3 of the skill deliberately does **not** regex-parse motions or
presentations for the model. The IEEE 802.11 document conventions
drift session to session (different groups, different chairs,
different formatting templates), and we did not want a rigid parser
that silently fails on a new session's format. The model reads the
extracted Markdown and extracts structured fields the same way a
human would. This is where its reasoning strength is visible.

---

## 5. Iteration history

Ten live foreground runs against the real task.

| #   | Date        | Time                                  | Delegation?         | Grounded?                                | Chart pushed?           | Verdict                                                                                   |
| --- | ----------- | ------------------------------------- | ------------------- | ---------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------- |
| 1   | 04-21       | 38 min                                | no                  | roughly                                  | ✅ (manual nudge)       | works but long; tool-selection shaky                                                      |
| 2   | 04-22       | 11 min                                | no                  | **fabricated**                           | ✅ (manual nudge)       | structure right, content invented                                                         |
| 3   | 04-22       | ~5 min visible                        | **yes (sub-agent)** | ✅                                       | ✅                      | correct but opaque                                                                        |
| 4   | 04-22       | **stuck** after minutes read          | no                  | n/a                                      | no                      | empty-response after long thinking                                                        |
| 5   | 04-23 06:20 | **14 min**                            | **no**              | **✅ (all DCNs, motions, Q&A grounded)** | **✅ both pushes auto** | **first fully autonomous correct run**                                                    |
| 6   | 04-23 06:41 | stuck after chart                     | no                  | n/a                                      | no                      | empty-response — retry blocked by side-effect gate                                        |
| 7   | 04-23 07:46 | stuck after SKILL.md guess            | no                  | n/a                                      | no                      | gemma substituted `/app/skills/…` path and bailed on one ENOENT (fixed by `5fb7d17b2e`)   |
| 8   | 04-23 09:09 | stuck after `fetch_workspace.sh pull` | no                  | n/a                                      | no                      | empty response, retry vetoed by `hadPotentialSideEffects` (fixed by `18f8e498f1`)         |
| 9   | 04-23 12:22 | **failed in 34 s** (Windows node)     | no                  | n/a                                      | no                      | `exec` routed to `host: "node"`; bash script not found on Windows (fixed by `d61afa44a2`) |
| 10  | 04-23 12:53 | **3 min** (Windows node)              | no                  | **✅ (correct session, motions, DCNs)**  | **✅ both pushes auto** | end-to-end success; cosmetic: § 6 used `### 6.N` + duplicated DCN (SKILL.md tightened)    |

Read runs 4, 6, 7, 8 together: each of them stalled at an internal
`thinking → empty content` turn, but the proximate cause drifted each
time — first because the `<channel|>` Harmony token leaked into the
output stream making the model's next turn return `content=[]`, second
because the ENOENT recovery policy was under-specified for the
skill-load step, third because the existing empty-response retry's
side-effect gate fired on any successful `exec` and silently skipped
the rescue. The 2026-04-23 commits address each one independently:

- `dcca2e3f04` (04-22) — extended the empty-response retry to
  non-strict-agentic models in the first place.
- `c1a346106c` (04-23 am) — raised `SELF_HOSTED_DEFAULT_MAX_TOKENS`
  from 8192 → 16384 and `DEFAULT_EMPTY_RESPONSE_RETRY_LIMIT` from
  1 → 3.
- `5fb7d17b2e` (04-23 am) — told the prompt that the `<location>`
  string in `<available_skills>` is authoritative and that one ENOENT
  on a skill path is not a reason to abandon the skill.
- `18f8e498f1` (04-23 pm) — narrowed the empty-response retry's
  side-effect gate from coarse `hadPotentialSideEffects` (any
  mutating tool) to just `didSendViaMessagingTool`, so file/exec/cron
  side effects no longer block the rescue.

Run #9 then surfaced a fresh signature when the workload moved from
the Jetson Linux node to a Windows CapybaraHome node: every
`exec` for `fetch_workspace.sh` was sent with `"host": "node"`, the
bash script path was a gateway path, Windows returned
`The system cannot find the path specified.` three times in a row,
and gemma gave up in 34 seconds. Root cause was not the skill but the
generated `TOOLS.md` that `manage.sh ask-off <user> <node>` installs:
Rule 1 said "use `host: node` for Windows commands", and gemma
classified the command as Windows because its **arguments** were a
Windows path, even though the **binary** was Linux `bash`. A small
model cannot be trusted to resolve that category conflict.

- `d61afa44a2` (04-23 pm) — rewrote `cmd_ask_off`'s generated
  `TOOLS.md` to forbid `host: "node"` entirely and document a single
  "pull to gateway, work in Linux, push back" workflow via `openclaw
nodes copy`. Removes the `dir`/`type`/`markitdown`-on-node guidance
  that was tempting small models into Windows-native exec paths.

Run #10 closed the end-to-end path in ~3 minutes on the Windows node,
with correct session-minutes selection, correct motion numbers, and
both artifacts pushed. Two cosmetic defects remained — § 6 Q&A used
`### 6.N` (H3) instead of `## 6.N` (H2), and the § 6 subsection titles
repeated the DCN (`### 6.1 11-26/512r0 (Title) (11-26/512r0)`). Root
cause was gemma bailing on a single ENOENT when it tried to read the
template under `./_extracted/skills/…` (a made-up working-directory
prefix) and writing the report from memory instead of the template.

- SKILL.md Step 5 now carries an explicit "use the absolute path
  verbatim, do not prefix it with `./_extracted/` / `./input/`"
  directive plus correct/wrong worked examples for the § 6 heading
  format so the H2/H3 distinction is learned from an example, not
  from an abstract rule.

Run #11 (2026-04-23 13:20 UTC) stalled twice in the same session: once
at an empty terminal turn after reading `_summary.txt`, and once after
the user nudged with "continue" and gemma replied with a text-only
"I will begin by reading the key documents…" but no tool call. Neither
stall triggered any existing retry, because the empty-response retry
bails out on `attempt.assistantTexts` once any earlier cycle produced
text, and the reasoning-only / planning-only retries are gated to the
GPT-5 strict-agentic contract. The user's original fix request
("whenever the agent responds without a tool call, auto-nudge once
per user message") was only implemented narrowly for the fully-empty
content case. The new no-tool-call nudge closes that gap — it fires
for any terminal turn (`stopReason !== "toolUse"`) when prior tool
activity exists (`toolMetas.length > 0`), sends one nudge ("confirm if
done, else call the next concrete tool action"), and caps at one
nudge per user message so pure-chat replies aren't turned into
two-message exchanges.

---

## 6. What's in the repo now

### 6a. The skill (user-facing)

- `multi-user-support/skills/ieee-meeting-report/SKILL.md` — 6-step
  workflow with hard rules, MANDATORY gates on source reads and
  chart generation, ENOENT recovery policy, explicit Markdown-only
  output directive, H2-vs-H3 heading pin, both-pushes-required
  directive.
- `multi-user-support/skills/ieee-meeting-report/scripts/` — the three
  helper scripts.
- `multi-user-support/skills/ieee-meeting-report/assets/Template_Basic_Meeting_Report.md` —
  the Markdown template with `> **AGENT INSTRUCTION:** …` blockquotes
  the agent should delete when filling.
- `multi-user-support/skills/ieee-meeting-report/references/aiml-sc-notes.md` —
  DCN decoding, motion formatting hints, what-to-skip list.

### 6b. Auto-mount wiring

- `multi-user-support/manage.sh` — adds the
  `${OPENCLAW_SKILLS_DIR}:/home/node/.openclaw/workspace/skills:ro`
  bind mount in `generate_compose_file`, backfills it into existing
  users via `ensure_skills_wiring`, seeds `tools.deny` for new users
  in `cmd_add`, writes explicit `maxTokens: 16384` in
  `cmd_sync_ollama` and `cmd_sync_vllm`.

### 6c. Per-user state ignore

- Root `.gitignore` excludes `multi-user-support/users/`. Local
  `manage.sh add <user>` output (`.env`, generated compose,
  `.auto-approve.pid`) stays on disk but untracked.

---

## 7. Code changes made to OpenClaw core

Nineteen commits, all on `main` at `github.com:ntutangyun/openclaw`,
each with pre-commit `pnpm check` green.

| #   | SHA           | Scope      | Summary                                                                                         |
| --- | ------------- | ---------- | ----------------------------------------------------------------------------------------------- |
| 01  | `4508414319`  | multi-user | stop tracking per-user runtime state                                                            |
| 02  | `f93409bfa1`  | multi-user | add `ieee-meeting-report` skill and auto-mount wiring                                           |
| 03  | `bece61dd56`  | multi-user | tighten `ieee-meeting-report` against template drift                                            |
| 04  | `285ddc4037`  | multi-user | require source reads + forbid made-up scripts                                                   |
| 05  | `b927682985`  | multi-user | forbid all delegation in SKILL.md                                                               |
| 06  | `c136c00f49`  | multi-user | skip read-only skills mount in `manage.sh` chown fix                                            |
| 07  | `afbecce67a`  | multi-user | generalize for any node + ENOENT recovery                                                       |
| 08  | `03ae15ae8a`  | multi-user | call out H2 Q&A headings and require both pushes                                                |
| 09  | `732d83ace9`  | multi-user | drop `check_report.py`; gate against wrong-session minutes                                      |
| 10  | `dcca2e3f04`  | **core**   | extend empty-response retry to non-strict-agentic models                                        |
| 11  | `ccef2168fc`  | **core**   | hide sub-agent tools from system prompt when denied; default-deny in multi-user                 |
| 12  | `ef9de9de79`  | **ui**     | auto-advance stale usage date-range + empty-state hint in protocol monitor                      |
| 13  | `c1a346106c`  | **core**   | raise self-hosted output budget 8K → 16K and empty-response retry limit 1 → 3                   |
| 14  | `5fb7d17b2e`  | **core**   | pin `<location>` as authoritative in skills prompt; forbid abandoning on first ENOENT           |
| 15  | `8f75f7a4ec`  | **build**  | expose `OPENCLAW_MARKITDOWN_EXTRAS`; multi-user defaults to `docx,pptx` and skips apt-upgrade   |
| 16  | `7b0249f387`  | **build**  | pnpm store BuildKit cache mount + `manage.sh cache-warm` one-shot seeding helper                |
| 17  | `18f8e498f1`  | **core**   | narrow empty-response retry side-effect gate to messaging-only (unblock file/exec retries)      |
| 18  | `d61afa44a2`  | multi-user | rewrite generated `TOOLS.md` to forbid `host: "node"`; mandate pull/copy-back for all node work |
| 19  | `a06ca403f2`  | multi-user | SKILL.md Step 5: verbatim template path + correct/wrong worked examples for § 6 headings        |
| 20  | (this commit) | **core**   | no-tool-call nudge: one-shot rescue for terminal turns that stop without a tool call            |

### Core code changes explained

**`dcca2e3f04` — `src/agents/pi-embedded-runner/run/incomplete-turn.ts`**

Previously the empty-response retry was gated to GPT-5 strict-agentic
runs via `shouldApplyPlanningOnlyRetryGuard`. But gemma4:e4b
intermittently emits its end-of-turn token with no parseable visible
content after Harmony-style template tokens (e.g.
`call:read{path:<|\"|>…`) leak into the output stream. That produces
a clean `stopReason=stop` with `content=[]`. Previously openclaw
accepted that as a normal completion. Now it fires a steer retry
with the existing `EMPTY_RESPONSE_RETRY_INSTRUCTION` for every
model, not just strict-agentic runs.

**`ccef2168fc` — `src/agents/system-prompt.ts`**

Four locations that unconditionally mentioned sub-agent tools, each
gated on availability:

- Line 660: _"If a task is more complex or takes longer, spawn a
  sub-agent…"_ → now only if `hasSessionsSpawn`.
- Line 313–314: `## Messaging` bullets for `sessions_send` and
  `subagents` → only if each tool is in `availableTools`.
- Line 669: _"Do not poll `subagents list` / `sessions_list` in a
  loop"_ → only if either is in `availableTools`.
- Line 766: _"Sub-agents stay sandboxed"_ → only if `hasSessionsSpawn`.

Net effect: when `tools.deny` removes the sub-agent family, the
model's system prompt contains zero references to sub-agent
orchestration. No filter-at-call-time attempt; the capability
is gone from the model's context entirely.

**`c1a346106c` — `src/agents/self-hosted-provider-defaults.ts` + `incomplete-turn.ts`**

- `SELF_HOSTED_DEFAULT_MAX_TOKENS`: 8192 → **16384**. Flows through
  `extensions/ollama/src/stream.ts:633-634` as `num_predict`, so
  ollama gives gemma a doubled per-response output budget. On
  self-hosted runs output tokens are free, so the only cost is
  memory for larger in-flight completions.
- `DEFAULT_EMPTY_RESPONSE_RETRY_LIMIT`: 1 → **3**. Three steer
  retries before the harness surfaces an "incomplete turn" error.

**`ef9de9de79` — `ui/src/ui/controllers/usage.ts`**

UI-only, indirectly related: the user saw "usage metrics all zero" in
the protocol monitor and thought gemma was broken. Actually the
Control UI's `usageEndDate` was initialized to local-today at page
load and never advanced past midnight — any new session after the
date rolled over was silently excluded from the
`sessions.usage` query. The fix adds `usageDateRangeDirty`: while
the user hasn't edited the picker, `loadUsage` rolls stale
start/end dates forward to today before issuing the request. Plus
an empty-state hint in the protocol monitor's Usage Overview that
tells the user where the date picker lives when the window returns
zeros.

**`5fb7d17b2e` — `src/agents/system-prompt.ts` (skills section)**

Run #7 hallucinated the SKILL.md path to `/app/skills/…` (the bundled
skill convention) despite the system prompt's `<available_skills>`
block advertising it at `~/.openclaw/workspace/skills/…`, then bailed
on one ENOENT. Two pins added to `buildSkillsSection`:

- "The `<location>` path shown per skill is authoritative: copy it
  character-for-character. Do not guess `/app/skills/<name>/SKILL.md`
  for workspace skills — those live under
  `~/.openclaw/workspace/skills/`."
- "If the first `read` on a skill's `<location>` returns ENOENT, the
  path is wrong — re-examine the exact `<location>` string and retry.
  Do NOT abandon the skill."

Names `/app/skills/` explicitly as the wrong guess so the model can
pattern-match against the warning.

**`8f75f7a4ec` + `7b0249f387` — build-speed cuts**

`OPENCLAW_MARKITDOWN_EXTRAS=docx,pptx` as the multi-user default drops
pandas (79 MB), numpy.libs (29 MB), speech_recognition (43 MB),
pdfminer + pdfplumber + pypdfium2 (25 MB), youtube_transcript_api (9 MB),
azure-\* + cryptography + msal (30 MB), pydub/xlrd/xlsxwriter. Saves
~200 MB in the image and ~3-5 min of ARM pip install time. Upstream
`all` still reachable via `OPENCLAW_MARKITDOWN_EXTRAS=all manage.sh rebuild`.

`OPENCLAW_DOCKER_APT_UPGRADE=0` default skips `apt-get upgrade -y` on
the pinned bookworm base image. Saves ~1-3 min. Operators can keep
the upgrade with `OPENCLAW_DOCKER_APT_UPGRADE=1 manage.sh rebuild`.

`7b0249f387` re-enables the BuildKit cache mount on the pnpm store,
shared between the install and prune steps. The cache persists across
builds, so the SECOND rebuild onwards does 1-2 min of
`pnpm install --frozen-lockfile` instead of 12 min on Jetson over home
broadband. The earlier "cache mount unreliable" concern is addressed
by sharing the cache with `pnpm prune --prod`.

`manage.sh cache-warm` is a one-shot pre-seed that copies the host's
own `~/.local/share/pnpm/store` (~5.7 GB on the Jetson) into the
BuildKit cache via a tiny dedicated `docker build`, so even the very
first rebuild after `docker builder prune` runs warm. Smoke-tested
locally: 135 s bind-mount transfer + 365 s cache copy = ~8 min one-time
cost, plus unlimited warm-build savings afterwards.

**`d61afa44a2` — `multi-user-support/manage.sh` (`cmd_ask_off` heredoc)**

`manage.sh ask-off <user> <node>` generates a workspace-level
`TOOLS.md` to teach the agent how to pick an `exec` host. The old
content led with "use `host: gateway` for Linux commands and `host:
node` for Windows commands", plus an "Exec Tool — Host Selection"
section, a "Document Extraction (Windows Node)" section that said
always run `markitdown` on the node, and a "When to use pull/push vs.
direct node execution" section that kept a loophole for `dir`,
`type`, and `markitdown` on the node.

That structure works for a capable model that can tell the difference
between "the binary is Linux `bash`" and "the arguments happen to
contain a Windows path", but gemma4:e4b cannot — in Run #9 it
pattern-matched on the Windows path in the arguments and sent
`bash /home/node/.openclaw/workspace/skills/.../fetch_workspace.sh` to
the Windows node, which failed three times with "The system cannot
find the path specified." before the model gave up.

The rewrite replaces all of the above with a single workflow:

1. Pull the files from the node into the gateway workspace.
2. Work on them locally in Linux.
3. Push the results back.

And a hard rule: never set `"host": "node"` on `exec`; never run
`dir`, `type`, `mkdir`, `markitdown`, Python, or any command directly
on the node. All shell commands — `openclaw nodes copy`, `bash`,
`python`, skill scripts — run on the gateway with `"host":
"gateway"`. Small-model agents now have one path, not two, and the
path does not depend on correctly classifying arguments.

The container's workspace copy is refreshed in-place by re-running
`manage.sh ask-off <user> <node>`, which also performs a
`--force-recreate` of the gateway.

**Workspace skill tightening (SKILL.md Step 5)**

Run #10 exposed a secondary failure mode in the skill itself: gemma
tried to read the template at `./_extracted/skills/ieee-meeting-report/
assets/Template_Basic_Meeting_Report.md` — a path that does not exist
because the agent prefixed the absolute skill path with its working
directory. A single ENOENT was enough for it to skip reading the
template and write the report from memory. The report came out
structurally close but with `### 6.N` (H3) instead of `## 6.N` (H2)
for § 6 Q&A subsections and duplicated DCN in each subsection title.

Step 5 now leads with:

- "Use the absolute path above verbatim. Do NOT prefix it with
  `./_extracted/`, `./input/`, or any working-directory path — the
  template lives under the skill directory, not in your working
  directory."
- "If the first `read` returns ENOENT, re-check the path and retry.
  Do NOT skip this step and try to reconstruct the template from
  memory — that is how H2/H3 heading violations and duplicated-DCN
  subsection titles sneak into the output."

The § 6 checklist entry also now carries three worked examples:

- Correct: `## 6.1 AI Offload Standardization (11-26/512r0)`
- Wrong (H3): `### 6.1 AI Offload Standardization (11-26/512r0)`
- Wrong (DCN repeated): `### 6.1 11-26/512r0 (AI Offload
Standardization) (11-26/512r0)`

Small models learn from examples more reliably than from abstract
rules, and both defects observed in Run #10 now have a direct
counter-example in the prompt.

**No-tool-call nudge — `src/agents/pi-embedded-runner/run/incomplete-turn.ts` + `run.ts`**

Run #11 exposed two stalls that none of the existing retries covered:

1. A terminal empty turn (`content: []`, `stopReason: "stop"`, 1 output
   token) _after_ earlier cycles in the same turn produced text. The
   empty-response retry checks `attempt.assistantTexts.join(...).trim().length
   > 0` and bails out as soon as any earlier cycle had text — fine for
   > GPT-5 (first-turn-only empty is the failure mode it was written for),
   > not fine for gemma (Harmony-token leak can happen 5 cycles in).
2. A text-only terminal turn with a thinking block and a "I will begin
   by reading the key documents" text block but no tool call at all.
   This is exactly what `resolveReasoningOnlyRetryInstruction` and
   `resolvePlanningOnlyRetryInstruction` are supposed to catch, but both
   are gated to `shouldApplyPlanningOnlyRetryGuard` →
   `isStrictAgenticSupportedProviderModel`, i.e. the GPT-5 family only.
   For ollama/gemma4 they always return null.

The new `resolveNoToolCallNudgeInstruction` is a single per-user-message
rescue that catches both cases:

- Fires when `lastAssistant.stopReason !== "toolUse"` and not `"error"`.
- Skips when `didSendViaMessagingTool` (same gate as empty-response —
  a duplicate Slack/Discord send is worse than a stall).
- Skips when `toolMetas.length === 0` (no prior tool activity). This
  scopes the nudge to agentic workflows so a pure "what's 2+2?"
  reply doesn't get a "did you finish?" nudge.
- Skips the usual aborted / timedOut / clientToolCall / yieldDetected /
  lastToolError / didSendDeterministicApprovalPrompt guards.

Placed last in the retry cascade (after planning-only, reasoning-only,
empty-response), limited to 1 per user message
(`DEFAULT_NO_TOOL_CALL_NUDGE_LIMIT = 1`). The nudge text is
deliberately dual-purpose so a genuine completion and a mid-task stall
share the same rescue:

> "The previous turn ended without a tool call. If you have fully
> completed the task, confirm it in one brief sentence and stop.
> Otherwise, continue now by calling the next concrete tool action —
> do not restate the plan."

If the task was genuinely done, the model spends one extra inference
confirming "yes, done" and stops (second `stop` is accepted without
further nudging because the counter is capped at 1). If gemma stalled,
the nudge typically unsticks the loop by forcing a concrete next
action.

**`18f8e498f1` — `src/agents/pi-embedded-runner/run/incomplete-turn.ts`**

Run #8 showed the empty-response retry was **silently vetoed** by the
`replayMetadata.hadPotentialSideEffects` gate, which fires on any
mutating tool call — including idempotent ones like
`fetch_workspace.sh pull`. Result: after a successful pull the rescue
path couldn't help, even though `DEFAULT_EMPTY_RESPONSE_RETRY_LIMIT`
was 3.

The coarse gate makes sense for planning-only and reasoning-only
retries (which REPLAY the prior attempt), but the empty-response
retry hands the same conversation state to the model with a "continue
from current state" steer — it doesn't re-execute anything. The gate
was narrowed to `didSendViaMessagingTool` only:

- File/exec/cron side effects → retry now fires.
- User-visible messaging sends (Slack/Discord/Telegram) → still
  blocked, because a duplicate externally-visible message is bad and
  a small model may not grasp the "continue, don't redo" framing.

Test coverage: existing "does not retry generic empty GPT turns after
side effects" renamed to be explicit about messaging; new test
reproduces the gemma4 post-fetch scenario and asserts the retry
instruction IS emitted.

---

## 8. Current reliability picture

With tangyun's config at `tools.deny` + `maxTokens: 16384` and all
17 commits deployed via `manage.sh rebuild && manage.sh restart`:

- **Tool-selection on remote paths** — reliable. The skill owns the
  `node:` prefix; the prompt is clean; no sub-agent escape hatch.
- **9-document read + markitdown extract** — reliable.
- **Chart generation** — reliable (PNG matches affiliations).
- **Template-aligned Markdown write** — reliable **structurally**
  and, as of runs 3 and 5, **factually grounded**. Runs 2 and 4
  demonstrated each failure mode (fabrication; mid-run stall).
- **Both-artifacts push (report + chart)** — reliable once SKILL.md
  Step 6 was split into 6a and 6b.
- **Observability** — delegation fully blocked; every turn is visible
  in the foreground chat.
- **Skill-load ENOENT recovery** — with `5fb7d17b2e` the prompt now
  tells gemma `<location>` is authoritative and that one ENOENT is
  not a reason to abandon the skill.
- **Empty-response rescue after tool calls** — with `18f8e498f1` the
  retry now fires after file/exec/cron side effects, not just on
  turns with no side effects. The 3-retry budget can actually run.

Remaining failure modes:

- **Linux-vs-Windows path hallucination** — run #8 showed gemma
  reformatting a user's Linux path (`/home/sutd/…`) to a Windows
  path (`C:\Users\sutd\…`) during step #03. SKILL.md Step 0 mentions
  both options but doesn't say "copy the path verbatim from the user
  prompt". A one-line SKILL.md tightening would close this. Not yet
  done.
- **§ 3 Agenda table column alignment** — Run #5 produced a 3-column
  Agenda table with misaligned cells (the `#` column lost its
  numbers). Motions and Presentations tables came out correctly. A
  tighter template invariant in SKILL.md Step 5 #5 ("Example: `| 1 |
Call to order | Completed |`") would fix this; not yet done.
- **Agenda-DCN revision ambiguity** — gemma sometimes picks `r0` (as
  quoted in Motion 33) and sometimes `r1` (the latest). Both are
  defensible; minor.
- **Motion Booklet extraction** — Run #10 left Motion Booklet as
  `11-24/765r10 (Not directly readable)` rather than extracting a
  clean DCN from the agenda. Partial credit, cosmetic.
- **Deep-context empty-response stalls** past the 3-retry budget —
  theoretically possible if the model is genuinely stuck on a
  Harmony-token leak. Hasn't been observed after the retry-gate fix
  landed. If it happens, the user can type "continue" to change the
  context enough that the next inference typically succeeds.

---

## 9. Operational checklist

For a fresh user gateway running the stack below:

```bash
# One-time: pre-seed the BuildKit pnpm cache from the host's pnpm store
# (~8 min one-shot; avoids the cold 12-min pnpm install on the first
# build). Assumes pnpm is installed on the host and `pnpm install` has
# been run against the repo at least once.
bash multi-user-support/manage.sh cache-warm

# Build image with all the above commits. With the cache warm, expect
# ~8-12 min on Jetson Orin instead of ~32 min.
bash multi-user-support/manage.sh setup

# Provision a user (tools.deny, skills mount, etc. are applied
# automatically by cmd_add + ensure_skills_wiring)
bash multi-user-support/manage.sh add <username>
bash multi-user-support/manage.sh pair-device <username>
bash multi-user-support/manage.sh ask-off <username> <node-name>

# Point at the local ollama and pre-populate model metadata with
# explicit maxTokens (16384 for self-hosted)
bash multi-user-support/manage.sh sync-ollama <username>

# Select ollama/gemma4:e4b in the Control UI and trigger the skill:
#   "generate IEEE AI/ML meeting report based on files at
#    /home/<user>/Desktop/openclaw_workspace on <node-name>"
```

### Upgrading an existing deployment

```bash
git pull
bash multi-user-support/manage.sh rebuild          # picks up core-code commits
bash multi-user-support/manage.sh restart <user>
```

`tools.deny` and `maxTokens: 16384` are already live in each user's
`openclaw.json` — no per-user re-provisioning needed.

### Opt-outs (if upstream behavior is preferred)

```bash
# Restore the upstream full markitdown bundle (PDF, xlsx, audio, youtube):
OPENCLAW_MARKITDOWN_EXTRAS=all bash multi-user-support/manage.sh rebuild

# Keep the in-build apt-get upgrade:
OPENCLAW_DOCKER_APT_UPGRADE=1 bash multi-user-support/manage.sh rebuild

# Point cache-warm at a different host store location:
OPENCLAW_HOST_PNPM_STORE=/opt/custom/pnpm-store bash multi-user-support/manage.sh cache-warm
```

Expected tool-call sequence for a successful run:

1. `read ~/.openclaw/workspace/skills/ieee-meeting-report/SKILL.md`
2. `exec fetch_workspace.sh ls <node> <remote-folder>`
3. `exec fetch_workspace.sh pull <node> <remote-folder> ./input`
4. `exec extract_all.py --input ./input --output ./_extracted`
5. `read ./_extracted/_summary.txt` (optional) / `ls ./_extracted/`
6. `read ./_extracted/<minutes-for-this-session>.md`
7. `read ./_extracted/<agenda>.md`
8. `read ./_extracted/<closing-report>.md`
9. `read` each technical contribution `.md`
10. `exec build_chart.py --affiliations "A,B,…" --out ./company_contributions.png`
11. `read /home/node/.openclaw/workspace/skills/ieee-meeting-report/assets/Template_Basic_Meeting_Report.md`
12. `write ./Report_Basic_<Meeting>_<Date>.md`
13. `exec fetch_workspace.sh push <node> ./Report_Basic_<Meeting>_<Date>.md <remote-folder>`
14. `exec fetch_workspace.sh push <node> ./company_contributions.png <remote-folder>`

---

## 10. Open items

### High impact

- **Run a 10-run reliability batch** after the `18f8e498f1` rebuild
  and record the hit rate. We now have all four known failure-mode
  fixes in place; the next measurement should establish whether
  gemma is production-reliable on this task or whether more of the
  tail needs attention.
- **Linux-vs-Windows path verbatim rule in SKILL.md** (see §8). One
  sentence in Step 0 telling the agent to copy the user's path
  character-for-character from the prompt and not reformat it. Would
  close the run #8 failure mode before the retry-budget is needed.
- **§ 3 Agenda table invariant tightening** (see §8). Small SKILL.md
  tweak, should be a one-commit fix.

### Medium impact

- **System prompt trimming**. With `tools.deny` removing sub-agents
  we are at ~33 K system-prompt chars. The bundled skills block and
  runtime metadata are the next targets — a leaner system prompt
  leaves more room in context for history and `thinking`. Every K
  tokens cut from the prompt is K tokens the model can spend
  elsewhere.
- **History compaction** — at large prompt sizes, gemma occasionally
  loses track of its own progress (double reads of agenda revisions,
  repeated `ls` calls). Summarizing old turns would help; core
  openclaw already has compaction but it's configured for hosted
  models' larger windows.
- **Grounding check**. We deliberately dropped `check_report.py`,
  but a narrower `--source` mode that only verifies Motion numbers,
  DCNs, author names, and affiliations exist in the extracted
  Markdown (no structural assertions) would catch the fabrication
  failure mode of Run #2 without the false-positives that doomed
  the earlier gate.
- **Registry-backed deps image**. For further build-speed gains
  beyond `cache-warm`, push a dedicated `openclaw:deps` image whose
  only change trigger is `pnpm-lock.yaml`. Subsequent Jetson builds
  skip `pnpm install` entirely by pulling from a registry. Requires
  a registry workflow but caps cold-build time at the base image
  pull + source compile.

### Low impact

- **TZ label inside container** is `UTC` while the host is `+08`.
  Cosmetic; if desired, add `TZ=Asia/Singapore` to the gateway
  service environment in `generate_compose_file`.
- **UI date picker persistence** — current implementation auto-rolls
  forward on midnight crossing but doesn't remember an explicit
  user pick across reloads. Low priority.
- **Folder name typo** — this file lives under `local_modal_support/`
  (should be `local_model_support/`). Rename with `git mv` when
  convenient.

---

## Appendix A — file-by-file diff footprint

19 commits; cumulative source-tree changes:

```
.gitignore                                          +1 rule (multi-user-support/users/)
multi-user-support/.gitignore                       +1 rule
multi-user-support/manage.sh                        +~350 lines (skills mount, tools.deny default,
                                                     explicit maxTokens in sync-*, cache-warm command,
                                                     markitdown-extras + apt-upgrade build args,
                                                     rewritten TOOLS.md heredoc in cmd_ask_off)
multi-user-support/skills/ieee-meeting-report/      new (SKILL.md + 3 scripts + 1 reference + 1 asset),
                                                     + Step 5 verbatim-path directive and worked-example
                                                     fixes for § 6 Q&A headings
Dockerfile                                          +OPENCLAW_MARKITDOWN_EXTRAS ARG, pnpm BuildKit cache mount
                                                     on install + prune, updated comments
src/agents/self-hosted-provider-defaults.ts         +1 constant change (8192 → 16384)
src/agents/pi-embedded-runner/run/incomplete-turn.ts  +1 constant change (1 → 3), side-effect gate narrowed
                                                     to didSendViaMessagingTool only, updated comments
src/agents/pi-embedded-runner/run.incomplete-turn.test.ts  +4 tests (retry limit assertion, gemma model retry,
                                                     messaging-only gate rename, post-fetch retry coverage)
src/agents/system-prompt.ts                         +4 conditional gates on sub-agent prose +2 new skills-
                                                     section lines (location authoritative, ENOENT retry)
src/agents/system-prompt.test.ts                    +3 new tests (sub-agent denied, sandbox note gated,
                                                     skills location pins)
ui/src/ui/controllers/usage.ts                      +UsageState.usageDateRangeDirty, +formatLocalDate,
                                                     +auto-advance in loadUsage
ui/src/ui/app.ts                                    +@state() usageDateRangeDirty
ui/src/ui/app-view-state.ts                         +AppViewState.usageDateRangeDirty
ui/src/ui/app-render-usage-tab.ts                   +2 dirty-flag writes in picker handlers
ui/src/ui/views/protocol-monitor.ts                 +empty-state card + styles
ui/src/ui/controllers/usage.node.test.ts            +3 new tests
```

## Appendix B — companion artifacts

Nothing in this folder depends on content under
`~/Desktop/openclaw-gemma-investigation/`, but that directory
contains the ground-truth inputs if you want to re-run any of the
probes:

- `~/Desktop/openclaw-gemma-investigation/REPORT.md` — the original
  Apr-21 snapshot of the investigation up to the skill-delivery point.
- `~/Desktop/openclaw-gemma-investigation/probes/*.py` — 35 probe
  scripts. Run any one with `python3 <name>.py` from that folder;
  the scripts require Ollama on `localhost:11434` and the
  `openclaw-tangyun-gateway` container to be running.
- `~/Desktop/openclaw-gemma-investigation/probes/dmd3_out.md` — a
  known-good filled report at 55 / 55 structural checks. Useful
  baseline for future verifier work.

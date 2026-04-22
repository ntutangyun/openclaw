---
name: ieee-meeting-report
description: "Produce a Basic Meeting Participation Report (Markdown) from IEEE 802.11 working-group and standing-committee documents (AIML SC, TGbn, TGbf, EHT, UHR, etc.). Use when the user asks to generate, write, fill, or draft a meeting report, plenary report, interim report, or participation report from a folder of IEEE 802.11 documents (agenda, opening snapshot, closing report, meeting minutes, technical contributions in .pptx/.docx). The report is produced as Markdown (.md) — the user can convert to Word later if needed. Trigger phrases: 'basic meeting report', 'IEEE plenary report', 'fill the meeting report template', '802.11 interim report', 'AIML SC report', 'follow basic_guidelines.md'."
---

# IEEE 802.11 Meeting Report

Produce a Basic Meeting Participation Report as **Markdown** from a workspace folder of IEEE 802.11 session documents. The agent drives the narrative work; this skill handles the mechanical file-access and document-extraction steps.

**Output format is always Markdown (`.md`)** — not Word. Small locally-hosted models (≤10B parameters) cannot reliably generate the python-docx code needed to fill a `.docx` template; Markdown text editing keeps the work in-modality. If the user needs a `.docx`, produce the `.md` first, then offer to convert with pandoc in a separate step.

## Skill paths (absolute — always use these)

- **Skill root:** `/home/node/.openclaw/workspace/skills/ieee-meeting-report/`
- **Template:** `/home/node/.openclaw/workspace/skills/ieee-meeting-report/assets/Template_Basic_Meeting_Report.md`
- **Scripts:** `/home/node/.openclaw/workspace/skills/ieee-meeting-report/scripts/{fetch_workspace.sh,extract_all.py,build_chart.py,check_report.py}`
- **References:** `/home/node/.openclaw/workspace/skills/ieee-meeting-report/references/aiml-sc-notes.md`

## Agent working directory

Your `exec` tool runs in `/home/node/.openclaw/workspace/`. All relative paths like `./input`, `./_extracted`, `./Report_*.md` resolve inside that directory. **Never prefix with `./workspace/`** — that double-nests the path and breaks subsequent reads.

## Hard rules for this task

- **Do the entire task yourself in this session. Do not delegate.** This task runs in the foreground chat so the user can monitor progress turn by turn. Delegating to a sub-agent hides the work and defeats observability, even if the sub-agent would succeed.
  - **Do NOT call `sessions_spawn` for any reason.** Not to "synthesize the report", not to "read the documents", not to "fill the template", not with attachments, not without attachments.
  - **Do NOT call `subagents`** (list / steer / kill) or any other delegation tool.
  - **Do NOT call `sessions_send`** to hand the task off to another session.
  - The only tools you need for this task are: `read`, `write`, `exec`, `process` (for long-running `exec`). `read` + `write` alone cover Steps 3 and 5.
  - If you find yourself thinking "a sub-agent can do this better", that is wrong — the user has already chosen you for this run. Do the work.
- **Only four scripts exist under `/home/node/.openclaw/workspace/skills/ieee-meeting-report/scripts/`:**
  `fetch_workspace.sh`, `extract_all.py`, `build_chart.py`, `check_report.py`.
  Do not invent or invoke any other name (e.g. `generate_report.py`, `synthesize.py`, `fill_template.py`). **If a synthesis script appears to be missing, it is not missing — the synthesis is YOUR job, done via `read` + `write`.**
- **You MUST `read` the minutes file, the agenda file, and every technical contribution in `./_extracted/` before you produce a `write` to `./Report_*.md`.** Reading `./_extracted/_summary.txt` is not a substitute. Without reading the source documents, you will fabricate motion numbers, DCNs, author names, affiliations, and Q&A — which is a task failure, not a stylistic choice.
- Use `exec` (not `read`) for any path under `/home/<user>/...` or anything described as being on a remote node.
- Never fabricate motion numbers, DCNs, author names, or Q&A content. If the minutes do not state it, leave it empty and note the gap briefly.
- No opinions outside the Section 5 **Comments** column.
- Do not include IEEE patent / copyright / IPR boilerplate slides in the report.

## Step 0 — Decide where the inputs live

- **Remote node** (most common) — the user's `.pptx`/`.docx` live on a named OpenClaw node. The node can be Linux (paths look like `/home/<user>/...`) or Windows (paths look like `C:\Users\<user>\...`). Any path the user describes as being "on <node>" is REMOTE and you CANNOT read it with the local `read` tool — pull it first. Use the exact node name and path the user gave; if unsure about the node name, run `exec openclaw nodes status` on the gateway to list available nodes.
- **Gateway workspace** (rare) — already under `/home/node/.openclaw/workspace/`. Skip Step 1 and point `extract_all.py` at that folder.

## Step 1 — Pull the workspace folder (remote case only)

```bash
# List first to confirm contents and the node is reachable
bash /home/node/.openclaw/workspace/skills/ieee-meeting-report/scripts/fetch_workspace.sh \
  ls <node-name> "<remote-folder>"

# Pull everything to ./input
bash /home/node/.openclaw/workspace/skills/ieee-meeting-report/scripts/fetch_workspace.sh \
  pull <node-name> "<remote-folder>" ./input
```

## Step 2 — Extract every input document to Markdown

```bash
/opt/python-tools/bin/python \
  /home/node/.openclaw/workspace/skills/ieee-meeting-report/scripts/extract_all.py \
  --input  ./input \
  --output ./_extracted
```

Outputs:

- `./_extracted/<basename>.md` — one Markdown file per input document.
- `./_extracted/_manifest.json` — JSON list of converted files + any failures.
- `./_extracted/_summary.txt` — short human-readable roll-up.

**Filename convention — important:** the script **strips the source extension** before appending `.md`. So `foo.pptx` becomes `foo.md`, NOT `foo.pptx.md`. Always `ls ./_extracted/` (or read `_manifest.json`) to get the exact output filename rather than guessing it from the `.pptx`/`.docx` source name — appending `.md` to the source name will miss.

Check the manifest's `failures` array; if non-empty, report partial coverage rather than retrying blindly.

## Step 3 — Read the source documents (MANDATORY — this gates Step 5)

**You must issue a `read` tool call on every source file listed below before you may write the report.** `./_extracted/_summary.txt` only shows filenames — reading it does NOT count as reading the sources. If you skip this step, the report you write will be fabricated.

### 3a. Classify and list

First, `ls ./_extracted/` (or read `_summary.txt`) to get the file list. Group by role using the filename DCN suffix (see `references/aiml-sc-notes.md`):

- `...-meeting-minutes.md` (exactly one file expected)
- `...-agenda.md` (exactly one file expected, take the highest revision if multiple)
- `...-opening-snapshot.md`
- `...-closing-report.md`
- everything else → technical contributions

### 3b. Read, one at a time

Issue `read` on each of: **the minutes · the agenda · the closing report · every technical contribution**. Opening snapshot is optional (it rarely adds information the agenda lacks). Do not skip the contributions — their DCNs, titles, authors, and affiliations are what you populate § 5 with.

**Use the exact filenames that `ls ./_extracted/` returned in Step 3a** — do not reconstruct paths from the original `.pptx`/`.docx` source names. Appending `.md` to the source name will produce `foo.pptx.md`, which does not exist.

**If a single `read` fails with `ENOENT`, do NOT abort the task.** Instead:

1. `exec ls ./_extracted/` to see what files are actually there.
2. `exec cat ./_extracted/_manifest.json` to check if that file is in `converted` (wrong path guess) or `failures` (genuine extraction failure).
3. If it is in `converted`, retry `read` with the exact `output` path from the manifest.
4. Only if it is in `failures`, proceed with partial coverage and note the gap in § 5 Comments for that presentation.

A single path-guess miss must never end the task — every other file is almost certainly still readable.

### 3c. After reading, extract from what you just read

1. From the **minutes**, the `Motion \d+:` entries each have number, text, mover, second, and result — capture them verbatim.
2. From the **minutes**, the Discussion/Presentation sections list each contribution's DCN, title, presenter, affiliation, and Q&A.
3. From the **agenda**, the ordered agenda-item list, chair, vice-chair(s), secretary, agenda DCN, motion booklet DCN.
4. From the **closing report** (or minutes tail), next-meeting date, teleconference plans, contribution deadline, expected topics.
5. From each **technical-contribution deck**, write **2–4 factual bullet "Key points"** (what it proposes, the mechanism, the scope — no opinions).
6. For each presentation, write **one editorial sentence in "Comments"** (the only place an editorial judgement is allowed).

See `/home/node/.openclaw/workspace/skills/ieee-meeting-report/references/aiml-sc-notes.md` for motion formatting, DCN decoding, and what to skip (IEEE patent/copyright boilerplate).

## Step 4 — Render the company-contribution chart

```bash
/opt/python-tools/bin/python \
  /home/node/.openclaw/workspace/skills/ieee-meeting-report/scripts/build_chart.py \
  --affiliations "Qualcomm,Nokia,DeepSig,Intel" \
  --title "Presentations by contributing company (<Meeting> <Date>)" \
  --out ./company_contributions.png
```

Pass one `--affiliations` entry per presentation (duplicates allowed — that is how the script counts). The script picks a bar chart when there are more than 6 companies, pie otherwise, and saves a 150-DPI PNG. First run installs matplotlib into `~/.skill-venv` (takes ~30 s); subsequent runs are instant.

## Step 5 — Fill the Markdown template

**Read the template first:**

```
read /home/node/.openclaw/workspace/skills/ieee-meeting-report/assets/Template_Basic_Meeting_Report.md
```

Then produce the filled report with a single `write` tool call to `./Report_Basic_<Meeting>_<Date>.md` (e.g. `./Report_Basic_AIML_SC_March2026_Plenary.md`). **Do not invent a new structure** — preserve every heading, every table header, and the chart image reference from the template.

### Template-preservation checklist (all must be true in the output)

1. **All 7 top-level section headings present, verbatim and in order:**
   - `# 1. Executive Summary`
   - `# 2. Meeting Information`
   - `# 3. Agenda Overview`
   - `# 4. Motions and Votes`
   - `# 5. Presentations`
   - `# 6. Questions & Answers Summary`
   - `# 7. Next Meeting & Action Items`
2. **Cover-page key/value lines all filled** (7 labels): `Meeting`, `Location`, `Date(s)`, `Report Prepared By`, `Date of Report`, `Distribution`, `Classification`.
3. **§ 1 Executive Summary**: 3–5 factual sentences covering when/where, how many presentations, motions + outcomes, next-meeting date.
4. **§ 2 Meeting Information**: all 8 labels filled (`Committee`, `Meeting Type`, `Session`, `Chair`, `Vice Chair(s)`, `Secretary`, `Agenda Document`, `Motion Booklet`).
5. **§ 3 Agenda Overview** contains a Markdown table with header `| # | Agenda Item | Status |`, one real row per agenda item.
6. **§ 4 Motions and Votes** contains a Markdown table with header `| Motion # | Description | Mover | Second | Result |`, one real row per motion.
7. **§ 5 Presentations** contains a Markdown table with header `| DCN | Title | Author | Affiliation | Key points | Comments |`, one real row per presentation (all 6 columns filled).
8. **§ 5** also contains the chart image reference: `![Figure 1. Presentations by contributing company](./company_contributions.png)` with a caption line below it.
9. **§ 6 Questions & Answers Summary** has one `## 6.N <Title> (<DCN>)` subsection per presentation that had Q&A, with bulleted `- Q: ...` / `- A: ...` pairs. **Use exactly two `#` (H2), not three (`### 6.N`) or four.** The template uses H2 for these subsections; the verifier only matches `## 6.N`.
10. **§ 7 Next Meeting & Action Items** has all 4 labels filled (`Next Meeting`, `Teleconference Planned`, `Contribution Deadline`, `Expected Topics`).
11. **Every `> **AGENT INSTRUCTION:** ...` blockquote is removed** (those are notes for the author, not part of the final report).
12. **Zero `*[...]*` or `*[e.g.,...]*` placeholder strings remain** anywhere in the output.

## Step 5.5 — Verify the structure (MANDATORY GATE — do not skip, do not push before it passes)

The task is **not complete** until `check_report.py` prints `Result: 12/12 checks passed` in this session. You must run:

```bash
/opt/python-tools/bin/python \
  /home/node/.openclaw/workspace/skills/ieee-meeting-report/scripts/check_report.py \
  ./Report_Basic_<Meeting>_<Date>.md
```

Interpretation:

- **If the result is `12/12 checks passed`** — proceed to Step 6.
- **If any check shows `[FAIL]`** — do NOT push. Treat it as work in progress:
  1. Re-read `/home/node/.openclaw/workspace/skills/ieee-meeting-report/assets/Template_Basic_Meeting_Report.md`.
  2. Re-read your last `./Report_Basic_*.md`.
  3. Fix the failing invariant(s) with a fresh `write` call (full-file rewrite; avoid `edit` for large rewrites).
  4. Run `check_report.py` again.
  5. Iterate. Do not skip steps 1–3 hoping the next `write` is better; the failure detail tells you exactly what's missing.

**A report that has not shown `12/12 checks passed` in this session must not be pushed to the node.** In your final summary to the user, echo the verifier's tail line so it is visible in chat.

## Step 6 — Push BOTH artifacts back to the node

The report references the chart by relative path. If you push only the `.md`, the image will be broken on the remote side. **Both pushes below are required — do not stop after the first one.**

**6a. Push the report:**

```bash
bash /home/node/.openclaw/workspace/skills/ieee-meeting-report/scripts/fetch_workspace.sh \
  push <node-name> ./Report_Basic_<Meeting>_<Date>.md "<remote-folder>"
```

**6b. Push the chart PNG into the same folder (required):**

```bash
bash /home/node/.openclaw/workspace/skills/ieee-meeting-report/scripts/fetch_workspace.sh \
  push <node-name> ./company_contributions.png "<remote-folder>"
```

The task is complete only after BOTH pushes succeed. In your final summary to the user, explicitly confirm that both `Report_Basic_*.md` and `company_contributions.png` were pushed to `<remote-folder>`. If you skip 6b, the report opens with a broken image link.

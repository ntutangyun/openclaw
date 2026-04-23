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
- **Scripts:** `/home/node/.openclaw/workspace/skills/ieee-meeting-report/scripts/{fetch_workspace.sh,extract_all.py,build_chart.py}`
- **References:** `/home/node/.openclaw/workspace/skills/ieee-meeting-report/references/aiml-sc-notes.md`

## Agent working directory

Your `exec` tool runs in `/home/node/.openclaw/workspace/`. All relative paths like `./input`, `./_extracted`, `./Report_*.md` resolve inside that directory. **Never prefix with `./workspace/`** — that double-nests the path and breaks subsequent reads.

## Hard rules for this task

- The tools you need for this task are `read`, `write`, `exec`, and `process` (for long-running `exec`). `read` + `write` alone cover Steps 3 and 5. Do the entire task yourself in this session — the user is watching the chat turn by turn.
- **Only three scripts exist under `/home/node/.openclaw/workspace/skills/ieee-meeting-report/scripts/`:**
  `fetch_workspace.sh`, `extract_all.py`, `build_chart.py`.
  Do not invent or invoke any other name (e.g. `generate_report.py`, `synthesize.py`, `fill_template.py`, `check_report.py`). **If a synthesis or verifier script appears to be missing, it is not missing — the synthesis is YOUR job, done via `read` + `write`.**
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

- `...-plenary-meeting-minutes.md` or `...-interim-meeting-minutes.md` — the **current session's** minutes
- `...-agenda.md` — exactly one file; take the highest revision if multiple
- `...-opening-snapshot.md`
- `...-closing-report.md`
- everything else → technical contributions

**CRITICAL — pick the right minutes file.** The user's folder often contains minutes from MULTIPLE sessions: e.g. `11-26-0304-00-aiml-aiml-sc-january-2026-interim-meeting-minutes.md` AND `11-26-0749-00-aiml-aiml-sc-march-2026-plenary-meeting-minutes.md`. They are NOT interchangeable. The report is for ONE session — pull the session name and year from the agenda (or the user's request), then match the minutes filename against it:

- Report for "March 2026 Plenary" → read `...-march-2026-plenary-meeting-minutes.md`
- Report for "January 2026 Interim" → read `...-january-2026-interim-meeting-minutes.md`

**Do not** read minutes from a different session and pull motions/Q&A from them — that is the #1 way this task fabricates the entire § 4 and § 6. Prior-session minutes may be mentioned in the current minutes (e.g. "Motion 34: approve 11-26/304r0 January Interim Minutes"), but their _contents_ do not belong in this report.

If multiple minutes files match the current session (rare), take the highest revision.

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

## Step 4 — Render the company-contribution chart (MANDATORY — do not skip)

You MUST run `build_chart.py` before Step 5. The template's § 5 embeds `./company_contributions.png`; if that file does not exist, Step 6b will fail with "local source does not exist" and the remote report will have a broken image link.

```bash
/opt/python-tools/bin/python \
  /home/node/.openclaw/workspace/skills/ieee-meeting-report/scripts/build_chart.py \
  --affiliations "Qualcomm,Nokia,DeepSig,Intel" \
  --title "Presentations by contributing company (<Meeting> <Date>)" \
  --out ./company_contributions.png
```

Pass one `--affiliations` entry per presentation (duplicates allowed — that is how the script counts). The script picks a bar chart when there are more than 6 companies, pie otherwise, and saves a 150-DPI PNG. First run installs matplotlib into `~/.skill-venv` (takes ~30 s); subsequent runs are instant.

After the script exits, verify the PNG exists with `ls -l ./company_contributions.png` before moving on. Do not proceed to Step 5 without the file on disk.

## Step 5 — Fill the Markdown template

**Read the template first:**

```
read /home/node/.openclaw/workspace/skills/ieee-meeting-report/assets/Template_Basic_Meeting_Report.md
```

Use the absolute path above **verbatim**. Do NOT prefix it with `./_extracted/`, `./input/`, or any working-directory path — the template lives under the skill directory, not in your working directory. If the first `read` returns ENOENT, re-check the path (it must start with `/home/node/.openclaw/workspace/skills/`) and retry. Do NOT skip this step and try to reconstruct the template from memory — that is how H2/H3 heading violations and duplicated-DCN subsection titles sneak into the output.

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
9. **§ 6 Questions & Answers Summary** has one `## 6.N <Title> (<DCN>)` subsection per presentation that had Q&A, with bulleted `- Q: ...` / `- A: ...` pairs. **Use exactly two `#` (H2), not three (`### 6.N`) or four.** The template uses H2 for these subsections. The DCN appears **once** at the end, in parentheses — do not also inline it at the start of the title.
   - **Correct:** `## 6.1 AI Offload Standardization (11-26/512r0)`
   - **Wrong (H3):** `### 6.1 AI Offload Standardization (11-26/512r0)`
   - **Wrong (DCN repeated):** `### 6.1 11-26/512r0 (AI Offload Standardization) (11-26/512r0)`
10. **§ 7 Next Meeting & Action Items** has all 4 labels filled (`Next Meeting`, `Teleconference Planned`, `Contribution Deadline`, `Expected Topics`).
11. **Every `> **AGENT INSTRUCTION:** ...` blockquote is removed** (those are notes for the author, not part of the final report).
12. **Zero `*[...]*` or `*[e.g.,...]*` placeholder strings remain** anywhere in the output.

## Step 5.5 — Self-check before pushing

Re-read your own `./Report_Basic_*.md` before Step 6 and confirm, by eye, that:

- All 7 top-level section headings are present in order (from the checklist above).
- § 4 Motions list matches what you actually saw in the MARCH PLENARY minutes file (`*-plenary-meeting-minutes.md`) — motion numbers, movers, and seconders must be verbatim from that file, not from any January interim minutes.
- § 5 Presentations rows and § 6 Q&A subsections only contain DCNs, authors, affiliations, and questions/answers that actually appear in the extracted Markdown files you read in Step 3b.
- No `*[...]*` placeholders remain. No `> **AGENT INSTRUCTION:** ...` blockquotes remain.
- The chart image reference is present in § 5 and `./company_contributions.png` exists in the working directory (from Step 4).

If anything is off, fix it with a fresh `write` (full-file rewrite; avoid `edit` for large rewrites) before pushing. If you never ran Step 4, go back and run it — do not push a report whose § 5 chart reference points at a missing file.

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

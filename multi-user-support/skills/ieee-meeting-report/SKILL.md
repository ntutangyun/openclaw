---
name: ieee-meeting-report
description: "Produce a Basic Meeting Participation Report (Markdown) from IEEE 802.11 working-group and standing-committee documents (AIML SC, TGbn, TGbf, EHT, UHR, etc.). Use when the user asks to generate, write, fill, or draft a meeting report, plenary report, interim report, or participation report from a folder of IEEE 802.11 documents (agenda, opening snapshot, closing report, meeting minutes, technical contributions in .pptx/.docx). The report is produced as Markdown (.md) — the user can convert to Word later if needed. Trigger phrases: 'basic meeting report', 'IEEE plenary report', 'fill the meeting report template', '802.11 interim report', 'AIML SC report', 'follow basic_guidelines.md'."
---

# IEEE 802.11 Meeting Report

Produce a Basic Meeting Participation Report as **Markdown** from a workspace folder of IEEE 802.11 session documents. The agent drives the narrative work; this skill handles the mechanical file-access and document-extraction steps.

**The output is always Markdown (`.md`)** — not Word. Small locally-hosted models (≤10B parameters) cannot reliably generate the python-docx code needed to fill a `.docx` template; Markdown text editing keeps the work in-modality and gives near-perfect results. If the user needs a `.docx`, produce the `.md` first, then offer to convert with pandoc in a separate step.

This skill lives at `/home/node/.openclaw/workspace/skills/ieee-meeting-report/` inside the gateway:

- `assets/Template_Basic_Meeting_Report.md` — the authoritative Markdown template. Do not modify it in place; copy it and fill the copy.
- `scripts/fetch_workspace.sh` — wraps `openclaw nodes copy`/`ls` so you do not have to remember the `node:` prefix.
- `scripts/extract_all.py` — converts every `.pptx`/`.docx` in a folder to Markdown via `markitdown`.
- `scripts/build_chart.py` — renders the company-contribution chart as a PNG. Self-bootstraps matplotlib in a user-owned venv on first run.
- `references/aiml-sc-notes.md` — DCN format, motion conventions, what to skip.

## Step 0 — Decide where the inputs live

- **Remote node** (most common) — the user's `.pptx`/`.docx` live on a node like `sutd-jetson`. Any path under `/home/<user>/...` or described as "on <node>" is REMOTE. You cannot read it with the local `read` tool.
- **Gateway workspace** (rare) — already under `/home/node/.openclaw/workspace/`. Skip Step 1 and point `extract_all.py` at that folder.

## Step 1 — Pull the workspace folder (remote case only)

Use `exec` — never `read` — for any remote operation.

```bash
# List first to confirm contents and the node is reachable
bash /home/node/.openclaw/workspace/skills/ieee-meeting-report/scripts/fetch_workspace.sh \
  ls <node-name> "<remote-folder>"

# Pull everything to ./workspace/input
bash /home/node/.openclaw/workspace/skills/ieee-meeting-report/scripts/fetch_workspace.sh \
  pull <node-name> "<remote-folder>" ./workspace/input
```

## Step 2 — Extract every input document to Markdown

```bash
/opt/python-tools/bin/python \
  /home/node/.openclaw/workspace/skills/ieee-meeting-report/scripts/extract_all.py \
  --input  ./workspace/input \
  --output ./workspace/_extracted
```

Outputs:

- `_extracted/<basename>.md` — one Markdown file per input document (including the template docx, if the user put one in the folder).
- `_extracted/_manifest.json` — JSON list of converted files + any failures.
- `_extracted/_summary.txt` — short roll-up.

Check the manifest's `failures` array; if non-empty, report partial coverage rather than retrying blindly.

## Step 3 — Read and reason over the extracted Markdown

This is the agent's job. No regex parsing is bundled because IEEE document formats drift session to session.

1. Match each `_extracted/*.md` file to its role (agenda, opening snapshot, closing report, minutes, technical contribution) — use both the filename DCN and the opening lines of the file.
2. From the **minutes**, extract:
   - **Motions** — number, text, mover, seconder, result (verbatim).
   - **Presentations** — DCN, title, author, affiliation.
   - **Q&A** — group by presentation. Paraphrase for clarity; preserve the technical meaning.
3. From the **agenda**, extract the ordered agenda-item list, chair, vice-chair(s), secretary, agenda DCN, motion booklet DCN.
4. From the **closing report** (or minutes), extract next-meeting date, teleconference plans, contribution deadline, expected topics.
5. For each presentation, write **2–4 factual bullet "Key points"** from its slide content (cover what it proposes, the mechanism, the scope — no opinions).
6. For each presentation, write **one editorial sentence in "Comments"** (this is the only place where a short judgement is allowed — e.g. strategic relevance, overlap with existing work, maturity).

See `references/aiml-sc-notes.md` for quick hints on motion formatting, DCN decoding, and what to skip (IEEE patent/copyright boilerplate).

## Step 4 — Render the company-contribution chart

```bash
/opt/python-tools/bin/python \
  /home/node/.openclaw/workspace/skills/ieee-meeting-report/scripts/build_chart.py \
  --affiliations "Qualcomm,Nokia,DeepSig,Intel" \
  --title "Presentations by contributing company (March 2026 Plenary)" \
  --out ./workspace/company_contributions.png
```

Pass one `--affiliations` entry per presentation (duplicates allowed — that is how the script counts). The script picks a bar chart for more than 6 companies, pie otherwise, and saves a 150-DPI PNG.

First run installs matplotlib into `~/.skill-venv` (takes ~30 s). Subsequent runs are instant.

## Step 5 — Fill the Markdown template

The template at `assets/Template_Basic_Meeting_Report.md` has:

- Cover-page key/value lines with `*[e.g., ...]*` placeholders.
- Tables with `*[...]*` placeholder rows.
- Blockquotes starting with `> **AGENT INSTRUCTION:** ...` — these are meta-notes. **Delete every one of them from the final report.**
- A Markdown image reference at Section 5 pointing at `./company_contributions.png`. Leave the reference; make sure the file exists beside the report.

Produce the filled report with a single `exec` that does:

1. Copy `assets/Template_Basic_Meeting_Report.md` to `./workspace/Report_Basic_<Meeting>_<Date>.md`.
2. Edit the copy (you can do this by writing a filled version directly with the `write` tool).

**Use the write tool**, not a python-docx script. Gemma-class models are strong at end-to-end Markdown text replacement — one pass outputs the whole filled document.

Required edits, in order:

1. Replace all cover-page `*[e.g., ...]*` placeholders with real values.
2. Replace the Executive Summary placeholder paragraph with 3–5 factual sentences.
3. Populate the Meeting Information key/value lines.
4. Replace the Agenda table's `*[...]*` row with one row per agenda item.
5. Replace the Motions table's `*[...]*` row with one row per motion (keep the header).
6. Replace the Presentations table's `*[...]*` row with one row per presentation (all 6 columns filled).
7. Under `# 6. Questions & Answers Summary`, create one `## 6.N <Title> (<DCN>)` subsection per presentation that had Q&A, with `- Q:` / `- A:` bullet pairs.
8. Replace the Next Meeting key/value lines.
9. **Delete every `> **AGENT INSTRUCTION:** ...` blockquote line.**
10. Verify no `*[...]*` or `*[e.g.,...]*` string remains anywhere in the output (that is the most common miss — do a final scan).

Output path: `./workspace/Report_Basic_<Meeting>_<Date>.md`, e.g. `Report_Basic_AIML_SC_March2026_Plenary.md`.

## Step 6 — Push back to the node

```bash
bash /home/node/.openclaw/workspace/skills/ieee-meeting-report/scripts/fetch_workspace.sh \
  push <node-name> ./workspace/Report_Basic_<Meeting>_<Date>.md "<remote-folder>"

# And the chart PNG in the same folder so the image reference resolves
bash /home/node/.openclaw/workspace/skills/ieee-meeting-report/scripts/fetch_workspace.sh \
  push <node-name> ./workspace/company_contributions.png "<remote-folder>"
```

## Guardrails

- Use `exec` (not `read`) for any `/home/<user>/...` path or anything the user describes as being on a remote node. `read` only sees the gateway filesystem.
- Never fabricate motion numbers, DCNs, author names, or Q&A content. If the minutes do not state it, leave it empty and note the gap briefly.
- No opinions outside the Section 5 **Comments** column.
- Do not include IEEE patent / copyright / IPR boilerplate slides in the report.
- Output is Markdown. Do not attempt to produce a `.docx` via `python-docx` — it will not survive a small-model code-gen pass.

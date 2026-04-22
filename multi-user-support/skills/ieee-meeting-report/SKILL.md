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

- **Do not call `sessions_spawn`.** Do the synthesis yourself using `read` + `write`. `sessions_spawn` with attachments is blocked by policy in this environment; trying it will cost you minutes per failed attempt.
- Use `exec` (not `read`) for any path under `/home/<user>/...` or anything described as being on a remote node.
- Never fabricate motion numbers, DCNs, author names, or Q&A content. If the minutes do not state it, leave it empty and note the gap briefly.
- No opinions outside the Section 5 **Comments** column.
- Do not include IEEE patent / copyright / IPR boilerplate slides in the report.

## Step 0 — Decide where the inputs live

- **Remote node** (most common) — the user's `.pptx`/`.docx` live on a node like `sutd-jetson`. Any path under `/home/<user>/...` or described as "on <node>" is REMOTE. You cannot read it with the local `read` tool.
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

Check the manifest's `failures` array; if non-empty, report partial coverage rather than retrying blindly.

## Step 3 — Read and reason over the extracted Markdown

This is the agent's job. No regex parsing is bundled because IEEE document formats drift session to session.

1. Match each `./_extracted/*.md` file to its role (agenda, opening snapshot, closing report, minutes, technical contribution) — use both the filename DCN and the opening lines of the file.
2. From the **minutes**, extract:
   - **Motions** — number, text, mover, seconder, result (verbatim).
   - **Presentations** — DCN, title, author, affiliation.
   - **Q&A** — group by presentation. Paraphrase for clarity; preserve the technical meaning.
3. From the **agenda**, extract the ordered agenda-item list, chair, vice-chair(s), secretary, agenda DCN, motion booklet DCN.
4. From the **closing report** (or minutes), extract next-meeting date, teleconference plans, contribution deadline, expected topics.
5. For each presentation, write **2–4 factual bullet "Key points"** from its slide content (cover what it proposes, the mechanism, the scope — no opinions).
6. For each presentation, write **one editorial sentence in "Comments"** (this is the only place where a short judgement is allowed — e.g. strategic relevance, overlap with existing work, maturity).

See `/home/node/.openclaw/workspace/skills/ieee-meeting-report/references/aiml-sc-notes.md` for quick hints on motion formatting, DCN decoding, and what to skip (IEEE patent/copyright boilerplate).

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
9. **§ 6 Questions & Answers Summary** has one `## 6.N <Title> (<DCN>)` subsection per presentation that had Q&A, with bulleted `- Q: ...` / `- A: ...` pairs.
10. **§ 7 Next Meeting & Action Items** has all 4 labels filled (`Next Meeting`, `Teleconference Planned`, `Contribution Deadline`, `Expected Topics`).
11. **Every `> **AGENT INSTRUCTION:** ...` blockquote is removed** (those are notes for the author, not part of the final report).
12. **Zero `*[...]*` or `*[e.g.,...]*` placeholder strings remain** anywhere in the output.

## Step 5.5 — Verify the structure

Always run the verifier before pushing back:

```bash
/opt/python-tools/bin/python \
  /home/node/.openclaw/workspace/skills/ieee-meeting-report/scripts/check_report.py \
  ./Report_Basic_<Meeting>_<Date>.md
```

If any check fails, **read the template again, re-read your output, fix the failing item(s), and `write` a revised copy.** Iterate until `check_report.py` prints `12/12 checks passed`. Do not push back a report that fails the verifier.

## Step 6 — Push back to the node

```bash
bash /home/node/.openclaw/workspace/skills/ieee-meeting-report/scripts/fetch_workspace.sh \
  push <node-name> ./Report_Basic_<Meeting>_<Date>.md "<remote-folder>"

bash /home/node/.openclaw/workspace/skills/ieee-meeting-report/scripts/fetch_workspace.sh \
  push <node-name> ./company_contributions.png "<remote-folder>"
```

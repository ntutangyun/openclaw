---
name: ieee-meeting-report
description: "Produce an IEEE 802.11 Meeting Participation Report (Markdown) at one of three depths — Basic (factual extraction), Analytical (mid-level reasoning + cross-cutting themes + organizational impact), or Strategic (research-enhanced intelligence with competitive matrices and tiered recommendations) — from working-group and standing-committee documents (AIML SC, TGbn, TGbf, EHT, UHR, etc.). Use when the user asks to generate, write, fill, or draft a meeting report, plenary report, interim report, or participation report from a folder of IEEE 802.11 documents (agenda, opening snapshot, closing report, meeting minutes, technical contributions in .pptx/.docx). Output is Markdown (.md) — the user can convert to Word later if needed. Trigger phrases per level: BASIC — 'basic meeting report', 'basic report', 'fill the meeting report template', 'follow basic_guidelines.md'; ANALYTICAL — 'analytical report', 'mid-level report', 'analytical meeting report', 'follow mid_guidelines.md'; STRATEGIC — 'strategic report', 'strategic intelligence report', 'complex report', 'follow complex_guidelines.md'. Generic phrases like 'IEEE plenary report' / 'AIML SC report' default to BASIC unless the user names a different depth."
---

# IEEE 802.11 Meeting Report (Basic / Analytical / Strategic)

Produce an IEEE 802.11 Meeting Participation Report as **Markdown** from a workspace folder of session documents. This skill supports three depths — Basic (factual extraction), Analytical (reasoning + themes + impact), and Strategic (research-enhanced intelligence). The agent drives the narrative work; this skill handles the mechanical file-access and document-extraction steps. Steps 0–3 and Step 6 are common to all three levels; Step 4 (chart) is Basic-only, and Step 5 branches per level.

**Output format is always Markdown (`.md`)** — not Word, regardless of level. Small locally-hosted models (≤10B parameters) cannot reliably generate the python-docx code needed to fill a `.docx` template; Markdown text editing keeps the work in-modality. If the user needs a `.docx`, produce the `.md` first, then offer to convert with pandoc in a separate step.

## Skill paths (absolute — always use these)

- **Skill root:** `/home/node/.openclaw/workspace/skills/ieee-meeting-report/`
- **Templates** (pick exactly one per the level you decide on — see "Report level" below):
  - Basic: `/home/node/.openclaw/workspace/skills/ieee-meeting-report/assets/Template_Basic_Meeting_Report.md`
  - Analytical: `/home/node/.openclaw/workspace/skills/ieee-meeting-report/assets/Template_MidLevel_Meeting_Report.md`
  - Strategic: `/home/node/.openclaw/workspace/skills/ieee-meeting-report/assets/Template_Complex_Strategic_Report.md`
- **Scripts:** `/home/node/.openclaw/workspace/skills/ieee-meeting-report/scripts/{fetch_workspace.sh,extract_all.sh,build_chart.sh}` — invoke every script with `bash <path>`. The two `.sh` wrappers delegate to the underlying `extract_all.py` / `build_chart.py` with the correct Python interpreter, so **you never need to run the `.py` files directly and must NOT prefix them with `bash`** (a Python file run under bash fails with `syntax error near unexpected token '('`).
- **References:** `/home/node/.openclaw/workspace/skills/ieee-meeting-report/references/aiml-sc-notes.md`

## Agent working directory

Your `exec` tool runs in `/home/node/.openclaw/workspace/`. All relative paths like `./input`, `./_extracted`, `./Report_*.md` resolve inside that directory. **Never prefix with `./workspace/`** — that double-nests the path and breaks subsequent reads.

## Hard rules for this task

- The tools you need for this task are `read`, `write`, `exec`, and `process` (for long-running `exec`). `read` + `write` alone cover Steps 3 and 5. Do the entire task yourself in this session — the user is watching the chat turn by turn.
- **Do NOT write your own extractor, parser, or helper script.** The `.pptx`/`.docx` → Markdown extraction is done by `extract_all.sh` (which calls markitdown under the hood). Do not write a new `extract_*.py`, `convert_*.py`, or similar, and do not `pip install python-pptx`, `python-docx`, `pptx`, or any other Office-parsing library. Every time you have reached for a fresh Python script instead of the three entrypoints below, you have wasted 3–5 minutes and produced worse extractions than markitdown. If `extract_all.sh` fails, report the failure — do not roll your own.
- **Only three entrypoint scripts are meant to be invoked, all via `bash <path>`:**
  `fetch_workspace.sh`, `extract_all.sh`, `build_chart.sh`.
  The same directory also contains `extract_all.py` and `build_chart.py` — those are the implementations that the `.sh` wrappers delegate to with the correct Python interpreter. **Never invoke the `.py` files directly, and NEVER prefix them with `bash`** — that fails with `syntax error near unexpected token '('` because bash cannot parse a Python docstring. Always invoke the `.sh` wrapper.
  Do not invent or invoke any other name (e.g. `generate_report.py`, `synthesize.py`, `fill_template.py`, `check_report.py`). **If a synthesis or verifier script appears to be missing, it is not missing — the synthesis is YOUR job, done via `read` + `write`.**
- **You MUST `read` the minutes file, the agenda file, the closing report, and every technical contribution in `./_extracted/` before you produce a `write` to `./Report_*.md`.** Reading `./_extracted/_summary.txt` is not a substitute. Without reading the source documents, you will fabricate motion numbers, DCNs, author names, affiliations, and Q&A — which is a task failure, not a stylistic choice. Reading only the minutes produces a plausible-but-thin report whose §3 agenda and §5 key-points are ungrounded; that also counts as a failure.
- Use `exec` (not `read`) for any path under `/home/<user>/...` or anything described as being on a remote node.
- Never fabricate motion numbers, DCNs, author names, or Q&A content. If the minutes do not state it, leave it empty and note the gap briefly.
- For BASIC, no opinions outside the Section 5 **Comments** column. ANALYTICAL and STRATEGIC require analysis throughout (clearly that is the point) — but every analytical claim must trace back to a specific meeting document or, in STRATEGIC, an external source you cite. Do not editorialize without grounding.
- Do not include IEEE patent / copyright / IPR boilerplate slides in the report.

## Report level — pick exactly one before Step 0

Map the user's wording to one of the three levels and remember which template you'll use. If the user is ambiguous, default to BASIC and ask only if the inputs clearly demand more depth.

| User says… | Level | Template file (under `assets/`) | Output filename |
| --- | --- | --- | --- |
| "basic report", "basic meeting report", "fill the template", `follow basic_guidelines.md` | **BASIC** | `Template_Basic_Meeting_Report.md` | `Report_Basic_<Meeting>_<Date>.md` |
| "analytical report", "mid-level report", "analytical meeting report", `follow mid_guidelines.md` | **ANALYTICAL** | `Template_MidLevel_Meeting_Report.md` | `Report_Analytical_<Meeting>_<Date>.md` |
| "strategic report", "strategic intelligence report", "complex report", `follow complex_guidelines.md` | **STRATEGIC** | `Template_Complex_Strategic_Report.md` | `Report_Strategic_<Meeting>_<Date>.md` |

Generic phrases like "IEEE plenary report" or "AIML SC report" default to **BASIC**.

What changes per level:

- **BASIC** — the simplest depth. Step 4 (company-contribution chart) IS required. Section 5 is a single table with one row per presentation. Output filename starts with `Report_Basic_`.
- **ANALYTICAL** — adds TOC, narrative §3 proceedings overview, per-presentation deep dive (one `## 5.N` subsection each, with Summary + Q&A theme synthesis + maturity table), cross-cutting themes (§6), organizational impact assessment (§7), recommended actions table (§8.2), and Appendices A (doc reference) + B (full Q&A log). **No chart.** Output filename starts with `Report_Analytical_`.
- **STRATEGIC** — everything in ANALYTICAL plus §3 cross-SDO context (3GPP / WBA / WFA / vendor positioning), competitive intelligence matrix (§7), risk + opportunity tables (§8), tiered recommendations (§9 — Immediate / Short-term / Long-term), next-meeting intelligence preview (§10), and Appendices A–D (D is a glossary). **Many sub-sections require internet research** (clearly marked in the template with "REQUIRES INTERNET SEARCH"). If no web-search tool is available in the current OpenClaw environment, write `[Research not available — external sources could not be consulted]` in those sections rather than fabricating findings, and note the limitation in §1. **No chart.** Output filename starts with `Report_Strategic_`.

## Step 0 — Decide where the inputs live

- **Remote node** (most common) — the user's `.pptx`/`.docx` live on a named OpenClaw node. The node can be Linux (paths look like `/home/<user>/...`) or Windows (paths look like `C:\Users\<user>\...`). Any path the user describes as being "on <node>" is REMOTE and you CANNOT read it with the local `read` tool — pull it first. Use the exact node name and path the user gave; if unsure about the node name, run `exec openclaw nodes status` on the gateway to list available nodes.
- **Gateway workspace** (rare) — already under `/home/node/.openclaw/workspace/`. Skip Step 1 and point `extract_all.sh` at that folder.

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
bash /home/node/.openclaw/workspace/skills/ieee-meeting-report/scripts/extract_all.sh \
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

## Step 4 — Render the company-contribution chart (BASIC LEVEL ONLY)

**Skip this step entirely for ANALYTICAL and STRATEGIC.** Those templates do not embed a chart. Only the Basic template's § 5 references `./company_contributions.png`, and if you generate one for analytical/strategic you'll waste 30+ seconds on a PNG no template references.

For BASIC, you MUST run `build_chart.sh` before Step 5. The template's § 5 embeds `./company_contributions.png`; if that file does not exist, Step 6b will fail with "local source does not exist" and the remote report will have a broken image link.

```bash
bash /home/node/.openclaw/workspace/skills/ieee-meeting-report/scripts/build_chart.sh \
  --affiliations "Qualcomm,Nokia,DeepSig,Intel" \
  --title "Presentations by contributing company (<Meeting> <Date>)" \
  --out ./company_contributions.png
```

Pass one `--affiliations` entry per presentation (duplicates allowed — that is how the script counts). The script picks a bar chart when there are more than 6 companies, pie otherwise, and saves a 150-DPI PNG. First run installs matplotlib into `~/.skill-venv` (takes ~30 s); subsequent runs are instant.

After the script exits, verify the PNG exists with `ls -l ./company_contributions.png` before moving on. Do not proceed to Step 5 without the file on disk.

## Step 5 — Fill the Markdown template (level-specific)

**Read the template first** using the absolute path for the level you picked in "Report level". Use the path **verbatim** — do NOT prefix it with `./_extracted/`, `./input/`, or any working-directory path. If the first `read` returns ENOENT, re-check the path (it must start with `/home/node/.openclaw/workspace/skills/`) and retry. Do NOT skip this step and try to reconstruct the template from memory — that is how heading-level violations and duplicated-DCN subsection titles sneak into the output.

Then produce the filled report with a single `write` tool call to the per-level filename (see "Report level"). **Do not invent a new structure** — preserve every heading, every table header, and any image references from the template you read.

Apply the checklist for your chosen level — only ONE of 5.A / 5.B / 5.C applies per run.

### Step 5.A — BASIC checklist

Read `assets/Template_Basic_Meeting_Report.md`. Output to `./Report_Basic_<Meeting>_<Date>.md` (e.g. `./Report_Basic_AIML_SC_March2026_Plenary.md`). All of the following must be true in the output:

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

### Step 5.B — ANALYTICAL checklist

Read `assets/Template_MidLevel_Meeting_Report.md`. Output to `./Report_Analytical_<Meeting>_<Date>.md` (e.g. `./Report_Analytical_AIML_SC_March2026_Plenary.md`). All of the following must be true in the output:

1. **All 8 top-level section headings present, verbatim and in order:**
   - `# Table of Contents`
   - `# 1. Executive Summary`
   - `# 2. Meeting Information`
   - `# 3. Agenda and Proceedings Overview`
   - `# 4. Motions and Governance Actions`
   - `# 5. Technical Contributions — Detailed Analysis`
   - `# 6. Cross-Cutting Technical Themes`
   - `# 7. Organizational Impact Assessment`
   - `# 8. Next Meeting & Recommended Actions`
   - **plus** `# Appendix A: Document Reference List` and `# Appendix B: Full Q&A Log`.
2. **Cover-page key/value lines all filled** (7 labels, same as BASIC).
3. **TOC** lists each section heading (a flat numbered list of titles is fine).
4. **§ 1 Executive Summary**: a single cohesive paragraph of **150–200 words** covering meeting context, volume of technical work, key governance decisions, the dominant technical theme, and a one-sentence outlook. Word count is the discriminator from BASIC.
5. **§ 2 Meeting Information**: a 2-column table (`Field | Value`) with all 8 fields populated (`Committee`, `Meeting Type`, `Session/Slot`, `Location`, `Chair`, `Vice Chair(s)`, `Secretary`, `Key Documents`).
6. **§ 3 Agenda and Proceedings Overview** is **narrative prose**, not a table. 1–3 paragraphs describing how the session actually unfolded (time pressure, deviations from agenda, tone).
7. **§ 4 Motions and Governance Actions** is a Markdown table with header `| Motion # | Description | Mover | Second | Result | Significance |`. The `Significance` column must be populated for every row (e.g. "Routine — minutes approval" / "Substantive — authorizes liaison with WBA").
8. **§ 5 Technical Contributions — Detailed Analysis** has **one `## 5.N` subsection per technical contribution**. Each subsection contains, in this exact order:
   - `**Author / Affiliation:** ...` and `**Document Number:** ...` lines
   - `### Summary` — 2–3 paragraphs
   - `### Discussion & Q&A Analysis` — thematic synthesis (NOT raw Q&A — raw Q&A goes in Appendix B)
   - `### Assessment` — a 4-row table with header `| Dimension | Rating | Notes |` covering Technical Maturity, Standards Readiness, Industry Support, Relevance to Our Org. Each rating is one of `Early / Developing / Mature`.
9. **§ 6 Cross-Cutting Technical Themes**: 3–5 `## 6.N` subsections, each themed across at least two presentations. A "theme" that only references one contribution is not cross-cutting — drop it.
10. **§ 7 Organizational Impact Assessment** is a Markdown table with header `| Topic | Impact Level | Opportunity / Risk | Recommended Action |`. Every row must trace back to a specific topic from the meeting; no generic industry-level rows.
11. **§ 8.1 Next Meeting Plans** has 4 labelled lines filled (`Next Meeting`, `Teleconference`, `Submission Deadline`, `Expected Focus Areas`). **§ 8.2 Recommended Actions for Our Organization** is a 5-column table (`# | Recommended Action | Priority | Suggested Owner | Timeline`) with 3–5 rows, every row tied to a specific meeting observation.
12. **Appendix A** is a 4-column table (`DCN | Title | Author | Type`) listing every input document. **Appendix B** has one `## B.N <Title> (<DCN>)` subsection per presentation with Q&A, with bulleted `- Q: ...` / `- A: ...` pairs (H2 like the BASIC §6 — same H2 rule as 5.A point 9).
13. **Every `> **AGENT INSTRUCTION:** ...` blockquote is removed.** **Zero `*[...]*` or `*[e.g.,...]*` placeholders remain.**
14. **No company-contributions chart reference** — that is a BASIC-only artifact and must not appear in an Analytical report.

### Step 5.C — STRATEGIC checklist

Read `assets/Template_Complex_Strategic_Report.md`. Output to `./Report_Strategic_<Meeting>_<Date>.md` (e.g. `./Report_Strategic_AIML_SC_March2026_Plenary.md`). All of the following must be true in the output:

1. **All 10 top-level sections + 4 appendices present, verbatim and in order:**
   - `# Table of Contents`
   - `# 1. Strategic Executive Brief`
   - `# 2. Meeting Information & Context`
   - `# 3. Industry Landscape & Cross-SDO Context`
   - `# 4. Proceedings, Motions & Governance`
   - `# 5. Technical Contributions — Strategic Deep Dive`
   - `# 6. Thematic Intelligence Analysis`
   - `# 7. Competitive Intelligence Matrix`
   - `# 8. Strategic Risk & Opportunity Assessment`
   - `# 9. Strategic Recommendations & Action Plan`
   - `# 10. Next Meeting Intelligence Preview`
   - `# Appendix A: Document Reference List`
   - `# Appendix B: Full Q&A Log with Attribution`
   - `# Appendix C: External Research Sources`
   - `# Appendix D: Glossary & Acronyms`
2. **Cover-page key/value lines all filled** (7 labels, same as BASIC/ANALYTICAL).
3. **§ 1 Strategic Executive Brief**: 200–300 words, contextualizing this meeting within the 802.11bn / Wi-Fi 9 cycle, competitive dynamics, and other-SDO trends. Followed by a `> **KEY STRATEGIC TAKEAWAYS**` blockquote with exactly 3 numbered bullets, each one sentence.
4. **§ 2 Meeting Information & Context** is a 2-column table with **9 rows** — the 8 ANALYTICAL rows PLUS a `Standards Cycle Context` row that situates this meeting in the broader 802.11bn timeline (REQUIRES INTERNET SEARCH).
5. **§ 3 Industry Landscape & Cross-SDO Context** has all 4 subsections (`## 3.1 3GPP AI/ML Parallel Work`, `## 3.2 WBA AI/ML Report & Liaison`, `## 3.3 Wi-Fi Alliance & Industry Roadmap`, `## 3.4 Vendor Strategic Positioning`). § 3.4 contains a 5-column table (`Company | Role in AIML SC | Known AI/ML Wi-Fi Strategy | Recent Moves | Assessment`).
6. **§ 4** is a 6-column motions table (`Motion # | Description | Mover | Second | Result | Strategic Note`) followed by a narrative paragraph on meeting flow and governance signals.
7. **§ 5 Strategic Deep Dive**: one `## 5.N` per contribution, each with `### Technical Summary`, `### Discussion Themes & Sentiment Analysis`, `### External Context & Comparison`, and `### Maturity & Impact Assessment`. The maturity table has **6 rows × 4 columns** (`Dimension | Rating | Evidence | Trend`) — Technical Maturity, Standards Readiness, Industry Support, Competitive Threat Level, Collaboration Opportunity, Alignment with Our Roadmap. Rating ∈ `Low/Medium/High`; Trend ∈ `Rising/Stable/Declining` (or `N/A — first appearance`).
8. **§ 6 Thematic Intelligence Analysis**: 4–6 `## 6.N` subsections, each with the FOUR sub-subsections `### Meeting Observations`, `### Industry Context`, `### Projected Trajectory`, `### Strategic Implication` — all four required per theme.
9. **§ 7 Competitive Intelligence Matrix** is a 6-column table (`Organization | AIML SC Role | Key Proposals | Strategic Direction | Threat Level | Collaboration Potential`) covering every active organization.
10. **§ 8** has both `## 8.1 Risks` (4-column table: `Risk | Likelihood | Impact | Mitigation Strategy`) and `## 8.2 Opportunities` (4-column table: `Opportunity | Strategic Value | Required Investment | Recommended Approach`).
11. **§ 9** has all three tiers as separate subsections with their distinct table shapes:
    - `## 9.1 Immediate Actions (Before Next Meeting)` — `# | Action | Justification | Owner | Deadline`
    - `## 9.2 Short-Term Strategic Positions (Next 2–3 Meetings)` — `# | Strategic Position | Supporting Evidence | Resources Needed`
    - `## 9.3 Long-Term Strategic Initiatives (12-Month Horizon)` — `# | Initiative | Strategic Rationale | Expected Outcome | Investment`
12. **§ 10 Next Meeting Intelligence Preview** has 4 labelled lines: `Next Meeting`, `Expected Submissions`, `Predicted Key Topics`, `Our Preparation Plan`.
13. **Appendix A** is a 5-column table (`DCN | Title | Author | Type | Link`). **Appendix B** has one `## B.N <Title> (<DCN>)` per Q&A presentation with `- Q (<Speaker>): ...` / `- A (<Speaker>): ...` (attribution where the minutes provide it; blank otherwise — never guess). **Appendix C** is a 4-column table (`Source | URL | Date | Relevance`) listing every external source cited; if no internet search was performed, write `No external sources consulted — research-dependent sections rely solely on meeting documents.` instead of an empty table. **Appendix D** is a 2-column glossary covering every acronym used in the report.
14. **Every `> **AGENT INSTRUCTION:** ...` blockquote is removed.** The `> **KEY STRATEGIC TAKEAWAYS**` blockquote in §1 is the ONE blockquote that stays — it is content, not an instruction. **Zero `*[...]*` or `*[e.g.,...]*` placeholders remain.**
15. **No company-contributions chart reference** — STRATEGIC does not use one.
16. **Research-section honesty**: every claim made in `§ 1`, `§ 2 Standards Cycle Context`, `§ 3`, `§ 5 External Context`, `§ 6 Industry Context`, `§ 7`, `§ 8`, `§ 9` that comes from external research must be backed by an entry in Appendix C (with URL and date). If you had no web tool, the explicit `[Research not available — external sources could not be consulted]` placeholder is acceptable in those sections; fabricated findings are not.

## Step 5.5 — Self-check before pushing

Re-read your own `./Report_<Level>_*.md` before Step 6 and confirm, by eye, that:

- All top-level section headings are present in order (per the level-specific checklist you applied — 7 for BASIC, 8+2 appendices for ANALYTICAL, 10+4 appendices for STRATEGIC).
- The motions list matches what you actually saw in the meeting's minutes file (`*-<session-name>-meeting-minutes.md`) — motion numbers, movers, and seconders must be verbatim from THAT session's minutes, not from a different session's. (The #1 way this task fails is pulling motions from prior-session minutes that the current minutes merely reference.)
- Presentation rows / per-presentation subsections only contain DCNs, authors, affiliations, and Q&A that actually appear in the extracted Markdown files you read in Step 3b.
- No `*[...]*` placeholders remain. No `> **AGENT INSTRUCTION:** ...` blockquotes remain (the STRATEGIC `KEY STRATEGIC TAKEAWAYS` blockquote in §1 is the only one that stays — and only for STRATEGIC).
- For BASIC only: the chart image reference is present in § 5 and `./company_contributions.png` exists in the working directory (from Step 4).
- For STRATEGIC only: every research claim is backed by an Appendix C row, OR the explicit `[Research not available — ...]` placeholder is in place where needed.

If anything is off, fix it with a fresh `write` (full-file rewrite; avoid `edit` for large rewrites) before pushing. For BASIC, if you never ran Step 4, go back and run it — do not push a report whose § 5 chart reference points at a missing file.

## Step 6 — Push the artifacts back to the node

Substitute the per-level filename you wrote in Step 5 — `Report_Basic_*.md`, `Report_Analytical_*.md`, or `Report_Strategic_*.md`.

**6a. Push the report (always required):**

```bash
bash /home/node/.openclaw/workspace/skills/ieee-meeting-report/scripts/fetch_workspace.sh \
  push <node-name> ./Report_<Level>_<Meeting>_<Date>.md "<remote-folder>"
```

**6b. Push the chart PNG (BASIC LEVEL ONLY — skip for ANALYTICAL / STRATEGIC):**

The Basic template's § 5 references the chart by relative path; if you push only the `.md`, the image will be broken on the remote side. ANALYTICAL and STRATEGIC reports do not embed a chart, so step 6b does not apply — push only the `.md`.

```bash
bash /home/node/.openclaw/workspace/skills/ieee-meeting-report/scripts/fetch_workspace.sh \
  push <node-name> ./company_contributions.png "<remote-folder>"
```

The task is complete when:
- BASIC: both 6a (the `Report_Basic_*.md`) and 6b (the chart PNG) succeed. In your final summary, explicitly confirm both were pushed.
- ANALYTICAL: 6a (`Report_Analytical_*.md`) succeeds. Confirm in your summary.
- STRATEGIC: 6a (`Report_Strategic_*.md`) succeeds. Confirm in your summary; if any sections were filled with the `[Research not available — ...]` placeholder, mention that explicitly so the user knows the report is research-degraded.

If you skip 6b on a BASIC run, the report opens with a broken image link — do not skip.

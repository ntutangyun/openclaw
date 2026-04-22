#!/usr/bin/env python3
"""
check_report.py — validate a filled Basic Meeting Participation Report
against the skill's structural contract.

Usage:
    /opt/python-tools/bin/python check_report.py <path-to-Report_Basic_*.md>

Exits 0 when all checks pass, 1 otherwise. Prints a PASS/FAIL per check so
the agent can see exactly which invariants were violated and fix them with
a second `write` pass.

The checks encode what the template at
  assets/Template_Basic_Meeting_Report.md
requires, so this script is the authoritative enforcement of "does the
produced report actually follow the template".
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path


SECTION_HEADINGS = [
    "# 1. Executive Summary",
    "# 2. Meeting Information",
    "# 3. Agenda Overview",
    "# 4. Motions and Votes",
    "# 5. Presentations",
    "# 6. Questions & Answers Summary",
    "# 7. Next Meeting & Action Items",
]

COVER_PAGE_LABELS = [
    "**Meeting:**",
    "**Location:**",
    "**Date(s):**",
    "**Report Prepared By:**",
    "**Date of Report:**",
    "**Distribution:**",
    "**Classification:**",
]

MEETING_INFO_LABELS = [
    "**Committee:**",
    "**Meeting Type:**",
    "**Session:**",
    "**Chair:**",
    "**Vice Chair(s):**",
    "**Secretary:**",
    "**Agenda Document:**",
    "**Motion Booklet:**",
]

NEXT_MEETING_LABELS = [
    "**Next Meeting:**",
    "**Teleconference Planned:**",
    "**Contribution Deadline:**",
    "**Expected Topics:**",
]

AGENDA_TABLE_COLS = ["#", "Agenda Item", "Status"]
MOTIONS_TABLE_COLS = ["Motion #", "Description", "Mover", "Second", "Result"]
PRESENTATIONS_TABLE_COLS = ["DCN", "Title", "Author", "Affiliation", "Key points", "Comments"]


@dataclass
class CheckResult:
    name: str
    passed: bool
    detail: str = ""


def has_table_with_header(body: str, required_cols: list[str]) -> tuple[bool, str]:
    """
    Return (ok, detail) indicating whether the body contains a Markdown table
    whose header row contains all of required_cols (case-insensitive,
    whitespace-tolerant, markdown-formatting-stripped).
    """
    def normalize(cell: str) -> str:
        # strip leading/trailing pipe noise, bold/italic markers, whitespace
        s = cell.strip()
        s = re.sub(r"^[*_]+|[*_]+$", "", s)
        return s.strip().lower()

    required_norm = [c.lower() for c in required_cols]
    for line in body.splitlines():
        stripped = line.strip()
        if not stripped.startswith("|") or not stripped.endswith("|"):
            continue
        cells = [normalize(c) for c in stripped.split("|")[1:-1]]
        if all(any(req == cell or req in cell for cell in cells) for req in required_norm):
            return True, f"header row: {stripped[:160]}"
    return False, f"no table found with columns {required_cols}"


def run_checks(body: str) -> list[CheckResult]:
    results: list[CheckResult] = []

    # 1) All 7 section headings present, in order.
    indices = []
    cursor = 0
    missing = []
    out_of_order = False
    for heading in SECTION_HEADINGS:
        idx = body.find(heading, cursor)
        if idx < 0:
            # Try loose match (the heading may have extra whitespace or different case)
            loose_pattern = "^" + re.escape(heading).replace(r"\ ", r"[ \t]+") + r"\s*$"
            loose = re.search(loose_pattern, body, re.M)
            if loose and loose.start() >= cursor:
                idx = loose.start()
        if idx < 0:
            missing.append(heading)
            continue
        if indices and idx < indices[-1]:
            out_of_order = True
        indices.append(idx)
        cursor = idx + len(heading)
    if missing:
        results.append(CheckResult("sections_all_present", False, f"missing: {missing}"))
    elif out_of_order:
        results.append(CheckResult("sections_in_order", False, "section headings appear out of order"))
    else:
        results.append(CheckResult("sections_all_present", True, f"7/7 in order"))

    # 2) Cover-page labels.
    cover_missing = [lbl for lbl in COVER_PAGE_LABELS if lbl not in body]
    results.append(CheckResult(
        "cover_page_labels",
        not cover_missing,
        f"missing: {cover_missing}" if cover_missing else "7/7 labels present",
    ))

    # 3) Meeting Information labels (in § 2 region).
    mi_missing = [lbl for lbl in MEETING_INFO_LABELS if lbl not in body]
    results.append(CheckResult(
        "meeting_info_labels",
        not mi_missing,
        f"missing: {mi_missing}" if mi_missing else "8/8 labels present",
    ))

    # 4) Next-meeting labels.
    nm_missing = [lbl for lbl in NEXT_MEETING_LABELS if lbl not in body]
    results.append(CheckResult(
        "next_meeting_labels",
        not nm_missing,
        f"missing: {nm_missing}" if nm_missing else "4/4 labels present",
    ))

    # 5) Three data tables present with correct headers.
    for label, cols in [
        ("agenda_table", AGENDA_TABLE_COLS),
        ("motions_table", MOTIONS_TABLE_COLS),
        ("presentations_table", PRESENTATIONS_TABLE_COLS),
    ]:
        ok, detail = has_table_with_header(body, cols)
        results.append(CheckResult(label, ok, detail))

    # 6) Chart image reference present (any PNG under company_contributions).
    has_chart = bool(re.search(r"!\[[^\]]*\]\([^)]*company_contributions\.png[^)]*\)", body))
    results.append(CheckResult(
        "chart_image_reference",
        has_chart,
        "![...](./company_contributions.png) found" if has_chart
        else "no image reference to company_contributions.png",
    ))

    # 7) § 6 Q&A has at least one `## 6.` subsection.
    qa_subheadings = re.findall(r"^##\s*6\.[0-9]", body, re.M)
    results.append(CheckResult(
        "qa_subsections",
        len(qa_subheadings) >= 1,
        f"{len(qa_subheadings)} Q&A subsection(s) (## 6.N)",
    ))

    # 8) No leftover placeholders.
    placeholders = re.findall(r"\*\[e\.g\.,[^\]]*\]\*|\*\[\.\.\.]\*", body)
    results.append(CheckResult(
        "no_placeholders",
        len(placeholders) == 0,
        f"found {len(placeholders)} leftover *[...]* placeholders" if placeholders else "none",
    ))

    # 9) No leftover AGENT INSTRUCTION blockquotes.
    instr_blocks = re.findall(r"AGENT INSTRUCTION", body)
    results.append(CheckResult(
        "no_instruction_blocks",
        len(instr_blocks) == 0,
        f"found {len(instr_blocks)} 'AGENT INSTRUCTION' occurrence(s)" if instr_blocks else "none",
    ))

    # 10) Length sanity — a real filled report is at least ~2 KB.
    size = len(body.encode("utf-8"))
    results.append(CheckResult(
        "size_sanity",
        size >= 2000,
        f"{size} bytes",
    ))

    return results


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__ or "")
    ap.add_argument("path", help="Path to the filled Basic Meeting Report Markdown file")
    ap.add_argument(
        "--strict",
        action="store_true",
        help="Treat warnings as errors (currently equivalent to default behavior)",
    )
    args = ap.parse_args()

    p = Path(args.path).expanduser().resolve()
    if not p.is_file():
        print(f"check_report: file not found: {p}", file=sys.stderr)
        return 2

    body = p.read_text(encoding="utf-8")
    results = run_checks(body)

    passed = sum(1 for r in results if r.passed)
    total = len(results)

    print(f"check_report: {p}")
    print(f"{'='*70}")
    for r in results:
        mark = "PASS" if r.passed else "FAIL"
        print(f"  [{mark}] {r.name:30s} {r.detail}")
    print(f"{'='*70}")
    print(f"Result: {passed}/{total} checks passed")

    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())

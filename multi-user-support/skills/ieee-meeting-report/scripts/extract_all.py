#!/usr/bin/env python3
"""
extract_all.py — convert every .pptx / .docx / .xlsx / .md / .txt in a folder
to Markdown using markitdown.

Run it inside the OpenClaw gateway container:

    /opt/python-tools/bin/python extract_all.py --input <src> --output <dst>

Writes one `<basename>.md` per input file plus a manifest/summary. Skips files
whose mtime is older than the existing output (incremental by default).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
import traceback
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Iterable

SUPPORTED_SUFFIXES = {
    ".pptx", ".docx", ".xlsx", ".xls", ".ppt", ".doc",
    ".pdf", ".md", ".txt", ".html", ".htm", ".csv",
}


@dataclass
class ConversionResult:
    input: str
    output: str | None
    bytes_in: int
    bytes_out: int | None
    duration_s: float
    ok: bool
    error: str | None = None


@dataclass
class Manifest:
    generated_at: str
    input_dir: str
    output_dir: str
    converted: list[ConversionResult] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)
    failures: list[ConversionResult] = field(default_factory=list)


def md_converter():
    try:
        from markitdown import MarkItDown  # type: ignore
    except ImportError as e:
        print(
            "ERROR: markitdown not installed in this Python.\n"
            "Use /opt/python-tools/bin/python (which has markitdown, python-docx, python-pptx).",
            file=sys.stderr,
        )
        raise SystemExit(2) from e
    return MarkItDown()


def iter_input_files(input_dir: Path) -> Iterable[Path]:
    for path in sorted(input_dir.rglob("*")):
        if path.is_file() and path.suffix.lower() in SUPPORTED_SUFFIXES:
            # skip any previously-generated artifacts
            if "_extracted" in path.parts:
                continue
            yield path


def sha8(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:8]


def output_name_for(src: Path, input_dir: Path) -> str:
    """
    Preserve the relative path inside input_dir so two files with the same
    basename in different subfolders don't collide.
    """
    rel = src.relative_to(input_dir)
    flat = "__".join(rel.with_suffix("").parts)
    return f"{flat}.md"


def is_up_to_date(src: Path, dst: Path) -> bool:
    try:
        return dst.exists() and dst.stat().st_mtime >= src.stat().st_mtime
    except OSError:
        return False


def convert_one(md, src: Path, dst: Path) -> ConversionResult:
    t0 = time.monotonic()
    try:
        result = md.convert(str(src))
        text = result.text_content or ""
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_text(text, encoding="utf-8")
        return ConversionResult(
            input=str(src),
            output=str(dst),
            bytes_in=src.stat().st_size,
            bytes_out=dst.stat().st_size,
            duration_s=round(time.monotonic() - t0, 3),
            ok=True,
        )
    except Exception as e:  # noqa: BLE001 — we want every failure captured
        return ConversionResult(
            input=str(src),
            output=None,
            bytes_in=src.stat().st_size if src.exists() else 0,
            bytes_out=None,
            duration_s=round(time.monotonic() - t0, 3),
            ok=False,
            error=f"{type(e).__name__}: {e}",
        )


def write_manifest(out_dir: Path, manifest: Manifest) -> None:
    manifest_path = out_dir / "_manifest.json"
    manifest_path.write_text(
        json.dumps(
            {
                "generated_at": manifest.generated_at,
                "input_dir": manifest.input_dir,
                "output_dir": manifest.output_dir,
                "converted": [asdict(c) for c in manifest.converted],
                "skipped": manifest.skipped,
                "failures": [asdict(f) for f in manifest.failures],
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    lines = [
        f"input:  {manifest.input_dir}",
        f"output: {manifest.output_dir}",
        f"converted: {len(manifest.converted)}",
        f"skipped:   {len(manifest.skipped)}",
        f"failures:  {len(manifest.failures)}",
        "",
        "Converted files:",
    ]
    for c in manifest.converted:
        lines.append(f"  - {Path(c.output).name}  ({c.duration_s:.2f}s, {c.bytes_out} bytes)")
    if manifest.skipped:
        lines.append("")
        lines.append("Skipped (already up to date):")
        for s in manifest.skipped:
            lines.append(f"  - {Path(s).name}")
    if manifest.failures:
        lines.append("")
        lines.append("Failures:")
        for f in manifest.failures:
            lines.append(f"  - {Path(f.input).name} — {f.error}")
    (out_dir / "_summary.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__ or "")
    ap.add_argument("--input", required=True, help="folder containing source documents")
    ap.add_argument("--output", required=True, help="where to write extracted .md files")
    ap.add_argument(
        "--force",
        action="store_true",
        help="re-extract even if an up-to-date .md already exists",
    )
    args = ap.parse_args()

    input_dir = Path(args.input).expanduser().resolve()
    output_dir = Path(args.output).expanduser().resolve()

    if not input_dir.is_dir():
        print(f"ERROR: input directory not found: {input_dir}", file=sys.stderr)
        return 2

    output_dir.mkdir(parents=True, exist_ok=True)

    md = md_converter()

    manifest = Manifest(
        generated_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        input_dir=str(input_dir),
        output_dir=str(output_dir),
    )

    for src in iter_input_files(input_dir):
        dst = output_dir / output_name_for(src, input_dir)
        if not args.force and is_up_to_date(src, dst):
            manifest.skipped.append(str(src))
            continue
        print(f"  -> {src.name}", flush=True)
        result = convert_one(md, src, dst)
        if result.ok:
            manifest.converted.append(result)
        else:
            manifest.failures.append(result)
            print(f"     FAILED: {result.error}", file=sys.stderr)

    write_manifest(output_dir, manifest)

    print()
    print(
        f"extract_all: {len(manifest.converted)} converted, "
        f"{len(manifest.skipped)} skipped, "
        f"{len(manifest.failures)} failed."
    )
    print(f"manifest: {output_dir / '_manifest.json'}")
    print(f"summary:  {output_dir / '_summary.txt'}")
    return 1 if manifest.failures and not manifest.converted else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
    except SystemExit:
        raise
    except Exception:
        traceback.print_exc()
        sys.exit(1)

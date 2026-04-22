#!/usr/bin/env python3
"""
build_chart.py — render a company-contribution chart (PNG) from a list of
presentation affiliations.

Usage:
    /opt/python-tools/bin/python build_chart.py \
        --affiliations "Qualcomm,Nokia,Qualcomm,Intel,DeepSig" \
        --title "Presentations by contributing company (March 2026 Plenary)" \
        --out ./workspace/company_contributions.png

Self-bootstraps matplotlib into ~/.skill-venv on first run (takes ~30 s),
then re-executes itself with that interpreter. Subsequent runs are instant.

Picks bar chart when there are more than 6 companies, pie otherwise.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path


VENV_DIR = Path.home() / ".skill-venv"
VENV_PY = VENV_DIR / "bin" / "python"


def _matplotlib_available_under(python: str) -> bool:
    result = subprocess.run(
        [python, "-c", "import matplotlib"],
        capture_output=True,
        text=True,
    )
    return result.returncode == 0


def ensure_matplotlib() -> None:
    """
    Guarantee that matplotlib is importable in this process.

    Strategy:
      1. If it imports directly, we're done.
      2. Otherwise, use ~/.skill-venv (creating it + installing matplotlib only
         if needed) and re-exec self under that interpreter.
    """
    try:
        import matplotlib  # noqa: F401
        return
    except ImportError:
        pass

    # Already re-execed under the venv and still missing? Bail hard.
    if os.environ.get("BUILD_CHART_BOOTSTRAPPED") == "1":
        print(
            f"ERROR: matplotlib still missing after bootstrap. "
            f"Install manually: {VENV_PY} -m pip install matplotlib",
            file=sys.stderr,
        )
        sys.exit(3)

    if not VENV_PY.exists():
        print(f"Creating venv at {VENV_DIR} (one-time, ~30 s)...", file=sys.stderr)
        try:
            subprocess.run(
                [sys.executable, "-m", "venv", "--system-site-packages", str(VENV_DIR)],
                check=True,
            )
        except subprocess.CalledProcessError as e:
            print(
                f"ERROR: could not create venv: {e}. "
                "Try running as the container's 'node' user.",
                file=sys.stderr,
            )
            sys.exit(4)

    if not _matplotlib_available_under(str(VENV_PY)):
        print("Installing matplotlib into venv...", file=sys.stderr)
        subprocess.run(
            [str(VENV_PY), "-m", "pip", "install", "--quiet", "matplotlib"],
            check=True,
        )

    # Re-exec self with the venv python so matplotlib is importable.
    env = dict(os.environ)
    env["BUILD_CHART_BOOTSTRAPPED"] = "1"
    os.execve(str(VENV_PY), [str(VENV_PY), __file__, *sys.argv[1:]], env)


def parse_affiliations(raw: str) -> list[str]:
    parts = [p.strip() for p in raw.split(",")]
    return [p for p in parts if p]


def render_chart(affiliations: list[str], out_path: Path, title: str) -> None:
    from collections import Counter

    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt  # noqa: E402

    counts = Counter(affiliations)
    if not counts:
        raise SystemExit("No affiliations provided — nothing to plot.")

    # Sort: most contributions first (stable for ties).
    ordered = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    labels = [name for name, _ in ordered]
    values = [n for _, n in ordered]
    total = sum(values)

    use_bar = len(labels) > 6

    if use_bar:
        fig, ax = plt.subplots(figsize=(8, 4.5))
        bars = ax.bar(labels, values, color="#2563eb")
        ax.set_ylabel("# Presentations")
        ax.set_title(title)
        ax.set_ylim(0, max(values) * 1.15 + 0.5)
        for bar, value in zip(bars, values):
            ax.text(
                bar.get_x() + bar.get_width() / 2,
                bar.get_height(),
                str(value),
                ha="center",
                va="bottom",
            )
        plt.xticks(rotation=30, ha="right")
        plt.tight_layout()
    else:
        fig, ax = plt.subplots(figsize=(6.5, 4.5))
        wedge_labels = [f"{name} ({count})" for name, count in zip(labels, values)]
        ax.pie(
            values,
            labels=wedge_labels,
            autopct=lambda p: f"{p * total / 100:.0f}",
            startangle=90,
            counterclock=False,
        )
        ax.set_title(title)
        ax.axis("equal")
        plt.tight_layout()

    out_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(str(out_path), dpi=150)
    plt.close(fig)


def main() -> int:
    ensure_matplotlib()

    ap = argparse.ArgumentParser(description=__doc__ or "")
    ap.add_argument(
        "--affiliations",
        required=True,
        help="Comma-separated list of affiliation strings, one per presentation. "
        "Duplicates are how multi-contribution companies get counted.",
    )
    ap.add_argument(
        "--out",
        required=True,
        help="Output PNG path (parent directories will be created).",
    )
    ap.add_argument(
        "--title",
        default="Presentations by contributing company",
        help="Chart title.",
    )
    args = ap.parse_args()

    affiliations = parse_affiliations(args.affiliations)
    out_path = Path(args.out).expanduser().resolve()
    render_chart(affiliations, out_path, args.title)

    from collections import Counter
    counts = Counter(affiliations)
    print(
        f"build_chart: {len(affiliations)} presentations across "
        f"{len(counts)} companies -> {out_path}"
    )
    for name, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0])):
        print(f"  {name}: {n}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

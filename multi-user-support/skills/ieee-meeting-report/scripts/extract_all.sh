#!/usr/bin/env bash
# extract_all.sh — thin bash wrapper that delegates to extract_all.py with the
# correct Python interpreter. See build_chart.sh for the rationale.

set -euo pipefail
exec /opt/python-tools/bin/python "$(dirname "$0")/extract_all.py" "$@"

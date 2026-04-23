#!/usr/bin/env bash
# build_chart.sh — thin bash wrapper that delegates to build_chart.py with the
# correct Python interpreter.
#
# Why this wrapper exists:
# Small local models (ollama/gemma4:e4b in particular) intermittently prefix
# skill scripts with `bash` regardless of file extension — pattern-matching on
# the `bash fetch_workspace.sh` invocation they already use. When the same
# pattern is applied to a Python file, bash fails parsing the docstring's `(`
# and the chart never renders. Exposing every skill entrypoint as a `.sh`
# wrapper means `bash skill.sh args` works uniformly and the agent can't pick
# the wrong interpreter.
#
# Direct invocation is also supported because the file is chmod +x and has a
# bash shebang:
#   ./build_chart.sh --affiliations "..." --out ./company_contributions.png

set -euo pipefail
exec /opt/python-tools/bin/python "$(dirname "$0")/build_chart.py" "$@"

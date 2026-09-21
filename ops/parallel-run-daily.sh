#!/bin/zsh
# ops/parallel-run-daily.sh — scheduler entrypoint for the daily parallel run.
#
# Reads the isolated dry-run database credentials from .env.dryrun (git-ignored,
# must point at a database whose name ends in _dryrun), runs `pnpm parallel-run`,
# appends the delta to a log and raises a macOS notification with the verdict.
#
# Installed by ops/com.scait.accommerce-parallel-run.plist (launchd, 07:30 local).
set -u
REPO_DIR="${REPO_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
LOG="${HOME}/Library/Logs/accommerce-parallel-run.log"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

cd "$REPO_DIR" || exit 2
if [[ ! -f .env.dryrun ]]; then
  echo "$(date '+%F %T') missing .env.dryrun in $REPO_DIR" >> "$LOG"
  exit 2
fi
set -a; source .env.dryrun; set +a

{
  echo "===== $(date '+%F %T') parallel run ($REPO_DIR)"
  pnpm parallel-run
  rc=$?
  echo "===== exit $rc"
} >> "$LOG" 2>&1

verdict="$(grep -m1 '^\*\*' docs/dryrun/latest.md 2>/dev/null | tr -d '*')"
/usr/bin/osascript -e "display notification \"${verdict:-run failed, see log}\" with title \"Accommerce parallel run\"" >/dev/null 2>&1 || true
exit $rc

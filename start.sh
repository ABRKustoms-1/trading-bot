#!/usr/bin/env bash
# Start the NQ Strategy Lab with one command: bash start.sh [PORT]
# Gets the latest code, installs packages if needed, downloads NQ data when it is
# missing or more than 12 hours old, stops any lab already running, then starts it.
cd "$(dirname "$0")"
PORT="${1:-8000}"

echo "==> Getting the latest code"
git pull --ff-only -q 2>/dev/null || echo "    (couldn't pull, using the code already here)"

echo "==> Checking Python packages"
python3 -c "import yfinance, pandas, numpy" 2>/dev/null || pip install -q -r requirements-lab.txt

DAILY=data/nq/nq_daily.csv
if [ ! -f "$DAILY" ] || [ -n "$(find "$DAILY" -mmin +720)" ]; then
  echo "==> Downloading NQ market data (takes a minute or two)"
  python3 fetch_nq.py > /dev/null || echo "    Download failed; the lab will use whatever is in data/nq/"
else
  echo "==> Market data is fresh (downloaded $(date -r "$DAILY" '+%b %d %H:%M'))"
fi

EVENTS=data/events.csv
if [ ! -f "$EVENTS" ] || [ -n "$(find "$EVENTS" -mtime +7)" ]; then
  echo "==> Downloading CPI / FOMC / jobs report dates"
  python3 fetch_events.py | head -6 || echo "    Couldn't download release dates; no-trade days will use the saved list"
fi

echo "==> Stopping any lab that is already running"
pkill -f "^python[0-9.]* .*serve_lab\.py" 2>/dev/null && sleep 1

echo "==> Starting the lab"
if [ -n "$CODESPACE_NAME" ]; then
  echo "    Open: https://$CODESPACE_NAME-$PORT.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
  echo "    (or the Ports tab -> port $PORT -> globe icon)"
fi
echo "    Press Ctrl+C to stop."
exec python3 serve_lab.py "$PORT"

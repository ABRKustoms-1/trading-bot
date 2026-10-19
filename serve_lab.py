"""Serve the NQ Strategy Lab and connect it to the downloaded data.

Usage: python serve_lab.py [PORT]   (default 8000), then open http://localhost:8000

The page loads every price CSV in data/nq/ automatically, its "Refresh data"
button re-runs fetch_nq.py to download the latest bars, and Pine Script
strategies you add in the page are saved as strategies/*.pine.
Only listens on localhost.
"""

import json
import os
import re
import subprocess
import sys
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PAGE = ROOT / "lab" / "nq_strategy_lab.html"
DATA = ROOT / "data" / "nq"
STRATEGIES = ROOT / "strategies"
SAFE_NAME = re.compile(r"^[a-z0-9_-]{1,80}$")
# Show daily NQ first, then other daily files, then intraday from slowest to fastest.
ORDER = ["nq_daily", "ndx_daily", "qqq_daily", "nq_1h", "nq_5m", "nq_1m"]


def price_files() -> list[Path]:
    """CSV files in data/nq/ that hold OHLC bars (skips summaries and FRED series)."""
    if not DATA.is_dir():
        return []
    files = []
    for f in DATA.glob("*.csv"):
        if f.stem.startswith("summary_") or f.stem.endswith("_drawdown"):
            continue
        with f.open() as fh:
            head = fh.readline().lower()
        if all(k in head for k in ("open", "high", "low", "close")):
            files.append(f)
    return sorted(files, key=lambda f: (ORDER.index(f.stem) if f.stem in ORDER else len(ORDER), f.stem))


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code: int = 200) -> None:
        self._send(code, json.dumps(obj).encode(), "application/json")

    def do_GET(self) -> None:
        if self.path in ("/", "/index.html"):
            html = PAGE.read_text(encoding="utf-8")
            build = subprocess.run(["git", "log", "-1", "--format=%h %cd", "--date=format:%b %d %H:%M"], cwd=ROOT,
                                   capture_output=True, text=True).stdout.strip() or "unknown"
            html = f'<script>window.LAB_BUILD = {json.dumps(build)};</script>' + html
            doc = ('<!doctype html><html lang="en"><head><meta charset="utf-8">'
                   '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'
                   f"</head><body>{html}</body></html>")
            return self._send(200, doc.encode(), "text/html; charset=utf-8")
        if self.path == "/pine.js":
            return self._send(200, (ROOT / "lab" / "pine.js").read_bytes(), "text/javascript; charset=utf-8")
        if self.path == "/api/events":
            f = ROOT / "data" / "events.csv"
            if not f.exists():
                return self._json([])
            with f.open() as fh:
                rows = [line.strip().split(",") for line in fh][1:]
            return self._json([{"date": r[0], "event": r[1], "time": r[2]} for r in rows if len(r) >= 3])
        if self.path == "/api/strategies":
            files = sorted(STRATEGIES.glob("*.pine")) if STRATEGIES.is_dir() else []
            return self._json([{"id": f"pine:{f.stem}", "code": f.read_text(encoding="utf-8")} for f in files])
        if self.path == "/api/datasets":
            return self._json([{"name": f.name, "size": f.stat().st_size, "modified": f.stat().st_mtime} for f in price_files()])
        if self.path.startswith("/api/data/"):
            name = self.path.removeprefix("/api/data/")
            match = next((f for f in price_files() if f.name == name), None)  # only files we listed
            if match is None:
                return self._json({"error": f"{name} not found"}, 404)
            return self._send(200, match.read_bytes(), "text/csv; charset=utf-8")
        self._json({"error": "not found"}, 404)

    def do_POST(self) -> None:
        if self.path == "/api/strategies":
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
                name, code = str(body["id"]).removeprefix("pine:"), str(body["code"])
            except (ValueError, KeyError):
                return self._json({"error": "expected JSON with id and code"}, 400)
            if not SAFE_NAME.match(name):
                return self._json({"error": f"bad strategy name {name!r}"}, 400)
            STRATEGIES.mkdir(exist_ok=True)
            (STRATEGIES / f"{name}.pine").write_text(code, encoding="utf-8")
            return self._json({"ok": True, "file": f"strategies/{name}.pine"})
        if self.path != "/api/refresh":
            return self._json({"error": "not found"}, 404)
        years = 10
        proc = subprocess.run([sys.executable, str(ROOT / "fetch_nq.py"), str(years)], cwd=ROOT,
                              capture_output=True, text=True, timeout=900)
        self._json({"ok": proc.returncode == 0, "output": (proc.stdout + proc.stderr)[-4000:]},
                   200 if proc.returncode == 0 else 500)

    def do_DELETE(self) -> None:
        name = self.path.removeprefix("/api/strategies/")
        if not self.path.startswith("/api/strategies/") or not SAFE_NAME.match(name):
            return self._json({"error": "not found"}, 404)
        (STRATEGIES / f"{name}.pine").unlink(missing_ok=True)
        self._json({"ok": True})

    def log_message(self, fmt, *args) -> None:
        sys.stderr.write("  " + fmt % args + "\n")


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    files = price_files()
    print(f"NQ Strategy Lab: http://localhost:{port}")
    print(f"  {len(files)} price files in {DATA}" if files else "  No data yet - click 'Refresh data' in the page, or run python fetch_nq.py")
    try:
        server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    except OSError as e:
        if e.errno in (48, 98):  # address already in use (macOS, Linux)
            sys.exit(f"Port {port} is already in use - the lab is probably still running in another terminal.\n"
                     f"Stop it with: bash start.sh (restarts it)   or start on another port: python serve_lab.py {port + 1}")
        raise
    if not os.environ.get("CODESPACES"):  # Codespaces opens the forwarded port itself
        webbrowser.open(f"http://localhost:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()

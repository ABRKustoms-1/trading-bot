"""Serve the NQ Strategy Lab and connect it to the downloaded data.

Usage: python serve_lab.py [PORT]   (default 8000), then open http://localhost:8000

The page loads every price CSV in data/nq/ automatically, and its
"Refresh data" button re-runs fetch_nq.py to download the latest bars.
Only listens on localhost.
"""

import json
import subprocess
import sys
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PAGE = ROOT / "lab" / "nq_strategy_lab.html"
DATA = ROOT / "data" / "nq"
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
            doc = ('<!doctype html><html lang="en"><head><meta charset="utf-8">'
                   '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'
                   f"</head><body>{html}</body></html>")
            return self._send(200, doc.encode(), "text/html; charset=utf-8")
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
        if self.path != "/api/refresh":
            return self._json({"error": "not found"}, 404)
        years = 10
        proc = subprocess.run([sys.executable, str(ROOT / "fetch_nq.py"), str(years)], cwd=ROOT,
                              capture_output=True, text=True, timeout=900)
        self._json({"ok": proc.returncode == 0, "output": (proc.stdout + proc.stderr)[-4000:]},
                   200 if proc.returncode == 0 else 500)

    def log_message(self, fmt, *args) -> None:
        sys.stderr.write("  " + fmt % args + "\n")


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    files = price_files()
    print(f"NQ Strategy Lab: http://localhost:{port}")
    print(f"  {len(files)} price files in {DATA}" if files else "  No data yet - click 'Refresh data' in the page, or run python fetch_nq.py")
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    webbrowser.open(f"http://localhost:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()

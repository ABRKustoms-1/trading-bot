"""Download US economic release dates into data/events.csv for the lab's no-trade days.

Usage: python fetch_events.py [START_YEAR]   (default 2016)

Sources (official, no API key):
  CPI, NFP (jobs report), PPI  - BLS news-release archives; each archived release is
                                 named like cpi_01112024.htm, which is its release date,
                                 plus the BLS schedule pages for upcoming releases
  FOMC                         - Federal Reserve: every rate-decision statement is
                                 monetaryYYYYMMDDa.htm, plus the calendar for upcoming meetings

Writes date,event,time_et rows (dates are US Eastern calendar days). If a source can't
be reached, the dates already in data/events.csv for that event are kept.
"""

import csv
import re
import sys
import urllib.request
from collections import Counter
from datetime import date
from pathlib import Path

OUT = Path("data/events.csv")
HEADERS = {  # bls.gov refuses requests without a browser-like user agent
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml",
    "Accept-Language": "en-US,en;q=0.9",
}
BLS = {"CPI": "cpi", "NFP": "empsit", "PPI": "ppi"}
TIMES = {"CPI": "08:30", "NFP": "08:30", "PPI": "08:30", "FOMC": "14:00"}
EXPECTED = {"CPI": 12, "NFP": 12, "PPI": 12, "FOMC": 8}  # per full year, for the coverage check
MONTHS = {m: i + 1 for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"])}


def get(url: str) -> str:
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "replace")


def bls_archive_dates(html: str, code: str) -> set[date]:
    """Release dates from archived file names like cpi_01112024.htm (MMDDYYYY)."""
    out = set()
    for mm, dd, yy in re.findall(rf"{code}_(\d{{2}})(\d{{2}})(\d{{4}})\.(?:htm|pdf)", html):
        try:
            out.add(date(int(yy), int(mm), int(dd)))
        except ValueError:
            pass
    return out


def bls_schedule_dates(html: str) -> set[date]:
    """Upcoming release dates from schedule tables: a 'Mon. D, YYYY' cell followed by an 08:30 AM cell."""
    out = set()
    for mon, dd, yy in re.findall(r"<td[^>]*>\s*([A-Z][a-z]{2,4})\.?\s+(\d{1,2}),\s+(\d{4})\s*</td>\s*<td[^>]*>\s*0?8:30\s*AM", html):
        m = MONTHS.get(mon[:3].lower())
        if m:
            out.add(date(int(yy), m, int(dd)))
    return out


def fomc_statement_dates(html: str) -> set[date]:
    """Decision days from statement links: monetary20240131a.htm (not implementation notes ...a1.htm)."""
    return {date(int(y), int(m), int(d)) for y, m, d in re.findall(r"monetary(\d{4})(\d{2})(\d{2})a\.htm", html)}


def fomc_calendar_dates(html: str) -> set[date]:
    """Scheduled meetings from the calendar page, e.g. '2026 FOMC Meetings' ... 'January' '27-28'.
    The decision is announced on the meeting's last day."""
    out = set()
    sections = re.split(r"(\d{4}) FOMC Meetings", html)
    for k in range(1, len(sections) - 1, 2):
        year, body = int(sections[k]), sections[k + 1]
        cells = re.findall(r'fomc-meeting__month[^>]*>\s*(?:<strong>)?\s*([A-Za-z/]+)\s*(?:</strong>)?.*?fomc-meeting__date[^>]*>\s*([\d\-]+)', body, re.S)
        for months, days in cells:
            last_month = months.split("/")[-1][:3].lower()
            last_day = days.split("-")[-1]
            if last_month in MONTHS and last_day.isdigit():
                try:
                    out.add(date(year, MONTHS[last_month], int(last_day)))
                except ValueError:
                    pass
    return out


def fetch_all(start_year: int) -> tuple[dict[str, set[date]], list[str]]:
    found: dict[str, set[date]] = {k: set() for k in TIMES}
    problems = []
    for event, code in BLS.items():
        try:
            found[event] |= bls_archive_dates(get(f"https://www.bls.gov/bls/news-release/{code}.htm"), code)
        except Exception as e:
            problems.append(f"{event} archive: {e}")
        try:
            found[event] |= bls_schedule_dates(get(f"https://www.bls.gov/schedule/news_release/{code}.htm"))
        except Exception as e:
            problems.append(f"{event} schedule: {e}")
    try:
        cal = get("https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm")
        found["FOMC"] |= fomc_statement_dates(cal) | fomc_calendar_dates(cal)
    except Exception as e:
        problems.append(f"FOMC calendar: {e}")
    for y in range(start_year, date.today().year - 4):  # older years live on per-year history pages
        try:
            found["FOMC"] |= fomc_statement_dates(get(f"https://www.federalreserve.gov/monetarypolicy/fomchistorical{y}.htm"))
        except Exception as e:
            problems.append(f"FOMC {y}: {e}")
    return {k: {d for d in v if d.year >= start_year} for k, v in found.items()}, problems


def main() -> None:
    start_year = int(sys.argv[1]) if len(sys.argv) > 1 else 2016
    found, problems = fetch_all(start_year)

    old: dict[str, set[date]] = {k: set() for k in TIMES}
    if OUT.exists():
        with OUT.open() as f:
            for row in csv.DictReader(f):
                if row.get("event") in old:
                    old[row["event"]].add(date.fromisoformat(row["date"]))
    for event in TIMES:
        if not found[event] and old[event]:
            print(f"  {event}: download failed, keeping the {len(old[event])} dates already saved")
            found[event] = old[event]

    OUT.parent.mkdir(parents=True, exist_ok=True)
    rows = sorted((d.isoformat(), e, TIMES[e]) for e, ds in found.items() for d in ds)
    with OUT.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["date", "event", "time_et"])
        w.writerows(rows)

    this_year = date.today().year
    print(f"Saved {len(rows)} release dates to {OUT}")
    for event in TIMES:
        per_year = Counter(d.year for d in found[event])
        short = [f"{y}: {per_year.get(y, 0)}" for y in range(start_year, this_year) if per_year.get(y, 0) < EXPECTED[event] - 1]
        span = f"{min(found[event])} to {max(found[event])}" if found[event] else "none"
        print(f"  {event:5} {len(found[event]):4} dates ({span})" + (f"  - looks incomplete for {', '.join(short)}" if short else ""))
    for p in problems:
        print(f"  warning: {p}")
    if not rows:
        sys.exit("No dates downloaded. Check the internet connection, then try again.")


if __name__ == "__main__":
    main()

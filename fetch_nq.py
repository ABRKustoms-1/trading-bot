"""Download every free NQ (Nasdaq-100 E-mini futures) dataset we can get and summarise it.

Usage: python fetch_nq.py [YEARS]   (default 10)

Writes CSVs to data/nq/ and prints a summary. Sources (all free, no API key):
  Yahoo Finance via yfinance
    NQ=F   continuous front-month futures: daily for the full window,
           hourly for the last ~730 days, 5-minute for ~60 days, 1-minute for ~30 days
    ^NDX   Nasdaq-100 cash index (daily)
    QQQ    Nasdaq-100 ETF (daily, split/dividend adjusted)
    ^VXN   Nasdaq-100 volatility index (daily)
  FRED
    NASDAQ100  official daily index close
    VXNCLS     official daily VXN close
Yahoo limits intraday history; for deeper intraday NQ you need a paid feed
(Databento, CME DataMine, Kibot, FirstRate Data, your broker).
"""

import sys
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import yfinance as yf

OUT = Path("data/nq")
DAILY = {"NQ=F": "nq_daily", "^NDX": "ndx_daily", "QQQ": "qqq_daily", "^VXN": "vxn_daily"}
INTRADAY = [("1h", 729, "nq_1h"), ("5m", 59, "nq_5m"), ("1m", 29, "nq_1m")]
FRED = ["NASDAQ100", "VXNCLS"]


def _clean(df: pd.DataFrame) -> pd.DataFrame:
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    return df.dropna(how="all")


def fetch_daily(start: date) -> dict[str, pd.DataFrame]:
    out = {}
    for ticker, name in DAILY.items():
        df = _clean(yf.download(ticker, start=start, interval="1d", auto_adjust=False, progress=False))
        out[name] = df
        print(f"{name:10} {len(df):6} rows")
    return out


def fetch_intraday() -> dict[str, pd.DataFrame]:
    out = {}
    for interval, days, name in INTRADAY:
        # Yahoo caps 1m requests at 7 days each, so fetch in chunks.
        step = 7 if interval == "1m" else days
        end, frames = date.today() + timedelta(days=1), []
        start = end - timedelta(days=days)
        while start < end:
            chunk_end = min(start + timedelta(days=step), end)
            frames.append(_clean(yf.download("NQ=F", start=start, end=chunk_end, interval=interval, progress=False)))
            start = chunk_end
        df = pd.concat(frames)
        out[name] = df[~df.index.duplicated()].sort_index()
        print(f"{name:10} {len(out[name]):6} rows")
    return out


def fetch_fred(start: date) -> dict[str, pd.DataFrame]:
    out = {}
    for series in FRED:
        url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={series}&cosd={start}"
        try:
            df = pd.read_csv(url, index_col=0, parse_dates=True, na_values=".").dropna()
        except Exception as e:  # FRED is a bonus source; don't fail the whole run
            print(f"FRED {series} failed: {e}")
            continue
        out[f"fred_{series.lower()}"] = df
        print(f"fred_{series.lower():5} {len(df):6} rows")
    return out


def summarise(nq: pd.DataFrame) -> dict[str, pd.DataFrame]:
    close = nq["Close"]
    ret = close.pct_change()

    yearly = pd.DataFrame({
        "open": nq["Open"].resample("YE").first(),
        "high": nq["High"].resample("YE").max(),
        "low": nq["Low"].resample("YE").min(),
        "close": close.resample("YE").last(),
    })
    yearly["return_%"] = yearly["close"].pct_change() * 100
    yearly.iloc[0, yearly.columns.get_loc("return_%")] = (yearly["close"].iloc[0] / yearly["open"].iloc[0] - 1) * 100
    yearly["realized_vol_%"] = ret.resample("YE").std() * np.sqrt(252) * 100
    yearly["avg_daily_range_pts"] = (nq["High"] - nq["Low"]).resample("YE").mean()
    yearly["up_days_%"] = (ret > 0).resample("YE").mean() * 100
    yearly.index = yearly.index.year

    monthly = close.resample("ME").last().pct_change() * 100
    seasonality = monthly.groupby(monthly.index.month).agg(["mean", "median", lambda s: (s > 0).mean() * 100])
    seasonality.columns = ["mean_%", "median_%", "positive_%"]

    weekday = ret.groupby(ret.index.dayofweek).agg(["mean", lambda s: (s > 0).mean()]) * 100
    weekday.columns = ["mean_%", "positive_%"]
    weekday.index = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][: len(weekday)]

    peak = close.cummax()
    dd = close / peak - 1
    trough = dd.idxmin()
    years = (close.index[-1] - close.index[0]).days / 365.25
    overall = pd.Series({
        "first_date": close.index[0].date(),
        "last_date": close.index[-1].date(),
        "first_close": close.iloc[0],
        "last_close": close.iloc[-1],
        "total_return_%": (close.iloc[-1] / close.iloc[0] - 1) * 100,
        "CAGR_%": ((close.iloc[-1] / close.iloc[0]) ** (1 / years) - 1) * 100,
        "annual_vol_%": ret.std() * np.sqrt(252) * 100,
        "sharpe_rf0": ret.mean() / ret.std() * np.sqrt(252),
        "max_drawdown_%": dd.min() * 100,
        "max_dd_peak": close[:trough].idxmax().date(),
        "max_dd_trough": trough.date(),
        "all_time_high": nq["High"].max(),
        "all_time_high_date": nq["High"].idxmax().date(),
        "best_day_%": ret.max() * 100,
        "best_day": ret.idxmax().date(),
        "worst_day_%": ret.min() * 100,
        "worst_day": ret.idxmin().date(),
        "avg_daily_range_pts": (nq["High"] - nq["Low"]).mean(),
        "avg_volume": nq["Volume"].mean(),
    })
    return {"summary_overall": overall.to_frame("value"), "summary_yearly": yearly,
            "summary_monthly_seasonality": seasonality, "summary_weekday": weekday,
            "nq_drawdown": dd.to_frame("drawdown")}


def main() -> None:
    years = int(sys.argv[1]) if len(sys.argv) > 1 else 10
    start = date.today().replace(year=date.today().year - years)
    OUT.mkdir(parents=True, exist_ok=True)

    data = {**fetch_daily(start), **fetch_intraday(), **fetch_fred(start)}
    if data["nq_daily"].empty:
        sys.exit("No NQ=F data returned - check your internet connection / yfinance version.")
    data.update(summarise(data["nq_daily"]))

    for name, df in data.items():
        df.to_csv(OUT / f"{name}.csv")

    pd.set_option("display.width", 160, "display.float_format", "{:,.2f}".format)
    for name in ["summary_overall", "summary_yearly", "summary_monthly_seasonality", "summary_weekday"]:
        print(f"\n== {name} ==\n{data[name]}")
    print(f"\nSaved {len(data)} files to {OUT.resolve()}")


if __name__ == "__main__":
    main()

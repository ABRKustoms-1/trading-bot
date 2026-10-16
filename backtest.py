"""Backtest a strategy on the NQ data from fetch_nq.py.

Usage:
  python backtest.py sma            # 20/50 moving-average cross, daily bars
  python backtest.py rsi            # RSI(2) mean reversion, daily bars
  python backtest.py orb            # opening-range breakout, 5-minute bars
  python backtest.py sma --contracts 2 --long-only

Each strategy is a function that takes the bars and returns a signal per bar:
1 = long, -1 = short, 0 = flat, decided on that bar's close. The engine holds
that position over the NEXT bar, so a strategy can't see the future.
To add your own, write a function like the ones below and add it to STRATEGIES.

Costs: NQ is $20 per point (0.25 tick = $5). Each side of a trade is charged
commission + slippage per contract (defaults: $2.50 + 1 tick).
Daily NQ=F is a continuous contract, so quarterly rolls add small fake gaps;
use --data ndx to test daily strategies on the cash index instead.
"""

import argparse
from pathlib import Path

import numpy as np
import pandas as pd

DATA = Path("data/nq")
FILES = {"daily": "nq_daily.csv", "ndx": "ndx_daily.csv", "5m": "nq_5m.csv", "1h": "nq_1h.csv", "1m": "nq_1m.csv"}
POINT_VALUE = 20.0
TICK = 0.25


def load(name: str) -> pd.DataFrame:
    df = pd.read_csv(DATA / FILES[name], index_col=0)
    idx = pd.to_datetime(df.index, utc=True)
    # Intraday bars are converted to New York time; daily bars just keep the date.
    df.index = idx.tz_convert("America/New_York") if name in ("5m", "1h", "1m") else idx.tz_localize(None).normalize()
    return df[["Open", "High", "Low", "Close", "Volume"]].astype(float).dropna()


# ---------------------------------------------------------------- strategies

def sma_cross(df: pd.DataFrame, fast: int = 20, slow: int = 50) -> pd.Series:
    """Long when the fast average is above the slow one, short when below."""
    f, s = df["Close"].rolling(fast).mean(), df["Close"].rolling(slow).mean()
    return pd.Series(np.where(f > s, 1, -1), df.index).where(s.notna(), 0)


def rsi_reversion(df: pd.DataFrame, period: int = 2, buy_below: float = 10, sell_above: float = 70) -> pd.Series:
    """Buy when RSI is very oversold, exit when it recovers. Long only."""
    delta = df["Close"].diff()
    gain = delta.clip(lower=0).ewm(alpha=1 / period, adjust=False).mean()
    loss = (-delta.clip(upper=0)).ewm(alpha=1 / period, adjust=False).mean()
    rsi = 100 - 100 / (1 + gain / loss)
    sig, pos = [], 0
    for r in rsi:
        if pos == 0 and r < buy_below:
            pos = 1
        elif pos == 1 and r > sell_above:
            pos = 0
        sig.append(pos)
    return pd.Series(sig, df.index)


def opening_range_breakout(df: pd.DataFrame, range_minutes: int = 15) -> pd.Series:
    """Mark the high/low of the first N minutes after 9:30 NY. Go long on a close
    above it, short on a close below it, stop out on a close beyond the other side,
    and be flat by the 15:55 bar. One trade per day."""
    sig = pd.Series(0, df.index)
    t = df.index.hour * 60 + df.index.minute
    open_t, close_t = 9 * 60 + 30, 15 * 60 + 55
    for _, day in df[(t >= open_t) & (t < 16 * 60)].groupby(lambda ts: ts.date()):
        mins = day.index.hour * 60 + day.index.minute
        rng = day[mins < open_t + range_minutes]
        if rng.empty:
            continue
        hi, lo, pos, traded = rng["High"].max(), rng["Low"].min(), 0, False
        for ts, close, m in zip(day.index, day["Close"], mins):
            if m < open_t + range_minutes:
                continue
            if m >= close_t:
                pos = 0
            elif pos == 0 and not traded:
                pos = 1 if close > hi else -1 if close < lo else 0
                traded = pos != 0
            elif (pos == 1 and close < lo) or (pos == -1 and close > hi):
                pos = 0
            sig[ts] = pos
    return sig


STRATEGIES = {
    "sma": (sma_cross, "daily"),
    "rsi": (rsi_reversion, "daily"),
    "orb": (opening_range_breakout, "5m"),
}


# ---------------------------------------------------------------- engine

def backtest(df, signal, contracts=1, commission=2.50, slippage_ticks=1.0, long_only=False):
    if long_only:
        signal = signal.clip(lower=0)
    held = signal.shift(1).fillna(0)  # position decided at close of t-1, held through bar t
    cost_per_side = (commission + slippage_ticks * TICK * POINT_VALUE) * contracts
    gross = held * df["Close"].diff().fillna(0) * POINT_VALUE * contracts
    costs = held.diff().abs().fillna(held.abs()) * cost_per_side
    pnl = gross - costs
    equity = pnl.cumsum()

    trade_id = (held != held.shift()).cumsum()
    trades = []
    for _, bars in pd.DataFrame({"held": held, "gross": gross}).groupby(trade_id):
        side = bars["held"].iloc[0]
        if side == 0:
            continue
        entry_ts = df.index[df.index.get_loc(bars.index[0]) - 1]
        trades.append({"entry": entry_ts, "exit": bars.index[-1], "side": "long" if side > 0 else "short",
                       "entry_price": df["Close"][entry_ts], "exit_price": df["Close"].iloc[df.index.get_loc(bars.index[-1])],
                       "bars": len(bars), "pnl": bars["gross"].sum() - 2 * cost_per_side * abs(side)})
    trades = pd.DataFrame(trades)
    return equity, trades


def report(equity: pd.Series, trades: pd.DataFrame, daily_bars: bool) -> None:
    if trades.empty:
        print("No trades.")
        return
    wins, losses = trades[trades.pnl > 0].pnl, trades[trades.pnl <= 0].pnl
    day_pnl = equity.groupby(equity.index.date).last().diff().dropna() if not daily_bars else equity.diff().dropna()
    dd = equity - equity.cummax()
    stats = {
        "Period": f"{equity.index[0]:%Y-%m-%d} to {equity.index[-1]:%Y-%m-%d}",
        "Net P&L": f"${equity.iloc[-1]:,.0f}",
        "Trades": len(trades),
        "Win rate": f"{len(wins) / len(trades):.1%}",
        "Avg trade": f"${trades.pnl.mean():,.0f}",
        "Avg win / avg loss": f"${wins.mean():,.0f} / ${losses.mean():,.0f}" if len(wins) and len(losses) else "n/a",
        "Profit factor": f"{wins.sum() / -losses.sum():.2f}" if losses.sum() < 0 else "inf",
        "Largest win / loss": f"${trades.pnl.max():,.0f} / ${trades.pnl.min():,.0f}",
        "Max drawdown": f"${dd.min():,.0f} (on {dd.idxmin():%Y-%m-%d})",
        "Sharpe (daily, ann.)": f"{day_pnl.mean() / day_pnl.std() * np.sqrt(252):.2f}" if day_pnl.std() else "n/a",
        "Long / short trades": f"{(trades.side == 'long').sum()} / {(trades.side == 'short').sum()}",
    }
    for k, v in stats.items():
        print(f"{k:22} {v}")
    yearly = trades.groupby(pd.to_datetime(trades["exit"].astype(str).str[:10]).dt.year)["pnl"].agg(["sum", "count"])
    if len(yearly) > 1:
        print("\nP&L by year:")
        for year, row in yearly.iterrows():
            print(f"  {year}  ${row['sum']:>11,.0f}  ({int(row['count'])} trades)")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("strategy", choices=STRATEGIES)
    p.add_argument("--data", choices=FILES, help="override the strategy's default data file")
    p.add_argument("--contracts", type=int, default=1)
    p.add_argument("--commission", type=float, default=2.50, help="$ per contract per side")
    p.add_argument("--slippage", type=float, default=1.0, help="ticks per side")
    p.add_argument("--long-only", action="store_true")
    args = p.parse_args()

    func, default_data = STRATEGIES[args.strategy]
    data = args.data or default_data
    df = load(data)
    equity, trades = backtest(df, func(df), args.contracts, args.commission, args.slippage, args.long_only)
    print(f"== {args.strategy} on {data} ({len(df)} bars, {args.contracts} NQ contract(s)) ==")
    report(equity, trades, data in ("daily", "ndx"))

    out = Path("results")
    out.mkdir(exist_ok=True)
    trades.to_csv(out / f"bt_{args.strategy}_{data}_trades.csv", index=False)
    equity.to_frame("equity").to_csv(out / f"bt_{args.strategy}_{data}_equity.csv")
    try:
        import matplotlib.pyplot as plt
        equity.plot(title=f"{args.strategy} on NQ {data} - equity ($)", figsize=(10, 4))
        plt.tight_layout()
        plt.savefig(out / f"bt_{args.strategy}_{data}_equity.png")
        print(f"\nSaved trades, equity curve and chart to {out.resolve()}")
    except ImportError:
        print(f"\nSaved trades and equity curve to {out.resolve()} (pip install matplotlib for a chart)")


if __name__ == "__main__":
    main()

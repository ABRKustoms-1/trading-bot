# trading-bot

A trading bot built on [TradingAgents](https://github.com/TauricResearch/TradingAgents),
a multi-agent LLM framework where analyst, researcher, trader and risk agents debate
a ticker and produce a buy/hold/sell decision.

This repo installs TradingAgents as a pinned dependency (see `requirements.txt`)
instead of copying its source.

## Quick start: NQ Strategy Lab (GitHub Codespaces or local)

```
bash start.sh
```

That one command gets the latest code, installs the packages it needs, downloads 10 years
of NQ data into `data/nq/` when it's missing or more than 12 hours old, stops any lab
already running and starts a fresh one on port 8000. In a Codespace it prints the link to
open (also under the **Ports** tab); locally it opens your browser. Ctrl+C stops it.

Codespaces made from a branch that has `.devcontainer/` run `bash start.sh` automatically
each time you open them. Data in `data/nq/` stays between sessions until the Codespace is deleted.

## Setup

Requires Python 3.11+.

**Windows (PowerShell)**

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env
```

If PowerShell refuses to run `Activate.ps1`, run
`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once.

**macOS / Linux**

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

Then open `.env` and fill in the API key for at least one LLM provider. The default
provider is OpenAI (`OPENAI_API_KEY`); to use another, set
`TRADINGAGENTS_LLM_PROVIDER` and the two model variables, e.g. for Claude:

```
ANTHROPIC_API_KEY=...
TRADINGAGENTS_LLM_PROVIDER=anthropic
TRADINGAGENTS_DEEP_THINK_LLM=claude-opus-5-5
TRADINGAGENTS_QUICK_THINK_LLM=claude-sonnet-5-5
```

## Usage

Interactive CLI (pick ticker, date, provider, depth):

```
tradingagents
```

Scripted run for one ticker (date defaults to today):

```
python run.py NVDA
python run.py AAPL 2026-09-01
```

Reports are saved under `~/.tradingagents` unless `TRADINGAGENTS_RESULTS_DIR` is set.

TradingAgents is a research framework. Its output is not financial advice.

## NQ historical data

`python fetch_nq.py [YEARS]` (default 10) downloads free Nasdaq-100 data into `data/nq/`:
NQ=F futures (daily for the full window, hourly ~2y, 5m ~60d, 1m ~30d), the ^NDX index,
QQQ, ^VXN, and FRED's NASDAQ100/VXNCLS series. It also writes and prints summary tables:
overall stats (CAGR, volatility, Sharpe, max drawdown, best/worst day), per-year stats,
month-of-year seasonality and day-of-week returns.

## Backtesting

`python backtest.py sma|rsi|orb [--contracts N] [--long-only] [--data daily|ndx|5m|1h|1m]`
runs a strategy on the downloaded NQ data with real contract math ($20/point,
commission + slippage per side) and prints net P&L, win rate, profit factor, max
drawdown, Sharpe and P&L by year. Trades, equity curve and a chart go to `results/`.
Add your own strategy as a function in `backtest.py` and register it in `STRATEGIES`.

## Strategy Lab (visual backtester)

Run `python serve_lab.py` and it opens http://localhost:8000 with every price CSV in
`data/nq/` already loaded; the "Refresh data" button re-runs `fetch_nq.py` to pull the
latest bars. (You can also open `lab/nq_strategy_lab.html` directly and use "Load CSV files".) It runs nine strategies (buy & hold, MA cross, trend filter, Donchian,
RSI, z-score, time-series momentum, opening-range breakout, session VWAP bands) with
stops, targets, direction, contract size and costs, and shows price with trade markers,
equity vs buy & hold, drawdown, a side-by-side comparison, P&L by year and a trade log.
Everything runs in the browser; files never leave your machine.

### Pine Script strategies

Click **+ Pine Script** in the lab, paste a TradingView `strategy()` script (Pine v5/v6)
and press **Test & save**. Its `input.*()` values become settings in the left panel, its
`plot()` lines are drawn on the price chart, and it joins the comparison table. With
`serve_lab.py` running, scripts are saved to `strategies/*.pine` (so they can be committed);
otherwise they are kept in the browser. Three examples ship in `strategies/`.

The interpreter (`lab/pine.js`) runs a practical subset of Pine: variables, `var`, if/else,
switch, loops, user functions, tuples, `x[n]` history, most `ta.*` and `math.*` functions,
sessions via `time()`, and `strategy.entry/exit/close/close_all/cancel` with stops, limits,
profit/loss ticks, trailing stops, partial exits and pyramiding. Orders fill at the next
bar's open like TradingView (or at the close with `process_orders_on_close=true`). Arrays,
drawings and `request.security()` on other timeframes are not supported; the editor says
which line it can't run.

### Account rules (prop-firm style)

The lab's **Account rules** panel enforces dollar limits on every strategy, built-in or Pine:
**max loss per trade** (default $400), **daily loss limit** (default $2,000: closes everything
and pauses until the next session at 18:00 NY) and an optional **trailing max drawdown**
(breaching it ends trading for the rest of the test). Starting capital defaults to $50,000.
Limits are checked against each bar's high and low and include open P&L, so a loss can only
exceed a limit by the exit costs or a gap through the level. A summary above the stats shows
how many trades were capped, how many days hit the daily limit and whether the drawdown was breached.

### Trading windows and Pacific time

On intraday data the lab only opens trades inside the **Trading windows** set in the left panel,
entered in Pacific time: Asia 3:00–7:00pm PT and New York 6:30am–1:00pm PT by default (London
12:00–5:00am PT is available but off). Nothing opens after 7pm PT (10pm ET). With "Close open
trades when a window ends" checked, positions are flattened at each window's end. Chart labels,
tooltips and the trade list show Pacific time; strategy logic (and Pine `hour`/`time()`) keeps
using exchange/NY time as on TradingView.

### No-trade days (CPI, FOMC, jobs report)

`python fetch_events.py` downloads official release dates since 2016 into `data/events.csv`:
CPI, the jobs report (NFP) and PPI from the BLS news-release archives, and FOMC decision days
from the Federal Reserve (`start.sh` refreshes it weekly). In the lab's **No-trade days**
panel, tick the events to skip (CPI, FOMC and jobs report by default) and add any extra dates.
No new trades open on a skipped day (US Eastern date); trades already open can still exit.

### Coin-flip test

The **Coin-flip test** card re-runs the current strategy's trades hundreds of times with a coin
making the decision, using the same costs, account rules, trading windows and no-trade days, and
shows how many coin-flip runs made as much as the strategy. The coin can choose long or short at
the same entry times (the default for long+short strategies), the entry times at the same hold
lengths (the default for long-only or short-only strategies), or both. Verdicts: **Beats the coin**
(5% or fewer of runs as good), **Borderline** (up to 20%) or **A coin keeps up**.

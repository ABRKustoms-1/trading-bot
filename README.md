# trading-bot

A trading bot built on [TradingAgents](https://github.com/TauricResearch/TradingAgents),
a multi-agent LLM framework where analyst, researcher, trader and risk agents debate
a ticker and produce a buy/hold/sell decision.

This repo installs TradingAgents as a pinned dependency (see `requirements.txt`)
instead of copying its source.

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

Open `lab/nq_strategy_lab.html` in a browser and load the CSVs from `data/nq/` with
"Load CSV files". It runs nine strategies (buy & hold, MA cross, trend filter, Donchian,
RSI, z-score, time-series momentum, opening-range breakout, session VWAP bands) with
stops, targets, direction, contract size and costs, and shows price with trade markers,
equity vs buy & hold, drawdown, a side-by-side comparison, P&L by year and a trade log.
Everything runs in the browser; files never leave your machine.

"""Run a TradingAgents analysis for one ticker and save the report.

Usage: python run.py NVDA [YYYY-MM-DD]
Provider, models and keys come from .env (see .env.example).
"""

import sys
from datetime import date

from tradingagents.default_config import DEFAULT_CONFIG
from tradingagents.graph.trading_graph import TradingAgentsGraph


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit("usage: python run.py TICKER [YYYY-MM-DD]")
    ticker = sys.argv[1].upper()
    trade_date = sys.argv[2] if len(sys.argv) > 2 else date.today().isoformat()

    ta = TradingAgentsGraph(debug=True, config=DEFAULT_CONFIG.copy())
    state, decision = ta.propagate(ticker, trade_date)
    print(decision)
    ta.save_reports(state, ticker)


if __name__ == "__main__":
    main()

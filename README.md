# Trade Republic Portfolio Analyser

A single-page web app for analyzing Trade Republic transaction CSV exports entirely on your local machine. Upload your export, and it reconstructs your holdings, cash balance, asset allocation, and risk profile, then lets you simulate future contributions and goals.

All portfolio logic runs in the browser. A small local Flask backend exists only to fetch per-asset metadata (country exposure, risk class, volatility, TER) from justETF/Yahoo Finance, since the browser can't call those sites directly due to CORS.

## Features

- **CSV import** — supports Italian, English, and German Trade Republic export formats, with automatic column and transaction-type detection.
- **Portfolio reconstruction** — holdings per ISIN and cash balance derived from deposits, withdrawals, and fees.
- **Asset metadata lookup** — country/region exposure, developed vs. emerging market split, SRRI risk class (1–7), volatility, max drawdown, and TER per holding, fetched once per ISIN and cached locally.
- **Allocation charts** — visual breakdown of your portfolio by asset class, region, and risk.
- **Holdings table** — per-position detail view.
- **Accumulation-plan simulator** — model future contributions with adjustable target allocations, including pessimistic/base/optimistic growth scenarios.
- **Goal planner** — estimate whether your current plan reaches a target amount by a target date.
- **Dark theme**, responsive down to mobile widths.

## Requirements

- Python 3.9+
- Packages: `flask`, `requests`, `beautifulsoup4`, `yfinance` (no `requirements.txt`; install manually)

```bash
pip install flask requests beautifulsoup4 yfinance
```

## Running

**Windows:**

```
run_server.bat
```

Starts the Flask dev server on `http://127.0.0.1:5000` and opens it in your browser. Uses the Anaconda Python at `C:\Users\belfi\anaconda3\python.exe`.

**Manually:**

```bash
python app.py
```

Runs Flask in debug mode on port 5000.

## Usage

1. Export your transaction history as CSV from the Trade Republic app.
2. Open the app in your browser and upload the CSV.
3. The app parses transactions, builds your holdings and cash position, and fetches metadata for each ISIN (cached for 7 days in `asset_cache.json`).
4. Review your metrics, risk profile, and allocation charts in the holdings table.
5. Use the accumulation-plan simulator to model future contributions against target allocations, and the goal planner to check progress toward a target amount and date.

A sample file, `sample_transactions.csv` (semicolon-delimited, Italian-style), is included for trying the app without your own data.

## Architecture

**Backend (`app.py`)** — a single Flask file that serves the `static/` frontend and exposes one endpoint:

```
GET /api/fetch-asset-data?isin=<ISIN>&name=<name>
```

Lookup chain per ISIN:

1. **justETF scrape** (`scrape_justetf`) — for ETFs, parses the justETF profile page for name, investment focus, country weights, volatility, max drawdown, and TER.
2. **yfinance fallback** (`fetch_yfinance`) — for individual stocks or when justETF has no match, resolves the ISIN to a ticker and pulls basic info plus realized 1-year volatility.
3. **Hardcoded defaults** — if both fail, a generic "estimated" entry is returned so the asset still shows up in the UI instead of disappearing.

All three stages return the same dict shape (name, asset class, countries, developed/emerging split, SRRI risk 1–7, volatility, max drawdown, TER, source). Results are cached in `asset_cache.json` in the repo root, keyed by ISIN, with a 7-day TTL. Delete an entry (or the whole file) to force a re-scrape.

Risk class is derived from annualized volatility via standard SRRI bands (`srri_from_volatility`). The opaque "Other" country bucket from justETF is spread proportionally across developed/emerging markets (`split_dev_emerging`).

**Frontend (`static/app.js`)** — one large `DOMContentLoaded` closure. Chart.js and PapaParse are loaded from CDNs in `index.html`; dark theme only.

Flow: CSV upload → PapaParse → column auto-detection (`findColumn`) and transaction-type classification (`TYPE_RULES`) → holdings built per ISIN, cash reconstructed from deposits/withdrawals/fees → one API call per ISIN for metadata → `renderAll()`.

Amount parsing (`parseNumber`) handles both `1.234,56` and `1,234.56` number formats.

Everything renders from a central `state` object (holdings, cash, plan inputs, target allocations, growth rates). Pseudo-assets keyed `NEW::<class>` represent planned positions not yet held, used by the simulator and goal planner.

## Project structure

```
app.py                  Flask backend (single file)
static/
  index.html             App shell
  app.js                 All frontend logic
  styles.css              Styles
asset_cache.json         Per-ISIN metadata cache (7-day TTL, generated at runtime)
sample_transactions.csv  Sample Italian-style export for manual testing
test_scrape.py           Manual script to probe justETF scraping for one hardcoded ISIN
run_server.bat           Windows launcher
```

## Testing

There is no automated test suite. Before trusting a change:

- **Backend**: run `python app.py`, hit `/api/fetch-asset-data?isin=<ISIN>` for both an ETF ISIN (justETF path) and a stock ISIN (yfinance path), and confirm `asset_cache.json` gets a new entry.
- **Frontend**: load `sample_transactions.csv` through the UI and check that metrics, charts, the holdings table, the simulator, and the goal planner all populate without console errors.
- **Amount parsing**: test both `1.234,56` and `1,234.56` inputs — regressions here are silent (wrong numbers, no crash).
- **New scraping/risk logic**: verify with a quick manual script (`test_scrape.py`-style) before trusting it against live sites, since justETF markup can change without notice.

## Privacy

All CSV parsing and portfolio computation happens locally in your browser. The only network calls are per-ISIN metadata lookups to justETF/Yahoo Finance (no transaction data is sent), and those are cached locally after the first fetch.

## License

This project is licensed for **personal, non-commercial use only**, with **no redistribution of modified versions**. See [LICENSE](LICENSE) for full terms.

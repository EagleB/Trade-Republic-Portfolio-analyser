import json
import os
import re
import time

import requests
import yfinance as yf
from bs4 import BeautifulSoup
from flask import Flask, jsonify, request, send_from_directory

app = Flask(__name__, static_folder='static')

CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'asset_cache.json')
CACHE_TTL_SECONDS = 7 * 24 * 3600  # re-scrape after a week

HTTP_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                  '(KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
}

DEVELOPED_MARKETS = {
    'United States', 'USA', 'Japan', 'United Kingdom', 'France', 'Canada',
    'Switzerland', 'Germany', 'Australia', 'Netherlands', 'Sweden', 'Italy',
    'Spain', 'Hong Kong', 'Singapore', 'Denmark', 'Finland', 'Norway',
    'Belgium', 'Austria', 'Ireland', 'Israel', 'New Zealand', 'Portugal',
    'Luxembourg', 'Iceland',
}


# ---------------------------------------------------------------------------
# Cache
# ---------------------------------------------------------------------------

def load_cache():
    if os.path.exists(CACHE_FILE):
        try:
            with open(CACHE_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            return {}
    return {}


def save_cache(cache):
    try:
        with open(CACHE_FILE, 'w', encoding='utf-8') as f:
            json.dump(cache, f, ensure_ascii=False, indent=1)
    except OSError as e:
        print(f'Warning: could not persist cache: {e}')


ASSET_CACHE = load_cache()


# ---------------------------------------------------------------------------
# Risk helpers
# ---------------------------------------------------------------------------

def srri_from_volatility(vol_pct):
    """Map annualised volatility (%) to the standard SRRI 1-7 risk class."""
    if vol_pct is None:
        return None
    bands = [(0.5, 1), (2.0, 2), (5.0, 3), (10.0, 4), (15.0, 5), (25.0, 6)]
    for limit, cls in bands:
        if vol_pct < limit:
            return cls
    return 7


def split_dev_emerging(countries):
    dev = sum(p for c, p in countries.items() if c in DEVELOPED_MARKETS and c != 'Other')
    emg = sum(p for c, p in countries.items() if c not in DEVELOPED_MARKETS and c != 'Other')
    other = countries.get('Other', 0.0)
    total = dev + emg
    if total <= 0:
        return 100.0, 0.0
    # Spread the opaque "Other" bucket proportionally to what we can see.
    dev += other * (dev / total)
    emg += other * (emg / total)
    total = dev + emg
    return round(dev / total * 100, 2), round(emg / total * 100, 2)


# ---------------------------------------------------------------------------
# JustETF scraper (ETFs by ISIN)
# ---------------------------------------------------------------------------

def scrape_justetf(isin):
    url = f'https://www.justetf.com/en/etf-profile.html?isin={isin}'
    try:
        response = requests.get(url, headers=HTTP_HEADERS, timeout=20)
    except requests.RequestException as e:
        print(f'justETF request failed for {isin}: {e}')
        return None
    if response.status_code != 200:
        return None

    soup = BeautifulSoup(response.text, 'html.parser')
    title_el = soup.find('h1')
    if not title_el or not title_el.text.strip():
        return None
    name = title_el.text.strip()
    page_text = soup.get_text(' ', strip=True)

    # --- Investment focus -> asset class -------------------------------
    asset_class = 'Stocks'
    focus_match = re.search(r'Investment focus\s+([A-Za-z ,/&-]+?)\s{0,2}(?:Fund size|Total expense|$)',
                            page_text)
    focus = focus_match.group(1).strip() if focus_match else ''
    focus_l = focus.lower()
    if 'bond' in focus_l or 'fixed income' in focus_l:
        asset_class = 'Bonds'
    elif 'money market' in focus_l:
        asset_class = 'Cash'
    elif 'commodit' in focus_l or 'precious metal' in focus_l or 'gold' in focus_l:
        asset_class = 'Commodities'
    elif 'real estate' in focus_l:
        asset_class = 'Real Estate'
    elif 'equity' in focus_l:
        asset_class = 'Stocks'
    else:
        # Fallback: look at the ETF name itself
        name_l = name.lower()
        if 'bond' in name_l or 'aggregate' in name_l or 'treasury' in name_l or 'govt' in name_l:
            asset_class = 'Bonds'
        elif 'gold' in name_l or 'commodity' in name_l:
            asset_class = 'Commodities'

    # --- Countries table ------------------------------------------------
    countries = {}
    for h in soup.find_all(['h3', 'h4']):
        if 'Countries' in h.text or 'Country' in h.text:
            parent = h.find_parent('div')
            if parent:
                table = parent.find('table')
                if table:
                    for row in table.find_all('tr'):
                        cols = row.find_all(['td', 'th'])
                        if len(cols) >= 2:
                            country_name = cols[0].text.strip()
                            pct_text = cols[1].text.strip().replace('%', '').replace(',', '.')
                            try:
                                countries[country_name] = float(pct_text)
                            except ValueError:
                                pass
            break

    # --- Risk metrics ----------------------------------------------------
    def find_pct(label):
        m = re.search(re.escape(label) + r'\s*(-?\d+[.,]?\d*)\s*%', page_text)
        return float(m.group(1).replace(',', '.')) if m else None

    vol_1y = find_pct('Volatility 1 year')
    vol_3y = find_pct('Volatility 3 years')
    vol_5y = find_pct('Volatility 5 years')
    max_dd = find_pct('Maximum drawdown since inception') or find_pct('Maximum drawdown 5 years')
    ter = find_pct('TER')

    risk_vol = vol_5y or vol_3y or vol_1y
    risk = srri_from_volatility(risk_vol)
    if risk is None:
        risk = {'Stocks': 5, 'Bonds': 3, 'Cash': 1, 'Commodities': 5, 'Real Estate': 5}[asset_class]

    developed, emerging = split_dev_emerging(countries)

    return {
        'name': name,
        'type': 'ETF',
        'asset_class': asset_class,
        'investment_focus': focus,
        'countries': countries,
        'developed_market': developed,
        'emerging_market': emerging,
        'risk': risk,
        'volatility_1y': vol_1y,
        'volatility_3y': vol_3y,
        'volatility_5y': vol_5y,
        'max_drawdown': max_dd,
        'ter': ter,
        'source': 'justETF',
    }


# ---------------------------------------------------------------------------
# yfinance (individual stocks / fallback)
# ---------------------------------------------------------------------------

def yf_resolve_ticker(isin, name=None):
    """Yahoo accepts ISINs in search; resolve to the primary ticker symbol."""
    for query in filter(None, [isin, name]):
        try:
            results = yf.Search(query, max_results=5).quotes
        except Exception:
            results = []
        for r in results:
            if r.get('symbol'):
                return r['symbol']
    return None


def fetch_yfinance(isin, name=None):
    try:
        symbol = yf_resolve_ticker(isin, name)
        if not symbol:
            return None
        t = yf.Ticker(symbol)
        info = t.info or {}
        if not info.get('shortName') and not info.get('longName'):
            return None

        display_name = info.get('longName') or info.get('shortName') or name or isin
        country = info.get('country', 'Unknown')
        quote_type = (info.get('quoteType') or 'EQUITY').upper()

        asset_class = 'Stocks'
        if quote_type in ('BOND',):
            asset_class = 'Bonds'
        elif quote_type in ('MONEYMARKET',):
            asset_class = 'Cash'

        # Realised annualised volatility from 1y of daily closes
        vol_1y = None
        try:
            hist = t.history(period='1y')['Close'].dropna()
            if len(hist) > 30:
                returns = hist.pct_change().dropna()
                vol_1y = round(float(returns.std() * (252 ** 0.5) * 100), 2)
        except Exception:
            pass

        risk = srri_from_volatility(vol_1y)
        if risk is None:
            risk = 6 if asset_class == 'Stocks' else 3

        countries = {country: 100.0} if country != 'Unknown' else {}
        developed, emerging = split_dev_emerging(countries)

        return {
            'name': display_name,
            'type': 'Stock' if quote_type == 'EQUITY' else quote_type.title(),
            'asset_class': asset_class,
            'investment_focus': info.get('sector', ''),
            'countries': countries,
            'developed_market': developed,
            'emerging_market': emerging,
            'risk': risk,
            'volatility_1y': vol_1y,
            'volatility_3y': None,
            'volatility_5y': None,
            'max_drawdown': None,
            'ter': None,
            'source': f'Yahoo Finance ({symbol})',
        }
    except Exception as e:
        print(f'yfinance error for {isin}: {e}')
        return None


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route('/')
def serve_index():
    return send_from_directory('static', 'index.html')


@app.route('/<path:path>')
def serve_static(path):
    return send_from_directory('static', path)


@app.route('/api/fetch-asset-data', methods=['GET'])
def fetch_asset_data():
    isin = (request.args.get('isin') or '').strip().upper()
    name = (request.args.get('name') or '').strip()

    if not isin:
        return jsonify({'success': False, 'error': 'ISIN required'}), 400

    cached = ASSET_CACHE.get(isin)
    if cached and time.time() - cached.get('fetched_at', 0) < CACHE_TTL_SECONDS:
        return jsonify({'success': True, 'data': cached['data'], 'cached': True})

    data = scrape_justetf(isin)
    if not data:
        data = fetch_yfinance(isin, name)

    if not data:
        # Last resort: keep the asset visible instead of dropping it.
        data = {
            'name': name or isin,
            'type': 'Unknown',
            'asset_class': 'Stocks',
            'investment_focus': '',
            'countries': {},
            'developed_market': 100.0,
            'emerging_market': 0.0,
            'risk': 5,
            'volatility_1y': None,
            'volatility_3y': None,
            'volatility_5y': None,
            'max_drawdown': None,
            'ter': None,
            'source': 'not found - defaults applied',
            'estimated': True,
        }

    ASSET_CACHE[isin] = {'fetched_at': time.time(), 'data': data}
    save_cache(ASSET_CACHE)
    return jsonify({'success': True, 'data': data})


if __name__ == '__main__':
    app.run(debug=True, port=5000)

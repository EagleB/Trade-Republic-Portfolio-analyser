/* Trade Republic Portfolio Analyzer */
document.addEventListener('DOMContentLoaded', () => {

    // ------------------------------------------------------------------
    // Palette (validated dark-mode categorical slots + status colors)
    // ------------------------------------------------------------------
    const SERIES = ['#3987e5', '#199e70', '#c98500', '#008300', '#9085e9', '#e66767', '#d55181', '#d95926'];
    const MUTED = '#898781';
    const CLASS_COLORS = {
        'Stocks': '#3987e5',
        'Bonds': '#199e70',
        'Cash': '#c98500',
        'Commodities': '#d95926',
        'Real Estate': '#d55181',
        'Unknown': MUTED,
    };
    const STATUS = { good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b' };
    // Expected annual returns in % (user-editable in the what-if section)
    const DEFAULT_GROWTH_PCT = { 'Stocks': 6, 'Bonds': 3, 'Cash': 2, 'Commodities': 4, 'Real Estate': 5, 'Unknown': 5 };
    // Scenario shifts in percentage points: [pessimistic, optimistic]
    const SCENARIO_SHIFTS = { 'Stocks': [-5, 3], 'Commodities': [-5, 3], 'Real Estate': [-5, 3], 'Bonds': [-2, 1.5], 'Cash': [-0.5, 0.5], 'Unknown': [-4, 2.5] };
    const SCENARIOS = [
        { key: 'pessimistic', label: 'Pessimistic', idx: 0, color: '#e66767' },
        { key: 'base', label: 'Base', idx: null, color: '#3987e5' },
        { key: 'optimistic', label: 'Optimistic', idx: 1, color: '#199e70' },
    ];

    Chart.defaults.color = '#c3c2b7';
    Chart.defaults.font.family = "'Inter', sans-serif";
    Chart.defaults.plugins.legend.labels.boxWidth = 12;
    Chart.defaults.plugins.legend.labels.boxHeight = 12;

    // ------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------
    const state = {
        holdings: {},        // isin -> { isin, name, invested, shares, meta }
        cash: 0,
        cashOverride: null,
        totalInvested: 0,
        charts: {},
        planInputs: {},      // isin (or NEW::class) -> €/month
        targets: {},         // class -> pct
        pseudoAssets: {},    // NEW::class -> {name, meta}
        growthRates: { ...DEFAULT_GROWTH_PCT },   // class -> expected annual return in %
        horizonMonths: 24,
        horizonUnit: 'months',                    // 'months' | 'years'
    };

    // Annual return (decimal) for a class; scenarioIdx: 0 = pessimistic, 1 = optimistic, null = base
    function rateFor(cls, scenarioIdx = null) {
        let pct = state.growthRates[cls] ?? state.growthRates['Unknown'] ?? 5;
        if (scenarioIdx !== null) pct += (SCENARIO_SHIFTS[cls] || SCENARIO_SHIFTS['Unknown'])[scenarioIdx];
        return pct / 100;
    }

    const $ = (id) => document.getElementById(id);
    const fmtEUR = (v) => '€' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const fmtPct = (v) => `${v.toFixed(1)}%`;
    const fmtMonthTick = (m) => (m > 0 && m % 12 === 0) ? `${m / 12}y` : `${m}m`;

    // ------------------------------------------------------------------
    // Upload handling
    // ------------------------------------------------------------------
    const uploadSection = $('upload-section');
    const fileInput = $('csv-file');

    uploadSection.addEventListener('dragover', (e) => { e.preventDefault(); uploadSection.style.borderColor = 'var(--primary)'; });
    uploadSection.addEventListener('dragleave', (e) => { e.preventDefault(); uploadSection.style.borderColor = 'var(--card-border)'; });
    uploadSection.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadSection.style.borderColor = 'var(--card-border)';
        if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener('change', (e) => { if (e.target.files.length) handleFile(e.target.files[0]); });

    function handleFile(file) {
        uploadSection.classList.add('hidden');
        $('loading').classList.remove('hidden');
        $('loading-status').textContent = 'Parsing CSV file...';
        Papa.parse(file, {
            header: true,
            skipEmptyLines: true,
            delimitersToGuess: [',', ';', '\t', '|'],
            complete: (results) => processTransactions(results.data),
            error: () => { $('loading-status').textContent = 'Error: could not parse the file.'; },
        });
    }

    // ------------------------------------------------------------------
    // Transaction parsing
    // ------------------------------------------------------------------
    const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;

    function parseNumber(raw) {
        if (raw === null || raw === undefined) return NaN;
        let s = String(raw).trim().replace(/[€$£\s]/g, '');
        if (!s) return NaN;
        const neg = /^-|^\(.*\)$/.test(s);
        s = s.replace(/[()]/g, '').replace(/^-/, '');
        const lastComma = s.lastIndexOf(','), lastDot = s.lastIndexOf('.');
        if (lastComma > -1 && lastDot > -1) {
            // Both present: the later one is the decimal separator
            s = lastComma > lastDot
                ? s.replace(/\./g, '').replace(',', '.')
                : s.replace(/,/g, '');
        } else if (lastComma > -1) {
            // Only comma: decimal if followed by 1-2 digits, else thousands
            s = (s.length - lastComma - 1) <= 2 ? s.replace(',', '.') : s.replace(/,/g, '');
        }
        const n = parseFloat(s);
        return neg ? -n : n;
    }

    const TYPE_RULES = [
        ['buy', /buy|acquisto|kauf|purchase|savings?\s?plan|sparplan|piano|saveback|round\s?up|execution/i],
        ['sell', /sell|vendita|verkauf/i],
        ['deposit', /deposit|deposito|bonifico|einzahlung|incoming|top.?up|transfer.?in|ricarica/i],
        ['withdrawal', /withdraw|removal|prelievo|auszahlung|payout|outgoing|transfer.?out/i],
        ['dividend', /dividend|dividendo|distribu/i],
        ['interest', /interest|interessi|zinsen/i],
        ['fee', /fee|tax|commissione|imposta|geb(ü|u)hr|steuer/i],
        ['card', /card|carta|kartenzahlung/i],
    ];

    function classifyType(t) {
        for (const [kind, re] of TYPE_RULES) if (re.test(t)) return kind;
        return 'unknown';
    }

    function findColumn(headers, patterns) {
        for (const p of patterns) {
            const hit = headers.find(h => h.toLowerCase().includes(p));
            if (hit) return hit;
        }
        return null;
    }

    async function processTransactions(rows) {
        if (!rows.length) { $('loading-status').textContent = 'Error: the file appears to be empty.'; return; }
        const headers = Object.keys(rows[0]);

        const isinCol = findColumn(headers, ['isin']);
        const typeCol = findColumn(headers, ['type', 'tipo', 'transaktion', 'event', 'tip']);
        const valueCol = findColumn(headers, ['value', 'valore', 'amount', 'importo', 'betrag', 'total', 'totale', 'cash']);
        const nameCol = findColumn(headers, ['name', 'nome', 'desc', 'note', 'bezeichnung', 'titolo']);
        const sharesCol = findColumn(headers, ['share', 'quantit', 'quote', 'stück', 'stuck', 'anteil', 'unit']);

        if (!valueCol) { $('loading-status').textContent = 'Error: could not detect an amount/value column.'; return; }

        const holdings = {};
        let signedSum = 0, hasNegatives = false;
        let deposits = 0, withdrawals = 0, dividends = 0, interest = 0, fees = 0, card = 0, buys = 0, sells = 0;

        rows.forEach(row => {
            const value = parseNumber(row[valueCol]);
            if (isNaN(value)) return;
            const isin = String(row[isinCol] || '').trim().toUpperCase();
            const isAsset = ISIN_RE.test(isin);
            let kind = classifyType(String(row[typeCol] || ''));

            if (isAsset && !['buy', 'sell', 'dividend'].includes(kind)) {
                // Row references a security but the type is unrecognized:
                // in TR exports money leaving the account (negative) is a purchase.
                kind = value < 0 ? 'buy' : 'sell';
            }

            signedSum += value;
            if (value < 0) hasNegatives = true;

            if (isAsset && (kind === 'buy' || kind === 'sell')) {
                if (!holdings[isin]) {
                    holdings[isin] = { isin, name: row[nameCol] || isin, invested: 0, shares: 0 };
                }
                const amount = Math.abs(value);
                const sh = Math.abs(parseNumber(row[sharesCol]) || 0);
                if (kind === 'buy') { holdings[isin].invested += amount; holdings[isin].shares += sh; buys += amount; }
                else { holdings[isin].invested -= amount; holdings[isin].shares -= sh; sells += amount; }
            } else {
                const amount = Math.abs(value);
                if (kind === 'deposit') deposits += amount;
                else if (kind === 'withdrawal') withdrawals += amount;
                else if (kind === 'dividend') dividends += amount;
                else if (kind === 'interest') interest += amount;
                else if (kind === 'fee') fees += amount;
                else if (kind === 'card') card += amount;
            }
        });

        // Cash: with a fully signed export the running sum IS the cash balance.
        state.cash = hasNegatives
            ? Math.max(0, signedSum)
            : Math.max(0, deposits - withdrawals + dividends + interest + sells - buys - fees - card);

        const active = Object.values(holdings).filter(h => h.invested > 1);
        if (!active.length) {
            $('loading-status').textContent = 'No security transactions with ISINs found. Check that the CSV contains an ISIN column.';
            return;
        }
        await fetchMetadata(active);
    }

    async function fetchMetadata(holdings) {
        state.holdings = {};
        state.totalInvested = 0;
        for (let i = 0; i < holdings.length; i++) {
            const h = holdings[i];
            $('loading-status').textContent = `Fetching web data for ${h.name} (${i + 1}/${holdings.length})...`;
            try {
                const res = await fetch(`/api/fetch-asset-data?isin=${encodeURIComponent(h.isin)}&name=${encodeURIComponent(h.name)}`);
                const json = await res.json();
                h.meta = json.success ? json.data : fallbackMeta(h);
            } catch (e) {
                h.meta = fallbackMeta(h);
            }
            state.holdings[h.isin] = h;
            state.totalInvested += h.invested;
        }
        $('loading').classList.add('hidden');
        $('dashboard').classList.remove('hidden');
        initSimulatorDefaults();
        renderAll();
    }

    function fallbackMeta(h) {
        return {
            name: h.name, type: 'Unknown', asset_class: 'Unknown', countries: {},
            developed_market: 100, emerging_market: 0, risk: 5,
            volatility_1y: null, volatility_3y: null, volatility_5y: null,
            max_drawdown: null, source: 'unavailable', estimated: true,
        };
    }

    // ------------------------------------------------------------------
    // Aggregations
    // ------------------------------------------------------------------
    function totalPortfolio() { return state.totalInvested + effectiveCash(); }
    function effectiveCash() { return state.cashOverride !== null ? state.cashOverride : state.cash; }

    function aggregate(valueOf) {
        // valueOf: holding -> € value. Returns aggregates incl. cash.
        const byClass = {}, byCountry = {};
        let dev = 0, emg = 0, riskWeighted = 0, volWeighted = 0, volCovered = 0, ddWeighted = 0, ddCovered = 0, total = 0;

        const all = Object.values(state.holdings).concat(Object.values(state.pseudoAssets));
        all.forEach(h => {
            const v = valueOf(h);
            if (v <= 0) return;
            total += v;
            const m = h.meta;
            const cls = m.asset_class || 'Unknown';
            byClass[cls] = (byClass[cls] || 0) + v;
            dev += (m.developed_market / 100) * v;
            emg += (m.emerging_market / 100) * v;
            riskWeighted += (m.risk || 5) * v;
            const vol = m.volatility_5y ?? m.volatility_3y ?? m.volatility_1y;
            if (vol !== null && vol !== undefined) { volWeighted += vol * v; volCovered += v; }
            if (m.max_drawdown !== null && m.max_drawdown !== undefined) { ddWeighted += m.max_drawdown * v; ddCovered += v; }
            const countries = m.countries || {};
            const known = Object.entries(countries);
            if (known.length) {
                known.forEach(([c, pct]) => { byCountry[c] = (byCountry[c] || 0) + (pct / 100) * v; });
            } else {
                byCountry['Unknown'] = (byCountry['Unknown'] || 0) + v;
            }
        });

        const cash = valueOf.cash !== undefined ? valueOf.cash : effectiveCash();
        if (cash > 0) {
            byClass['Cash'] = (byClass['Cash'] || 0) + cash;
            riskWeighted += 1 * cash;
            volWeighted += 0; volCovered += cash;   // cash volatility ~ 0
            total += cash;
        }

        return {
            total, byClass, byCountry, dev, emg,
            risk: total ? riskWeighted / total : 0,
            vol: volCovered ? volWeighted / volCovered : null,
            volCoverage: total ? volCovered / total : 0,
            dd: ddCovered ? ddWeighted / ddCovered : null,
        };
    }

    const currentAgg = () => aggregate(h => h.invested || 0);

    // ------------------------------------------------------------------
    // Dashboard rendering
    // ------------------------------------------------------------------
    function renderAll() {
        const agg = currentAgg();
        renderMetrics(agg);
        renderRiskProfile(agg);
        renderMainCharts(agg);
        renderHoldingsTable();
        renderTargetSliders(agg);
        renderGrowthInputs();
        renderPlanTable();
        renderSimulation();
    }

    $('edit-cash').addEventListener('click', () => {
        const v = prompt('Current cash balance (€) — detected value may be off if the export is partial:', effectiveCash().toFixed(2));
        if (v !== null && !isNaN(parseNumber(v))) {
            state.cashOverride = Math.max(0, parseNumber(v));
            renderAll();
        }
    });

    function renderMetrics(agg) {
        $('total-value').textContent = fmtEUR(agg.total);
        $('invested-value').textContent = fmtEUR(state.totalInvested);
        $('cash-value').textContent = fmtEUR(effectiveCash());
        $('risk-score').textContent = agg.risk.toFixed(1) + ' / 7';
        $('risk-score-label').textContent = riskLabel(agg.risk).name;
    }

    function riskLabel(score) {
        if (score < 2) return { name: 'Conservative', color: STATUS.good, desc: 'Capital preservation focus. Very low expected fluctuations.' };
        if (score < 3.5) return { name: 'Cautious', color: STATUS.good, desc: 'Low volatility. Small temporary losses possible.' };
        if (score < 4.5) return { name: 'Balanced', color: STATUS.warning, desc: 'Moderate volatility. Temporary drops of 10–20% are normal.' };
        if (score < 5.5) return { name: 'Growth', color: STATUS.serious, desc: 'Equity-driven portfolio. Expect drops of 20–35% in bad markets.' };
        if (score < 6.5) return { name: 'Aggressive', color: STATUS.critical, desc: 'High volatility. Drawdowns beyond 35% are possible.' };
        return { name: 'Speculative', color: STATUS.critical, desc: 'Very high risk of large and prolonged losses.' };
    }

    function renderRiskProfile(agg) {
        const label = riskLabel(agg.risk);
        const scale = $('risk-scale');
        scale.innerHTML = '';
        for (let i = 1; i <= 7; i++) {
            const seg = document.createElement('div');
            seg.className = 'risk-seg';
            seg.textContent = i;
            if (Math.round(agg.risk) === i) {
                seg.classList.add('active');
                seg.style.background = label.color;
            }
            scale.appendChild(seg);
        }
        $('risk-description').innerHTML = `<strong style="color:${label.color}">${label.name}</strong> — ${label.desc}`;
        $('risk-vol').textContent = agg.vol !== null ? `${agg.vol.toFixed(1)}% p.a.` : 'n/a';
        $('risk-dd').textContent = agg.dd !== null ? `${agg.dd.toFixed(1)}%` : 'n/a';
        const devP = agg.total ? (agg.dev / (agg.dev + agg.emg || 1)) * 100 : 0;
        $('developed-pct').textContent = fmtPct(devP);
        $('emerging-pct').textContent = fmtPct(100 - devP);

        // Warnings
        const warnings = [];
        const holdings = Object.values(state.holdings);
        const top = holdings.slice().sort((a, b) => b.invested - a.invested)[0];
        if (top && top.invested / agg.total > 0.25 && top.meta.type !== 'ETF') {
            warnings.push(['critical', `Concentration risk: <strong>${top.meta.name}</strong> is ${fmtPct(top.invested / agg.total * 100)} of your portfolio and it is a single company.`]);
        }
        const topCountry = Object.entries(agg.byCountry).sort((a, b) => b[1] - a[1])[0];
        if (topCountry && topCountry[1] / agg.total > 0.6 && topCountry[0] !== 'Unknown') {
            warnings.push(['serious', `Geographic concentration: ~${fmtPct(topCountry[1] / agg.total * 100)} of your portfolio is exposed to <strong>${topCountry[0]}</strong>.`]);
        }
        const emgP = 100 - devP;
        if (emgP > 30) warnings.push(['warning', `Emerging markets are ${fmtPct(emgP)} of your equity exposure — higher volatility and currency risk.`]);
        const defensive = ((agg.byClass['Bonds'] || 0) + (agg.byClass['Cash'] || 0)) / agg.total;
        if (defensive < 0.1) warnings.push(['warning', `Less than 10% in bonds/cash: your portfolio has almost no defensive cushion in a downturn.`]);
        const estimated = holdings.filter(h => h.meta.estimated);
        if (estimated.length) warnings.push(['warning', `No web data found for: ${estimated.map(h => h.meta.name).join(', ')} — defaults were applied.`]);
        if (agg.volCoverage < 0.7) warnings.push(['warning', `Volatility data covers only ${fmtPct(agg.volCoverage * 100)} of the portfolio — the risk estimate is partial.`]);
        if (!warnings.length) warnings.push(['good', 'No major concentration or data-quality issues detected. Nicely diversified!']);

        $('risk-warnings').innerHTML = warnings.map(([lvl, msg]) =>
            `<div class="suggestion-item" style="border-left-color:${STATUS[lvl] || STATUS.warning}">${lvl === 'good' ? '✅' : '⚠️'} ${msg}</div>`
        ).join('');
    }

    function makeChart(id, config) {
        if (state.charts[id]) state.charts[id].destroy();
        state.charts[id] = new Chart($(id).getContext('2d'), config);
    }

    function doughnut(id, labels, values, colors) {
        makeChart(id, {
            type: 'doughnut',
            data: { labels, datasets: [{ data: values, backgroundColor: colors, borderColor: '#0b0f19', borderWidth: 2 }] },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: {
                    legend: { position: 'right' },
                    tooltip: { callbacks: { label: (c) => ` ${c.label}: ${fmtEUR(c.parsed)} (${fmtPct(c.parsed / values.reduce((a, b) => a + b, 0) * 100)})` } },
                },
            },
        });
    }

    function renderMainCharts(agg) {
        const classes = Object.entries(agg.byClass).sort((a, b) => b[1] - a[1]);
        doughnut('assetClassChart', classes.map(c => c[0]), classes.map(c => c[1]), classes.map(c => CLASS_COLORS[c[0]] || MUTED));

        const sorted = Object.entries(agg.byCountry).sort((a, b) => b[1] - a[1]);
        const top9 = sorted.slice(0, 9);
        const otherSum = sorted.slice(9).reduce((s, c) => s + c[1], 0);
        const labels = top9.map(c => c[0]).concat(otherSum > 0 ? ['Other'] : []);
        const values = top9.map(c => c[1]).concat(otherSum > 0 ? [otherSum] : []);
        const colors = top9.map((c, i) => (c[0] === 'Unknown' || c[0] === 'Other') ? MUTED : SERIES[i % SERIES.length]).concat(otherSum > 0 ? [MUTED] : []);
        doughnut('countryChart', labels, values, colors);

        doughnut('devEmgChart', ['Developed', 'Emerging'], [agg.dev, agg.emg], [SERIES[0], SERIES[2]]);

        const top5 = Object.values(state.holdings).sort((a, b) => b.invested - a.invested).slice(0, 5);
        makeChart('topHoldingsChart', {
            type: 'bar',
            data: {
                labels: top5.map(h => h.meta.name.length > 28 ? h.meta.name.substring(0, 28) + '…' : h.meta.name),
                datasets: [{ data: top5.map(h => h.invested), backgroundColor: top5.map(h => CLASS_COLORS[h.meta.asset_class] || MUTED), borderRadius: 4, maxBarThickness: 28 }],
            },
            options: {
                indexAxis: 'y', responsive: true, maintainAspectRatio: false,
                plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ` ${fmtEUR(c.parsed.x)}` } } },
                scales: { x: { grid: { color: '#2c2c2a' } }, y: { grid: { display: false } } },
            },
        });
    }

    function renderHoldingsTable() {
        const tbody = $('holdings-table').querySelector('tbody');
        const total = totalPortfolio();
        const rows = Object.values(state.holdings).sort((a, b) => b.invested - a.invested).map(h => {
            const m = h.meta;
            const vol = m.volatility_5y ?? m.volatility_3y ?? m.volatility_1y;
            return `<tr>
                <td><strong>${m.name}</strong><br><span class="text-sm text-gray">${h.isin}</span></td>
                <td>${m.type}</td>
                <td><span class="class-dot" style="background:${CLASS_COLORS[m.asset_class] || MUTED}"></span>${m.asset_class}</td>
                <td class="num">${fmtEUR(h.invested)}</td>
                <td class="num">${fmtPct(h.invested / total * 100)}</td>
                <td class="num">${m.risk ?? '–'}</td>
                <td class="num">${vol != null ? vol.toFixed(1) + '%' : '–'}</td>
                <td class="text-sm text-gray">${m.source}</td>
            </tr>`;
        });
        rows.push(`<tr>
            <td><strong>Cash</strong></td><td>Cash</td>
            <td><span class="class-dot" style="background:${CLASS_COLORS['Cash']}"></span>Cash</td>
            <td class="num">${fmtEUR(effectiveCash())}</td>
            <td class="num">${fmtPct(effectiveCash() / total * 100)}</td>
            <td class="num">1</td><td class="num">0%</td><td class="text-sm text-gray">account balance</td>
        </tr>`);
        tbody.innerHTML = rows.join('');
    }

    // ------------------------------------------------------------------
    // Simulator
    // ------------------------------------------------------------------
    function initSimulatorDefaults() {
        const agg = currentAgg();
        // Targets default to current allocation, rounded
        state.targets = {};
        const classList = ['Stocks', 'Bonds', 'Cash'];
        Object.keys(agg.byClass).forEach(c => { if (!classList.includes(c)) classList.push(c); });
        let remaining = 100;
        classList.forEach((c, i) => {
            const pct = i === classList.length - 1 ? remaining : Math.round((agg.byClass[c] || 0) / agg.total * 100);
            state.targets[c] = Math.max(0, pct);
            remaining -= pct;
        });
        // Plan defaults: proportional to current weights of invested securities
        const monthly = parseFloat($('sim-monthly').value) || 0;
        state.planInputs = {};
        Object.values(state.holdings).forEach(h => {
            state.planInputs[h.isin] = state.totalInvested > 0 ? Math.round(monthly * h.invested / state.totalInvested) : 0;
        });
        state.pseudoAssets = {};
    }

    function renderTargetSliders(agg) {
        const container = $('target-sliders');
        container.innerHTML = '';
        Object.keys(state.targets).forEach(cls => {
            const currentPct = (agg.byClass[cls] || 0) / agg.total * 100;
            const group = document.createElement('div');
            group.className = 'slider-group';
            group.innerHTML = `
                <label>
                    <span><span class="class-dot" style="background:${CLASS_COLORS[cls] || MUTED}"></span>${cls} <span class="text-sm text-gray">(now ${fmtPct(currentPct)})</span></span>
                    <span id="target-val-${cls}">${state.targets[cls]}%</span>
                </label>
                <input type="range" min="0" max="100" step="1" value="${state.targets[cls]}" data-class="${cls}">`;
            container.appendChild(group);
            group.querySelector('input').addEventListener('input', (e) => {
                setTarget(cls, parseInt(e.target.value, 10));
                Object.keys(state.targets).forEach(c => {
                    const inp = container.querySelector(`input[data-class="${c}"]`);
                    if (inp) { inp.value = state.targets[c]; $(`target-val-${c}`).textContent = `${state.targets[c]}%`; }
                });
                renderSimulation();
            });
        });
    }

    function setTarget(changed, value) {
        state.targets[changed] = value;
        const others = Object.keys(state.targets).filter(c => c !== changed);
        const rest = 100 - value;
        const otherSum = others.reduce((s, c) => s + state.targets[c], 0);
        others.forEach((c, i) => {
            if (otherSum > 0) state.targets[c] = Math.round(state.targets[c] / otherSum * rest);
            else state.targets[c] = Math.round(rest / others.length);
        });
        // Fix rounding drift on the last one
        const sum = Object.values(state.targets).reduce((a, b) => a + b, 0);
        if (others.length) state.targets[others[others.length - 1]] += 100 - sum;
    }

    function renderPlanTable() {
        const tbody = $('plan-table').querySelector('tbody');
        const total = totalPortfolio();
        const entries = Object.values(state.holdings).map(h => ({ id: h.isin, name: h.meta.name, cls: h.meta.asset_class, weight: h.invested / total }))
            .concat(Object.entries(state.pseudoAssets).map(([id, p]) => ({ id, name: p.meta.name, cls: p.meta.asset_class, weight: 0 })));
        tbody.innerHTML = entries.map(e => `<tr>
            <td>${e.name}</td>
            <td><span class="class-dot" style="background:${CLASS_COLORS[e.cls] || MUTED}"></span>${e.cls}</td>
            <td class="num">${fmtPct(e.weight * 100)}</td>
            <td class="num"><input type="number" class="plan-input" data-id="${e.id}" min="0" step="5" value="${Math.round(state.planInputs[e.id] || 0)}"></td>
        </tr>`).join('');
        tbody.querySelectorAll('.plan-input').forEach(inp => {
            inp.addEventListener('input', () => {
                state.planInputs[inp.dataset.id] = parseFloat(inp.value) || 0;
                renderSimulation();
            });
        });
    }

    $('sim-monthly').addEventListener('input', renderSimulation);
    $('sim-growth').addEventListener('change', renderSimulation);
    $('tax-rate').addEventListener('input', renderSimulation);
    $('withdrawal-amount').addEventListener('input', renderSimulation);
    $('withdrawal-month').addEventListener('input', renderSimulation);

    // --- Horizon control: months/years toggle + presets ----------------
    function horizonLabel() {
        const m = state.horizonMonths;
        return m % 12 === 0 && m >= 12 ? `${m / 12} ${m === 12 ? 'year' : 'years'}` : `${m} months`;
    }

    function syncHorizonControls() {
        const slider = $('sim-months');
        if (state.horizonUnit === 'years') {
            slider.min = 1; slider.max = 40; slider.step = 1;
            slider.value = Math.max(1, Math.round(state.horizonMonths / 12));
        } else {
            slider.min = 1; slider.max = 480; slider.step = 1;
            slider.value = state.horizonMonths;
        }
        $('sim-months-label').textContent = horizonLabel();
        document.querySelectorAll('#horizon-unit button').forEach(b =>
            b.classList.toggle('active', b.dataset.unit === state.horizonUnit));
        document.querySelectorAll('#horizon-presets button').forEach(b =>
            b.classList.toggle('active', parseInt(b.dataset.months, 10) === state.horizonMonths));
    }

    $('sim-months').addEventListener('input', () => {
        const v = parseInt($('sim-months').value, 10);
        state.horizonMonths = state.horizonUnit === 'years' ? v * 12 : v;
        syncHorizonControls();
        renderSimulation();
    });

    document.querySelectorAll('#horizon-unit button').forEach(btn =>
        btn.addEventListener('click', () => {
            state.horizonUnit = btn.dataset.unit;
            syncHorizonControls();
        }));

    document.querySelectorAll('#horizon-presets button').forEach(btn =>
        btn.addEventListener('click', () => {
            state.horizonMonths = parseInt(btn.dataset.months, 10);
            state.horizonUnit = state.horizonMonths >= 12 ? 'years' : 'months';
            syncHorizonControls();
            renderSimulation();
        }));

    syncHorizonControls();

    function projectedValue(v0, monthly, months, annualRate, withGrowth) {
        if (!withGrowth || annualRate === 0) return v0 + monthly * months;
        const r = Math.pow(1 + annualRate, 1 / 12) - 1;
        const g = Math.pow(1 + r, months);
        return v0 * g + monthly * ((g - 1) / r);
    }

    function renderSimulation() {
        const months = state.horizonMonths;
        const monthlyTotal = parseFloat($('sim-monthly').value) || 0;
        const withGrowth = $('sim-growth').checked;
        const taxRate = Math.max(0, parseFloat($('tax-rate').value) || 0);

        const allocated = Object.values(state.planInputs).reduce((a, b) => a + (b || 0), 0);
        const cashMonthly = monthlyTotal - allocated;
        const balanceEl = $('plan-balance');
        if (cashMonthly < -0.01) {
            balanceEl.innerHTML = `<span style="color:${STATUS.critical}">⚠️ Your per-asset plan (${fmtEUR(allocated)}/month) exceeds the monthly budget (${fmtEUR(monthlyTotal)}/month).</span>`;
        } else {
            balanceEl.textContent = `${fmtEUR(allocated)}/month invested in securities, ${fmtEUR(Math.max(0, cashMonthly))}/month accumulating as cash.`;
        }

        // pseudo assets have id keys in planInputs
        const makeValueOf = (m, scenarioIdx = null) => {
            const vOf = (h) => projectedValue(h.invested || 0, state.planInputs[h.isin || h.id] || 0, m,
                rateFor(h.meta.asset_class, scenarioIdx), withGrowth);
            vOf.cash = projectedValue(effectiveCash(), Math.max(0, cashMonthly), m, rateFor('Cash', scenarioIdx), withGrowth);
            return vOf;
        };
        const valueOf = makeValueOf(months);

        const cur = currentAgg();
        const proj = aggregate(valueOf);

        // --- Current vs projected vs target grouped bars -----------------
        const classList = Object.keys(state.targets);
        makeChart('projectionChart', {
            type: 'bar',
            data: {
                labels: classList,
                datasets: [
                    { label: 'Current', data: classList.map(c => (cur.byClass[c] || 0) / cur.total * 100), backgroundColor: MUTED, borderRadius: 4, maxBarThickness: 32 },
                    { label: `Projected (${horizonLabel()})`, data: classList.map(c => (proj.byClass[c] || 0) / proj.total * 100), backgroundColor: SERIES[0], borderRadius: 4, maxBarThickness: 32 },
                    { label: 'Target', data: classList.map(c => state.targets[c]), backgroundColor: SERIES[1], borderRadius: 4, maxBarThickness: 32 },
                ],
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${fmtPct(c.parsed.y)}` } } },
                scales: {
                    y: { grid: { color: '#2c2c2a' }, ticks: { callback: v => v + '%' }, max: 100 },
                    x: { grid: { display: false } },
                },
            },
        });

        // --- Projected countries -----------------------------------------
        const sorted = Object.entries(proj.byCountry).sort((a, b) => b[1] - a[1]);
        const top9 = sorted.slice(0, 9);
        const otherSum = sorted.slice(9).reduce((s, c) => s + c[1], 0);
        doughnut('projCountryChart',
            top9.map(c => c[0]).concat(otherSum > 0 ? ['Other'] : []),
            top9.map(c => c[1]).concat(otherSum > 0 ? [otherSum] : []),
            top9.map((c, i) => (c[0] === 'Unknown' || c[0] === 'Other') ? MUTED : SERIES[i % SERIES.length]).concat(otherSum > 0 ? [MUTED] : []));

        // --- Value over time ----------------------------------------------
        const steps = [];
        const stepCount = Math.min(months, 24);
        for (let i = 0; i <= stepCount; i++) steps.push(Math.round(i * months / stepCount));
        const series = steps.map(m => aggregate(makeValueOf(m)).total);
        const principalAt = (m) => totalPortfolio() + monthlyTotal * m;
        const netSeries = series.map((v, i) => v - Math.max(0, v - principalAt(steps[i])) * taxRate / 100);
        makeChart('projValueChart', {
            type: 'line',
            data: {
                labels: steps.map(fmtMonthTick),
                datasets: [
                    { label: 'Gross value', data: series, borderColor: SERIES[0], backgroundColor: 'rgba(57,135,229,0.15)', fill: true, borderWidth: 2, pointRadius: 0, tension: 0.3 },
                    { label: `Net after ${taxRate}% tax (if liquidated)`, data: netSeries, borderColor: SERIES[2], backgroundColor: 'transparent', borderWidth: 2, borderDash: [6, 4], pointRadius: 0, tension: 0.3 },
                ],
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { position: 'top' }, tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${fmtEUR(c.parsed.y)}` } } },
                scales: { y: { grid: { color: '#2c2c2a' }, ticks: { callback: v => '€' + Math.round(v / 1000) + 'k' } }, x: { grid: { display: false } } },
            },
        });

        // --- Summary --------------------------------------------------------
        const gaps = classList.map(c => {
            const projPct = (proj.byClass[c] || 0) / proj.total * 100;
            return { cls: c, gap: projPct - state.targets[c], projPct };
        }).sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
        const worst = gaps[0];
        const lines = [];
        lines.push(`In <strong>${horizonLabel()}</strong> your portfolio is projected at <strong>${fmtEUR(proj.total)}</strong> with risk score <strong>${proj.risk.toFixed(1)}/7 (${riskLabel(proj.risk).name})</strong> vs ${cur.risk.toFixed(1)}/7 today.`);
        if (Math.abs(worst.gap) <= 2) {
            lines.push(`🎯 This plan reaches your target allocation (all classes within ±2%).`);
        } else {
            lines.push(`📐 Largest remaining gap: <strong>${worst.cls}</strong> projected at ${fmtPct(worst.projPct)} vs ${state.targets[worst.cls]}% target (${worst.gap > 0 ? '+' : ''}${worst.gap.toFixed(1)}%). Use "Suggest plan" to close it with new contributions.`);
        }
        const finalPrincipal = principalAt(months);
        const finalTaxableGain = Math.max(0, proj.total - finalPrincipal);
        const finalNet = proj.total - finalTaxableGain * taxRate / 100;
        lines.push(`If fully liquidated at the end of the horizon, ${taxRate}% capital gains tax on the ${fmtEUR(finalTaxableGain)} taxable gain would leave you with <strong>${fmtEUR(finalNet)}</strong> net (vs ${fmtEUR(proj.total)} gross).`);
        $('sim-summary').innerHTML = lines.map(l => `<div class="suggestion-item">${l}</div>`).join('');

        renderScenarios(months, cashMonthly, monthlyTotal, taxRate);
        renderGoalPlanner();
        renderWithdrawalSim(months, cashMonthly, taxRate);
    }

    // ------------------------------------------------------------------
    // What-if: editable expected returns + market scenarios
    // ------------------------------------------------------------------
    function renderGrowthInputs() {
        const container = $('growth-inputs');
        container.innerHTML = '';
        Object.keys(state.targets).forEach(cls => {
            const div = document.createElement('div');
            div.className = 'sim-control';
            div.innerHTML = `
                <label><span class="class-dot" style="background:${CLASS_COLORS[cls] || MUTED}"></span>${cls} expected return (%/year)</label>
                <input type="number" step="0.5" min="-10" max="20" value="${state.growthRates[cls] ?? DEFAULT_GROWTH_PCT[cls] ?? 5}" data-growth="${cls}">`;
            container.appendChild(div);
            div.querySelector('input').addEventListener('input', (e) => {
                state.growthRates[cls] = parseFloat(e.target.value) || 0;
                renderSimulation();
            });
        });
    }

    function scenarioValueOf(m, scenarioIdx, cashMonthly) {
        const vOf = (h) => projectedValue(h.invested || 0, state.planInputs[h.isin || h.id] || 0, m,
            rateFor(h.meta.asset_class, scenarioIdx), true);
        vOf.cash = projectedValue(effectiveCash(), Math.max(0, cashMonthly), m, rateFor('Cash', scenarioIdx), true);
        return vOf;
    }

    function renderScenarios(months, cashMonthly, monthlyTotal, taxRate) {
        const stepCount = Math.min(months, 24);
        const steps = [];
        for (let i = 0; i <= stepCount; i++) steps.push(Math.round(i * months / stepCount));

        const datasets = SCENARIOS.map(s => ({
            label: s.label,
            data: steps.map(m => aggregate(scenarioValueOf(m, s.idx, cashMonthly)).total),
            borderColor: s.color,
            backgroundColor: 'transparent',
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.3,
            borderDash: s.idx === null ? [] : [6, 4],
        }));

        makeChart('scenarioChart', {
            type: 'line',
            data: { labels: steps.map(fmtMonthTick), datasets },
            options: {
                responsive: true, maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: { tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${fmtEUR(c.parsed.y)}` } } },
                scales: {
                    y: { grid: { color: '#2c2c2a' }, ticks: { callback: v => '€' + Math.round(v / 1000) + 'k' } },
                    x: { grid: { display: false } },
                },
            },
        });

        const paidIn = totalPortfolio() + monthlyTotal * months;
        $('scenario-summary').innerHTML = SCENARIOS.map((s, i) => {
            const v = datasets[i].data[datasets[i].data.length - 1];
            const gain = v - paidIn;
            const net = v - Math.max(0, gain) * taxRate / 100;
            return `<div class="suggestion-item" style="border-left-color:${s.color}">
                <strong>${s.label}:</strong> ${fmtEUR(v)} gross after ${horizonLabel()} —
                ${gain >= 0 ? '+' : ''}${fmtEUR(gain)} vs the ${fmtEUR(paidIn)} paid in. Net of ${taxRate}% capital gains tax: <strong>${fmtEUR(net)}</strong>.</div>`;
        }).join('');
    }

    // ------------------------------------------------------------------
    // Partial withdrawal simulator: tax due now + growth impact
    // ------------------------------------------------------------------
    function renderWithdrawalSim(months, cashMonthly, taxRate) {
        const amount = parseFloat($('withdrawal-amount').value) || 0;
        const atMonth = parseInt($('withdrawal-month').value, 10) || 0;
        const el = $('withdrawal-result');
        const valid = amount > 0 && atMonth > 0 && atMonth < months;

        if (!valid) {
            el.innerHTML = `<div class="suggestion-item">Set a withdrawal amount and a month within the horizon (1–${Math.max(1, months - 1)}) to simulate a partial cash-out.</div>`;
            if (state.charts['withdrawalChart']) { state.charts['withdrawalChart'].destroy(); delete state.charts['withdrawalChart']; }
            return;
        }

        const assets = Object.values(state.holdings).concat(Object.values(state.pseudoAssets)).map(h => ({
            v0: h.invested || 0, monthly: state.planInputs[h.isin || h.id] || 0, rate: rateFor(h.meta.asset_class, null),
        }));
        assets.push({ v0: effectiveCash(), monthly: Math.max(0, cashMonthly), rate: rateFor('Cash', null) });

        // Totals at month m; withdraw=true applies the pro-rata cash-out at atMonth for m beyond it.
        function totalsAt(m, withdraw) {
            if (!withdraw || m <= atMonth) {
                let total = 0, principal = 0;
                assets.forEach(a => { total += projectedValue(a.v0, a.monthly, m, a.rate, true); principal += a.v0 + a.monthly * m; });
                return { total, principal };
            }
            const atW = assets.map(a => ({
                fv: projectedValue(a.v0, a.monthly, atMonth, a.rate, true),
                principal: a.v0 + a.monthly * atMonth,
                rate: a.rate, monthly: a.monthly,
            }));
            const fvSum = atW.reduce((s, a) => s + a.fv, 0);
            const w = Math.min(amount, Math.max(0, fvSum));
            const keep = fvSum > 0 ? Math.max(0, (fvSum - w) / fvSum) : 1;
            const rem = m - atMonth;
            let total = 0, principal = 0;
            atW.forEach(a => {
                total += projectedValue(a.fv * keep, a.monthly, rem, a.rate, true);
                principal += a.principal * keep + a.monthly * rem;
            });
            return { total, principal };
        }

        // Tax due on the withdrawal itself, based on the gain fraction at that point.
        // Capped to what's actually available — you can't withdraw more than the projected balance.
        const atW = totalsAt(atMonth, false);
        const withdrawn = Math.min(amount, Math.max(0, atW.total));
        const capped = withdrawn < amount - 0.01;
        const gainFraction = atW.total > 0 ? Math.max(0, atW.total - atW.principal) / atW.total : 0;
        const withdrawTax = withdrawn * gainFraction * taxRate / 100;
        const netReceived = withdrawn - withdrawTax;

        const stepCount = Math.min(months, 24);
        const steps = [];
        for (let i = 0; i <= stepCount; i++) steps.push(Math.round(i * months / stepCount));
        const noWithdraw = steps.map(m => totalsAt(m, false).total);
        const withWithdraw = steps.map(m => totalsAt(m, true).total);

        makeChart('withdrawalChart', {
            type: 'line',
            data: {
                labels: steps.map(fmtMonthTick),
                datasets: [
                    { label: 'No withdrawal', data: noWithdraw, borderColor: MUTED, backgroundColor: 'transparent', borderWidth: 2, pointRadius: 0, tension: 0.3 },
                    { label: 'With withdrawal', data: withWithdraw, borderColor: SERIES[5], backgroundColor: 'transparent', borderWidth: 2, borderDash: [6, 4], pointRadius: 0, tension: 0.3 },
                ],
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: { legend: { position: 'top' }, tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${fmtEUR(c.parsed.y)}` } } },
                scales: { y: { grid: { color: '#2c2c2a' }, ticks: { callback: v => '€' + Math.round(v / 1000) + 'k' } }, x: { grid: { display: false } } },
            },
        });

        const finalNo = totalsAt(months, false);
        const finalWith = totalsAt(months, true);
        const finalNoNet = finalNo.total - Math.max(0, finalNo.total - finalNo.principal) * taxRate / 100;
        const finalWithNet = finalWith.total - Math.max(0, finalWith.total - finalWith.principal) * taxRate / 100;
        const growthDelta = finalWith.total - finalNo.total; // always <= 0: less capital left to compound

        el.innerHTML = `
            <div class="suggestion-item" style="border-left-color:${STATUS.warning}">
                At month ${atMonth} (${fmtMonthTick(atMonth)} in), your portfolio is projected at <strong>${fmtEUR(atW.total)}</strong> (cost basis ${fmtEUR(atW.principal)}).
                ${capped ? `You asked for ${fmtEUR(amount)} but only <strong>${fmtEUR(withdrawn)}</strong> is available, so the withdrawal is capped to your projected balance. It` : `Withdrawing <strong>${fmtEUR(withdrawn)}</strong>`}
                realizes ${fmtPct(gainFraction * 100)} gain on that amount, triggering
                <strong>${fmtEUR(withdrawTax)}</strong> in capital gains tax (${taxRate}%) — you'd receive <strong>${fmtEUR(netReceived)}</strong> net in hand.
            </div>
            <div class="suggestion-item">
                By the end of the horizon (${horizonLabel()}): <strong>without</strong> this withdrawal your portfolio reaches ${fmtEUR(finalNo.total)} gross / ${fmtEUR(finalNoNet)} net of tax;
                <strong>with</strong> the withdrawal it reaches ${fmtEUR(finalWith.total)} gross / ${fmtEUR(finalWithNet)} net of tax —
                the reduced remaining capital compounds to ${fmtEUR(Math.abs(growthDelta))} less by the end, on top of the ${fmtEUR(netReceived)} already pocketed at month ${atMonth}.
            </div>`;
    }

    // ------------------------------------------------------------------
    // Goal planner: required monthly contribution to reach a target
    // ------------------------------------------------------------------
    function renderGoalPlanner() {
        const target = parseFloat($('goal-amount').value) || 0;
        const years = parseInt($('goal-years').value, 10) || 0;
        const el = $('goal-result');
        if (target <= 0 || years <= 0) { el.innerHTML = ''; return; }

        const m = years * 12;
        const v0 = totalPortfolio();
        const monthlyNow = parseFloat($('sim-monthly').value) || 0;

        el.innerHTML = SCENARIOS.map(s => {
            // Blended annual return, weighted by the target allocation the PAC converges to
            const blend = Object.keys(state.targets).reduce((sum, c) => sum + (state.targets[c] / 100) * rateFor(c, s.idx), 0);
            const r = Math.pow(1 + blend, 1 / 12) - 1;
            const flat = Math.abs(r) < 1e-9;
            const g = Math.pow(1 + r, m);
            const required = flat ? (target - v0) / m : (target - v0 * g) / ((g - 1) / r);
            const reached = flat ? v0 + monthlyNow * m : v0 * g + monthlyNow * ((g - 1) / r);

            let msg;
            if (required <= 0) {
                msg = `your current portfolio alone is projected to exceed the target — no monthly contribution needed`;
            } else {
                msg = `you need to invest <strong>${fmtEUR(required)}/month</strong>`;
                if (monthlyNow > 0) {
                    const ok = monthlyNow >= required;
                    msg += ` — your current ${fmtEUR(monthlyNow)}/month would get you to ~${fmtEUR(reached)} ${ok ? '✅' : '(short of the goal)'}`;
                }
            }
            return `<div class="suggestion-item" style="border-left-color:${s.color}">
                <strong>${s.label}</strong> (${(blend * 100).toFixed(1)}%/y blended return):
                to reach ${fmtEUR(target)} in ${years} years, ${msg}.</div>`;
        }).join('');
    }

    $('goal-amount').addEventListener('input', renderGoalPlanner);
    $('goal-years').addEventListener('input', renderGoalPlanner);

    // ------------------------------------------------------------------
    // Suggest plan: distribute monthly budget to converge on targets
    // ------------------------------------------------------------------
    $('suggest-plan').addEventListener('click', () => {
        const months = state.horizonMonths;
        const monthlyTotal = parseFloat($('sim-monthly').value) || 0;
        if (monthlyTotal <= 0) { alert('Set a monthly investment amount first.'); return; }

        const cur = currentAgg();
        const futureTotal = cur.total + monthlyTotal * months;
        const budget = monthlyTotal * months;

        // How much each class needs to reach its target share of the future total
        const needs = {};
        Object.keys(state.targets).forEach(c => {
            needs[c] = Math.max(0, (state.targets[c] / 100) * futureTotal - (cur.byClass[c] || 0));
        });
        const needSum = Object.values(needs).reduce((a, b) => a + b, 0);

        const classBudget = {};
        Object.keys(needs).forEach(c => {
            classBudget[c] = needSum > 0 ? budget * needs[c] / needSum : budget * state.targets[c] / 100;
        });

        // Distribute class budgets to holdings of that class (proportional to size)
        state.planInputs = {};
        state.pseudoAssets = {};
        Object.keys(classBudget).forEach(cls => {
            const monthlyForClass = classBudget[cls] / months;
            if (monthlyForClass < 0.5) return;
            if (cls === 'Cash') return; // leftover handling below
            const inClass = Object.values(state.holdings).filter(h => h.meta.asset_class === cls);
            const clsTotal = inClass.reduce((s, h) => s + h.invested, 0);
            if (inClass.length) {
                inClass.forEach(h => {
                    state.planInputs[h.isin] = Math.round(monthlyForClass * (clsTotal > 0 ? h.invested / clsTotal : 1 / inClass.length));
                });
            } else {
                const id = `NEW::${cls}`;
                state.pseudoAssets[id] = {
                    id, invested: 0,
                    meta: { name: `➕ New ${cls} ETF (to be added on Trade Republic)`, type: 'ETF', asset_class: cls, countries: {}, developed_market: 100, emerging_market: 0, risk: cls === 'Bonds' ? 3 : 5, volatility_1y: null, volatility_3y: null, volatility_5y: null, max_drawdown: null, source: 'suggested' },
                };
                state.planInputs[id] = Math.round(monthlyForClass);
            }
        });

        renderPlanTable();
        renderSimulation();
    });
});

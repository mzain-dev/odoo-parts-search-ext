// Stock-outs mode: a quick look at which parts most often go negative or sell
// out, with a button into the full-page report (report/stockouts.html) for
// the day-by-day detail, filters and export. Same data and calculations as
// the report (lib/stockout-analysis.js).
(function () {
  const { $, state, sendToOdoo, showFatalError, clear, emptyNote, buildStatGrid,
    buildLineRow, renderExpandableList } = window.PI;

  // Quantities: whole numbers stay whole ("3", not "3.00").
  const num = (n) => (typeof n === 'number' ? n : 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
  const SA = window.StockoutAnalysis;

  const rangeButtons = Array.from(document.querySelectorAll('#stockouts-range-bar .quick-btn'));
  const openReportBtn = $('stockouts-open-report-btn');
  const refreshBtn = $('stockouts-refresh-btn');
  const loadingEl = $('stockouts-loading');
  const resultsEl = $('stockouts-results');
  const totalsEl = $('stockouts-totals');
  const topEl = $('stockouts-top');

  let preset = 'last30';
  let loaded = false;
  let requestSeq = 0;

  function todayLocal() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function openReport(extra) {
    const params = new URLSearchParams(Object.assign({ tab: String(state.odooTabId || ''), preset }, extra || {}));
    chrome.tabs.create({ url: chrome.runtime.getURL(`report/stockouts.html?${params}`) });
  }

  function partRowNode(r) {
    const flags = [];
    if (r.needsReplenishment) flags.push('needs replenishment');
    else if (r.repeated) flags.push('repeated');
    if (r.negativeNow) flags.push('negative now');
    const row = buildLineRow({
      title: `${r.code || '—'} · ${r.name}`,
      subLines: [
        `Went negative ${r.timesNegative}× · sold out ${r.stockOuts}× · ${r.negativeDays} day${r.negativeDays === 1 ? '' : 's'} negative`,
        r.soldWithoutStock > 0 ? { text: `${num(r.soldWithoutStock)} units sold without stock`, tone: 'danger' } : null,
        flags.length ? { text: flags.join(' · '), tone: 'warning' } : null
      ],
      value: `${num(r.current)} on hand`
    });
    row.classList.add('clickable-row');
    row.title = 'Open day-by-day history';
    row.addEventListener('click', () => openReport({ part: String(r.productId) }));
    return row;
  }

  async function load() {
    const seq = ++requestSeq;
    loaded = true;
    resultsEl.style.display = 'none';
    loadingEl.style.display = 'block';
    refreshBtn.disabled = true;

    const offsetMinutes = -new Date().getTimezoneOffset();
    const range = SA.resolveDateRange(preset, todayLocal());
    const res = await sendToOdoo('GET_STOCKOUT_DATA', { sinceUtc: SA.localMidnightUtc(range.from, offsetMinutes) });
    if (seq !== requestSeq) return;

    loadingEl.style.display = 'none';
    refreshBtn.disabled = false;
    if (!res.ok) { loaded = false; showFatalError(res.error); return; }

    const daily = SA.buildDailyStock(res.data, { from: range.from, to: range.to, offsetMinutes });
    const summary = SA.summarizeParts(daily);
    const t = SA.summaryTotals(summary);
    buildStatGrid(totalsEl, [
      { label: 'Parts affected', value: String(t.parts), sub: `${t.repeated} repeated`, highlight: true },
      { label: 'Sold without stock', value: num(t.soldWithoutStock), sub: 'units' },
      { label: 'Negative now', value: String(t.negativeNow) },
      { label: 'Needs replenishment', value: String(t.needsReplenishment) }
    ]);
    clear(topEl);
    const ranked = SA.rankParts(summary);
    if (!ranked.length) emptyNote(topEl, 'No part went negative or sold out in this period.');
    else renderExpandableList(topEl, ranked, partRowNode, 10);
    resultsEl.style.display = 'block';
  }

  rangeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.preset === preset && loaded) return;
      preset = btn.dataset.preset;
      rangeButtons.forEach((b) => b.classList.toggle('active', b === btn));
      load();
    });
  });
  refreshBtn.addEventListener('click', () => load());
  openReportBtn.addEventListener('click', () => openReport());

  PI.registerMode('stockouts', {
    onShow() {
      if (!loaded) load();
    }
  });
})();

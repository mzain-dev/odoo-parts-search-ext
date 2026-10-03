// Stock-outs mode: a quick look at which parts most often go negative or sell
// out, with a button into the full-page report (report/stockouts.html) for
// the day-by-day detail, filters and export. Same data and calculations as
// the report (lib/stockout-analysis.js).
//
// "Sold on" picks one day and lists only the parts sold with negative stock
// that day (a sale bigger than what was on hand) - not parts that merely sat
// negative or sold out to exactly zero.
(function () {
  const { $, state, sendToOdoo, showFatalError, clear, emptyNote, buildStatGrid,
    buildLineRow, renderExpandableList } = window.PI;

  // Quantities: whole numbers stay whole ("3", not "3.00").
  const num = (n) => (typeof n === 'number' ? n : 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
  const SA = window.StockoutAnalysis;

  const rangeButtons = Array.from(document.querySelectorAll('#stockouts-range-bar .quick-btn'));
  const dateInput = $('stockouts-date');
  const dateClearBtn = $('stockouts-date-clear');
  const openReportBtn = $('stockouts-open-report-btn');
  const refreshBtn = $('stockouts-refresh-btn');
  const loadingEl = $('stockouts-loading');
  const resultsEl = $('stockouts-results');
  const totalsEl = $('stockouts-totals');
  const headingEl = $('stockouts-heading');
  const topEl = $('stockouts-top');

  let preset = 'last30';
  let day = null; // 'YYYY-MM-DD' when "Sold on" is set - overrides the preset
  let loaded = false;
  let requestSeq = 0;

  function todayLocal() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function openReport(extra) {
    const base = day ? { preset: 'date', date: day, soldNeg: '1' } : { preset };
    const params = new URLSearchParams(Object.assign({ tab: String(state.odooTabId || '') }, base, extra || {}));
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
        r.location ? { text: `Location: ${r.location}`, tone: 'info' } : null,
        day
          ? `${r.salesWithoutStock} sale${r.salesWithoutStock === 1 ? '' : 's'} without stock · ${num(r.totalSold)} sold that day`
          : `Went negative ${r.timesNegative}× · sold out ${r.stockOuts}× · ${r.negativeDays} day${r.negativeDays === 1 ? '' : 's'} negative`,
        r.soldWithoutStock > 0 ? { text: `${num(r.soldWithoutStock)} units sold without stock`, tone: 'danger' } : null,
        flags.length ? { text: flags.join(' · '), tone: 'warning' } : null
      ],
      value: `${num(r.current)} on hand`,
      subValue: r.location ? 'at this location' : null
    });
    row.classList.add('clickable-row');
    row.title = 'Open day-by-day history';
    row.addEventListener('click', () => openReport({ part: r.key }));
    return row;
  }

  async function load() {
    const seq = ++requestSeq;
    loaded = true;
    resultsEl.style.display = 'none';
    loadingEl.style.display = 'block';
    refreshBtn.disabled = true;

    const offsetMinutes = -new Date().getTimezoneOffset();
    const range = day ? SA.resolveDateRange('date', todayLocal(), { date: day }) : SA.resolveDateRange(preset, todayLocal());
    const res = await sendToOdoo('GET_STOCKOUT_DATA', { sinceUtc: SA.localMidnightUtc(range.from, offsetMinutes) });
    if (seq !== requestSeq) return;

    loadingEl.style.display = 'none';
    refreshBtn.disabled = false;
    if (!res.ok) { loaded = false; showFatalError(res.error); return; }

    // Per location: a sale is deducted from the shelf it was picked from, so
    // one location can go negative while the part total is still positive.
    const daily = SA.buildDailyStock(res.data, { from: range.from, to: range.to, offsetMinutes, byLocation: true });
    const summary = SA.summarizeParts(daily);
    clear(topEl);

    if (day) {
      const rows = SA.sortRows(SA.filterParts(summary, { onlySoldNegative: true }), 'soldWithoutStock', 'desc', ['salesWithoutStock']);
      const t = SA.summaryTotals(rows);
      buildStatGrid(totalsEl, [
        { label: 'Parts sold in negative', value: String(t.parts), sub: `${t.rows} location${t.rows === 1 ? '' : 's'} · ${day}`, highlight: true },
        { label: 'Sold without stock', value: num(t.soldWithoutStock), sub: 'units' },
        { label: 'Sales', value: String(rows.reduce((s, r) => s + r.salesWithoutStock, 0)), sub: 'without stock' },
        { label: 'Negative now', value: String(t.negativeNow) }
      ]);
      headingEl.textContent = `Sold with negative stock on ${day}`;
      if (!rows.length) emptyNote(topEl, `No part was sold with negative stock on ${day}.`);
      else renderExpandableList(topEl, rows, partRowNode, 10);
    } else {
      const t = SA.summaryTotals(summary);
      buildStatGrid(totalsEl, [
        { label: 'Parts affected', value: String(t.parts), sub: `${t.rows} location${t.rows === 1 ? '' : 's'} · ${t.repeated} repeated`, highlight: true },
        { label: 'Sold without stock', value: num(t.soldWithoutStock), sub: 'units' },
        { label: 'Negative now', value: String(t.negativeNow) },
        { label: 'Needs replenishment', value: String(t.needsReplenishment) }
      ]);
      headingEl.textContent = 'Most frequent stock-outs';
      const ranked = SA.rankParts(summary);
      if (!ranked.length) emptyNote(topEl, 'No part went negative or sold out in this period.');
      else renderExpandableList(topEl, ranked, partRowNode, 10);
    }
    resultsEl.style.display = 'block';
  }

  function setDay(value) {
    day = value || null;
    dateInput.value = day || '';
    dateClearBtn.disabled = !day;
    // A picked day replaces the 7/30 day buttons; clearing it brings them back.
    rangeButtons.forEach((b) => b.classList.toggle('active', !day && b.dataset.preset === preset));
    load();
  }

  rangeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.preset === preset && loaded && !day) return;
      preset = btn.dataset.preset;
      setDay(null);
    });
  });
  dateInput.max = todayLocal();
  dateInput.addEventListener('change', () => setDay(dateInput.value));
  dateClearBtn.addEventListener('click', () => setDay(null));
  refreshBtn.addEventListener('click', () => load());
  openReportBtn.addEventListener('click', () => openReport());

  PI.registerMode('stockouts', {
    onShow() {
      if (!loaded) load();
    }
  });
})();

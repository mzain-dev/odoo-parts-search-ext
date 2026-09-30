// Full-page Stock-outs report. Opened from the popup's Stock-outs mode with
// ?tab=<Odoo tab id>; if that tab is gone it looks for any open Odoo tab.
// All Odoo reads go through the content script on that tab (GET_STOCKOUT_DATA
// in content-scripts/odoo-bridge.js); all calculations are in
// lib/stockout-analysis.js.
(function () {
  const SA = window.StockoutAnalysis;
  const $ = (id) => document.getElementById(id);

  const PAGE_SIZE = 100;

  // ---------------- State ----------------

  const state = {
    tabId: null,
    origin: null,
    preset: 'last30',
    date: null,
    from: null,
    to: null,
    warehouseId: null,
    search: '',
    onlyRepeated: false,
    onlyNegativeNow: false,
    onlyNeedsReplenishment: false,
    minTimes: 0,
    partsSort: { key: 'timesNegative', dir: 'desc' },
    daysSort: { key: 'date', dir: 'desc' },
    daysMode: 'problem',
    selectedProductId: null,
    partsShown: PAGE_SIZE,
    daysShown: PAGE_SIZE
  };

  // Fetched data is kept per start day: a later start (e.g. Last 7 after
  // Last 30) reuses it, since every move from the earlier start is included.
  let cache = null; // { sinceDay, data }
  let view = null; // { daily, summary, filtered, dayRows }
  let requestSeq = 0;

  // Opened from the popup: ?preset=last7|last30 and ?part=<product id> jump
  // straight to that period and part.
  const params = new URLSearchParams(location.search);
  let pendingPartId = Number(params.get('part')) || null;
  if (['today', 'yesterday', 'last7', 'last30'].includes(params.get('preset'))) state.preset = params.get('preset');

  const offsetMinutes = -new Date().getTimezoneOffset();

  function todayLocal() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // ---------------- Formatting ----------------

  function qty(n) {
    if (typeof n !== 'number') return '';
    const r = Math.round(n * 100) / 100;
    return (Object.is(r, -0) ? 0 : r).toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  // "02 Sep, 20 Sep +3 more" - the days a part crossed below zero.
  function shortDates(days) {
    if (!days || !days.length) return '';
    const fmt = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { day: '2-digit', month: 'short', timeZone: 'UTC' });
    const shown = days.slice(0, 3).map(fmt).join(', ');
    return days.length > 3 ? `${shown} +${days.length - 3} more` : shown;
  }

  function niceDate(day) {
    if (!day) return '';
    const d = new Date(`${day}T00:00:00Z`);
    return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
  }

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of [].concat(children || [])) if (c !== null && c !== undefined) node.append(c);
    return node;
  }

  // ---------------- Connection ----------------

  function odooPatterns() {
    const m = chrome.runtime.getManifest();
    return (m.content_scripts && m.content_scripts[0] && m.content_scripts[0].matches) || [];
  }

  function findOdooTab() {
    return new Promise((resolve) => {
      const wanted = Number(new URLSearchParams(location.search).get('tab'));
      chrome.tabs.query({ url: odooPatterns() }, (tabs) => {
        const list = tabs || [];
        resolve(list.find((t) => t.id === wanted) || list[0] || null);
      });
    });
  }

  function send(type, extra) {
    return new Promise((resolve) => {
      if (!state.tabId) { resolve({ ok: false, error: 'No Odoo tab is open.' }); return; }
      chrome.tabs.sendMessage(state.tabId, Object.assign({ type }, extra), (res) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: 'Could not reach the Odoo tab. Reload the Odoo page, then press Refresh.' });
          return;
        }
        resolve(res || { ok: false, error: 'No response from the Odoo tab.' });
      });
    });
  }

  async function connect() {
    const tab = await findOdooTab();
    const conn = $('connection');
    if (!tab) {
      state.tabId = null;
      conn.textContent = 'No Odoo tab open';
      conn.className = 'connection bad';
      return false;
    }
    state.tabId = tab.id;
    try { state.origin = new URL(tab.url).origin; } catch (err) { state.origin = null; }
    conn.textContent = state.origin ? `Connected to ${new URL(state.origin).host}` : 'Connected to Odoo';
    conn.className = 'connection ok';
    return true;
  }

  // ---------------- Loading ----------------

  function showState(which, message) {
    $('loading').hidden = which !== 'loading';
    $('error').hidden = which !== 'error';
    $('content').hidden = which !== 'content';
    if (which === 'error') $('error').textContent = message;
  }

  async function load({ force = false } = {}) {
    const range = SA.resolveDateRange(state.preset, todayLocal(), { date: state.date, from: state.from, to: state.to });
    state.range = range;
    updatePeriodLabel();

    if (!force && cache && cache.sinceDay <= range.from) {
      recompute();
      return;
    }

    const seq = ++requestSeq;
    showState('loading');
    $('refresh-btn').disabled = true;
    if (!state.tabId || force) await connect();
    const res = await send('GET_STOCKOUT_DATA', { sinceUtc: SA.localMidnightUtc(range.from, offsetMinutes) });
    if (seq !== requestSeq) return;
    $('refresh-btn').disabled = false;
    if (!res.ok) { showState('error', res.error); return; }

    cache = { sinceDay: range.from, data: res.data };
    fillWarehouses(res.data.warehouses || []);
    recompute();
  }

  function fillWarehouses(warehouses) {
    const select = $('warehouse-select');
    const current = select.value;
    select.replaceChildren(el('option', { value: '', text: 'All warehouses (combined)' }),
      ...warehouses.map((w) => el('option', { value: String(w.id), text: w.name })));
    select.value = warehouses.some((w) => String(w.id) === current) ? current : '';
    state.warehouseId = select.value ? Number(select.value) : null;
  }

  // ---------------- Compute & render ----------------

  function recompute() {
    const daily = SA.buildDailyStock(cache.data, {
      from: state.range.from, to: state.range.to, offsetMinutes, warehouseId: state.warehouseId
    });
    const summary = SA.summarizeParts(daily);
    view = { daily, summary };
    if (state.selectedProductId && !summary.some((r) => r.productId === state.selectedProductId)) {
      state.selectedProductId = null;
    }
    state.partsShown = PAGE_SIZE;
    state.daysShown = PAGE_SIZE;
    showState('content');
    render();
    if (pendingPartId) {
      const id = pendingPartId;
      pendingPartId = null;
      if (summary.some((r) => r.productId === id)) selectPart(id);
    }
  }

  function filteredParts() {
    const rows = SA.filterParts(view.summary, {
      search: state.search,
      onlyRepeated: state.onlyRepeated,
      onlyNegativeNow: state.onlyNegativeNow,
      onlyNeedsReplenishment: state.onlyNeedsReplenishment,
      minTimes: state.minTimes
    });
    const { key, dir } = state.partsSort;
    return key === 'timesNegative' && dir === 'desc' ? SA.rankParts(rows) : SA.sortRows(rows, key, dir, ['timesNegative', 'soldWithoutStock']);
  }

  function render() {
    const parts = filteredParts();
    view.filtered = parts;
    renderKpis(SA.summaryTotals(view.summary));
    renderPartsTable(parts);
    renderPartDetail();
    renderDaysTable(parts);
  }

  function updatePeriodLabel() {
    const r = state.range;
    $('period-label').textContent = r.from === r.to
      ? `Showing ${niceDate(r.from)}`
      : `Showing ${niceDate(r.from)} – ${niceDate(r.to)}`;
  }

  // KPI tiles double as quick filters where that makes sense.
  function renderKpis(t) {
    const tiles = [
      { label: 'Parts affected', value: t.parts, sub: 'went negative, sold out or sold without stock' },
      { label: 'Repeated offenders', value: t.repeated, sub: 'ran out 2+ times · click to filter', toggle: 'onlyRepeated' },
      { label: 'Times went negative', value: t.negativeEvents, sub: 'all parts, this period' },
      { label: 'Units sold without stock', value: qty(t.soldWithoutStock), sub: 'more than was on hand' },
      { label: 'Negative right now', value: t.negativeNow, sub: 'click to filter', toggle: 'onlyNegativeNow' },
      { label: 'Needs replenishment', value: t.needsReplenishment, sub: 'repeated and none on hand · click to filter', toggle: 'onlyNeedsReplenishment' }
    ];
    $('kpis').replaceChildren(...tiles.map((tile) => {
      const node = el(tile.toggle ? 'button' : 'div', {
        class: tile.toggle ? 'kpi' : 'kpi static',
        type: tile.toggle ? 'button' : null,
        onclick: tile.toggle ? () => setToggle(tile.toggle, !state[tile.toggle]) : null
      }, [
        el('div', { class: 'kpi-label', text: tile.label }),
        el('div', { class: 'kpi-value', text: String(tile.value) }),
        el('div', { class: 'kpi-sub', text: tile.sub })
      ]);
      return node;
    }));
  }

  // ---------------- Tables ----------------

  const PART_COLUMNS = [
    { key: 'code', label: 'Part Number', cls: 'code' },
    { key: 'name', label: 'Part Name', cls: 'name', exportLabel: 'Part Name' },
    { key: 'current', label: 'On Hand Now', num: true, format: qty, neg: (r) => r.current < 0 },
    { key: 'timesNegative', label: 'Times Neg.', title: 'Times the part went below zero', num: true, exportLabel: 'Times Went Negative' },
    { key: 'stockOuts', label: 'Sold Out', title: 'Times a sale took the last unit (stock exactly 0)', num: true, exportLabel: 'Times Sold Out' },
    { key: 'negativeDays', label: 'Days Neg.', title: 'Days that ended with negative stock', num: true, exportLabel: 'Days Negative' },
    { key: 'longestNegativeStretch', label: 'Longest Run', title: 'Longest run of negative days in a row', num: true, exportLabel: 'Longest Negative Run (days)' },
    { key: 'soldWithoutStock', label: 'Sold w/o Stock', title: 'Units sold beyond what was on hand', num: true, format: qty, neg: (r) => r.soldWithoutStock > 0 },
    { key: 'totalSold', label: 'Total Sold', num: true, format: qty },
    { key: 'maxShortage', label: 'Max Shortage', title: 'Lowest balance reached', num: true, format: (v) => (v ? `-${qty(v)}` : '0'), neg: (r) => r.maxShortage > 0 },
    { key: 'wentNegativeDates', label: 'Went Negative On', sortable: false, cls: 'dates', format: shortDates },
    { key: 'lastNegativeDate', label: 'Last Negative', format: niceDate, cls: 'date' }
  ];

  const DAY_COLUMNS = [
    { key: 'date', label: 'Date', format: niceDate, cls: 'date' },
    { key: 'code', label: 'Part Number', cls: 'code' },
    { key: 'name', label: 'Part Name', cls: 'name' },
    { key: 'opening', label: 'On Hand (start)', num: true, format: qty, neg: (r) => r.opening < 0 },
    { key: 'received', label: 'Received', num: true, format: qty, muted: (r) => !r.received },
    { key: 'sold', label: 'Sold', num: true, format: qty, muted: (r) => !r.sold },
    { key: 'returned', label: 'Returned', num: true, format: qty, muted: (r) => !r.returned },
    { key: 'issued', label: 'Other Out', num: true, format: qty, muted: (r) => !r.issued },
    { key: 'closing', label: 'On Hand (end)', num: true, format: qty, neg: (r) => r.closing < 0 },
    { key: 'negativeQty', label: 'Negative Qty', num: true, format: qty, neg: (r) => r.negativeQty < 0, muted: (r) => !r.negativeQty },
    { key: 'soldWithoutStock', label: 'Sold w/o Stock', num: true, format: qty, neg: (r) => r.soldWithoutStock > 0, muted: (r) => !r.soldWithoutStock }
  ];

  function flagBadges(r) {
    const out = [];
    if (r.needsReplenishment) out.push(el('span', { class: 'badge replenish', text: 'Needs replenishment' }));
    if (r.repeated) out.push(el('span', { class: 'badge repeated', text: 'Repeated' }));
    if (r.negativeNow) out.push(el('span', { class: 'badge negnow', text: 'Negative now' }));
    return out;
  }

  function headerRow(columns, sort, onSort) {
    return el('thead', {}, el('tr', {}, columns.map((c) => {
      const sorted = sort.key === c.key;
      return el('th', {
        class: c.num ? 'num' : null,
        scope: 'col',
        'aria-sort': sorted ? (sort.dir === 'asc' ? 'ascending' : 'descending') : null,
        title: c.title || (c.sortable === false ? null : 'Sort'),
        onclick: c.sortable === false ? null : () => onSort(c)
      }, c.label);
    })));
  }

  function cell(c, r) {
    // Part name carries the status badges underneath, instead of a column of its own.
    if (c.key === 'name' && r.repeated !== undefined) {
      const badges = flagBadges(r);
      return el('td', { class: 'name' }, [el('div', { text: r.name }), badges.length ? el('div', { class: 'badges' }, badges) : null]);
    }
    const v = r[c.key];
    const classes = [c.cls, c.num ? 'num' : null, c.neg && c.neg(r) ? 'neg' : null, c.muted && c.muted(r) ? 'muted' : null];
    return el('td', { class: classes.filter(Boolean).join(' ') || null }, c.format ? c.format(v, r) : String(v === null || v === undefined ? '' : v));
  }

  function footer(container, shown, total, noun, onMore) {
    const parts = [el('span', { text: total ? `Showing ${Math.min(shown, total)} of ${total} ${noun}` : '' })];
    if (shown < total) {
      parts.push(el('button', { class: 'btn btn-small', text: `Show ${Math.min(PAGE_SIZE, total - shown)} more`, onclick: onMore }));
    }
    container.replaceChildren(...parts);
  }

  function nextSort(sort, column) {
    if (sort.key === column.key) return { key: column.key, dir: sort.dir === 'asc' ? 'desc' : 'asc' };
    return { key: column.key, dir: column.num || column.key.toLowerCase().includes('date') ? 'desc' : 'asc' };
  }

  function renderPartsTable(parts) {
    const table = $('parts-table');
    const body = el('tbody');
    if (!parts.length) {
      body.append(el('tr', { class: 'empty-row' }, el('td', {
        colspan: PART_COLUMNS.length,
        text: view.summary.length ? 'No parts match these filters.' : 'No part went negative or sold out in this period.'
      })));
    }
    for (const r of parts.slice(0, state.partsShown)) {
      body.append(el('tr', {
        class: `clickable${r.productId === state.selectedProductId ? ' selected' : ''}`,
        onclick: () => selectPart(r.productId === state.selectedProductId ? null : r.productId)
      }, PART_COLUMNS.map((c) => cell(c, r))));
    }
    table.replaceChildren(headerRow(PART_COLUMNS, state.partsSort, (c) => {
      state.partsSort = nextSort(state.partsSort, c);
      render();
    }), body);
    footer($('parts-foot'), state.partsShown, parts.length, 'parts', () => {
      state.partsShown += PAGE_SIZE;
      renderPartsTable(view.filtered);
    });
  }

  function currentDayRows(parts) {
    const productIds = state.selectedProductId ? [state.selectedProductId] : parts.map((r) => r.productId);
    const rows = SA.dayRowsFor(view.daily, parts, { productIds, onlyProblemDays: state.daysMode === 'problem' });
    const { key, dir } = state.daysSort;
    return SA.sortRows(rows, key, dir, key === 'date' ? ['code'] : ['date']);
  }

  function renderDaysTable(parts) {
    const rows = currentDayRows(parts);
    view.dayRows = rows;
    const table = $('days-table');
    const body = el('tbody');
    if (!rows.length) {
      body.append(el('tr', { class: 'empty-row' }, el('td', {
        colspan: DAY_COLUMNS.length,
        text: state.daysMode === 'problem' ? 'No problem days for these parts. Switch to "All days" to see every day.' : 'No days to show.'
      })));
    }
    for (const r of rows.slice(0, state.daysShown)) {
      body.append(el('tr', { class: r.problem ? 'problem' : null }, DAY_COLUMNS.map((c) => cell(c, r))));
    }
    table.replaceChildren(headerRow(DAY_COLUMNS, state.daysSort, (c) => {
      state.daysSort = nextSort(state.daysSort, c);
      renderDaysTable(view.filtered);
    }), body);
    footer($('days-foot'), state.daysShown, rows.length, 'days', () => {
      state.daysShown += PAGE_SIZE;
      renderDaysTable(view.filtered);
    });

    const chip = $('days-filter-chip');
    const selected = state.selectedProductId && view.summary.find((r) => r.productId === state.selectedProductId);
    chip.hidden = !selected;
    if (selected) {
      chip.replaceChildren(
        el('span', { text: `Showing ${selected.code || selected.name} only` }),
        el('button', { title: 'Show all parts', 'aria-label': 'Show all parts', text: '×', onclick: () => selectPart(null) })
      );
    }
  }

  function selectPart(productId) {
    state.selectedProductId = productId;
    state.daysShown = PAGE_SIZE;
    // Looking at one part: show every day so the whole on-hand story is visible.
    setDaysMode(productId ? 'all' : 'problem', false);
    render();
    if (productId) $('part-detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---------------- Selected part: chart ----------------

  function renderPartDetail() {
    const box = $('part-detail');
    const row = state.selectedProductId && view.summary.find((r) => r.productId === state.selectedProductId);
    box.hidden = !row;
    if (!row) return;
    $('part-detail-title').textContent = `${row.code ? `${row.code} · ` : ''}${row.name}`;
    const bits = [
      `On hand now: ${qty(row.current)}`,
      `went negative ${row.timesNegative} time${row.timesNegative === 1 ? '' : 's'}`,
      `sold out ${row.stockOuts} time${row.stockOuts === 1 ? '' : 's'}`,
      `${row.negativeDays} day${row.negativeDays === 1 ? '' : 's'} negative`,
      `${qty(row.soldWithoutStock)} sold without stock`
    ];
    if (row.wentNegativeDates.length) bits.push(`went negative on: ${row.wentNegativeDates.map(niceDate).join(', ')}`);
    if (row.soldOutDates.length) bits.push(`sold out on: ${row.soldOutDates.map(niceDate).join(', ')}`);
    if (row.negativeAtStart) bits.push('already negative at the start of the period');
    $('part-detail-sub').textContent = bits.join(' · ');
    renderChart(view.daily[row.productId].days);
  }

  function niceTicks(min, max, count = 4) {
    const span = max - min || 1;
    const step0 = span / count;
    const mag = 10 ** Math.floor(Math.log10(step0));
    const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= step0) || mag * 10;
    const ticks = [];
    for (let v = Math.floor(min / step) * step; v <= max + 1e-9; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
    return ticks;
  }

  // Bar from the zero line to the value, rounded only at the data end.
  function barPath(x, w, yZero, yVal, r) {
    const up = yVal < yZero;
    const h = Math.abs(yZero - yVal);
    const rr = Math.min(r, w / 2, h);
    if (h < 0.5) return '';
    if (up) {
      return `M${x},${yZero}V${yVal + rr}Q${x},${yVal} ${x + rr},${yVal}H${x + w - rr}Q${x + w},${yVal} ${x + w},${yVal + rr}V${yZero}Z`;
    }
    return `M${x},${yZero}V${yVal - rr}Q${x},${yVal} ${x + rr},${yVal}H${x + w - rr}Q${x + w},${yVal} ${x + w},${yVal - rr}V${yZero}Z`;
  }

  function renderChart(days) {
    const NS = 'http://www.w3.org/2000/svg';
    const W = 1000;
    const H = 230;
    const m = { top: 12, right: 12, bottom: 26, left: 44 };
    const values = days.map((d) => d.closing);
    const lo = Math.min(0, ...values);
    const hi = Math.max(0, ...values);
    const ticks = niceTicks(lo, hi === lo ? lo + 1 : hi);
    const yMin = Math.min(lo, ticks[0]);
    const yMax = Math.max(hi, ticks[ticks.length - 1]);
    const y = (v) => m.top + (yMax - v) / (yMax - yMin || 1) * (H - m.top - m.bottom);
    const band = (W - m.left - m.right) / days.length;
    const gap = Math.min(2, band * 0.2); // 2px surface gap between bars
    const barW = Math.max(1, band - gap);

    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Closing on-hand quantity per day; bars below zero are days the part ended negative.');
    const add = (parent, tag, attrs, text) => {
      const n = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      if (text !== undefined) n.textContent = text;
      parent.appendChild(n);
      return n;
    };

    const grid = add(svg, 'g', { class: 'grid' });
    const axis = add(svg, 'g', { class: 'axis' });
    for (const t of ticks) {
      add(grid, 'line', { x1: m.left, x2: W - m.right, y1: y(t), y2: y(t) });
      add(axis, 'text', { x: m.left - 6, y: y(t) + 3, 'text-anchor': 'end' }, qty(t));
    }
    const every = Math.max(1, Math.ceil(days.length / 10));
    days.forEach((d, i) => {
      if (i % every === 0 || i === days.length - 1) {
        const label = new Date(`${d.date}T00:00:00Z`).toLocaleDateString(undefined, { day: '2-digit', month: 'short', timeZone: 'UTC' });
        add(axis, 'text', { x: m.left + i * band + band / 2, y: H - 8, 'text-anchor': 'middle' }, label);
      }
    });

    const tooltip = $('chart-tooltip');
    const wrap = $('part-chart');
    days.forEach((d, i) => {
      const x = m.left + i * band + gap / 2;
      const path = barPath(x, barW, y(0), y(d.closing), 4);
      const hit = add(svg, 'rect', { class: 'hit', x: m.left + i * band, y: m.top, width: band, height: H - m.top - m.bottom });
      const bar = path ? add(svg, 'path', { class: `bar ${d.closing < 0 ? 'neg' : 'pos'}`, d: path }) : null;
      hit.addEventListener('mousemove', (e) => {
        if (bar) bar.classList.add('hover');
        tooltip.hidden = false;
        tooltip.replaceChildren(
          el('b', { text: niceDate(d.date) }),
          `On hand: ${qty(d.opening)} → ${qty(d.closing)}`,
          el('br'),
          `Sold ${qty(d.sold)} · Received ${qty(d.received)}`,
          d.soldWithoutStock ? el('br') : null,
          d.soldWithoutStock ? `Sold without stock: ${qty(d.soldWithoutStock)}` : null
        );
        const box = wrap.getBoundingClientRect();
        const left = e.clientX - box.left + 12;
        tooltip.style.left = `${Math.min(left, box.width - tooltip.offsetWidth - 4)}px`;
        tooltip.style.top = `${e.clientY - box.top + 12}px`;
      });
      hit.addEventListener('mouseleave', () => {
        if (bar) bar.classList.remove('hover');
        tooltip.hidden = true;
      });
    });
    add(svg, 'line', { class: 'zero', x1: m.left, x2: W - m.right, y1: y(0), y2: y(0) });
    wrap.replaceChildren(svg);
  }

  // ---------------- Export ----------------

  const PART_EXPORT = [
    ...PART_COLUMNS.filter((c) => c.key !== 'wentNegativeDates').map((c) => ({ key: c.key, label: c.exportLabel || c.label })),
    { key: 'wentNegativeDates', label: 'Went Negative On', format: (v) => (v || []).join(' ') },
    { key: 'soldOutDates', label: 'Sold Out On', format: (v) => (v || []).join(' ') },
    { key: 'negativeDates', label: 'All Negative Days', format: (v) => (v || []).join(' ') },
    { key: 'repeated', label: 'Repeated', format: (v) => (v ? 'Yes' : 'No') },
    { key: 'needsReplenishment', label: 'Needs Replenishment', format: (v) => (v ? 'Yes' : 'No') },
    { key: 'negativeNow', label: 'Negative Now', format: (v) => (v ? 'Yes' : 'No') }
  ];
  const DAY_EXPORT = DAY_COLUMNS.map((c) => ({ key: c.key, label: c.label }));

  function fileStamp() {
    const r = state.range;
    const wh = state.warehouseId ? `_wh${state.warehouseId}` : '';
    return r.from === r.to ? `${r.from}${wh}` : `${r.from}_to_${r.to}${wh}`;
  }

  function download(name, text) {
    // BOM so Excel opens UTF-8 (Arabic names etc.) correctly
    const url = URL.createObjectURL(new Blob(['﻿', text], { type: 'text/csv;charset=utf-8' }));
    const a = el('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function flash(btn, text) {
    const original = btn.textContent;
    btn.textContent = text;
    btn.classList.add('done');
    setTimeout(() => { btn.textContent = original; btn.classList.remove('done'); }, 1400);
  }

  function copy(btn, text) {
    navigator.clipboard.writeText(text).then(() => flash(btn, 'Copied!')).catch(() => flash(btn, 'Could not copy'));
  }

  $('export-parts-btn').addEventListener('click', (e) => {
    download(`stockouts-parts_${fileStamp()}.csv`, SA.toDelimited(view.filtered, PART_EXPORT, ','));
    flash(e.currentTarget, 'Downloaded');
  });
  $('copy-parts-btn').addEventListener('click', (e) => copy(e.currentTarget, SA.toDelimited(view.filtered, PART_EXPORT, '\t')));
  $('export-days-btn').addEventListener('click', (e) => {
    download(`stockouts-daywise_${fileStamp()}.csv`, SA.toDelimited(view.dayRows, DAY_EXPORT, ','));
    flash(e.currentTarget, 'Downloaded');
  });
  $('copy-days-btn').addEventListener('click', (e) => copy(e.currentTarget, SA.toDelimited(view.dayRows, DAY_EXPORT, '\t')));

  // ---------------- Filter controls ----------------

  function setToggle(key, value) {
    state[key] = value;
    const box = { onlyRepeated: 'only-repeated', onlyNegativeNow: 'only-negative-now', onlyNeedsReplenishment: 'only-replenish' }[key];
    $(box).checked = value;
    state.partsShown = PAGE_SIZE;
    state.daysShown = PAGE_SIZE;
    if (view) render();
  }

  function setDaysMode(mode, rerender = true) {
    state.daysMode = mode;
    document.querySelectorAll('#days-mode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    state.daysShown = PAGE_SIZE;
    if (rerender && view) renderDaysTable(view.filtered);
  }

  document.querySelectorAll('#period-bar button').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#period-bar button').forEach((b) => b.classList.toggle('active', b === btn));
      state.preset = btn.dataset.preset;
      $('date-single').hidden = state.preset !== 'date';
      $('date-range').hidden = state.preset !== 'range';
      if (state.preset === 'date') {
        state.date = $('date-single-input').value || todayLocal();
        $('date-single-input').value = state.date;
      }
      if (state.preset === 'range') {
        // Prefill with the period currently shown; loads on Apply.
        $('date-from-input').value = state.range ? state.range.from : '';
        $('date-to-input').value = state.range ? state.range.to : todayLocal();
        return;
      }
      load();
    });
  });

  $('date-single-input').addEventListener('change', () => {
    if (!$('date-single-input').value) return;
    state.date = $('date-single-input').value;
    load();
  });

  $('date-apply-btn').addEventListener('click', () => {
    state.from = $('date-from-input').value || null;
    state.to = $('date-to-input').value || null;
    load();
  });

  $('warehouse-select').addEventListener('change', () => {
    state.warehouseId = $('warehouse-select').value ? Number($('warehouse-select').value) : null;
    if (cache) recompute();
  });

  let searchTimer = null;
  $('search-input').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = $('search-input').value;
      state.partsShown = PAGE_SIZE;
      state.daysShown = PAGE_SIZE;
      if (view) render();
    }, 200);
  });

  $('min-times-select').addEventListener('change', () => {
    state.minTimes = Number($('min-times-select').value) || 0;
    if (view) render();
  });
  $('only-repeated').addEventListener('change', (e) => setToggle('onlyRepeated', e.target.checked));
  $('only-negative-now').addEventListener('change', (e) => setToggle('onlyNegativeNow', e.target.checked));
  $('only-replenish').addEventListener('change', (e) => setToggle('onlyNeedsReplenishment', e.target.checked));

  document.querySelectorAll('#days-mode button').forEach((btn) => {
    btn.addEventListener('click', () => setDaysMode(btn.dataset.mode));
  });

  $('part-detail-close').addEventListener('click', () => selectPart(null));
  $('refresh-btn').addEventListener('click', () => load({ force: true }));

  // Today can't be later than today: cap the date pickers.
  for (const id of ['date-single-input', 'date-from-input', 'date-to-input']) $(id).max = todayLocal();

  // ---------------- Start ----------------

  document.querySelectorAll('#period-bar button').forEach((b) => b.classList.toggle('active', b.dataset.preset === state.preset));

  (async () => {
    if (!(await connect())) {
      showState('error', 'Open your Odoo tab (and log in), then press Refresh.');
      return;
    }
    load();
  })();
})();

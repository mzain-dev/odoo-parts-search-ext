(function () {
  const { shapeStockByLocation, computeStockValue, shapeIncomingStock, shapeReservedTransfers,
    shapeCostHistory, sortCostHistory, groupCostHistoryByType, costTrend, vendorComparison, attachLandedCost,
    shapeSalesHistory, sortSalesTransactions, groupSalesByMonth, attachFulfillment,
    marginPerSale, topCustomersForPart, priceDrift } = window.PartData;
  const { shapeCustomerCard, sortOrders, buyingPattern, shapeTopProducts,
    buildOrdersSpreadsheetText, buildCustomerSummaryText } = window.CustomerData;
  const { filterCustomers, parseCustomerSearchText } = window.Filters;

  const $ = (id) => document.getElementById(id);

  const searchTypeToggleEl = document.querySelector('.search-type-toggle');
  const typeButtons = Array.from(document.querySelectorAll('.type-btn'));

  const screens = {
    notOdoo: $('not-odoo-screen'),
    error: $('error-screen'),
    part: $('part-mode'),
    customer: $('customer-mode')
  };
  const errorTextEl = $('error-text');
  const errorBackBtn = $('error-back-btn');

  // ---- Part mode elements ----
  const partSearchAreaEl = $('part-search-area');
  const partSearchBoxEl = $('part-search-box');
  const partLoadingEl = $('part-loading');
  const partSearchResultsEl = $('part-search-results');
  const partNoResultsEl = $('part-no-results');
  const partDetailEl = $('part-detail');
  const partBackBtn = $('part-back-btn');
  const partImageEl = $('part-image');
  const partNameEl = $('part-name');
  const partCodeEl = $('part-code');
  const partDetailLoadingEl = $('part-detail-loading');
  const partTabsWrapEl = $('part-tabs-wrap');
  const tabButtons = Array.from(document.querySelectorAll('.tab-btn'));
  const tabPanels = {
    stock: $('tab-stock'),
    cost: $('tab-cost'),
    sales: $('tab-sales')
  };
  const stockTotalsEl = $('stock-totals');
  const stockLocationsEl = $('stock-locations');
  const stockReservedSectionEl = $('stock-reserved-section');
  const stockReservedEl = $('stock-reserved');
  const stockIncomingEl = $('stock-incoming');
  const costTotalsEl = $('cost-totals');
  const costVendorsEl = $('cost-vendors');
  const costHistoryEl = $('cost-history');
  const vendorSortBarEl = $('vendor-sort-bar');
  const costHistorySortBarEl = $('cost-history-sort-bar');
  const salesTotalsEl = $('sales-totals');
  const priceDriftBoxEl = $('price-drift-box');
  const salesCustomerSearchBoxEl = $('sales-customer-search-box');
  const salesTopCustomersEl = $('sales-top-customers');
  const salesTransactionsEl = $('sales-transactions');
  const salesSortBarEl = $('sales-sort-bar');

  // ---- Customer mode elements ----
  const customerSearchAreaEl = $('customer-search-area');
  const customerSearchBoxEl = $('customer-search-box');
  const quickButtons = Array.from(document.querySelectorAll('.quick-btn'));
  const customerLoadingEl = $('customer-loading');
  const customerListEl = $('customer-list');
  const customerNoResultsEl = $('customer-no-results');
  const customerDetailEl = $('customer-detail');
  const customerBackBtn = $('customer-back-btn');
  const customerNameEl = $('customer-name');
  const customerContactEl = $('customer-contact');
  const customerMetaTagsEl = $('customer-meta-tags');
  const customerTotalsEl = $('customer-totals');
  const buyingPatternBoxEl = $('buying-pattern-box');
  const openQuotesBoxEl = $('open-quotes-box');
  const openQuotesListEl = $('open-quotes-list');
  const customerOrdersEl = $('customer-orders');
  const ordersSortBarEl = $('orders-sort-bar');
  const copySummaryBtn = $('copy-summary-btn');
  const copyOrdersBtn = $('copy-orders-btn');
  const topProductsLoadingEl = $('top-products-loading');
  const customerTopProductsEl = $('customer-top-products');

  let odooTabId = null;
  let activeType = 'part';
  let activeQuickFilters = new Set();
  let currentScreenKey = null; // null until showScreen() runs for the first time

  function showScreen(name) {
    currentScreenKey = name;
    Object.entries(screens).forEach(([key, el]) => {
      el.style.display = key === name ? 'block' : 'none';
    });
  }

  function sendToOdoo(type, extra) {
    return new Promise((resolve) => {
      if (!odooTabId) {
        resolve({ ok: false, error: 'Not connected to your Odoo tab.' });
        return;
      }
      chrome.tabs.sendMessage(odooTabId, Object.assign({ type }, extra), (response) => {
        if (chrome.runtime.lastError) {
          resolve({
            ok: false,
            error: 'Could not reach Odoo tab. Try reloading the Odoo page and reopening this popup.'
          });
          return;
        }
        resolve(response || { ok: false, error: 'No response from Odoo tab.' });
      });
    });
  }

  function showFatalError(message) {
    errorTextEl.textContent = message;
    showScreen('error');
  }

  function debounce(fn, ms) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  }

  function num(n) {
    return (typeof n === 'number' ? n : 0).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  // Purchases/sales span multiple currencies (OMR/USD/AED/...) - always show
  // which one an amount is actually in rather than a bare number.
  function formatMoney(amount, currency) {
    return currency ? `${num(amount)} ${currency}` : num(amount);
  }

  // "≈ X OMR" note for a non-OMR amount, or null when there's nothing useful
  // to add (already OMR, or the conversion couldn't be resolved).
  function omrNote(currency, amountOmr) {
    if (currency === 'OMR' || typeof amountOmr !== 'number') return null;
    return `≈ ${num(amountOmr)} OMR`;
  }

  function formatDate(str) {
    if (!str) return '—';
    return String(str).slice(0, 10);
  }

  function clear(el) {
    el.innerHTML = '';
  }

  function emptyNote(container, text) {
    clear(container);
    const p = document.createElement('p');
    p.className = 'empty-message';
    p.textContent = text;
    container.appendChild(p);
  }

  function copyToClipboard(text, btnEl) {
    const original = btnEl.textContent;
    navigator.clipboard.writeText(text).then(() => {
      btnEl.textContent = 'Copied!';
      btnEl.classList.add('copied');
      setTimeout(() => {
        btnEl.textContent = original;
        btnEl.classList.remove('copied');
      }, 1500);
    }).catch(() => {
      btnEl.textContent = 'Could not copy';
      setTimeout(() => { btnEl.textContent = original; }, 1500);
    });
  }

  function buildStatGrid(container, tiles) {
    clear(container);
    for (const t of tiles) {
      const tile = document.createElement('div');
      tile.className = 'stat-tile' + (t.highlight ? ' highlight' : '');
      const label = document.createElement('span');
      label.className = 'stat-label';
      label.textContent = t.label;
      const value = document.createElement('div');
      value.className = 'stat-value' + (t.small ? ' small' : '');
      value.textContent = t.value;
      if (t.badge) value.appendChild(t.badge);
      tile.appendChild(label);
      tile.appendChild(value);
      if (t.sub) {
        const sub = document.createElement('div');
        sub.className = 'stat-sub';
        sub.textContent = t.sub;
        tile.appendChild(sub);
      }
      container.appendChild(tile);
    }
  }

  function trendBadge(trend) {
    if (!trend || trend === 'insufficient_data') return null;
    const span = document.createElement('span');
    span.className = `trend-badge trend-${trend}`;
    span.textContent = trend;
    return span;
  }

  // Local (Omani vendor) vs Foreign (import) - foreign purchases are the
  // ones that can carry a landed cost (freight/duty); local ones normally
  // won't, so this badge explains at a glance why a landed-cost figure is or
  // isn't showing for a given purchase.
  function purchaseTypeBadge(type) {
    if (!type) return null;
    const span = document.createElement('span');
    span.className = `ptype-badge ptype-${type.toLowerCase()}`;
    span.textContent = type;
    return span;
  }

  // Returns the row element rather than appending it, so callers that need
  // to control placement (grouped sections, paginated lists) can do so;
  // lineRow() below is the append-directly convenience wrapper most call
  // sites still want.
  // A sub-line can be a plain string (neutral gray metadata) or
  // { text, tone } to carry semantic color - tone is one of
  // success/warning/info/danger/primary. Keeps status/insight text visually
  // prominent instead of every line reading as the same flat gray.
  function appendSubLine(parent, value) {
    if (!value) return;
    const isToned = typeof value === 'object';
    const el = document.createElement('div');
    el.className = 'line-row-sub' + (isToned && value.tone ? ` tone-${value.tone}` : '');
    el.textContent = isToned ? value.text : value;
    parent.appendChild(el);
  }

  function buildLineRow({ title, sub, sub2, sub3, value, subValue, titleBadge }) {
    const row = document.createElement('div');
    row.className = 'line-row';
    const main = document.createElement('div');
    main.className = 'line-row-main';
    const t = document.createElement('div');
    t.className = 'line-row-title';
    t.textContent = title;
    if (titleBadge) {
      t.appendChild(document.createTextNode(' '));
      t.appendChild(titleBadge);
    }
    main.appendChild(t);
    appendSubLine(main, sub);
    appendSubLine(main, sub2);
    appendSubLine(main, sub3);
    const valWrap = document.createElement('div');
    valWrap.className = 'line-row-value';
    valWrap.textContent = value;
    appendSubLine(valWrap, subValue);
    row.appendChild(main);
    row.appendChild(valWrap);
    return row;
  }

  function lineRow(container, opts) {
    container.appendChild(buildLineRow(opts));
  }

  // Renders the first `pageSize` items plus a "Show N more" button that
  // reveals the next page in place - keeps long lists (purchase/sales
  // history, orders, top products) from all rendering at once.
  function renderExpandableList(container, items, buildRowFn, pageSize = 10) {
    let shown = Math.min(pageSize, items.length);

    function render() {
      clear(container);
      for (const item of items.slice(0, shown)) container.appendChild(buildRowFn(item));
      if (shown < items.length) {
        const remaining = items.length - shown;
        const btn = document.createElement('button');
        btn.className = 'show-more-btn';
        btn.textContent = `Show more (${remaining} more)`;
        btn.addEventListener('click', () => {
          shown = Math.min(shown + pageSize, items.length);
          render();
        });
        container.appendChild(btn);
      }
    }
    render();
  }

  function groupHeader(container, label, meta) {
    const header = document.createElement('div');
    header.className = 'group-header';
    const labelEl = document.createElement('span');
    labelEl.className = 'group-header-label';
    labelEl.textContent = label;
    header.appendChild(labelEl);
    if (meta) {
      const metaEl = document.createElement('span');
      metaEl.className = 'group-header-meta';
      metaEl.textContent = meta;
      header.appendChild(metaEl);
    }
    container.appendChild(header);
  }

  // Wires a .sort-bar's buttons to a callback and returns them, so the
  // active state can be reset (e.g. when a new part/customer is selected)
  // without re-attaching listeners.
  function wireSortBar(barEl, onSelect) {
    const buttons = Array.from(barEl.querySelectorAll('.sort-btn'));
    buttons.forEach((btn) => {
      btn.addEventListener('click', () => {
        buttons.forEach((b) => b.classList.toggle('active', b === btn));
        onSelect(btn.dataset.sort);
      });
    });
    return buttons;
  }

  function resetSortBar(buttons, sortValue) {
    buttons.forEach((b) => b.classList.toggle('active', b.dataset.sort === sortValue));
  }

  // ================= PART MODE =================

  function renderPartResults(results) {
    clear(partSearchResultsEl);
    partNoResultsEl.style.display = results.length ? 'none' : 'block';
    for (const p of results) {
      const row = document.createElement('div');
      row.className = 'result-row';

      const img = document.createElement('img');
      if (p.image_128) {
        img.src = `data:image/png;base64,${p.image_128}`;
      } else {
        img.style.visibility = 'hidden';
      }
      img.onerror = () => { img.style.visibility = 'hidden'; };

      const main = document.createElement('div');
      main.className = 'result-main';
      const nameEl = document.createElement('div');
      nameEl.className = 'result-name';
      nameEl.textContent = p.name;
      const codeEl = document.createElement('div');
      codeEl.className = 'result-code';
      codeEl.textContent = p.default_code || 'No code';
      main.appendChild(nameEl);
      main.appendChild(codeEl);

      const priceEl = document.createElement('div');
      priceEl.className = 'result-price';
      priceEl.textContent = num(p.list_price);

      row.appendChild(img);
      row.appendChild(main);
      row.appendChild(priceEl);
      row.addEventListener('click', () => selectPart(p));
      partSearchResultsEl.appendChild(row);
    }
  }

  const doPartSearch = debounce(async (query) => {
    const trimmed = (query || '').trim();
    if (!trimmed) {
      clear(partSearchResultsEl);
      partNoResultsEl.style.display = 'none';
      return;
    }
    partLoadingEl.style.display = 'block';
    const res = await sendToOdoo('SEARCH_PART', { query: trimmed });
    partLoadingEl.style.display = 'none';
    if (!res.ok) { showFatalError(res.error); return; }
    renderPartResults(res.data);
  }, 300);

  partSearchBoxEl.addEventListener('input', () => doPartSearch(partSearchBoxEl.value));

  // Sort state for the currently-open part's Cost/Sales lists - reset each
  // time a new part is selected, re-applied without re-fetching on click.
  let costHistoryState = [];
  let costSortBy = 'date';
  let vendorSortBy = 'price';
  let salesTransactionsState = [];
  let salesSortBy = 'date';
  let topCustomersState = [];
  let salesCustomerFilter = '';
  let expandedTopCustomerId = null; // which Top Customers row is drilled into, if any
  let deliveryInvoiceByLine = {}; // line_id -> { doNumbers, invoiceNumbers }, fetched once per part (see selectPart)

  async function selectPart(part) {
    partSearchAreaEl.style.display = 'none';
    partDetailEl.style.display = 'block';
    partTabsWrapEl.style.display = 'none';
    partDetailLoadingEl.style.display = 'block';

    partNameEl.textContent = part.name;
    partCodeEl.textContent = part.default_code ? `Code: ${part.default_code}` : 'No code';
    if (part.image_128) {
      partImageEl.src = `data:image/png;base64,${part.image_128}`;
      partImageEl.style.visibility = 'visible';
    } else {
      partImageEl.style.visibility = 'hidden';
    }

    const [stockRes, incomingRes, reservedRes, purchaseRes, salesRes] = await Promise.all([
      sendToOdoo('GET_STOCK', { productId: part.id }),
      sendToOdoo('GET_INCOMING_STOCK', { productId: part.id }),
      sendToOdoo('GET_RESERVED_TRANSFERS', { productId: part.id }),
      sendToOdoo('GET_PURCHASE_HISTORY', { productId: part.id }),
      sendToOdoo('GET_SALES_HISTORY', { productId: part.id })
    ]);

    const failed = [stockRes, incomingRes, purchaseRes, salesRes].find((r) => !r.ok);
    if (failed) { partDetailLoadingEl.style.display = 'none'; showFatalError(failed.error); return; }

    // Landed cost and delivery/invoice numbers each need ids from the data
    // just fetched, so they run as follow-ups rather than in the initial
    // Promise.all - but the two follow-ups are independent of each other,
    // so they run in parallel. Delivery/invoice details are fetched once for
    // EVERY line here (not lazily per customer click) since it's the same
    // handful of batched queries either way - simpler, and lets both the
    // Transactions list and the Top Customers drill-down show it instantly.
    const costHistory = shapeCostHistory(purchaseRes.data);
    const orderIds = [...new Set(costHistory.map((l) => l.orderId).filter((id) => id !== null))];
    const saleLineIds = [...new Set(salesRes.data.map((l) => l.line_id).filter((id) => id !== null && id !== undefined))];

    const [landedRes, deliveryInvoiceRes] = await Promise.all([
      orderIds.length
        ? sendToOdoo('GET_LANDED_COSTS_FOR_ORDERS', { productId: part.id, orderIds })
        : Promise.resolve({ ok: true, data: {} }),
      saleLineIds.length
        ? sendToOdoo('GET_DELIVERY_INVOICE_DETAILS', { lineIds: saleLineIds })
        : Promise.resolve({ ok: true, data: {} })
    ]);
    const landedCostsByOrder = landedRes.ok ? landedRes.data : {};
    deliveryInvoiceByLine = deliveryInvoiceRes.ok ? deliveryInvoiceRes.data : {};
    const costHistoryWithLanded = attachLandedCost(costHistory, landedCostsByOrder);

    partDetailLoadingEl.style.display = 'none';
    partTabsWrapEl.style.display = 'block';

    renderStockTab(stockRes.data, incomingRes.data, reservedRes.ok ? reservedRes.data : [], part.standard_price);
    renderCostTab(costHistoryWithLanded, part.standard_price);

    // Margin vs a landed reference uses the most recent purchase that
    // actually has both an OMR price and a landed cost - NOT avg cost plus
    // landed cost, since avg cost may already include landed cost once
    // Odoo's automatic valuation applies it (that would double-count).
    // This is instead "how does the sale price compare to that one
    // shipment's true landed cost", a distinct, clearly-labeled question.
    const landedReference = costHistoryWithLanded.find(
      (l) => typeof l.priceOmr === 'number' && typeof l.landedPerUnit === 'number'
    );
    const landedUnitCostReference = landedReference ? landedReference.priceOmr + landedReference.landedPerUnit : null;

    renderSalesTab(salesRes.data, part.standard_price, part.list_price, landedUnitCostReference);
  }

  partBackBtn.addEventListener('click', () => {
    partDetailEl.style.display = 'none';
    partSearchAreaEl.style.display = 'block';
  });

  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      tabButtons.forEach((b) => b.classList.toggle('active', b === btn));
      Object.entries(tabPanels).forEach(([key, panel]) => {
        panel.classList.toggle('active', key === btn.dataset.tab);
      });
    });
  });

  function renderStockTab(quants, incomingLines, reservedLines, avgCost) {
    const shaped = shapeStockByLocation(quants);
    const incoming = shapeIncomingStock(incomingLines);
    const reserved = shapeReservedTransfers(reservedLines);
    const stockValue = computeStockValue(shaped.totalOnHand, avgCost);

    const tiles = [
      { label: 'On Hand', value: num(shaped.totalOnHand) },
      { label: 'Reserved', value: num(shaped.totalReserved) }
    ];
    if (typeof stockValue === 'number') {
      tiles.push({ label: 'Stock value (OMR)', value: num(stockValue), highlight: true });
    }
    buildStatGrid(stockTotalsEl, tiles);

    clear(stockLocationsEl);
    if (!shaped.byLocation.length) {
      emptyNote(stockLocationsEl, 'No stock on hand at any internal location.');
    } else {
      for (const loc of shaped.byLocation) {
        lineRow(stockLocationsEl, {
          title: loc.location,
          sub: `Reserved: ${num(loc.reserved)}`,
          value: num(loc.qty)
        });
      }
    }

    // Only shown when there's a specific transfer to point to - if reserved
    // qty is nonzero (already shown above) but no transfer detail could be
    // resolved, the section stays hidden rather than claiming "none found".
    if (!reserved.items.length) {
      stockReservedSectionEl.style.display = 'none';
      clear(stockReservedEl);
    } else {
      stockReservedSectionEl.style.display = 'block';
      clear(stockReservedEl);
      for (const item of reserved.items) {
        lineRow(stockReservedEl, {
          title: item.pickingName || 'Transfer',
          sub: `${item.pickingType || 'Transfer'}${item.origin ? ' · For ' + item.origin : ''} · ${item.location || 'Unknown location'}`,
          value: num(item.qty)
        });
      }
    }

    clear(stockIncomingEl);
    if (!incoming.items.length) {
      emptyNote(stockIncomingEl, 'No open purchase orders for this part.');
    } else {
      buildStatGrid(stockIncomingEl, [{ label: 'Total incoming', value: num(incoming.totalIncoming) }]);
      const list = document.createElement('div');
      for (const item of incoming.items) {
        lineRow(list, {
          title: item.orderName || 'Purchase order',
          sub: `Expected ${formatDate(item.datePlanned)}`,
          value: num(item.remaining)
        });
      }
      stockIncomingEl.appendChild(list);
    }
  }

  function costHistoryRowNode(c) {
    const landedNote = (typeof c.priceOmr === 'number' && typeof c.landedPerUnit === 'number')
      ? { text: `Landed unit cost: ${num(c.priceOmr)} + ${num(c.landedPerUnit)} = ${num(c.priceOmr + c.landedPerUnit)} OMR`, tone: 'primary' }
      : null;
    return buildLineRow({
      title: c.order || 'Purchase order',
      titleBadge: purchaseTypeBadge(c.purchaseType),
      sub: `${c.vendor || 'Unknown vendor'} · ${formatDate(c.date)} · qty ${num(c.qty)}`,
      sub2: landedNote,
      value: formatMoney(c.price, c.currency),
      subValue: omrNote(c.currency, c.priceOmr)
    });
  }

  // Foreign first - that's the group landed cost actually applies to, so
  // leading with it surfaces the more actionable section.
  const PURCHASE_TYPE_ORDER = ['Foreign', 'Local', 'Unknown'];

  function renderCostHistoryList() {
    clear(costHistoryEl);
    if (!costHistoryState.length) {
      emptyNote(costHistoryEl, 'No purchase history for this part.');
      return;
    }
    const sorted = sortCostHistory(costHistoryState, costSortBy);
    const groups = groupCostHistoryByType(sorted);
    for (const key of PURCHASE_TYPE_ORDER) {
      const items = groups[key];
      if (!items.length) continue;
      groupHeader(costHistoryEl, `${key} Purchases`, `${items.length} line${items.length === 1 ? '' : 's'}`);
      const groupContainer = document.createElement('div');
      costHistoryEl.appendChild(groupContainer);
      renderExpandableList(groupContainer, items, costHistoryRowNode, 10);
    }
  }

  function renderVendorComparisonList() {
    clear(costVendorsEl);
    const vendors = vendorComparison(costHistoryState); // already OMR-price sorted desc
    if (!vendors.length) {
      emptyNote(costVendorsEl, 'No purchase history for this part.');
      return;
    }
    const sorted = vendorSortBy === 'vendor'
      ? [...vendors].sort((a, b) => a.vendor.localeCompare(b.vendor))
      : vendors;
    renderExpandableList(costVendorsEl, sorted, (v) => buildLineRow({
      title: v.vendor,
      titleBadge: purchaseTypeBadge(v.purchaseType),
      sub: `Most recent: ${formatDate(v.date)}`,
      value: formatMoney(v.price, v.currency),
      subValue: omrNote(v.currency, v.priceOmr)
    }), 10);
  }

  const costHistorySortButtons = wireSortBar(costHistorySortBarEl, (sortBy) => {
    costSortBy = sortBy;
    renderCostHistoryList();
  });
  const vendorSortButtons = wireSortBar(vendorSortBarEl, (sortBy) => {
    vendorSortBy = sortBy;
    renderVendorComparisonList();
  });

  function renderCostTab(costHistoryWithLanded, avgCost) {
    costHistoryState = costHistoryWithLanded;
    costSortBy = 'date';
    vendorSortBy = 'price';
    resetSortBar(costHistorySortButtons, 'date');
    resetSortBar(vendorSortButtons, 'price');

    const trend = costTrend(costHistoryWithLanded);
    const lastPurchase = costHistoryWithLanded.length ? costHistoryWithLanded[0] : null;

    buildStatGrid(costTotalsEl, [
      { label: 'Current avg cost', value: num(avgCost), badge: trendBadge(trend), highlight: true },
      {
        label: 'Last purchase price',
        value: lastPurchase ? formatMoney(lastPurchase.price, lastPurchase.currency) : '—',
        badge: lastPurchase ? purchaseTypeBadge(lastPurchase.purchaseType) : null,
        sub: lastPurchase ? omrNote(lastPurchase.currency, lastPurchase.priceOmr) : null
      }
    ]);

    renderVendorComparisonList();
    renderCostHistoryList();
  }

  // Delivery/invoice line shared by the Transactions list and the Top
  // Customers drill-down - status (none/partial/full) is always known
  // up front from qty_delivered/qty_invoiced; the DO/invoice numbers come
  // from deliveryInvoiceByLine, fetched once for the whole part in selectPart().
  function fulfillmentLine(status, kind, numbers) {
    if (status === 'none') {
      return { text: kind === 'delivery' ? 'Not delivered' : 'Not invoiced', tone: 'warning' };
    }
    const verb = kind === 'delivery' ? 'Delivered' : 'Invoiced';
    const list = numbers && numbers.length ? numbers.join(', ') : '—';
    if (status === 'partial') {
      return { text: `Partially ${verb.toLowerCase()}: ${list}`, tone: 'info' };
    }
    return { text: `${verb}: ${list}`, tone: 'success' };
  }

  function salesTransactionRowNode(t) {
    const marginParts = [];
    if (typeof t.marginAvg === 'number') marginParts.push(`avg ${num(t.marginAvg)}`);
    if (typeof t.marginLanded === 'number') marginParts.push(`landed ${num(t.marginLanded)}`);
    const marginText = marginParts.length ? `margin approx: ${marginParts.join(' / ')}` : null;
    const detail = deliveryInvoiceByLine[t.line_id];
    return buildLineRow({
      title: t.customer,
      sub: `${t.order_name || 'Sale order'} · ${formatDate(t.date_order)} · qty ${num(t.product_uom_qty)}${marginText ? ' · ' + marginText : ''}`,
      sub2: fulfillmentLine(t.deliveryStatus, 'delivery', detail && detail.doNumbers),
      sub3: fulfillmentLine(t.invoiceStatus, 'invoice', detail && detail.invoiceNumbers),
      value: formatMoney(t.price_unit, t.currency),
      subValue: omrNote(t.currency, t.price_unit_omr)
    });
  }

  // Both the Top Customers and Transactions lists share this one filter, so
  // searching "Rawahi" narrows both to just that customer's history with
  // this part - a plain substring match, not the fancier free-text syntax
  // Customer mode's search box supports (no "over OMR 5000" here).
  function matchesCustomerFilter(customerName) {
    if (!salesCustomerFilter) return true;
    return (customerName || '').toLowerCase().includes(salesCustomerFilter.toLowerCase());
  }

  function renderSalesTransactionsList() {
    clear(salesTransactionsEl);
    if (!salesTransactionsState.length) {
      emptyNote(salesTransactionsEl, 'No sales history for this part.');
      return;
    }
    const filtered = salesTransactionsState.filter((t) => matchesCustomerFilter(t.customer));
    if (!filtered.length) {
      emptyNote(salesTransactionsEl, `No purchases of this part by "${salesCustomerFilter}".`);
      return;
    }
    if (salesSortBy === 'date') {
      // Grouping into months only makes sense for chronological order.
      const groups = groupSalesByMonth(filtered);
      for (const g of groups) {
        groupHeader(salesTransactionsEl, g.monthLabel, `${num(g.totalQty)} units · ${num(g.totalRevenueOmr)} OMR`);
        const groupContainer = document.createElement('div');
        salesTransactionsEl.appendChild(groupContainer);
        renderExpandableList(groupContainer, g.transactions, salesTransactionRowNode, 10);
      }
    } else {
      const sorted = sortSalesTransactions(filtered, salesSortBy);
      renderExpandableList(salesTransactionsEl, sorted, salesTransactionRowNode, 15);
    }
  }

  function customerOrderRowNode(line) {
    const detail = deliveryInvoiceByLine[line.line_id];
    return buildLineRow({
      title: line.order_name || 'Sale order',
      sub: formatDate(line.date_order),
      sub2: fulfillmentLine(line.deliveryStatus, 'delivery', detail && detail.doNumbers),
      sub3: fulfillmentLine(line.invoiceStatus, 'invoice', detail && detail.invoiceNumbers),
      value: `qty ${num(line.product_uom_qty)}`
    });
  }

  function toggleTopCustomerDrilldown(customerId) {
    expandedTopCustomerId = expandedTopCustomerId === customerId ? null : customerId;
    renderTopCustomersList();
  }

  function topCustomerRowNode(c) {
    const wrapper = document.createElement('div');
    const expanded = expandedTopCustomerId === c.customerId;
    const row = buildLineRow({
      title: `${expanded ? '▾' : '▸'} ${c.customer}`,
      sub: `${c.orders} order${c.orders === 1 ? '' : 's'} · ${c.deliveredCount} delivered · ${c.invoicedCount} invoiced`,
      value: `${num(c.qty)} units`
    });
    row.classList.add('clickable-row');
    row.addEventListener('click', () => toggleTopCustomerDrilldown(c.customerId));
    wrapper.appendChild(row);

    if (expanded) {
      const drilldown = document.createElement('div');
      drilldown.className = 'customer-drilldown';
      const customerLines = salesTransactionsState.filter((t) => t.customer_id === c.customerId);
      if (!customerLines.length) {
        emptyNote(drilldown, 'No orders found.');
      } else {
        for (const line of customerLines) drilldown.appendChild(customerOrderRowNode(line));
      }
      wrapper.appendChild(drilldown);
    }
    return wrapper;
  }

  function renderTopCustomersList() {
    clear(salesTopCustomersEl);
    if (!topCustomersState.length) {
      emptyNote(salesTopCustomersEl, 'No sales history for this part.');
      return;
    }
    const filtered = topCustomersState.filter((c) => matchesCustomerFilter(c.customer));
    if (!filtered.length) {
      emptyNote(salesTopCustomersEl, `No purchases of this part by "${salesCustomerFilter}".`);
      return;
    }
    renderExpandableList(salesTopCustomersEl, filtered, topCustomerRowNode, 10);
  }

  const doSalesCustomerFilter = debounce((value) => {
    salesCustomerFilter = value.trim();
    renderTopCustomersList();
    renderSalesTransactionsList();
  }, 200);

  salesCustomerSearchBoxEl.addEventListener('input', () => doSalesCustomerFilter(salesCustomerSearchBoxEl.value));

  const salesSortButtons = wireSortBar(salesSortBarEl, (sortBy) => {
    salesSortBy = sortBy;
    renderSalesTransactionsList();
  });

  function renderSalesTab(saleLines, avgCost, listPrice, landedUnitCostReference) {
    const enrichedLines = attachFulfillment(saleLines); // adds deliveryStatus/invoiceStatus per line
    const shaped = shapeSalesHistory(enrichedLines, { windowDays: 90 });
    const marginVsAvg = marginPerSale(shaped.transactions, avgCost, { isApproximate: true });
    const marginVsLanded = typeof landedUnitCostReference === 'number'
      ? marginPerSale(shaped.transactions, landedUnitCostReference, { isApproximate: true })
      : null;
    salesTransactionsState = marginVsAvg.map((t, i) => ({
      ...t,
      marginAvg: t.margin,
      marginLanded: marginVsLanded ? marginVsLanded[i].margin : null
    }));
    salesSortBy = 'date';
    resetSortBar(salesSortButtons, 'date');

    topCustomersState = topCustomersForPart(enrichedLines);
    salesCustomerFilter = '';
    salesCustomerSearchBoxEl.value = '';
    expandedTopCustomerId = null; // deliveryInvoiceByLine is already set fresh by selectPart() before this runs

    const drift = priceDrift(listPrice, saleLines, { windowDays: 90 });

    buildStatGrid(salesTotalsEl, [
      { label: 'Units sold (90d)', value: num(shaped.recentUnitsSold) },
      { label: 'Total units sold', value: num(shaped.totalUnitsSold), highlight: true },
      { label: 'Last sold', value: formatDate(shaped.lastSoldDate), small: true }
    ]);

    if (drift) {
      clear(priceDriftBoxEl);
      priceDriftBoxEl.style.display = 'block';
      const note = document.createElement('div');
      note.className = 'price-drift-note';
      const sign = drift.diff >= 0 ? '+' : '';
      note.textContent =
        `List price ${num(drift.listPrice)} vs. avg recent sale price ${num(drift.avgRecentPrice)} ` +
        `(${sign}${num(drift.diff)}, last ${drift.windowDays}d).`;
      priceDriftBoxEl.appendChild(note);
    } else {
      priceDriftBoxEl.style.display = 'none';
      clear(priceDriftBoxEl);
    }

    renderTopCustomersList();
    renderSalesTransactionsList();
  }

  // ================= CUSTOMER MODE =================

  function renderCustomerList(cards) {
    clear(customerListEl);
    customerNoResultsEl.style.display = cards.length ? 'none' : 'block';
    for (const c of cards) {
      const row = document.createElement('div');
      row.className = 'customer-row';

      const nameEl = document.createElement('div');
      nameEl.className = 'customer-row-name';
      nameEl.textContent = c.name;

      if (c.openQuotations.length > 0) {
        const badge = document.createElement('span');
        badge.className = 'open-quote-badge';
        badge.textContent = `${c.openQuotations.length} open`;
        nameEl.appendChild(document.createTextNode(' '));
        nameEl.appendChild(badge);
      }

      const meta = document.createElement('div');
      meta.className = 'customer-row-meta';
      const amount = document.createElement('span');
      amount.className = 'amount';
      amount.textContent = num(c.totalRevenue);
      meta.appendChild(amount);
      meta.appendChild(document.createTextNode(
        c.lastOrderDate ? `Last order ${formatDate(c.lastOrderDate)}` : 'No confirmed orders'
      ));

      row.appendChild(nameEl);
      row.appendChild(meta);
      row.addEventListener('click', () => openCustomerDetail(c));
      customerListEl.appendChild(row);
    }
  }

  function buildQuickFilters(parsed) {
    const filters = Object.assign({}, parsed);
    if (activeQuickFilters.has('dormant90')) {
      filters.dormantDays = Math.max(filters.dormantDays || 0, 90);
    }
    if (activeQuickFilters.has('openQuotes')) filters.hasOpenQuotes = true;
    if (activeQuickFilters.has('muscat')) filters.branch = 'Muscat';
    if (activeQuickFilters.has('salalah')) filters.branch = 'Salalah';
    return filters;
  }

  const doCustomerSearch = debounce(async () => {
    const rawText = customerSearchBoxEl.value.trim();
    const parsed = parseCustomerSearchText(rawText);
    const filters = buildQuickFilters(parsed);

    customerLoadingEl.style.display = 'block';
    clear(customerListEl);
    customerNoResultsEl.style.display = 'none';

    const nameQuery = filters.nameText || '';
    const searchRes = await sendToOdoo('SEARCH_CUSTOMERS', { name: nameQuery });
    if (!searchRes.ok) { customerLoadingEl.style.display = 'none'; showFatalError(searchRes.error); return; }

    const partners = searchRes.data;
    if (!partners.length) {
      customerLoadingEl.style.display = 'none';
      customerNoResultsEl.style.display = 'block';
      return;
    }

    const partnerIds = partners.map((p) => p.id);
    const ordersRes = await sendToOdoo('GET_ORDERS_FOR_PARTNERS', { partnerIds });
    customerLoadingEl.style.display = 'none';
    if (!ordersRes.ok) { showFatalError(ordersRes.error); return; }

    const ordersByPartner = {};
    for (const o of ordersRes.data) {
      const pid = Array.isArray(o.partner_id) ? o.partner_id[0] : null;
      if (pid === null) continue;
      if (!ordersByPartner[pid]) ordersByPartner[pid] = [];
      ordersByPartner[pid].push(o);
    }

    const cards = partners.map((p) => shapeCustomerCard(p, ordersByPartner[p.id] || []));

    const clientFilters = Object.assign({}, filters);
    delete clientFilters.nameText; // already applied server-side via the ilike search
    renderCustomerList(filterCustomers(cards, clientFilters));
  }, 300);

  customerSearchBoxEl.addEventListener('input', doCustomerSearch);

  quickButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.quick;
      if (activeQuickFilters.has(key)) activeQuickFilters.delete(key);
      else activeQuickFilters.add(key);
      btn.classList.toggle('active');
      doCustomerSearch();
    });
  });

  function renderContactLinks(c) {
    clear(customerContactEl);
    if (!c.phone && !c.email) {
      customerContactEl.textContent = 'No phone/email on file';
      return;
    }
    if (c.phone) {
      const tel = document.createElement('a');
      tel.href = `tel:${c.phone}`;
      tel.textContent = `Call ${c.phone}`;
      customerContactEl.appendChild(tel);
    }
    if (c.email) {
      const mail = document.createElement('a');
      mail.href = `mailto:${c.email}`;
      mail.textContent = `Email ${c.email}`;
      customerContactEl.appendChild(mail);
    }
  }

  function renderMetaTags(c) {
    clear(customerMetaTagsEl);
    const tags = [
      c.branch ? `Branch: ${c.branch}` : null,
      c.salesperson ? `Salesperson: ${c.salesperson}` : null,
      `Pricelist: ${c.pricelist}`
    ].filter(Boolean);
    for (const t of tags) {
      const tag = document.createElement('span');
      tag.className = 'meta-tag';
      tag.textContent = t;
      customerMetaTagsEl.appendChild(tag);
    }
  }

  function renderBuyingPattern(c) {
    const pattern = buyingPattern(c.confirmedOrders);
    clear(buyingPatternBoxEl);
    if (!pattern.avgDaysBetweenOrders && !pattern.busiestMonth) {
      buyingPatternBoxEl.style.display = 'none';
      return;
    }
    buyingPatternBoxEl.style.display = 'block';
    const parts = [];
    if (typeof pattern.avgDaysBetweenOrders === 'number') {
      parts.push(`Orders roughly every ${Math.round(pattern.avgDaysBetweenOrders)} days.`);
    }
    if (pattern.busiestMonth) {
      parts.push(
        `Busiest month: ${pattern.busiestMonth.monthLabel} ` +
        `(${pattern.busiestMonth.count} order${pattern.busiestMonth.count === 1 ? '' : 's'}).`
      );
    }
    const note = document.createElement('div');
    note.className = 'buying-pattern-note';
    note.textContent = parts.join(' ');
    buyingPatternBoxEl.appendChild(note);
  }

  function orderRowNode(o) {
    return buildLineRow({
      title: o.name,
      sub: formatDate(o.date_order),
      value: num(o.amount_total),
      titleBadge: (() => {
        const span = document.createElement('span');
        span.className = `order-state state-${o.state}`;
        span.textContent = o.state;
        return span;
      })()
    });
  }

  let currentCustomerCard = null;
  let ordersSortBy = 'date';

  function renderCustomerOrdersList() {
    clear(customerOrdersEl);
    if (!currentCustomerCard.orders.length) {
      emptyNote(customerOrdersEl, 'No orders on file.');
      return;
    }
    const sorted = sortOrders(currentCustomerCard.orders, ordersSortBy);
    renderExpandableList(customerOrdersEl, sorted, orderRowNode, 10);
  }

  const ordersSortButtons = wireSortBar(ordersSortBarEl, (sortBy) => {
    ordersSortBy = sortBy;
    renderCustomerOrdersList();
  });

  copySummaryBtn.addEventListener('click', () => {
    if (!currentCustomerCard) return;
    copyToClipboard(buildCustomerSummaryText(currentCustomerCard), copySummaryBtn);
  });

  copyOrdersBtn.addEventListener('click', () => {
    if (!currentCustomerCard) return;
    const sorted = sortOrders(currentCustomerCard.orders, ordersSortBy);
    copyToClipboard(buildOrdersSpreadsheetText(sorted), copyOrdersBtn);
  });

  async function openCustomerDetail(c) {
    customerSearchAreaEl.style.display = 'none';
    customerDetailEl.style.display = 'block';

    currentCustomerCard = c;
    ordersSortBy = 'date';
    resetSortBar(ordersSortButtons, 'date');

    customerNameEl.textContent = c.name;
    renderContactLinks(c);
    renderMetaTags(c);

    buildStatGrid(customerTotalsEl, [
      { label: 'Total orders', value: String(c.totalOrders) },
      { label: 'Total revenue', value: num(c.totalRevenue), highlight: true },
      { label: 'Last order', value: formatDate(c.lastOrderDate), small: true }
    ]);

    renderBuyingPattern(c);

    if (c.openQuotations.length > 0) {
      openQuotesBoxEl.style.display = 'block';
      clear(openQuotesListEl);
      for (const q of c.openQuotations) openQuotesListEl.appendChild(orderRowNode(q));
    } else {
      openQuotesBoxEl.style.display = 'none';
      clear(openQuotesListEl);
    }

    renderCustomerOrdersList();

    clear(customerTopProductsEl);
    topProductsLoadingEl.style.display = 'block';
    const topRes = await sendToOdoo('GET_CUSTOMER_TOP_PRODUCTS', { partnerId: c.id });
    topProductsLoadingEl.style.display = 'none';
    if (!topRes.ok) {
      emptyNote(customerTopProductsEl, 'Could not load purchased parts.');
      return;
    }
    const topProducts = shapeTopProducts(topRes.data);
    if (!topProducts.length) {
      emptyNote(customerTopProductsEl, 'No sales history for this customer.');
    } else {
      renderExpandableList(customerTopProductsEl, topProducts, (p) => buildLineRow({
        title: p.product,
        sub: `${p.orders} order${p.orders === 1 ? '' : 's'}`,
        value: `${num(p.qty)} units`
      }), 10);
    }
  }

  customerBackBtn.addEventListener('click', () => {
    customerDetailEl.style.display = 'none';
    customerSearchAreaEl.style.display = 'block';
  });

  // ================= Type toggle & init =================

  typeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.type === activeType) return;
      activeType = btn.dataset.type;
      typeButtons.forEach((b) => b.classList.toggle('active', b === btn));
      showScreen(activeType);
    });
  });

  errorBackBtn.addEventListener('click', () => showScreen(activeType));

  // Re-checks which tab is active and updates odooTabId accordingly. Called
  // once on load, and again on every tab switch/navigation - a side panel
  // (unlike a popup) stays open across those, so it must keep tracking
  // whichever tab is actually in front rather than freezing on whatever was
  // true when it first opened.
  function checkOdooTab() {
    const manifest = chrome.runtime.getManifest();
    const patterns =
      (manifest.content_scripts && manifest.content_scripts[0] && manifest.content_scripts[0].matches) || [];

    chrome.tabs.query({ active: true, currentWindow: true, url: patterns }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab) {
        odooTabId = null;
        searchTypeToggleEl.style.display = 'none';
        showScreen('notOdoo');
        return;
      }

      // Jump to the top-level mode screen on the very first load, or if we
      // were previously disconnected/errored - but if the user was already
      // mid-search on one Odoo tab and switches to a second Odoo tab, leave
      // their in-progress results/detail view alone instead of wiping it on
      // every tab switch.
      const wasDisconnected = currentScreenKey === null || currentScreenKey === 'notOdoo' || currentScreenKey === 'error';

      odooTabId = tab.id;
      searchTypeToggleEl.style.display = 'flex';
      if (wasDisconnected) showScreen(activeType);
    });
  }

  // Neither listener reads the tab's URL beyond changeInfo.url - checkOdooTab()
  // re-resolves the active tab itself via the same host-permission-scoped
  // query used on load, so no extra "tabs" permission is needed beyond what's
  // already granted via host_permissions.
  chrome.tabs.onActivated.addListener(() => checkOdooTab());
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (tab.active && changeInfo.url) checkOdooTab();
  });

  checkOdooTab();
})();

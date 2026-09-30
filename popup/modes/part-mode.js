// Part mode: search a part, then Stock & Location / Cost / Sales History tabs.
(function () {
  const { $, sendToOdoo, showFatalError, debounce, num, formatMoney, omrNote, formatDate,
    clear, emptyNote, copyToClipboard, buildStatGrid, trendBadge, purchaseTypeBadge, buildLineRow,
    lineRow, renderExpandableList, groupHeader, wireSortBar, resetSortBar } = window.PI;
  const { shapeStockByLocation, computeStockValue, shapeIncomingStock, shapeReservedTransfers,
    shapeCostHistory, sortCostHistory, groupCostHistoryByType, costTrend, vendorComparison, attachLandedCost,
    shapeSalesHistory, sortSalesTransactions, groupSalesByMonth, attachFulfillment,
    marginPerSale, topCustomersForPart, priceDrift, soldBeforeLateLandedCost,
    buildStockSummaryText, buildCostSummaryText, buildSalesSummaryText } = window.PartData;

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
  const copyPartSummaryBtn = $('copy-part-summary-btn');
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

  partSearchBoxEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const first = partSearchResultsEl.querySelector('.result-row');
      if (first) first.click();
    } else if (e.key === 'Escape') {
      if (partSearchBoxEl.value) {
        partSearchBoxEl.value = '';
        doPartSearch('');
      }
      partSearchBoxEl.blur();
    }
  });

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

  // Held for "Copy part summary" - the raw part (name/code/avgCost/listPrice)
  // plus the Stock tab's shaped results, which aren't otherwise kept around
  // after renderStockTab runs (unlike Cost/Sales, which already keep
  // costHistoryState/salesTransactionsState/topCustomersState for sorting).
  let currentPart = null;
  let stockShapedState = null;
  let stockIncomingState = null;
  let stockReservedState = null;
  let stockValueState = null;

  async function selectPart(part) {
    currentPart = part;
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
    stockShapedState = shaped;
    stockIncomingState = incoming;
    stockReservedState = reserved;
    stockValueState = stockValue;

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
          subLines: [`Reserved: ${num(loc.reserved)}`],
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
          subLines: [`${item.pickingType || 'Transfer'}${item.origin ? ' · For ' + item.origin : ''} · ${item.location || 'Unknown location'}`],
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
          subLines: [`Expected ${formatDate(item.datePlanned)}`],
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
    const untouchedDescs = (c.landedUntouched || [])
      .map((u) => (typeof u.divertedValue === 'number' ? `${u.costName}: ${num(u.divertedValue)} OMR` : u.costName))
      .filter(Boolean)
      .join(', ');
    const lateLandedWarning = untouchedDescs
      ? { text: `Landed cost applied to this shipment but not reflected in cost (${untouchedDescs}) - check if it went entirely to COGS`, tone: 'warning' }
      : null;
    return buildLineRow({
      title: c.order || 'Purchase order',
      titleBadge: purchaseTypeBadge(c.purchaseType),
      subLines: [
        `${c.vendor || 'Unknown vendor'} · ${formatDate(c.date)} · qty ${num(c.qty)}`,
        landedNote,
        lateLandedWarning
      ],
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
      subLines: [`Most recent: ${formatDate(v.date)}`],
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
    lateLandedCostDates = costHistoryWithLanded
      .flatMap((c) => c.landedUntouched || [])
      .map((u) => u.date)
      .filter(Boolean);
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

  // Dates of every landed cost found in this part's purchase history that
  // never produced a valuation layer for it (see attachLandedCost's
  // landedUntouched) - set in renderCostTab, read here to flag sales that
  // happened before one of those posted (the PDF's core "late landed cost"
  // scenario: the sale's cost was locked in without a landed cost that
  // arrived afterward). An existential check, not a receipt-level trace -
  // it can't prove THIS sale drew from THAT receipt, only that a landed
  // cost affecting this part was still outstanding at time of sale.
  let lateLandedCostDates = [];

  function lateLandedCostWarning(dateOrder) {
    if (!soldBeforeLateLandedCost(dateOrder, lateLandedCostDates)) return null;
    return { text: 'Sold before a landed cost was posted for this part - margin may be understated', tone: 'warning' };
  }

  function salesTransactionRowNode(t) {
    const marginParts = [];
    if (typeof t.marginAvg === 'number') marginParts.push(`avg ${num(t.marginAvg)}`);
    if (typeof t.marginLanded === 'number') marginParts.push(`landed ${num(t.marginLanded)}`);
    const marginText = marginParts.length ? `margin approx: ${marginParts.join(' / ')}` : null;
    const detail = deliveryInvoiceByLine[t.line_id];
    return buildLineRow({
      title: t.customer,
      subLines: [
        `${t.order_name || 'Sale order'} · ${formatDate(t.date_order)} · qty ${num(t.product_uom_qty)}${marginText ? ' · ' + marginText : ''}`,
        fulfillmentLine(t.deliveryStatus, 'delivery', detail && detail.doNumbers),
        fulfillmentLine(t.invoiceStatus, 'invoice', detail && detail.invoiceNumbers),
        lateLandedCostWarning(t.date_order)
      ],
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
      subLines: [
        formatDate(line.date_order),
        fulfillmentLine(line.deliveryStatus, 'delivery', detail && detail.doNumbers),
        fulfillmentLine(line.invoiceStatus, 'invoice', detail && detail.invoiceNumbers),
        lateLandedCostWarning(line.date_order)
      ],
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
      subLines: [`${c.orders} order${c.orders === 1 ? '' : 's'} · ${c.deliveredCount} delivered · ${c.invoicedCount} invoiced`],
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

  salesCustomerSearchBoxEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && salesCustomerSearchBoxEl.value) {
      salesCustomerSearchBoxEl.value = '';
      doSalesCustomerFilter('');
    }
  });

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

  // Assembles a full plain-text report from whatever's already been rendered
  // across all three tabs (all three render synchronously in selectPart, so
  // by the time this button is clickable everything is populated regardless
  // of which tab is currently visible). Cost/Sales recompute their derived
  // views (vendors, trend, drift) from the already-stored line data instead
  // of keeping yet more parallel state.
  function buildFullPartSummaryText() {
    if (!currentPart) return '';
    const header = [`Part: ${currentPart.name}`, currentPart.default_code ? `Code: ${currentPart.default_code}` : null]
      .filter(Boolean).join('\n');

    const sections = [header];

    if (stockShapedState) {
      sections.push(buildStockSummaryText(stockShapedState, stockIncomingState, stockReservedState, stockValueState));
    }

    const vendors = vendorComparison(costHistoryState);
    const trend = costTrend(costHistoryState);
    sections.push(buildCostSummaryText(costHistoryState, vendors, currentPart.standard_price, trend));

    const salesShaped = shapeSalesHistory(salesTransactionsState, { windowDays: 90 });
    const drift = priceDrift(currentPart.list_price, salesTransactionsState, { windowDays: 90 });
    sections.push(buildSalesSummaryText(salesShaped, drift, topCustomersState, salesTransactionsState, lateLandedCostDates));

    return sections.join('\n\n');
  }

  copyPartSummaryBtn.addEventListener('click', () => {
    copyToClipboard(buildFullPartSummaryText(), copyPartSummaryBtn);
  });

  PI.registerMode('part', {
    onEscape() {
      if (partDetailEl.style.display !== 'none') partBackBtn.click();
    }
  });
})();

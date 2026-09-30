// Customer mode: customer search with quick filters, then the customer's detail.
(function () {
  const { $, sendToOdoo, showFatalError, debounce, num, formatDate, clear, emptyNote,
    copyToClipboard, buildStatGrid, buildLineRow, renderExpandableList, wireSortBar, resetSortBar } = window.PI;
  const { shapeCustomerCard, sortOrders, buyingPattern, shapeTopProducts,
    buildOrdersSpreadsheetText, buildCustomerSummaryText } = window.CustomerData;
  const { filterCustomers, parseCustomerSearchText } = window.Filters;

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


  let activeQuickFilters = new Set();


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

  customerSearchBoxEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const first = customerListEl.querySelector('.customer-row');
      if (first) first.click();
    } else if (e.key === 'Escape') {
      if (customerSearchBoxEl.value) {
        customerSearchBoxEl.value = '';
        doCustomerSearch();
      }
      customerSearchBoxEl.blur();
    }
  });

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
      subLines: [formatDate(o.date_order)],
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
        subLines: [`${p.orders} order${p.orders === 1 ? '' : 's'}`],
        value: `${num(p.qty)} units`
      }), 10);
    }
  }

  customerBackBtn.addEventListener('click', () => {
    customerDetailEl.style.display = 'none';
    customerSearchAreaEl.style.display = 'block';
  });

  PI.registerMode('customer', {
    onEscape() {
      if (customerDetailEl.style.display !== 'none') customerBackBtn.click();
    }
  });
})();

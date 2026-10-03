// Landed Cost mode: company-wide landed cost checks (see lib/landed-audit.js).
(function () {
  const { $, state, sendToOdoo, showFatalError, num, formatDate, clear, emptyNote, copyToClipboard,
    buildStatGrid, buildLineRow, renderExpandableList, openInOdoo, detailNote, expandableRow } = window.PI;
  const { sinceDateForRange, auditLandedCosts, buildAuditSpreadsheetText,
    replayFifo, replayMatchesOdoo, affectedSales, localDayStartUtc, negativeSalesOnDay } = window.LandedAudit;

  // ---- Landed Cost mode elements ----
  const landedRangeButtons = Array.from(document.querySelectorAll('.range-btn'));
  const landedRefreshBtn = $('landed-refresh-btn');
  const landedCopyBtn = $('landed-copy-btn');
  const landedLoadingEl = $('landed-loading');
  const landedResultsEl = $('landed-results');
  const landedTotalsEl = $('landed-totals');
  const landedFixNowEl = $('landed-fix-now');
  const landedAlreadySoldEl = $('landed-already-sold');
  const landedWentToCogsEl = $('landed-went-to-cogs');
  const landedIncompleteEl = $('landed-incomplete');
  const landedBillsEl = $('landed-bills');
  const landedNegativeEl = $('landed-negative');
  const negDateInput = $('landed-neg-date');
  const negDateClearBtn = $('landed-neg-date-clear');
  const negDaySummaryEl = $('landed-neg-day-summary');
  const landedTabButtons = Array.from(document.querySelectorAll('.landed-tab-btn'));
  const landedPanels = Array.from(document.querySelectorAll('.landed-panel'));


  let landedRange = '30';
  let landedAuditState = null;
  let landedLoaded = false;
  let landedRequestSeq = 0; // ignore a slow older response if the range changed meanwhile
  let negDay = null; // Neg. stock tab: local 'YYYY-MM-DD' picked, or null for the whole period
  let negDayRequestSeq = 0;

  // "Which sales used units from this receipt" - replays the product's
  // valuation history (see replayFifo) and, for a late landed cost, splits the
  // amount that went to COGS across those sales.
  async function loadAffectedSales(container, { productId, moveIds, cutoff, divertedValue }) {
    const heading = detailNote(container, 'Loading the sales that used these units...');
    const layersRes = await sendToOdoo('GET_PRODUCT_LAYERS', { productId });
    if (!layersRes.ok) { heading.textContent = `Could not load sales: ${layersRes.error}`; return; }

    const layers = layersRes.data;
    const { consumption, remainingByLayer } = replayFifo(layers);
    const exact = replayMatchesOdoo(layers, remainingByLayer, moveIds);
    const rows = affectedSales({ consumption, receiptMoveIds: moveIds, cutoff, divertedValue });
    if (!rows.length) { heading.textContent = 'No sales found that used units from this receipt.'; return; }

    const infoRes = await sendToOdoo('GET_MOVE_SALE_INFO', { moveIds: rows.map((r) => r.outMoveId) });
    const info = infoRes.ok ? infoRes.data : {};

    heading.textContent = typeof divertedValue === 'number'
      ? 'Sales that carry this missing cost (their margin shows higher than real):'
      : 'Sales that used units from this receipt:';
    heading.className = 'landed-detail-note';

    for (const r of rows) {
      const sale = info[r.outMoveId] || {};
      const isSale = !!sale.saleOrderId;
      const rowEl = buildLineRow({
        title: isSale ? `${sale.saleOrderName} · ${sale.customer || 'Unknown customer'}` : `${sale.pickingName || 'Transfer'} (not a sale)`,
        subLines: [
          `${sale.pickingName || '—'} · ${formatDate(r.outDate)} · qty ${num(r.qty)}`,
          r.viaNegative ? { text: 'Sold before this stock was received (negative stock)', tone: 'danger' } : null,
          r.perUnit !== null ? { text: `Cost understated by ${num(r.perUnit)} OMR per unit`, tone: 'warning' } : null
        ],
        value: r.share !== null ? `${num(r.share)} OMR` : `${num(r.qty)} units`
      });
      if (isSale && state.odooOrigin) {
        rowEl.classList.add('clickable-row');
        rowEl.title = 'Open sale order in Odoo';
        rowEl.addEventListener('click', (e) => { e.stopPropagation(); openInOdoo('sale.order', sale.saleOrderId); });
      }
      container.appendChild(rowEl);
    }
    if (!exact) {
      detailNote(container, 'Approximate: some of this receipt\'s history couldn\'t be matched exactly (e.g. returns), so check the list in Odoo.', 'info');
    }
  }

  function draftNote(names) {
    return names && names.length
      ? { text: `Draft landed cost not posted yet: ${names.join(', ')}`, tone: 'info' }
      : null;
  }

  function receiptLinks(r) {
    return [{ label: 'Open receipt in Odoo', model: 'stock.picking', id: r.pickingId }];
  }

  function fixNowRowNode(r) {
    return expandableRow({
      title: r.product || 'Unknown part',
      subLines: [
        `${r.pickingName} · ${r.poName || '—'} · ${formatDate(r.dateDone)}`,
        r.vendor || 'Unknown vendor',
        r.soldQty > 0 ? { text: `${num(r.soldQty)} of ${num(r.receivedQty)} already sold`, tone: 'warning' } : null,
        draftNote(r.draftLandedCosts)
      ],
      value: `${num(r.remainingQty)} in stock`,
      subValue: `of ${num(r.receivedQty)} received`
    }, receiptLinks(r), r.soldQty > 0
      ? (el) => loadAffectedSales(el, { productId: r.productId, moveIds: r.moveIds })
      : null);
  }

  function alreadySoldRowNode(r) {
    return expandableRow({
      title: r.product || 'Unknown part',
      subLines: [
        `${r.pickingName} · ${r.poName || '—'} · ${formatDate(r.dateDone)}`,
        r.vendor || 'Unknown vendor',
        draftNote(r.draftLandedCosts)
      ],
      value: `${num(r.receivedQty)} sold`
    }, receiptLinks(r), (el) => loadAffectedSales(el, { productId: r.productId, moveIds: r.moveIds }));
  }

  function incompleteRowNode(r) {
    return expandableRow({
      title: `${r.pickingName} · ${r.poName || '—'}`,
      subLines: [
        `${r.vendor || 'Unknown vendor'} · ${formatDate(r.dateDone)}`,
        `Posted: ${r.costProducts.join(', ') || '—'} (${r.landedCosts.join(', ')})`,
        { text: `Usually also: ${r.missing.map((m) => `${m.product} (${m.seen} of ${m.of} receipts)`).join(', ')}`, tone: 'warning' }
      ],
      value: `${r.missing.length} missing`
    }, receiptLinks(r), null);
  }

  function billRowNode(r) {
    const applied = (r.appliedCosts || []).map((c) => c.name).join(', ');
    return expandableRow({
      title: r.billName || 'Vendor bill',
      subLines: [
        `${r.vendor || 'Unknown vendor'} · ${formatDate(r.date)}`,
        r.products.join(', '),
        r.status === 'partial'
          ? { text: `Partly applied: ${num(r.appliedTotal)} of ${num(r.lcTotal)} OMR (${applied})`, tone: 'warning' }
          : { text: 'Not applied - no posted landed cost from this bill', tone: 'danger' },
        draftNote(r.draftCosts)
      ],
      value: `${num(r.unapplied)} OMR`,
      subValue: 'not applied'
    }, [{ label: 'Open bill in Odoo', model: 'account.move', id: r.billId }], null);
  }

  function wentToCogsRowNode(r) {
    return expandableRow({
      title: r.product || 'Unknown part',
      subLines: [
        `${r.costName} · ${formatDate(r.costDate)} · ${r.pickingName}`,
        `${r.poName || '—'} · ${r.vendor || 'Unknown vendor'}`,
        r.fullyDiverted
          ? { text: 'All of it went to COGS', tone: 'danger' }
          : { text: `Partly: ${num(r.intoStock)} reached stock, ${num(r.divertedValue)} went to COGS`, tone: 'warning' }
      ],
      value: `${num(r.divertedValue)} OMR`,
      subValue: 'to COGS'
    }, [{ label: 'Open landed cost in Odoo', model: 'stock.landed.cost', id: r.costId }],
    (el) => loadAffectedSales(el, {
      productId: r.productId, moveIds: [r.moveId], cutoff: r.costValidatedAt, divertedValue: r.divertedValue
    }));
  }

  function negativeRowNode(r) {
    const sale = r.sale || {};
    return expandableRow({
      title: r.product || 'Unknown part',
      subLines: [
        `${sale.saleOrderName || '—'} · ${sale.customer || 'Unknown customer'}`,
        `${sale.pickingName || '—'} · ${formatDate(r.date)} · qty ${num(r.qty)} · cost used ${num(r.unitCost)}`,
        r.status === 'waiting'
          ? { text: `Still ${num(r.waitingQty)} short - waiting for a receipt`, tone: 'danger' }
          : { text: `Covered by a later receipt on ${formatDate(r.coveredAt)}`, tone: 'info' },
        Math.abs(r.correction) > 0.0005
          ? { text: `Cost corrected afterwards: ${r.correction > 0 ? '+' : ''}${num(r.correction)} OMR (not on the sale margin)`, tone: 'warning' }
          : null
      ],
      value: r.status === 'waiting' ? 'Waiting' : 'Covered'
    }, [
      { label: 'Open sale order', model: 'sale.order', id: sale.saleOrderId },
      { label: 'Open delivery', model: 'stock.picking', id: sale.pickingId }
    ], null);
  }

  function renderLandedList(container, items, rowFn, emptyText) {
    clear(container);
    if (!items.length) { emptyNote(container, emptyText); return; }
    renderExpandableList(container, items, rowFn, 15);
  }

  function renderLandedAudit(audit) {
    const t = audit.totals;
    buildStatGrid(landedTotalsEl, [
      { label: 'Fix now', value: String(t.fixNowLines), sub: `${t.fixNowReceipts} receipt${t.fixNowReceipts === 1 ? '' : 's'} · ${t.incompleteReceipts} maybe incomplete`, highlight: true },
      { label: 'Bills not applied', value: num(t.billsValue), sub: `OMR · ${t.billsCount} bill${t.billsCount === 1 ? '' : 's'}`, small: true },
      { label: 'Went to COGS', value: num(t.wentToCogsValue), sub: `OMR · ${t.wentToCogsLines} line${t.wentToCogsLines === 1 ? '' : 's'}`, small: true },
      { label: 'Negative stock', value: String(t.negativeCount), sub: `${t.negativeWaiting} still waiting` }
    ]);
    renderLandedList(landedFixNowEl, audit.fixNow, fixNowRowNode, 'Nothing to fix - every foreign receipt with stock has a landed cost.');
    renderLandedList(landedAlreadySoldEl, audit.alreadySold, alreadySoldRowNode, 'None in this period.');
    renderLandedList(landedIncompleteEl, audit.incomplete, incompleteRowNode, 'None found (needs at least 3 past receipts per vendor to learn from).');
    if (audit.errors.bills) emptyNote(landedBillsEl, `Could not check bills: ${audit.errors.bills}`);
    else renderLandedList(landedBillsEl, audit.bills, billRowNode, 'Every landed-cost bill in this period has been applied.');
    renderLandedList(landedWentToCogsEl, audit.wentToCogs, wentToCogsRowNode, 'None in this period.');
    if (negDay) loadNegativeDay();
    else renderNegativeAll(audit);
  }

  function renderNegativeAll(audit) {
    negDaySummaryEl.style.display = 'none';
    if (audit.errors.negative) emptyNote(landedNegativeEl, `Could not check negative stock: ${audit.errors.negative}`);
    else renderLandedList(landedNegativeEl, audit.negativeSales, negativeRowNode, 'No sales made with negative stock in this period.');
  }

  // One day only: fetched on its own, independent of the 30/60/all range, so
  // any date works. Covered sales are found through the correction layer Odoo
  // creates when the stock arrives - always on or after the sale - so asking
  // for corrections since that day's midnight catches every sale on it.
  async function loadNegativeDay() {
    const seq = ++negDayRequestSeq;
    const day = negDay;
    const offsetMinutes = -new Date(`${day}T12:00:00`).getTimezoneOffset();
    negDaySummaryEl.style.display = 'none';
    emptyNote(landedNegativeEl, 'Loading sales made with negative stock on this day...');

    const res = await sendToOdoo('GET_NEGATIVE_STOCK_SALES', { sinceUtc: localDayStartUtc(day, offsetMinutes) });
    if (seq !== negDayRequestSeq) return;
    if (!res.ok) { emptyNote(landedNegativeEl, `Could not check negative stock: ${res.error}`); return; }

    const { sales, totals } = negativeSalesOnDay(res.data, day, offsetMinutes);
    negDaySummaryEl.textContent = sales.length
      ? `${day}: ${totals.parts} part${totals.parts === 1 ? '' : 's'} sold with negative stock · ` +
        `${totals.sales} sale${totals.sales === 1 ? '' : 's'} · ${num(totals.units)} units · ${totals.waiting} still waiting`
      : '';
    negDaySummaryEl.style.display = sales.length ? 'block' : 'none';
    renderLandedList(landedNegativeEl, sales, negativeRowNode, `No part was sold with negative stock on ${day}.`);
  }

  function todayLocal() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  negDateInput.max = todayLocal();

  negDateInput.addEventListener('change', () => {
    negDay = negDateInput.value || null;
    negDateClearBtn.disabled = !negDay;
    if (negDay) loadNegativeDay();
    else if (landedAuditState) { negDayRequestSeq++; renderNegativeAll(landedAuditState); }
  });

  negDateClearBtn.addEventListener('click', () => {
    negDateInput.value = '';
    negDateInput.dispatchEvent(new Event('change'));
  });

  async function loadLandedAudit() {
    const seq = ++landedRequestSeq;
    landedLoaded = true;
    landedResultsEl.style.display = 'none';
    landedLoadingEl.style.display = 'block';
    landedCopyBtn.disabled = true;
    landedRefreshBtn.disabled = true;

    const res = await sendToOdoo('GET_LANDED_COST_AUDIT', { sinceDate: sinceDateForRange(landedRange) });
    if (seq !== landedRequestSeq) return;

    landedLoadingEl.style.display = 'none';
    landedRefreshBtn.disabled = false;
    if (!res.ok) { landedLoaded = false; showFatalError(res.error); return; }

    landedAuditState = auditLandedCosts(res.data);
    renderLandedAudit(landedAuditState);
    landedResultsEl.style.display = 'block';
    landedCopyBtn.disabled = false;
  }

  landedRangeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.range === landedRange && landedLoaded) return;
      landedRange = btn.dataset.range;
      landedRangeButtons.forEach((b) => b.classList.toggle('active', b === btn));
      loadLandedAudit();
    });
  });

  landedTabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      landedTabButtons.forEach((b) => b.classList.toggle('active', b === btn));
      landedPanels.forEach((panel) => panel.classList.toggle('active', panel.id === `ltab-${btn.dataset.ltab}`));
    });
  });

  landedRefreshBtn.addEventListener('click', () => loadLandedAudit());

  landedCopyBtn.addEventListener('click', () => {
    if (!landedAuditState) return;
    copyToClipboard(buildAuditSpreadsheetText(landedAuditState), landedCopyBtn);
  });

  PI.registerMode('landed', {
    onShow() {
      if (!landedLoaded) loadLandedAudit();
    }
  });
})();

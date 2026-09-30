// Runs only on the Odoo domain (per manifest.json content_scripts match).
// Every RPC call funnels through callKw() below, which only ever issues
// search_read - no create/write/unlink anywhere in this file, ever.
// Uses the tab's existing session cookie (credentials: 'same-origin') -
// there is no other authentication path in this extension.

async function callKw(model, method, args, kwargs) {
  const response = await fetch('/web/dataset/call_kw', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'call',
      params: {
        model,
        method,
        args,
        kwargs: kwargs || {}
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Odoo request failed: HTTP ${response.status}`);
  }

  const data = await response.json();

  if (data.error) {
    const message =
      (data.error.data && (data.error.data.message || data.error.data.debug)) ||
      data.error.message ||
      'Unknown Odoo RPC error';
    throw new Error(message);
  }

  return data.result;
}

function searchRead(model, domain, fields, kwargs) {
  return callKw(model, 'search_read', [domain, fields], kwargs);
}

function uniqueRelationIds(records, relationField) {
  return [...new Set(
    records
      .map((r) => (Array.isArray(r[relationField]) ? r[relationField][0] : null))
      .filter((id) => id !== null)
  )];
}

// ---------------- Currency conversion (purchases span OMR/USD/AED/etc.) ----------------

async function getCurrencyMap(currencyIds) {
  if (!currencyIds.length) return {};
  const recs = await searchRead('res.currency', [['id', 'in', currencyIds]], ['id', 'name', 'rate']);
  const map = {};
  for (const c of recs) map[c.id] = { name: c.name, rate: c.rate };
  return map;
}

async function getOmrCurrency() {
  const recs = await searchRead('res.currency', [['name', '=', 'OMR']], ['id', 'name', 'rate'], { limit: 1 });
  return recs.length ? recs[0] : null;
}

// Shared by getPurchaseHistory and getSalesHistory. Never throws - any
// currency-lookup failure just means OMR conversion is unavailable, not that
// the whole purchase/sale history fetch should fail.
async function getCurrencyContext(currencyIds) {
  try {
    const currencyMap = await getCurrencyMap(currencyIds);
    const omr = await getOmrCurrency();
    return { currencyMap, omr };
  } catch (err) {
    return { currencyMap: {}, omr: null };
  }
}

// res.currency.rate is each currency's current rate relative to the
// company's currency - using that as a common pivot converts between any two
// currencies without needing to know what the company currency actually is:
// amount_in_B = amount_in_A * (rate_B / rate_A). Returns null (never a wrong
// number) whenever the currency or its rate can't be resolved.
function convertToOmr(amount, currencyId, currencyMap, omr) {
  if (typeof amount !== 'number' || !omr || !omr.rate) return null;
  const cur = currencyMap[currencyId];
  if (!cur || !cur.rate) return null;
  if (cur.name === 'OMR') return amount;
  return amount * (omr.rate / cur.rate);
}

// ---------------- Local vs. foreign purchase ----------------

async function getVendorCountryMap(vendorIds) {
  if (!vendorIds.length) return {};
  const recs = await searchRead('res.partner', [['id', 'in', vendorIds]], ['id', 'country_id']);
  const map = {};
  for (const p of recs) map[p.id] = Array.isArray(p.country_id) ? p.country_id[1] : null;
  return map;
}

// Vendor's country is the authoritative signal (a Local purchase is one from
// an Omani vendor); when a vendor has no country set, fall back to currency
// (non-OMR strongly implies an import) rather than leaving it unclassified.
function classifyPurchaseType(vendorCountry, currencyName) {
  if (vendorCountry) return /^oman$/i.test(vendorCountry) ? 'Local' : 'Foreign';
  if (currencyName) return currencyName === 'OMR' ? 'Local' : 'Foreign';
  return 'Unknown';
}

// ---------------- Parts ----------------

const PART_FIELDS = ['id', 'name', 'default_code', 'standard_price', 'list_price', 'image_128', 'uom_id'];

async function searchPart(query) {
  if (!query) return [];
  return searchRead(
    'product.product',
    ['|', ['default_code', 'ilike', query], ['name', 'ilike', query]],
    PART_FIELDS,
    { limit: 25 }
  );
}

async function getStockByLocation(productId) {
  return searchRead(
    'stock.quant',
    [['product_id', '=', productId], ['location_id.usage', '=', 'internal']],
    ['location_id', 'quantity', 'reserved_quantity']
  );
}

// Open (not yet fully received) purchase order lines for this product -
// "incoming" stock, never a reorder judgment.
async function getIncomingStock(productId) {
  return searchRead(
    'purchase.order.line',
    [['product_id', '=', productId], ['order_id.state', '=', 'purchase']],
    ['product_qty', 'qty_received', 'date_planned', 'order_id']
  );
}

// Best-effort. Answers "which delivery/transfer is holding my reserved
// stock" - not just which location, which stock.quant.reserved_quantity
// alone can't say. stock.move.line is the actual reservation record (one
// per location a move has claimed stock from); querying it directly for
// not-yet-done lines tied to a real transfer is more robust than inferring
// from stock.move state, which varies in meaning across partial/backorder
// scenarios. Any schema mismatch (field renamed in this Odoo instance)
// degrades to an empty list - the reliable reserved_quantity total from
// getStockByLocation still shows even if this detail can't be resolved.
async function getReservedTransfers(productId) {
  try {
    // Excludes incoming receipts - reserved_quantity means on-hand stock
    // earmarked for something going OUT (a delivery or an internal transfer),
    // never stock still arriving from a purchase. Without this filter, a
    // confirmed-but-not-yet-received PO line matches the same "not done"
    // state and would wrongly show up here as if it were a reservation.
    const moveLines = await searchRead(
      'stock.move.line',
      [
        ['product_id', '=', productId],
        ['state', 'not in', ['done', 'cancel']],
        ['picking_id', '!=', false],
        ['picking_id.picking_type_id.code', '!=', 'incoming']
      ],
      ['quantity', 'location_id', 'picking_id']
    );
    if (!moveLines.length) return [];

    const pickingIds = uniqueRelationIds(moveLines, 'picking_id');
    const pickings = pickingIds.length
      ? await searchRead('stock.picking', [['id', 'in', pickingIds]], ['id', 'name', 'origin', 'picking_type_id'])
      : [];
    const pickingById = {};
    for (const p of pickings) pickingById[p.id] = p;

    return moveLines.map((l) => {
      const pickingId = Array.isArray(l.picking_id) ? l.picking_id[0] : null;
      const picking = pickingId !== null ? pickingById[pickingId] : null;
      return {
        qty: l.quantity,
        location: Array.isArray(l.location_id) ? l.location_id[1] : null,
        pickingName: picking ? picking.name : (Array.isArray(l.picking_id) ? l.picking_id[1] : null),
        pickingType: picking && Array.isArray(picking.picking_type_id) ? picking.picking_type_id[1] : null,
        origin: picking ? picking.origin : null
      };
    });
  } catch (err) {
    return [];
  }
}

// Confirmed/done purchase lines, joined to their order's vendor and currency -
// powers the cost history list and the vendor comparison, without a second
// RPC per line. Vendors are frequently billed in different currencies (OMR,
// USD, AED, ...), so every line also carries an OMR-converted price -
// price_unit_omr is null (never a guessed number) if the currency/rate can't
// be resolved, so the UI can fall back to showing the original amount alone.
async function getPurchaseHistory(productId) {
  const lines = await searchRead(
    'purchase.order.line',
    [['product_id', '=', productId], ['order_id.state', 'in', ['purchase', 'done']]],
    ['price_unit', 'date_planned', 'order_id', 'product_qty']
  );

  const orderIds = uniqueRelationIds(lines, 'order_id');
  const orders = orderIds.length
    ? await searchRead('purchase.order', [['id', 'in', orderIds]], ['id', 'name', 'partner_id', 'currency_id'])
    : [];
  const ordersById = {};
  for (const o of orders) ordersById[o.id] = o;

  const { currencyMap, omr } = await getCurrencyContext(uniqueRelationIds(orders, 'currency_id'));

  let vendorCountryMap = {};
  try {
    vendorCountryMap = await getVendorCountryMap(uniqueRelationIds(orders, 'partner_id'));
  } catch (err) {
    vendorCountryMap = {};
  }

  return lines.map((l) => {
    const orderId = Array.isArray(l.order_id) ? l.order_id[0] : null;
    const order = orderId !== null ? ordersById[orderId] : null;
    const currencyId = order && Array.isArray(order.currency_id) ? order.currency_id[0] : null;
    const currencyName = order && Array.isArray(order.currency_id) ? order.currency_id[1] : null;
    const vendorId = order && Array.isArray(order.partner_id) ? order.partner_id[0] : null;
    const vendorCountry = vendorId !== null ? vendorCountryMap[vendorId] : null;
    return {
      order_id: orderId,
      price_unit: l.price_unit,
      price_unit_omr: currencyId !== null ? convertToOmr(l.price_unit, currencyId, currencyMap, omr) : null,
      currency: currencyName,
      purchase_type: classifyPurchaseType(vendorCountry, currencyName),
      product_qty: l.product_qty,
      date_planned: l.date_planned,
      order_name: order ? order.name : (Array.isArray(l.order_id) ? l.order_id[1] : null),
      vendor: order && Array.isArray(order.partner_id) ? order.partner_id[1] : null,
      vendor_id: vendorId
    };
  });
}

// Best-effort only. Covers EVERY purchase order passed in (not just the most
// recent), so each foreign purchase in the full cost history can show its
// own "purchase + landed = total" line, not only the latest one. Chain per
// order: its receipt picking(s) -> any stock.landed.cost document applied to
// those pickings -> the stock.valuation.layer value that document created
// for THIS product specifically. Going through purchase.order.picking_ids /
// stock.landed.cost.picking_ids (the same relations Odoo's own "New Landed
// Cost" wizard uses to pick receipts) avoids depending on stock.move linkage
// surviving backorders/corrections. Landed cost distribution schema varies
// by how a given Odoo instance uses stock.landed.cost, and plenty of orders
// legitimately have none (local purchases) - either way, any failure here
// (missing field, no receipt yet) must resolve to "not tracked" for that
// order, never an error or a misleading blank/zero on the Cost tab.
//
// A landed cost that applied to this receipt but produced NO valuation layer
// for this product is surfaced separately as "untouched", not dropped. Per
// Odoo's own AVCO rule, a landed cost posted after a receipt's stock is
// already fully sold goes 100% to COGS with no Stock Valuation line at all -
// that's a real risk signal ("this cost may never have reached the product's
// cost field"), not the same as "no landed cost exists". It's still only a
// flag to check, not a confirmed diagnosis: the same empty result would also
// occur if the document was simply never configured to apply to this
// product's line, which this data can't distinguish.
//
// Returns a map of orderId -> { totalValue, entries: [{ costName, value }],
// untouched: [{ costName, date }] }; an order with neither simply has no key.
async function getLandedCostsForOrders(productId, orderIds) {
  try {
    if (!orderIds || !orderIds.length) return {};

    const orders = await searchRead('purchase.order', [['id', 'in', orderIds]], ['id', 'picking_ids']);
    const pickingIds = [...new Set(orders.flatMap((o) => o.picking_ids || []))];
    if (!pickingIds.length) return {};

    // Posted ('done') only - a draft landed cost has no valuation layers yet
    // simply because it hasn't been validated, and would otherwise be
    // misreported below as "untouched / went to COGS".
    const landedCosts = await searchRead(
      'stock.landed.cost',
      [['picking_ids', 'in', pickingIds], ['state', '=', 'done']],
      ['id', 'name', 'picking_ids', 'date']
    );
    if (!landedCosts.length) return {};

    const costIds = landedCosts.map((c) => c.id);
    const layers = await searchRead(
      'stock.valuation.layer',
      [['product_id', '=', productId], ['stock_landed_cost_id', 'in', costIds]],
      ['value', 'stock_landed_cost_id']
    );

    // Value this specific product picked up from each landed cost document -
    // summed defensively in case a document created more than one layer for it.
    const valueByCostId = {};
    for (const l of layers) {
      const costId = Array.isArray(l.stock_landed_cost_id) ? l.stock_landed_cost_id[0] : null;
      if (costId === null) continue;
      valueByCostId[costId] = (valueByCostId[costId] || 0) + (l.value || 0);
    }

    // Odoo splits every landed cost across products/moves in
    // stock.valuation.adjustment.lines BEFORE deciding whether that split
    // lands in a stock.valuation.layer or gets diverted to COGS - so this is
    // the only place the diverted amount for an "untouched" cost still shows
    // up. additional_landed_cost is the amount allocated to this product.
    // Fetched defensively: if this model/field isn't available on some
    // deployment, the untouched flag should still work, just without a value.
    const allocatedByCostId = {};
    try {
      const adjustmentLines = await searchRead(
        'stock.valuation.adjustment.lines',
        [['product_id', '=', productId], ['cost_id', 'in', costIds]],
        ['additional_landed_cost', 'cost_id']
      );
      for (const a of adjustmentLines) {
        const costId = Array.isArray(a.cost_id) ? a.cost_id[0] : null;
        if (costId === null) continue;
        allocatedByCostId[costId] = (allocatedByCostId[costId] || 0) + (a.additional_landed_cost || 0);
      }
    } catch (err) {
      // leave allocatedByCostId empty - untouched entries fall back to no value
    }

    const result = {};
    for (const order of orders) {
      const orderPickingIds = new Set(order.picking_ids || []);
      const entries = [];
      const untouched = [];
      let totalValue = 0;
      for (const lc of landedCosts) {
        const touchesThisOrder = (lc.picking_ids || []).some((pid) => orderPickingIds.has(pid));
        if (!touchesThisOrder) continue;
        const value = valueByCostId[lc.id];
        if (typeof value !== 'number') {
          const divertedValue = typeof allocatedByCostId[lc.id] === 'number' ? allocatedByCostId[lc.id] : null;
          untouched.push({ costName: lc.name, date: lc.date, divertedValue });
          continue;
        }
        entries.push({ costName: lc.name, value });
        totalValue += value;
      }
      if (entries.length || untouched.length) result[order.id] = { totalValue, entries, untouched };
    }
    return result;
  } catch (err) {
    return {};
  }
}

// Confirmed sale lines, joined to their order's date, customer and currency.
// Customers can be invoiced in different currencies just like vendors, so
// every line also carries an OMR-converted price for correct margin/revenue
// math downstream (see lib/part-data.js). qty_delivered/qty_invoiced are
// stored fields Odoo already tracks per line (not per whole order), so
// delivery/invoice status can be computed for THIS product specifically even
// when an order mixes other products - no extra query needed for that part.
async function getSalesHistory(productId) {
  const lines = await searchRead(
    'sale.order.line',
    [['product_id', '=', productId], ['order_id.state', '=', 'sale']],
    ['price_unit', 'product_uom_qty', 'qty_delivered', 'qty_invoiced', 'order_id']
  );

  const orderIds = uniqueRelationIds(lines, 'order_id');
  const orders = orderIds.length
    ? await searchRead('sale.order', [['id', 'in', orderIds]], ['id', 'name', 'date_order', 'partner_id', 'currency_id'])
    : [];
  const ordersById = {};
  for (const o of orders) ordersById[o.id] = o;

  const { currencyMap, omr } = await getCurrencyContext(uniqueRelationIds(orders, 'currency_id'));

  return lines.map((l) => {
    const orderId = Array.isArray(l.order_id) ? l.order_id[0] : null;
    const order = orderId !== null ? ordersById[orderId] : null;
    const currencyId = order && Array.isArray(order.currency_id) ? order.currency_id[0] : null;
    const currencyName = order && Array.isArray(order.currency_id) ? order.currency_id[1] : null;
    return {
      line_id: l.id,
      price_unit: l.price_unit,
      price_unit_omr: currencyId !== null ? convertToOmr(l.price_unit, currencyId, currencyMap, omr) : null,
      currency: currencyName,
      product_uom_qty: l.product_uom_qty,
      qty_delivered: l.qty_delivered,
      qty_invoiced: l.qty_invoiced,
      order_name: order ? order.name : (Array.isArray(l.order_id) ? l.order_id[1] : null),
      date_order: order ? order.date_order : null,
      customer: order && Array.isArray(order.partner_id) ? order.partner_id[1] : 'Unknown',
      customer_id: order && Array.isArray(order.partner_id) ? order.partner_id[0] : null
    };
  });
}

// Best-effort, and fetched lazily (only for the sale lines the popup asks
// about, typically one customer's lines at a time) since it's heavier than
// the rest of the sales history. Chain: stock.move.sale_line_id links a
// delivered move straight back to the line it fulfilled -> its picking's
// name is the DO number. sale.order.line.invoice_lines links straight to the
// account.move.line(s) that billed it -> their move's name is the invoice
// number. Both chains are scoped to the SPECIFIC line passed in, so if an
// order/DO/invoice bundles other products too, only entries that actually
// touch our product's line come back. Only 'done' deliveries and 'posted'
// invoices count, matching what qty_delivered/qty_invoiced themselves track.
async function getDeliveryInvoiceDetails(lineIds) {
  try {
    if (!lineIds || !lineIds.length) return {};

    const moves = await searchRead(
      'stock.move',
      [['sale_line_id', 'in', lineIds], ['picking_id', '!=', false], ['state', '=', 'done']],
      ['sale_line_id', 'picking_id']
    );
    const pickingIds = uniqueRelationIds(moves, 'picking_id');
    const pickings = pickingIds.length
      ? await searchRead('stock.picking', [['id', 'in', pickingIds]], ['id', 'name'])
      : [];
    const pickingNameById = {};
    for (const p of pickings) pickingNameById[p.id] = p.name;

    const doNumbersByLine = {};
    for (const m of moves) {
      const lineId = Array.isArray(m.sale_line_id) ? m.sale_line_id[0] : null;
      const pickingId = Array.isArray(m.picking_id) ? m.picking_id[0] : null;
      const name = pickingId !== null ? pickingNameById[pickingId] : null;
      if (lineId === null || !name) continue;
      if (!doNumbersByLine[lineId]) doNumbersByLine[lineId] = new Set();
      doNumbersByLine[lineId].add(name);
    }

    const linesWithInvoices = await searchRead('sale.order.line', [['id', 'in', lineIds]], ['id', 'invoice_lines']);
    const saleLineIdByInvoiceLineId = {};
    for (const l of linesWithInvoices) {
      for (const invoiceLineId of (l.invoice_lines || [])) saleLineIdByInvoiceLineId[invoiceLineId] = l.id;
    }
    const invoiceLineIds = Object.keys(saleLineIdByInvoiceLineId).map(Number);

    const invoiceNumbersByLine = {};
    if (invoiceLineIds.length) {
      const moveLines = await searchRead('account.move.line', [['id', 'in', invoiceLineIds]], ['id', 'move_id']);
      const moveIds = uniqueRelationIds(moveLines, 'move_id');
      const moves2 = moveIds.length
        ? await searchRead('account.move', [['id', 'in', moveIds], ['state', '=', 'posted']], ['id', 'name'])
        : [];
      const moveNameById = {};
      for (const mv of moves2) moveNameById[mv.id] = mv.name;

      for (const ml of moveLines) {
        const saleLineId = saleLineIdByInvoiceLineId[ml.id];
        const moveId = Array.isArray(ml.move_id) ? ml.move_id[0] : null;
        const name = moveId !== null ? moveNameById[moveId] : null;
        if (saleLineId === undefined || !name) continue;
        if (!invoiceNumbersByLine[saleLineId]) invoiceNumbersByLine[saleLineId] = new Set();
        invoiceNumbersByLine[saleLineId].add(name);
      }
    }

    const result = {};
    for (const lineId of lineIds) {
      result[lineId] = {
        doNumbers: doNumbersByLine[lineId] ? [...doNumbersByLine[lineId]] : [],
        invoiceNumbers: invoiceNumbersByLine[lineId] ? [...invoiceNumbersByLine[lineId]] : []
      };
    }
    return result;
  } catch (err) {
    return {};
  }
}

// ---------------- Customers ----------------

const CUSTOMER_FIELDS = ['id', 'name', 'phone', 'email', 'company_id', 'user_id', 'property_product_pricelist'];

// name is optional - an empty/omitted name browses all customers (used by
// filter-only searches like "Muscat over OMR 5000" with no name in it).
async function searchCustomers(name) {
  const domain = [['customer_rank', '>', 0]];
  if (name) domain.push(['name', 'ilike', name]);
  return searchRead('res.partner', domain, CUSTOMER_FIELDS, { limit: 300 });
}

async function getOrdersForPartners(partnerIds) {
  if (!partnerIds || !partnerIds.length) return [];
  return searchRead(
    'sale.order',
    [['partner_id', 'in', partnerIds]],
    ['name', 'amount_total', 'date_order', 'state', 'partner_id']
  );
}

// Most frequently/heavily purchased parts for one customer - domain traversal
// (order_id.partner_id) is fine here since it's a search filter, not a field projection.
async function getCustomerTopProducts(partnerId) {
  return searchRead(
    'sale.order.line',
    [['order_id.partner_id', '=', partnerId], ['order_id.state', '=', 'sale']],
    ['product_id', 'product_uom_qty', 'price_subtotal']
  );
}

// ---------------- Landed cost audit (all parts) ----------------

// "All time" can mean thousands of receipts/moves - split big id lists so no
// single RPC carries an enormous 'in' domain.
async function searchReadIn(model, field, ids, extraDomain, fields) {
  const CHUNK = 500;
  const out = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const recs = await searchRead(model, [[field, 'in', chunk], ...(extraDomain || [])], fields);
    out.push(...recs);
  }
  return out;
}

function relId(value) {
  return Array.isArray(value) ? value[0] : null;
}

function relName(value) {
  return Array.isArray(value) ? value[1] : null;
}

// purchase.order id -> { name, vendor, purchaseType } using the same
// Local/Foreign rule as the Cost tab (vendor country, falling back to currency).
async function getOrderClassification(orderIds) {
  if (!orderIds.length) return {};
  const orders = await searchReadIn('purchase.order', 'id', orderIds, [], ['id', 'name', 'partner_id', 'currency_id']);
  let vendorCountryMap = {};
  try {
    vendorCountryMap = await getVendorCountryMap([...new Set(orders.map((o) => relId(o.partner_id)).filter((id) => id !== null))]);
  } catch (err) {
    vendorCountryMap = {};
  }
  const map = {};
  for (const o of orders) {
    const vendorId = relId(o.partner_id);
    map[o.id] = {
      name: o.name,
      vendor: relName(o.partner_id),
      vendorId,
      purchaseType: classifyPurchaseType(vendorId !== null ? vendorCountryMap[vendorId] : null, relName(o.currency_id))
    };
  }
  return map;
}

// Company-wide, read-only. Returns the raw material for lib/landed-audit.js:
//
// receiptLines - one per (receipt, product) for FOREIGN-purchase receipts
//   validated since `sinceDate` that have no POSTED landed cost. Received and
//   remaining qty come from the receipt's own stock.valuation.layer (the same
//   per-receipt "remaining quantity" Odoo uses to split a landed cost), not
//   from total on-hand stock.
//
// divertedLines - one per (posted landed cost, receipt move) for landed costs
//   dated since `sinceDate` on foreign receipts: the share Odoo allocated
//   (stock.valuation.adjustment.lines) vs. the value that actually reached a
//   valuation layer. The difference is what went straight to COGS.
//
// historyReceipts - foreign receipts that DO have a posted landed cost, with
//   the cost products on them. Fetched over at least the last 365 days (even
//   for a 30-day view) so lib/landed-audit.js can learn which charges each
//   vendor's shipments normally carry and flag receipts missing one.
//
// bills / negativeRows - see getUnappliedLandedCostBills and
//   getNegativeStockRows. These two are independent checks: if either query
//   fails on this Odoo instance, the rest of the audit still returns, with
//   the failure reported in `errors`.
async function getLandedCostAudit(sinceDate) {
  const since = sinceDate ? `${sinceDate} 00:00:00` : null;

  // History window for "which charges does this vendor usually have".
  const yearAgo = new Date();
  yearAgo.setDate(yearAgo.getDate() - 365);
  const yearAgoStr = yearAgo.toISOString().slice(0, 10);
  const historySinceDate = sinceDate && sinceDate > yearAgoStr ? yearAgoStr : sinceDate;
  const inPeriod = (picking) => !since || (picking.date_done || '') >= since;

  // ---- Part 1: receipts with no posted landed cost ----
  const pickingDomain = [
    ['picking_type_id.code', '=', 'incoming'],
    ['state', '=', 'done'],
    ['purchase_id', '!=', false]
  ];
  if (historySinceDate) pickingDomain.push(['date_done', '>=', `${historySinceDate} 00:00:00`]);
  const pickings = await searchRead('stock.picking', pickingDomain, ['id', 'name', 'date_done', 'purchase_id']);

  // ---- Part 2 input: posted landed costs in the period ----
  const costDomain = [['state', '=', 'done']];
  if (since) costDomain.push(['date', '>=', sinceDate]);
  const postedCosts = await searchRead('stock.landed.cost', costDomain, ['id', 'name', 'date', 'picking_ids', 'account_move_id']);
  const costIds = postedCosts.map((c) => c.id);

  // When each landed cost was actually validated (its journal entry's
  // creation time) - units sold before this moment are the ones whose share
  // went to COGS. The 'date' field is the accounting date, which can differ.
  const costValidatedAt = {};
  try {
    const moveIds = [...new Set(postedCosts.map((c) => relId(c.account_move_id)).filter((id) => id !== null))];
    const entries = moveIds.length ? await searchReadIn('account.move', 'id', moveIds, [], ['id', 'create_date']) : [];
    const createdById = {};
    for (const e of entries) createdById[e.id] = e.create_date;
    for (const c of postedCosts) costValidatedAt[c.id] = createdById[relId(c.account_move_id)] || null;
  } catch (err) {
    // no cutoff available - affected-sales view falls back to "all sales from this receipt"
  }

  const adjustmentLines = costIds.length
    ? await searchReadIn('stock.valuation.adjustment.lines', 'cost_id', costIds, [],
      ['cost_id', 'product_id', 'move_id', 'additional_landed_cost'])
    : [];
  const adjMoveIds = [...new Set(adjustmentLines.map((a) => relId(a.move_id)).filter((id) => id !== null))];
  const adjMoves = adjMoveIds.length
    ? await searchReadIn('stock.move', 'id', adjMoveIds, [], ['id', 'picking_id'])
    : [];
  const adjPickingIds = [...new Set(adjMoves.map((m) => relId(m.picking_id)).filter((id) => id !== null))];
  const adjPickings = adjPickingIds.length
    ? await searchReadIn('stock.picking', 'id', adjPickingIds, [], ['id', 'name', 'purchase_id'])
    : [];

  // One classification pass covers both parts.
  const orderIds = [...new Set([...pickings, ...adjPickings].map((p) => relId(p.purchase_id)).filter((id) => id !== null))];
  const orderInfo = await getOrderClassification(orderIds);
  const isForeign = (picking) => {
    const info = orderInfo[relId(picking.purchase_id)];
    return !!info && info.purchaseType === 'Foreign';
  };

  // ---- Part 1 continued ----
  const foreignAll = pickings.filter(isForeign);
  const foreignPickings = foreignAll.filter(inPeriod);
  const foreignAllIds = foreignAll.map((p) => p.id);

  const costsOnForeign = foreignAllIds.length
    ? await searchReadIn('stock.landed.cost', 'picking_ids', foreignAllIds, [['state', 'in', ['draft', 'done']]],
      ['id', 'name', 'state', 'picking_ids'])
    : [];
  const postedPickingIds = new Set();
  const draftNamesByPicking = {};
  for (const c of costsOnForeign) {
    for (const pid of (c.picking_ids || [])) {
      if (c.state === 'done') postedPickingIds.add(pid);
      else (draftNamesByPicking[pid] = draftNamesByPicking[pid] || []).push(c.name);
    }
  }

  // ---- Receipts that have SOME landed cost: which cost products are on them ----
  const historyReceipts = [];
  try {
    const doneCosts = costsOnForeign.filter((c) => c.state === 'done');
    const costLines = doneCosts.length
      ? await searchReadIn('stock.landed.cost.lines', 'cost_id', doneCosts.map((c) => c.id), [], ['cost_id', 'product_id'])
      : [];
    const productsByCost = {};
    for (const l of costLines) {
      const cid = relId(l.cost_id);
      (productsByCost[cid] = productsByCost[cid] || new Set()).add(relName(l.product_id));
    }
    const costsByPicking = {};
    for (const c of doneCosts) {
      for (const pid of (c.picking_ids || [])) (costsByPicking[pid] = costsByPicking[pid] || []).push(c);
    }
    for (const p of foreignAll) {
      const costs = costsByPicking[p.id];
      if (!costs || !costs.length) continue;
      const info = orderInfo[relId(p.purchase_id)] || {};
      const products = new Set();
      for (const c of costs) for (const name of (productsByCost[c.id] || [])) if (name) products.add(name);
      historyReceipts.push({
        pickingId: p.id,
        pickingName: p.name,
        dateDone: p.date_done,
        poName: info.name || relName(p.purchase_id),
        vendor: info.vendor || null,
        vendorKey: info.vendorId === undefined ? null : info.vendorId,
        inPeriod: inPeriod(p),
        costProducts: [...products],
        landedCosts: costs.map((c) => c.name)
      });
    }
  } catch (err) {
    // leave historyReceipts empty - the "possibly missing" list just shows nothing
  }

  const missingPickings = foreignPickings.filter((p) => !postedPickingIds.has(p.id));
  const missingById = {};
  for (const p of missingPickings) missingById[p.id] = p;

  const receiptMoves = missingPickings.length
    ? await searchReadIn('stock.move', 'picking_id', missingPickings.map((p) => p.id), [['state', '=', 'done']],
      ['id', 'picking_id', 'product_id'])
    : [];
  const receiptMoveById = {};
  for (const m of receiptMoves) receiptMoveById[m.id] = m;

  // quantity > 0 keeps only the receipt's own layer - landed cost and
  // negative-stock correction layers on the same move have quantity 0.
  const receiptLayers = receiptMoves.length
    ? await searchReadIn('stock.valuation.layer', 'stock_move_id', receiptMoves.map((m) => m.id), [['quantity', '>', 0]],
      ['stock_move_id', 'quantity', 'remaining_qty', 'value'])
    : [];

  const receiptLineByKey = {};
  for (const layer of receiptLayers) {
    const move = receiptMoveById[relId(layer.stock_move_id)];
    if (!move) continue;
    const pickingId = relId(move.picking_id);
    const picking = missingById[pickingId];
    if (!picking) continue;
    const productId = relId(move.product_id);
    const key = `${pickingId}:${productId}`;
    if (!receiptLineByKey[key]) {
      const info = orderInfo[relId(picking.purchase_id)] || {};
      receiptLineByKey[key] = {
        pickingId,
        pickingName: picking.name,
        dateDone: picking.date_done,
        poName: info.name || relName(picking.purchase_id),
        vendor: info.vendor || null,
        productId,
        product: relName(move.product_id),
        moveIds: [],
        receivedQty: 0,
        remainingQty: 0,
        receivedValue: 0,
        draftLandedCosts: draftNamesByPicking[pickingId] || []
      };
    }
    const row = receiptLineByKey[key];
    if (!row.moveIds.includes(move.id)) row.moveIds.push(move.id);
    row.receivedQty += layer.quantity || 0;
    row.remainingQty += layer.remaining_qty || 0;
    row.receivedValue += layer.value || 0;
  }

  // ---- Part 2 continued: allocated vs. reached-stock per (cost, move) ----
  const costLayers = costIds.length
    ? await searchReadIn('stock.valuation.layer', 'stock_landed_cost_id', costIds, [],
      ['stock_landed_cost_id', 'stock_move_id', 'value'])
    : [];
  const intoStockByKey = {};
  for (const l of costLayers) {
    const key = `${relId(l.stock_landed_cost_id)}:${relId(l.stock_move_id)}`;
    intoStockByKey[key] = (intoStockByKey[key] || 0) + (l.value || 0);
  }

  const costById = {};
  for (const c of postedCosts) costById[c.id] = c;
  const adjMoveById = {};
  for (const m of adjMoves) adjMoveById[m.id] = m;
  const adjPickingById = {};
  for (const p of adjPickings) adjPickingById[p.id] = p;

  const divertedByKey = {};
  for (const a of adjustmentLines) {
    const costId = relId(a.cost_id);
    const moveId = relId(a.move_id);
    const move = adjMoveById[moveId];
    const picking = move ? adjPickingById[relId(move.picking_id)] : null;
    if (!picking || !isForeign(picking)) continue;
    const key = `${costId}:${moveId}`;
    if (!divertedByKey[key]) {
      const cost = costById[costId] || {};
      const info = orderInfo[relId(picking.purchase_id)] || {};
      divertedByKey[key] = {
        costId,
        costName: cost.name || relName(a.cost_id),
        costDate: cost.date || null,
        costValidatedAt: costValidatedAt[costId] || null,
        moveId,
        pickingName: picking.name,
        poName: info.name || relName(picking.purchase_id),
        vendor: info.vendor || null,
        productId: relId(a.product_id),
        product: relName(a.product_id),
        allocated: 0,
        intoStock: intoStockByKey[key] || 0
      };
    }
    divertedByKey[key].allocated += a.additional_landed_cost || 0;
  }

  const errors = {};
  let bills = [];
  try {
    bills = await getUnappliedLandedCostBills(sinceDate);
  } catch (err) {
    errors.bills = String(err && err.message ? err.message : err);
  }
  let negativeRows = [];
  try {
    negativeRows = await getNegativeStockRows(since);
  } catch (err) {
    errors.negative = String(err && err.message ? err.message : err);
  }

  return {
    receiptLines: Object.values(receiptLineByKey),
    divertedLines: Object.values(divertedByKey),
    historyReceipts,
    bills,
    negativeRows,
    errors
  };
}

// Posted vendor bills (in any currency - amounts read in company currency via
// 'balance') that carry landed-cost lines (product flagged "Is a Landed
// Cost"), with the landed cost documents created from each bill. Not limited
// to foreign vendors: freight forwarders and clearing agents are often local.
async function getUnappliedLandedCostBills(sinceDate) {
  const domain = [
    ['is_landed_costs_line', '=', true],
    ['move_id.state', '=', 'posted'],
    ['move_id.move_type', '=', 'in_invoice']
  ];
  if (sinceDate) domain.push(['date', '>=', sinceDate]);
  const lines = await searchRead('account.move.line', domain, ['move_id', 'product_id', 'balance']);
  const billIds = [...new Set(lines.map((l) => relId(l.move_id)).filter((id) => id !== null))];
  if (!billIds.length) return [];

  const bills = await searchReadIn('account.move', 'id', billIds, [], ['id', 'name', 'date', 'partner_id']);
  const costs = await searchReadIn('stock.landed.cost', 'vendor_bill_id', billIds, [['state', 'in', ['draft', 'done']]],
    ['id', 'name', 'state', 'amount_total', 'vendor_bill_id']);

  const byBill = {};
  for (const b of bills) {
    byBill[b.id] = {
      billId: b.id, billName: b.name, date: b.date, vendor: relName(b.partner_id),
      lcLines: [], appliedCosts: [], draftCosts: []
    };
  }
  for (const l of lines) {
    const bill = byBill[relId(l.move_id)];
    if (bill) bill.lcLines.push({ product: relName(l.product_id), amount: l.balance || 0 });
  }
  for (const c of costs) {
    const bill = byBill[relId(c.vendor_bill_id)];
    if (!bill) continue;
    if (c.state === 'done') bill.appliedCosts.push({ id: c.id, name: c.name, amount: c.amount_total || 0 });
    else bill.draftCosts.push(c.name);
  }
  return Object.values(byBill);
}

const OUT_LAYER_FIELDS = ['id', 'product_id', 'quantity', 'unit_cost', 'remaining_qty', 'stock_move_id', 'create_date'];

// Deliveries made while stock was below zero. Two sources:
//  - still waiting: outgoing layers whose remaining_qty is still negative
//    (always shown, whatever the period - they're open problems);
//  - already covered: Odoo's negative-stock correction layers (quantity 0,
//    linked to the outgoing layer they fix), created in the period.
// Known gap: when the receipt's price exactly matched the cost used on the
// sale, Odoo creates no correction layer, so that covered sale can't be seen.
async function getNegativeStockRows(since) {
  const corrDomain = [
    ['stock_valuation_layer_id', '!=', false],
    ['stock_landed_cost_id', '=', false],
    ['quantity', '=', 0]
  ];
  if (since) corrDomain.push(['create_date', '>=', since]);
  const corrections = await searchRead('stock.valuation.layer', corrDomain, ['stock_valuation_layer_id', 'value', 'create_date']);

  const correctionByOut = {};
  for (const c of corrections) {
    const outId = relId(c.stock_valuation_layer_id);
    if (outId === null) continue;
    const entry = correctionByOut[outId] || (correctionByOut[outId] = { value: 0, at: null });
    entry.value += c.value || 0;
    if (!entry.at || (c.create_date || '') > entry.at) entry.at = c.create_date;
  }

  // Linked layers with quantity < 0 only - vendor-bill price difference
  // layers also link to a layer, but to an incoming one.
  const correctedOuts = Object.keys(correctionByOut).length
    ? await searchReadIn('stock.valuation.layer', 'id', Object.keys(correctionByOut).map(Number), [['quantity', '<', 0]], OUT_LAYER_FIELDS)
    : [];
  const waitingOuts = await searchRead('stock.valuation.layer',
    [['quantity', '<', 0], ['remaining_qty', '<', 0]], OUT_LAYER_FIELDS);

  const outsById = {};
  for (const l of [...correctedOuts, ...waitingOuts]) outsById[l.id] = l;
  const outs = Object.values(outsById);
  if (!outs.length) return [];

  const saleInfo = await getMoveSaleInfo([...new Set(outs.map((l) => relId(l.stock_move_id)).filter((id) => id !== null))]);

  return outs.map((l) => {
    const corr = correctionByOut[l.id];
    return {
      outLayerId: l.id,
      productId: relId(l.product_id),
      product: relName(l.product_id),
      qty: -(l.quantity || 0),
      unitCost: l.unit_cost,
      date: l.create_date,
      waitingQty: l.remaining_qty < 0 ? -l.remaining_qty : 0,
      correction: corr ? corr.value : 0,
      coveredAt: corr ? corr.at : null,
      sale: saleInfo[relId(l.stock_move_id)] || null
    };
  });
}

// stock.move id -> { pickingId, pickingName, date, qty, saleOrderId,
// saleOrderName, customer, priceUnit, currency }. saleOrderId is null for
// moves that didn't come from a sale (returns to vendor, adjustments).
async function getMoveSaleInfo(moveIds) {
  if (!moveIds || !moveIds.length) return {};
  const moves = await searchReadIn('stock.move', 'id', moveIds, [], ['id', 'sale_line_id', 'picking_id', 'date', 'product_qty']);
  const saleLineIds = [...new Set(moves.map((m) => relId(m.sale_line_id)).filter((id) => id !== null))];
  const saleLines = saleLineIds.length
    ? await searchReadIn('sale.order.line', 'id', saleLineIds, [], ['id', 'order_id', 'price_unit'])
    : [];
  const saleLineById = {};
  for (const l of saleLines) saleLineById[l.id] = l;
  const orderIds = [...new Set(saleLines.map((l) => relId(l.order_id)).filter((id) => id !== null))];
  const orders = orderIds.length
    ? await searchReadIn('sale.order', 'id', orderIds, [], ['id', 'name', 'partner_id', 'date_order', 'currency_id'])
    : [];
  const orderById = {};
  for (const o of orders) orderById[o.id] = o;

  const map = {};
  for (const m of moves) {
    const line = saleLineById[relId(m.sale_line_id)];
    const order = line ? orderById[relId(line.order_id)] : null;
    map[m.id] = {
      pickingId: relId(m.picking_id),
      pickingName: relName(m.picking_id),
      date: m.date,
      qty: m.product_qty,
      saleOrderId: order ? order.id : null,
      saleOrderName: order ? order.name : null,
      customer: order ? relName(order.partner_id) : null,
      priceUnit: line ? line.price_unit : null,
      currency: order ? relName(order.currency_id) : null
    };
  }
  return map;
}

// Every stock-moving valuation layer of one product, oldest first - the input
// for lib/landed-audit.js's replayFifo() ("which sales used this receipt").
async function getProductLayers(productId) {
  const layers = await searchRead('stock.valuation.layer',
    [['product_id', '=', productId], ['quantity', '!=', 0]],
    ['id', 'stock_move_id', 'quantity', 'remaining_qty', 'create_date'],
    { order: 'create_date asc, id asc' });
  return layers.map((l) => ({
    id: l.id,
    moveId: relId(l.stock_move_id),
    quantity: l.quantity,
    remainingQty: l.remaining_qty,
    createDate: l.create_date
  }));
}

// ---------------- Stock-outs (negative / sold-out stock) ----------------

// Big result sets (a month of stock moves) are read in pages so no single
// request is enormous.
async function searchReadPaged(model, domain, fields, order, pageSize = 5000, context) {
  const out = [];
  for (let offset = 0; ; offset += pageSize) {
    const kwargs = { limit: pageSize, offset, order };
    if (context) kwargs.context = context;
    const page = await searchRead(model, domain, fields, kwargs);
    out.push(...page);
    if (page.length < pageSize) return out;
  }
}

// Raw material for lib/stockout-analysis.js. sinceUtc is the UTC datetime of
// local midnight on the first day of the report: every done move of a
// storable product from then until now is needed, because the day-by-day
// balance is rebuilt backwards from today's on-hand.
//
// Locations/products are read including archived ones (active_test false) -
// old moves can point at a location or part that has since been archived.
async function getStockoutData(sinceUtc) {
  const withArchived = { active_test: false };

  const [locations, warehouses] = await Promise.all([
    searchRead('stock.location', [], ['id', 'usage', 'warehouse_id'], { context: withArchived }),
    searchRead('stock.warehouse', [], ['id', 'name', 'code'])
  ]);

  const moves = await searchReadPaged('stock.move',
    [['state', '=', 'done'], ['date', '>=', sinceUtc], ['product_id.type', '=', 'product']],
    ['id', 'product_id', 'product_qty', 'date', 'location_id', 'location_dest_id', 'reference'],
    'date asc, id asc');

  const movedProductIds = [...new Set(moves.map((m) => relId(m.product_id)).filter((id) => id !== null))];
  const quantFields = ['product_id', 'location_id', 'quantity'];
  const internal = [['location_id.usage', '=', 'internal']];
  const [movedQuants, negativeQuants] = await Promise.all([
    movedProductIds.length ? searchReadIn('stock.quant', 'product_id', movedProductIds, internal, quantFields) : [],
    // parts sitting negative with no moves in the period still belong in the report
    searchRead('stock.quant', [...internal, ['quantity', '<', 0]], quantFields)
  ]);
  const quantsById = {};
  for (const q of [...movedQuants, ...negativeQuants]) quantsById[q.id] = q;
  const quants = Object.values(quantsById);

  const productIds = [...new Set([...movedProductIds, ...quants.map((q) => relId(q.product_id))].filter((id) => id !== null))];
  const productRecs = productIds.length
    ? await searchReadIn('product.product', 'id', productIds, [], ['id', 'default_code', 'name'])
    : [];
  // archived parts: searchReadIn has no context, so fetch any missing ones separately
  const found = new Set(productRecs.map((p) => p.id));
  const missing = productIds.filter((id) => !found.has(id));
  if (missing.length) {
    productRecs.push(...await searchRead('product.product', [['id', 'in', missing]], ['id', 'default_code', 'name'], { context: withArchived }));
  }

  const locationMap = {};
  for (const l of locations) locationMap[l.id] = { usage: l.usage, warehouseId: relId(l.warehouse_id) };
  const products = {};
  for (const p of productRecs) products[p.id] = { code: p.default_code || '', name: p.name || '' };

  return {
    locations: locationMap,
    warehouses: warehouses.map((w) => ({ id: w.id, name: w.name, code: w.code })),
    moves: moves.map((m) => ({
      id: m.id,
      productId: relId(m.product_id),
      qty: m.product_qty || 0,
      date: m.date,
      src: relId(m.location_id),
      dest: relId(m.location_dest_id),
      reference: m.reference || null
    })),
    onHand: quants.map((q) => ({ productId: relId(q.product_id), locationId: relId(q.location_id), quantity: q.quantity || 0 })),
    products
  };
}

// ---------------- Message routing ----------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handlers = {
    SEARCH_PART: () => searchPart(msg.query),
    GET_STOCK: () => getStockByLocation(msg.productId),
    GET_INCOMING_STOCK: () => getIncomingStock(msg.productId),
    GET_RESERVED_TRANSFERS: () => getReservedTransfers(msg.productId),
    GET_PURCHASE_HISTORY: () => getPurchaseHistory(msg.productId),
    GET_LANDED_COSTS_FOR_ORDERS: () => getLandedCostsForOrders(msg.productId, msg.orderIds),
    GET_SALES_HISTORY: () => getSalesHistory(msg.productId),
    GET_DELIVERY_INVOICE_DETAILS: () => getDeliveryInvoiceDetails(msg.lineIds),
    SEARCH_CUSTOMERS: () => searchCustomers(msg.name),
    GET_ORDERS_FOR_PARTNERS: () => getOrdersForPartners(msg.partnerIds),
    GET_CUSTOMER_TOP_PRODUCTS: () => getCustomerTopProducts(msg.partnerId),
    GET_LANDED_COST_AUDIT: () => getLandedCostAudit(msg.sinceDate),
    GET_PRODUCT_LAYERS: () => getProductLayers(msg.productId),
    GET_MOVE_SALE_INFO: () => getMoveSaleInfo(msg.moveIds),
    GET_STOCKOUT_DATA: () => getStockoutData(msg.sinceUtc)
  };

  const handler = handlers[msg && msg.type];
  if (!handler) return;

  handler()
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
  return true; // keeps the message channel open for the async response
});

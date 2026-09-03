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

// Groups a list of records that carry a many2one [id, label] field into a
// map of id -> array of records, for a client-side join against a second
// query's results (e.g. purchase.order.line rows joined to their purchase.order).
function groupByRelationId(records, relationField) {
  const map = {};
  for (const r of records) {
    const rel = r[relationField];
    const id = Array.isArray(rel) ? rel[0] : null;
    if (id === null) continue;
    if (!map[id]) map[id] = [];
    map[id].push(r);
  }
  return map;
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
// order, never an error or a misleading blank/zero on the Cost tab. Returns
// a map of orderId -> { totalValue, entries: [{ costName, value }] };
// an order with no landed cost simply has no key.
async function getLandedCostsForOrders(productId, orderIds) {
  try {
    if (!orderIds || !orderIds.length) return {};

    const orders = await searchRead('purchase.order', [['id', 'in', orderIds]], ['id', 'picking_ids']);
    const pickingIds = [...new Set(orders.flatMap((o) => o.picking_ids || []))];
    if (!pickingIds.length) return {};

    const landedCosts = await searchRead(
      'stock.landed.cost',
      [['picking_ids', 'in', pickingIds]],
      ['id', 'name', 'picking_ids']
    );
    if (!landedCosts.length) return {};

    const costIds = landedCosts.map((c) => c.id);
    const layers = await searchRead(
      'stock.valuation.layer',
      [['product_id', '=', productId], ['stock_landed_cost_id', 'in', costIds]],
      ['value', 'stock_landed_cost_id']
    );
    if (!layers.length) return {};

    // Value this specific product picked up from each landed cost document -
    // summed defensively in case a document created more than one layer for it.
    const valueByCostId = {};
    for (const l of layers) {
      const costId = Array.isArray(l.stock_landed_cost_id) ? l.stock_landed_cost_id[0] : null;
      if (costId === null) continue;
      valueByCostId[costId] = (valueByCostId[costId] || 0) + (l.value || 0);
    }

    const result = {};
    for (const order of orders) {
      const orderPickingIds = new Set(order.picking_ids || []);
      const entries = [];
      let totalValue = 0;
      for (const lc of landedCosts) {
        const touchesThisOrder = (lc.picking_ids || []).some((pid) => orderPickingIds.has(pid));
        if (!touchesThisOrder) continue;
        const value = valueByCostId[lc.id];
        if (typeof value !== 'number') continue; // this document never touched OUR product
        entries.push({ costName: lc.name, value });
        totalValue += value;
      }
      if (entries.length) result[order.id] = { totalValue, entries };
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

// ---------------- Message routing ----------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handlers = {
    SEARCH_PART: () => searchPart(msg.query),
    GET_STOCK: () => getStockByLocation(msg.productId),
    GET_INCOMING_STOCK: () => getIncomingStock(msg.productId),
    GET_PURCHASE_HISTORY: () => getPurchaseHistory(msg.productId),
    GET_LANDED_COSTS_FOR_ORDERS: () => getLandedCostsForOrders(msg.productId, msg.orderIds),
    GET_SALES_HISTORY: () => getSalesHistory(msg.productId),
    GET_DELIVERY_INVOICE_DETAILS: () => getDeliveryInvoiceDetails(msg.lineIds),
    SEARCH_CUSTOMERS: () => searchCustomers(msg.name),
    GET_ORDERS_FOR_PARTNERS: () => getOrdersForPartners(msg.partnerIds),
    GET_CUSTOMER_TOP_PRODUCTS: () => getCustomerTopProducts(msg.partnerId)
  };

  const handler = handlers[msg && msg.type];
  if (!handler) return;

  handler()
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
  return true; // keeps the message channel open for the async response
});

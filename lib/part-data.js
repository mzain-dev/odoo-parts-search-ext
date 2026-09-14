// Pure functions: no DOM, no chrome.* calls. Shared by popup.js and testable
// in isolation. Every input here already carries whatever joins
// content-scripts/odoo-bridge.js performed (e.g. purchase/sale lines already
// know their order's vendor/customer/currency and date) - nothing in this
// file makes further Odoo calls.

const DAY_MS = 1000 * 60 * 60 * 24;

function toDate(str) {
  return str ? new Date(str) : null;
}

function daysSince(dateStr, now = new Date()) {
  const d = toDate(dateStr);
  if (!d) return Infinity;
  return Math.floor((now - d) / DAY_MS);
}

// Best available OMR figure for an amount: the pre-converted value if the
// currency lookup succeeded, or the raw amount itself when it's OMR-native
// (or currency is simply unknown, e.g. older data - nothing here contradicts
// that assumption, so raw amount is a reasonable best effort). Only returns
// null when the currency is KNOWN to be foreign and unconverted - that's the
// one case where blending the raw amount in would silently mix currencies.
function bestOmrAmount(amount, currency, amountOmr) {
  if (typeof amountOmr === 'number') return amountOmr;
  if ((currency === 'OMR' || !currency) && typeof amount === 'number') return amount;
  return null;
}

// ---------------- Stock & Location (Phase 2) ----------------

function shapeStockByLocation(quants) {
  const byLocation = {};
  let totalFree = 0;
  let totalReserved = 0;
  let totalOnHand = 0;
  for (const q of quants) {
    const loc = Array.isArray(q.location_id) ? q.location_id[1] : 'Unknown';
    if (!byLocation[loc]) byLocation[loc] = { location: loc, qty: 0, reserved: 0 };
    byLocation[loc].qty += q.quantity;
    byLocation[loc].reserved += q.reserved_quantity;
    totalFree += (q.quantity - q.reserved_quantity);
    totalReserved += q.reserved_quantity;
    totalOnHand += q.quantity;
  }
  return {
    byLocation: Object.values(byLocation),
    totalFreeToSell: totalFree,
    totalReserved: totalReserved,
    totalOnHand
  };
}

// On-hand quantity valued at the current avg cost (OMR, since that's the
// company-currency field Odoo already reports standard_price in). null
// rather than 0 when either input is missing, so the UI can omit the tile
// instead of showing a misleading zero.
function computeStockValue(totalOnHand, avgCost) {
  if (typeof totalOnHand !== 'number' || typeof avgCost !== 'number') return null;
  return totalOnHand * avgCost;
}

// Remaining-to-receive quantity per open PO line - describes what's on order,
// never whether more should be ordered.
function shapeIncomingStock(lines) {
  const items = lines
    .map((l) => ({
      orderName: Array.isArray(l.order_id) ? l.order_id[1] : null,
      datePlanned: l.date_planned,
      remaining: Math.max(0, (l.product_qty || 0) - (l.qty_received || 0))
    }))
    .filter((l) => l.remaining > 0)
    .sort((a, b) => new Date(a.datePlanned || 0) - new Date(b.datePlanned || 0));

  const totalIncoming = items.reduce((sum, l) => sum + l.remaining, 0);
  return { items, totalIncoming };
}

// Which delivery/internal transfer is holding the reserved stock, not just
// which location - sorted largest reservation first (most actionable when
// there are several). Zero-qty lines filtered out defensively.
function shapeReservedTransfers(lines) {
  const items = lines
    .map((l) => ({
      pickingName: l.pickingName,
      pickingType: l.pickingType,
      origin: l.origin,
      location: l.location,
      qty: l.qty || 0
    }))
    .filter((l) => l.qty > 0)
    .sort((a, b) => b.qty - a.qty);

  const totalReserved = items.reduce((sum, l) => sum + l.qty, 0);
  return { items, totalReserved };
}

// ---------------- Cost (Phase 3) ----------------

function shapeCostHistory(purchaseLines) {
  return [...purchaseLines]
    .sort((a, b) => new Date(b.date_planned || 0) - new Date(a.date_planned || 0))
    .map((l) => ({
      orderId: l.order_id,
      price: l.price_unit,
      priceOmr: l.price_unit_omr,
      currency: l.currency,
      purchaseType: l.purchase_type,
      qty: l.product_qty,
      date: l.date_planned,
      order: l.order_name,
      vendor: l.vendor
    }));
}

function sortCostHistory(costHistory, sortBy) {
  const copy = [...costHistory];
  if (sortBy === 'price') {
    copy.sort((a, b) => (bestOmrAmount(b.price, b.currency, b.priceOmr) ?? -Infinity) -
      (bestOmrAmount(a.price, a.currency, a.priceOmr) ?? -Infinity));
  } else if (sortBy === 'vendor') {
    copy.sort((a, b) => (a.vendor || '').localeCompare(b.vendor || ''));
  } else {
    copy.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0)); // date, newest first
  }
  return copy;
}

// Splits cost history into Local/Foreign/Unknown groups, preserving each
// group's existing order - lets the Cost tab show "which purchases even have
// a landed cost" at a glance instead of one flat list.
function groupCostHistoryByType(costHistory) {
  const groups = { Local: [], Foreign: [], Unknown: [] };
  for (const line of costHistory) {
    const key = groups[line.purchaseType] ? line.purchaseType : 'Unknown';
    groups[key].push(line);
  }
  return groups;
}

// Compares OMR-equivalent price where available, not raw price - two
// purchases in different currencies can't be compared as raw numbers.
function costTrend(costHistory) {
  if (costHistory.length < 2) return 'insufficient_data';
  const [latest, previous] = costHistory;
  const latestVal = bestOmrAmount(latest.price, latest.currency, latest.priceOmr) ?? latest.price;
  const prevVal = bestOmrAmount(previous.price, previous.currency, previous.priceOmr) ?? previous.price;
  if (latestVal > prevVal) return 'rising';
  if (latestVal < prevVal) return 'falling';
  return 'stable';
}

// One row per vendor, most-recent price only - lets a buyer compare vendors
// at a glance without wading through the full transaction list. Sorted by
// the OMR-equivalent price when available, so vendors billing in different
// currencies still compare on a like-for-like basis.
function vendorComparison(costHistory) {
  const byVendor = {};
  for (const line of costHistory) {
    const key = line.vendor || 'Unknown vendor';
    const existing = byVendor[key];
    if (!existing || new Date(line.date || 0) > new Date(existing.date || 0)) {
      byVendor[key] = {
        vendor: key,
        price: line.price,
        priceOmr: line.priceOmr,
        currency: line.currency,
        purchaseType: line.purchaseType,
        date: line.date
      };
    }
  }
  return Object.values(byVendor).sort((a, b) =>
    (bestOmrAmount(b.price, b.currency, b.priceOmr) ?? -Infinity) -
    (bestOmrAmount(a.price, a.currency, a.priceOmr) ?? -Infinity)
  );
}

// Attaches a per-line landed cost figure to EVERY line in the cost history
// (not just the most recent), from the orderId -> {totalValue, entries} map
// content-scripts/odoo-bridge.js's getLandedCostsForOrders() already built.
// perUnit divides by the purchase LINE's own quantity, never the valuation
// layer's "quantity" field - Odoo records a landed-cost layer with quantity
// 0 (it's a pure value adjustment, not a stock movement), so dividing by
// that would always yield null even when the cost is real and known. A line
// whose order has no key in landedCostsByOrder gets landedPerUnit: null -
// "not tracked" for that purchase (typically because it was Local).
function attachLandedCost(costHistory, landedCostsByOrder) {
  return costHistory.map((line) => {
    const landed = line.orderId !== null && landedCostsByOrder ? landedCostsByOrder[line.orderId] : null;
    if (!landed) {
      return { ...line, landedTotalValue: null, landedPerUnit: null, landedEntries: null };
    }
    const perUnit = typeof line.qty === 'number' && line.qty > 0 ? landed.totalValue / line.qty : null;
    return { ...line, landedTotalValue: landed.totalValue, landedPerUnit: perUnit, landedEntries: landed.entries };
  });
}

// ---------------- Sales History (Phase 4) ----------------

function shapeSalesHistory(saleLines, { windowDays = 90 } = {}) {
  const sorted = [...saleLines].sort(
    (a, b) => new Date(b.date_order || 0) - new Date(a.date_order || 0)
  );
  const totalQty = sorted.reduce((sum, l) => sum + (l.product_uom_qty || 0), 0);
  const recentQty = sorted
    .filter((l) => daysSince(l.date_order) <= windowDays)
    .reduce((sum, l) => sum + (l.product_uom_qty || 0), 0);

  return {
    transactions: sorted,
    totalUnitsSold: totalQty,
    recentUnitsSold: recentQty,
    recentWindowDays: windowDays,
    lastSoldDate: sorted.length ? sorted[0].date_order : null
  };
}

function sortSalesTransactions(transactions, sortBy) {
  const copy = [...transactions];
  if (sortBy === 'price') {
    copy.sort((a, b) =>
      (bestOmrAmount(b.price_unit, b.currency, b.price_unit_omr) ?? -Infinity) -
      (bestOmrAmount(a.price_unit, a.currency, a.price_unit_omr) ?? -Infinity)
    );
  } else if (sortBy === 'customer') {
    copy.sort((a, b) => (a.customer || '').localeCompare(b.customer || ''));
  } else {
    copy.sort((a, b) => new Date(b.date_order || 0) - new Date(a.date_order || 0)); // date, newest first
  }
  return copy;
}

// Groups transactions by calendar month for a lightweight trend view, newest
// month first. totalRevenueOmr only sums lines whose OMR amount could be
// resolved - never blends an unresolved foreign amount in.
function groupSalesByMonth(transactions) {
  const groups = {};
  for (const t of transactions) {
    if (!t.date_order) continue;
    const d = new Date(t.date_order);
    const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!groups[monthKey]) {
      groups[monthKey] = {
        monthKey,
        monthLabel: d.toLocaleDateString(undefined, { year: 'numeric', month: 'long' }),
        transactions: [],
        totalQty: 0,
        totalRevenueOmr: 0
      };
    }
    const g = groups[monthKey];
    g.transactions.push(t);
    g.totalQty += t.product_uom_qty || 0;
    const omr = bestOmrAmount(t.price_unit, t.currency, t.price_unit_omr);
    if (typeof omr === 'number') g.totalRevenueOmr += omr * (t.product_uom_qty || 0);
  }
  return Object.values(groups).sort((a, b) => b.monthKey.localeCompare(a.monthKey));
}

// 'none' / 'partial' / 'full', comparing a fulfilled quantity (delivered or
// invoiced) against the ordered quantity - scoped to whatever line it's
// called on, so it naturally answers "is OUR product delivered/invoiced on
// this order" even when the order/DO/invoice also covers other products.
function fulfillmentStatus(orderedQty, fulfilledQty) {
  const ordered = orderedQty || 0;
  const fulfilled = fulfilledQty || 0;
  if (fulfilled <= 0) return 'none';
  if (fulfilled >= ordered) return 'full';
  return 'partial';
}

// Attaches deliveryStatus/invoiceStatus to each sale line, from the
// qty_delivered/qty_invoiced fields Odoo already tracks per line.
function attachFulfillment(saleLines) {
  return saleLines.map((l) => ({
    ...l,
    deliveryStatus: fulfillmentStatus(l.product_uom_qty, l.qty_delivered),
    invoiceStatus: fulfillmentStatus(l.product_uom_qty, l.qty_invoiced)
  }));
}

// Margin per sale line vs. a single reference cost (expected in OMR, e.g.
// current avg cost or a landed unit cost). Uses the sale's OMR-equivalent
// price, never the raw price_unit, since referenceCost is always in the
// company currency and a raw foreign price would silently mix currencies.
// isApproximate is true whenever the reference is the CURRENT average cost
// rather than the cost actually in effect at sale time - Odoo doesn't expose
// point-in-time historical cost through search_read, so this is the normal
// case in practice, and the UI must label it as such.
function marginPerSale(saleLines, referenceCost, { isApproximate = true } = {}) {
  return saleLines.map((l) => {
    const saleOmr = bestOmrAmount(l.price_unit, l.currency, l.price_unit_omr);
    return {
      ...l,
      margin: (typeof referenceCost === 'number' && typeof saleOmr === 'number') ? saleOmr - referenceCost : null,
      marginIsApproximate: isApproximate
    };
  });
}

// Grouped by customer, sorted by quantity purchased. revenue only sums lines
// whose OMR amount could be resolved. deliveredCount/invoicedCount tally
// lines already FULLY delivered/invoiced (per attachFulfillment) - partial
// ones show up in the per-order drill-down instead of being counted here.
function topCustomersForPart(saleLines) {
  const byCustomer = {};
  for (const l of saleLines) {
    const key = l.customer_id !== null && l.customer_id !== undefined ? l.customer_id : l.customer;
    if (!byCustomer[key]) {
      byCustomer[key] = { customer: l.customer, customerId: l.customer_id, qty: 0, orders: 0, revenue: 0, deliveredCount: 0, invoicedCount: 0 };
    }
    byCustomer[key].qty += l.product_uom_qty || 0;
    byCustomer[key].orders += 1;
    if (l.deliveryStatus === 'full') byCustomer[key].deliveredCount += 1;
    if (l.invoiceStatus === 'full') byCustomer[key].invoicedCount += 1;
    const omr = bestOmrAmount(l.price_unit, l.currency, l.price_unit_omr);
    if (typeof omr === 'number') byCustomer[key].revenue += omr * (l.product_uom_qty || 0);
  }
  return Object.values(byCustomer).sort((a, b) => b.qty - a.qty);
}

// Average recent actual sale price (OMR) vs. the current catalog list price
// (already company-currency) - surfaces drift without implying either
// number is "wrong". Lines whose OMR amount can't be resolved are skipped
// rather than blended in.
function priceDrift(listPrice, saleLines, { windowDays = 90 } = {}) {
  const recentOmr = saleLines
    .filter((l) => daysSince(l.date_order) <= windowDays)
    .map((l) => bestOmrAmount(l.price_unit, l.currency, l.price_unit_omr))
    .filter((v) => typeof v === 'number');
  if (!recentOmr.length || typeof listPrice !== 'number') return null;
  const avgRecentPrice = recentOmr.reduce((sum, v) => sum + v, 0) / recentOmr.length;
  return {
    listPrice,
    avgRecentPrice,
    diff: avgRecentPrice - listPrice,
    windowDays
  };
}

const PART_DATA_EXPORTS = {
  shapeStockByLocation, computeStockValue, shapeIncomingStock, shapeReservedTransfers,
  shapeCostHistory, sortCostHistory, groupCostHistoryByType, costTrend, vendorComparison, attachLandedCost,
  shapeSalesHistory, sortSalesTransactions, groupSalesByMonth, fulfillmentStatus, attachFulfillment,
  marginPerSale, topCustomersForPart, priceDrift
};

// Exposed for popup.js (classic script, no bundler/module system in this build).
if (typeof window !== 'undefined') {
  window.PartData = PART_DATA_EXPORTS;
}
// Exposed for Node-based unit testing (see lib/part-data.test.js).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = PART_DATA_EXPORTS;
}

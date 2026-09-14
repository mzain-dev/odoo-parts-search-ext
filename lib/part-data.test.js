// Run with: node lib/part-data.test.js
const assert = require('assert');
const {
  shapeStockByLocation, computeStockValue, shapeIncomingStock, shapeReservedTransfers,
  shapeCostHistory, sortCostHistory, groupCostHistoryByType, costTrend, vendorComparison, attachLandedCost,
  shapeSalesHistory, sortSalesTransactions, groupSalesByMonth, fulfillmentStatus, attachFulfillment,
  marginPerSale, topCustomersForPart, priceDrift
} = require('./part-data.js');

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

// shapeStockByLocation
{
  const quants = [
    { location_id: [1, 'Muscat/Stock'], quantity: 10, reserved_quantity: 2 },
    { location_id: [1, 'Muscat/Stock'], quantity: 5, reserved_quantity: 0 },
    { location_id: [2, 'Salalah/Stock'], quantity: 3, reserved_quantity: 1 }
  ];
  const shaped = shapeStockByLocation(quants);
  assert.strictEqual(shaped.byLocation.length, 2);
  const muscat = shaped.byLocation.find((l) => l.location === 'Muscat/Stock');
  assert.strictEqual(muscat.qty, 15);
  assert.strictEqual(muscat.reserved, 2);
  assert.strictEqual(shaped.totalFreeToSell, (15 - 2) + (3 - 1));
  assert.strictEqual(shaped.totalReserved, 3);
  assert.strictEqual(shaped.totalOnHand, 18);
}

// computeStockValue - null (not a misleading 0) when either input is missing
{
  assert.strictEqual(computeStockValue(18, 2.5), 45);
  assert.strictEqual(computeStockValue(null, 2.5), null);
  assert.strictEqual(computeStockValue(18, null), null);
}

// shapeIncomingStock - only lines with remaining > 0 survive, sorted by date
{
  const lines = [
    { order_id: [1, 'PO001'], product_qty: 10, qty_received: 10, date_planned: daysAgo(-5) },
    { order_id: [2, 'PO002'], product_qty: 20, qty_received: 5, date_planned: daysAgo(-10) },
    { order_id: [3, 'PO003'], product_qty: 8, qty_received: 0, date_planned: daysAgo(-2) }
  ];
  const incoming = shapeIncomingStock(lines);
  assert.strictEqual(incoming.items.length, 2);
  assert.strictEqual(incoming.totalIncoming, 15 + 8);
  assert.strictEqual(incoming.items[0].orderName, 'PO003'); // earliest planned date first (2 days out, before PO002's 10)
}

// shapeReservedTransfers - zero-qty lines dropped, sorted largest reservation first
{
  const lines = [
    { pickingName: 'WH/OUT/0001', pickingType: 'Delivery Orders', origin: 'SO/2001', location: 'Muscat/Stock', qty: 3 },
    { pickingName: 'WH/OUT/0002', pickingType: 'Delivery Orders', origin: 'SO/2002', location: 'Muscat/Stock', qty: 7 },
    { pickingName: 'WH/INT/0001', pickingType: 'Internal Transfers', origin: false, location: 'Salalah/Stock', qty: 0 }
  ];
  const reserved = shapeReservedTransfers(lines);
  assert.strictEqual(reserved.items.length, 2); // the zero-qty transfer is dropped
  assert.strictEqual(reserved.items[0].pickingName, 'WH/OUT/0002'); // largest reservation first
  assert.strictEqual(reserved.totalReserved, 10);
}

// shapeCostHistory + costTrend
{
  const purchaseLines = [
    { price_unit: 10, product_qty: 5, date_planned: daysAgo(30), order_name: 'PO1', vendor: 'Acme' },
    { price_unit: 12, product_qty: 5, date_planned: daysAgo(5), order_name: 'PO2', vendor: 'Acme' }
  ];
  const history = shapeCostHistory(purchaseLines);
  assert.strictEqual(history[0].order, 'PO2'); // most recent first
  assert.strictEqual(costTrend(history), 'rising');
  assert.strictEqual(costTrend([history[0]]), 'insufficient_data');
  assert.strictEqual(costTrend([{ price: 5 }, { price: 5 }]), 'stable');
}

// vendorComparison - one row per vendor, most recent price only
{
  const history = [
    { price: 10, date: daysAgo(30), vendor: 'Acme' },
    { price: 12, date: daysAgo(5), vendor: 'Acme' },
    { price: 9, date: daysAgo(15), vendor: 'Beta' }
  ];
  const vendors = vendorComparison(history);
  assert.strictEqual(vendors.length, 2);
  const acme = vendors.find((v) => v.vendor === 'Acme');
  assert.strictEqual(acme.price, 12); // most recent, not first
}

// shapeCostHistory/vendorComparison carry purchaseType (Local/Foreign) through
{
  const purchaseLines = [
    { price_unit: 10, currency: 'OMR', purchase_type: 'Local', product_qty: 5, date_planned: daysAgo(5), order_name: 'PO1', vendor: 'Oman Traders' },
    { price_unit: 20, currency: 'USD', purchase_type: 'Foreign', product_qty: 5, date_planned: daysAgo(2), order_name: 'PO2', vendor: 'Global Supply' }
  ];
  const history = shapeCostHistory(purchaseLines);
  assert.strictEqual(history.find((h) => h.order === 'PO1').purchaseType, 'Local');
  assert.strictEqual(history.find((h) => h.order === 'PO2').purchaseType, 'Foreign');
  const vendors = vendorComparison(history);
  assert.strictEqual(vendors.find((v) => v.vendor === 'Oman Traders').purchaseType, 'Local');
  assert.strictEqual(vendors.find((v) => v.vendor === 'Global Supply').purchaseType, 'Foreign');
}

// shapeCostHistory carries currency/OMR-equivalent through
{
  const purchaseLines = [
    { price_unit: 10, price_unit_omr: 3.85, currency: 'USD', product_qty: 5, date_planned: daysAgo(5), order_name: 'PO2', vendor: 'Acme' }
  ];
  const history = shapeCostHistory(purchaseLines);
  assert.strictEqual(history[0].currency, 'USD');
  assert.strictEqual(history[0].priceOmr, 3.85);
}

// vendorComparison sorts by OMR-equivalent, not raw price, when currencies differ
{
  const history = [
    { price: 100, priceOmr: 38.5, currency: 'USD', date: daysAgo(5), vendor: 'Acme (USD)' },
    { price: 50, priceOmr: 50, currency: 'OMR', date: daysAgo(5), vendor: 'Beta (OMR)' }
  ];
  const vendors = vendorComparison(history);
  assert.strictEqual(vendors[0].vendor, 'Beta (OMR)'); // 50 OMR > 38.5 OMR, even though raw price 50 < 100
}

// sortCostHistory - date (default), price (OMR-aware), vendor
{
  const history = [
    { order: 'PO1', price: 100, priceOmr: 38.5, currency: 'USD', vendor: 'Zeta', date: daysAgo(20) },
    { order: 'PO2', price: 50, priceOmr: 50, currency: 'OMR', vendor: 'Acme', date: daysAgo(5) }
  ];
  assert.strictEqual(sortCostHistory(history, 'date')[0].order, 'PO2'); // most recent first
  assert.strictEqual(sortCostHistory(history, 'price')[0].order, 'PO2'); // 50 OMR > 38.5 OMR
  assert.strictEqual(sortCostHistory(history, 'vendor')[0].vendor, 'Acme'); // alphabetical
}

// groupCostHistoryByType - splits into Local/Foreign/Unknown, unrecognized types fall to Unknown
{
  const history = [
    { order: 'PO1', purchaseType: 'Local' },
    { order: 'PO2', purchaseType: 'Foreign' },
    { order: 'PO3', purchaseType: 'Foreign' },
    { order: 'PO4', purchaseType: undefined }
  ];
  const groups = groupCostHistoryByType(history);
  assert.strictEqual(groups.Local.length, 1);
  assert.strictEqual(groups.Foreign.length, 2);
  assert.strictEqual(groups.Unknown.length, 1);
}

// attachLandedCost - only lines whose order has a map entry get a non-null
// perUnit; perUnit always divides by the LINE's own quantity, never a
// valuation layer's "quantity" field (which Odoo records as 0 for landed
// cost adjustments since they don't move stock).
{
  const costHistory = [
    { order: 'PO-Foreign', orderId: 10, qty: 20 },
    { order: 'PO-Local', orderId: 11, qty: 5 }
  ];
  const landedCostsByOrder = {
    10: { totalValue: 25, entries: [{ costName: 'Freight', value: 20 }, { costName: 'Duty', value: 5 }] }
  };
  const withLanded = attachLandedCost(costHistory, landedCostsByOrder);
  const foreign = withLanded.find((l) => l.order === 'PO-Foreign');
  assert.strictEqual(foreign.landedTotalValue, 25);
  assert.strictEqual(foreign.landedPerUnit, 1.25); // 25 / 20 units on THIS line
  assert.strictEqual(foreign.landedEntries.length, 2);
  const local = withLanded.find((l) => l.order === 'PO-Local');
  assert.strictEqual(local.landedPerUnit, null); // no key for this order -> not tracked
}

// shapeSalesHistory
{
  const saleLines = [
    { price_unit: 100, product_uom_qty: 2, date_order: daysAgo(200), customer: 'Old Co', customer_id: 1 },
    { price_unit: 110, product_uom_qty: 3, date_order: daysAgo(10), customer: 'Recent Co', customer_id: 2 }
  ];
  const shaped = shapeSalesHistory(saleLines, { windowDays: 90 });
  assert.strictEqual(shaped.totalUnitsSold, 5);
  assert.strictEqual(shaped.recentUnitsSold, 3);
  assert.strictEqual(shaped.lastSoldDate, daysAgo(10));
}

// sortSalesTransactions - date (default), price (OMR-aware), customer
{
  const transactions = [
    { customer: 'Zeta Co', price_unit: 100, currency: 'USD', price_unit_omr: 38.5, date_order: daysAgo(20) },
    { customer: 'Acme Co', price_unit: 50, currency: 'OMR', price_unit_omr: 50, date_order: daysAgo(5) }
  ];
  assert.strictEqual(sortSalesTransactions(transactions, 'date')[0].customer, 'Acme Co');
  assert.strictEqual(sortSalesTransactions(transactions, 'price')[0].customer, 'Acme Co'); // 50 OMR > 38.5 OMR
  assert.strictEqual(sortSalesTransactions(transactions, 'customer')[0].customer, 'Acme Co'); // alphabetical
}

// groupSalesByMonth - groups by calendar month, newest first, sums resolvable OMR revenue only
{
  const now = new Date();
  const thisMonth = new Date(now.getFullYear(), now.getMonth(), 15).toISOString().slice(0, 10);
  const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 15);
  const lastMonth = lastMonthDate.toISOString().slice(0, 10);
  const transactions = [
    { date_order: thisMonth, product_uom_qty: 2, price_unit: 10, currency: 'OMR', price_unit_omr: 10 },
    { date_order: lastMonth, product_uom_qty: 1, price_unit: 20, currency: 'USD', price_unit_omr: null } // unresolvable, skipped from revenue
  ];
  const groups = groupSalesByMonth(transactions);
  assert.strictEqual(groups.length, 2);
  assert.strictEqual(groups[0].transactions.length, 1); // newest month first
  assert.strictEqual(groups[0].totalRevenueOmr, 20); // 2 * 10 OMR
  assert.strictEqual(groups[1].totalRevenueOmr, 0); // unresolvable USD line contributes nothing, not a wrong number
}

// marginPerSale - approximate flag always set when using current cost
{
  const result = marginPerSale([{ price_unit: 15 }], 10);
  assert.strictEqual(result[0].margin, 5);
  assert.strictEqual(result[0].marginIsApproximate, true);
  const noCost = marginPerSale([{ price_unit: 15 }], null);
  assert.strictEqual(noCost[0].margin, null);
}

// topCustomersForPart
{
  const saleLines = [
    { customer_id: 1, customer: 'A', product_uom_qty: 5, price_unit: 10 },
    { customer_id: 1, customer: 'A', product_uom_qty: 3, price_unit: 10 },
    { customer_id: 2, customer: 'B', product_uom_qty: 1, price_unit: 10 }
  ];
  const top = topCustomersForPart(saleLines);
  assert.strictEqual(top[0].customer, 'A');
  assert.strictEqual(top[0].qty, 8);
  assert.strictEqual(top[0].orders, 2);
}

// fulfillmentStatus - none/partial/full
{
  assert.strictEqual(fulfillmentStatus(10, 0), 'none');
  assert.strictEqual(fulfillmentStatus(10, null), 'none');
  assert.strictEqual(fulfillmentStatus(10, 4), 'partial');
  assert.strictEqual(fulfillmentStatus(10, 10), 'full');
  assert.strictEqual(fulfillmentStatus(10, 12), 'full'); // over-delivered still counts as full
}

// attachFulfillment - derives status from qty_delivered/qty_invoiced per line
{
  const lines = [
    { product_uom_qty: 10, qty_delivered: 10, qty_invoiced: 0 },
    { product_uom_qty: 10, qty_delivered: 4, qty_invoiced: 10 }
  ];
  const withStatus = attachFulfillment(lines);
  assert.strictEqual(withStatus[0].deliveryStatus, 'full');
  assert.strictEqual(withStatus[0].invoiceStatus, 'none');
  assert.strictEqual(withStatus[1].deliveryStatus, 'partial');
  assert.strictEqual(withStatus[1].invoiceStatus, 'full');
}

// topCustomersForPart - deliveredCount/invoicedCount tally only FULLY
// fulfilled lines (partial ones are left for the per-order drill-down), and
// customerId is carried through for that drill-down to key off of
{
  const saleLines = attachFulfillment([
    { customer_id: 1, customer: 'A', product_uom_qty: 5, price_unit: 10, qty_delivered: 5, qty_invoiced: 5 },
    { customer_id: 1, customer: 'A', product_uom_qty: 5, price_unit: 10, qty_delivered: 2, qty_invoiced: 0 }
  ]);
  const top = topCustomersForPart(saleLines);
  assert.strictEqual(top[0].customerId, 1);
  assert.strictEqual(top[0].orders, 2);
  assert.strictEqual(top[0].deliveredCount, 1); // only the fully-delivered line
  assert.strictEqual(top[0].invoicedCount, 1);
}

// priceDrift - null when no recent sales or no list price
{
  assert.strictEqual(priceDrift(null, [{ date_order: daysAgo(5), price_unit: 10 }]), null);
  assert.strictEqual(priceDrift(10, []), null);
  const drift = priceDrift(100, [{ date_order: daysAgo(5), price_unit: 90 }], { windowDays: 90 });
  assert.strictEqual(drift.avgRecentPrice, 90);
  assert.strictEqual(drift.diff, -10);
}

console.log('part-data.test.js: all assertions passed');

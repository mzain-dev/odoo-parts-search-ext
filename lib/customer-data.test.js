// Run with: node lib/customer-data.test.js
const assert = require('assert');
const {
  shapeCustomerCard, sortOrders, buyingPattern, shapeTopProducts,
  buildOrdersSpreadsheetText, buildCustomerSummaryText
} = require('./customer-data.js');

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

// shapeCustomerCard - revenue/last-order only count confirmed orders; drafts/sent are open quotations
{
  const partner = {
    id: 5,
    name: 'Al Rawahi Trading',
    phone: '123',
    email: 'x@y.com',
    company_id: [1, 'Muscat Branch'],
    user_id: [2, 'Fatima'],
    property_product_pricelist: [3, 'VIP Pricelist']
  };
  const orders = [
    { name: 'SO001', amount_total: 500, date_order: daysAgo(10), state: 'sale' },
    { name: 'SO002', amount_total: 200, date_order: daysAgo(2), state: 'draft' },
    { name: 'SO003', amount_total: 300, date_order: daysAgo(40), state: 'sale' }
  ];
  const card = shapeCustomerCard(partner, orders);
  assert.strictEqual(card.totalOrders, 2);
  assert.strictEqual(card.totalRevenue, 800);
  assert.strictEqual(card.lastOrderDate, daysAgo(10)); // most recent confirmed, not the draft
  assert.strictEqual(card.openQuotations.length, 1);
  assert.strictEqual(card.branch, 'Muscat Branch');
  assert.strictEqual(card.salesperson, 'Fatima');
  assert.strictEqual(card.pricelist, 'VIP Pricelist');
}

// shapeCustomerCard - defaults when partner has no pricelist/company/salesperson
{
  const partner = { id: 6, name: 'Walk-in', phone: null, email: null, company_id: false, user_id: false, property_product_pricelist: false };
  const card = shapeCustomerCard(partner, []);
  assert.strictEqual(card.pricelist, 'Standard');
  assert.strictEqual(card.branch, null);
  assert.strictEqual(card.totalOrders, 0);
  assert.strictEqual(card.lastOrderDate, null);
}

// shapeTopProducts - grouped by product, sorted by quantity
{
  const lines = [
    { product_id: [1, 'Filter A'], product_uom_qty: 3, price_subtotal: 30 },
    { product_id: [1, 'Filter A'], product_uom_qty: 2, price_subtotal: 20 },
    { product_id: [2, 'Filter B'], product_uom_qty: 10, price_subtotal: 100 }
  ];
  const top = shapeTopProducts(lines);
  assert.strictEqual(top[0].product, 'Filter B');
  assert.strictEqual(top[0].qty, 10);
  assert.strictEqual(top[1].qty, 5);
  assert.strictEqual(top[1].orders, 2);
}

// shapeCustomerCard also exposes the full order list (uncapped) and the
// confirmed-only subset, for pagination/buying-pattern use downstream
{
  const partner = { id: 7, name: 'Big Buyer', phone: null, email: null, company_id: false, user_id: false, property_product_pricelist: false };
  const orders = Array.from({ length: 15 }, (_, i) => ({
    name: `SO${i}`, amount_total: 100, date_order: daysAgo(i), state: 'sale'
  }));
  const card = shapeCustomerCard(partner, orders);
  assert.strictEqual(card.orders.length, 15); // not truncated
  assert.strictEqual(card.confirmedOrders.length, 15);
}

// sortOrders - date (default) vs amount
{
  const orders = [
    { name: 'SO1', amount_total: 100, date_order: daysAgo(20) },
    { name: 'SO2', amount_total: 500, date_order: daysAgo(5) }
  ];
  assert.strictEqual(sortOrders(orders, 'date')[0].name, 'SO2'); // most recent first
  assert.strictEqual(sortOrders(orders, 'amount')[0].name, 'SO2'); // highest amount first
}

// buyingPattern - average gap between orders and the busiest month
{
  const orders = [
    { amount_total: 100, date_order: daysAgo(60) },
    { amount_total: 100, date_order: daysAgo(30) },
    { amount_total: 100, date_order: daysAgo(0) }
  ];
  const pattern = buyingPattern(orders);
  assert.strictEqual(pattern.avgDaysBetweenOrders, 30); // evenly spaced every 30 days
  assert.ok(pattern.busiestMonth); // at least one month bucket exists

  const empty = buyingPattern([]);
  assert.strictEqual(empty.avgDaysBetweenOrders, null);
  assert.strictEqual(empty.busiestMonth, null);
}

// buildOrdersSpreadsheetText / buildCustomerSummaryText - copy-to-clipboard text builders
{
  const orders = [{ name: 'SO001', date_order: daysAgo(5), amount_total: 250.5, state: 'sale' }];
  const tsv = buildOrdersSpreadsheetText(orders);
  const lines = tsv.split('\n');
  assert.strictEqual(lines[0], 'Order\tDate\tAmount\tStatus');
  assert.strictEqual(lines[1], `SO001\t${daysAgo(5)}\t250.50\tsale`);

  const card = { name: 'Al Rawahi Trading', phone: '123', email: null, branch: 'Muscat Branch', salesperson: null, pricelist: 'Standard', totalOrders: 1, totalRevenue: 250.5, lastOrderDate: daysAgo(5) };
  const summary = buildCustomerSummaryText(card);
  assert.ok(summary.includes('Customer: Al Rawahi Trading'));
  assert.ok(summary.includes('Phone: 123'));
  assert.ok(!summary.includes('Email:')); // null fields omitted, not shown as "Email: null"
  assert.ok(summary.includes('Total Revenue: 250.50'));
}

console.log('customer-data.test.js: all assertions passed');

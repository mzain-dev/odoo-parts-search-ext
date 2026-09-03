// Pure functions: no DOM, no chrome.* calls. Shared by popup.js and testable
// in isolation.

function shapeCustomerCard(partner, orders) {
  const sorted = [...orders].sort(
    (a, b) => new Date(b.date_order || 0) - new Date(a.date_order || 0)
  );
  // 'sale' and 'done' both mean a confirmed order - only confirmed orders
  // count toward revenue and last-order-date; a quotation isn't a sale yet.
  const confirmed = sorted.filter((o) => o.state === 'sale' || o.state === 'done');
  const totalRevenue = confirmed.reduce((sum, o) => sum + (o.amount_total || 0), 0);
  const openQuotations = sorted.filter((o) => o.state === 'draft' || o.state === 'sent');

  return {
    id: partner.id,
    name: partner.name,
    phone: partner.phone || null,
    email: partner.email || null,
    branch: Array.isArray(partner.company_id) ? partner.company_id[1] : null,
    salesperson: Array.isArray(partner.user_id) ? partner.user_id[1] : null,
    pricelist: Array.isArray(partner.property_product_pricelist)
      ? partner.property_product_pricelist[1]
      : 'Standard',
    totalOrders: confirmed.length,
    totalRevenue,
    lastOrderDate: confirmed.length ? confirmed[0].date_order : null,
    openQuotations,
    confirmedOrders: confirmed,
    orders: sorted // full list, newest first - UI paginates ("show more") rather than this truncating
  };
}

function sortOrders(orders, sortBy) {
  const copy = [...orders];
  if (sortBy === 'amount') copy.sort((a, b) => (b.amount_total || 0) - (a.amount_total || 0));
  else copy.sort((a, b) => new Date(b.date_order || 0) - new Date(a.date_order || 0)); // date, newest first
  return copy;
}

// Average gap between confirmed orders, and the single busiest calendar
// month by order count - a lightweight "buying pattern" read that's more
// useful than a raw order list for spotting a rhythm (or its absence).
function buyingPattern(confirmedOrders) {
  if (!confirmedOrders.length) return { avgDaysBetweenOrders: null, busiestMonth: null };

  const sorted = [...confirmedOrders]
    .filter((o) => o.date_order)
    .sort((a, b) => new Date(a.date_order) - new Date(b.date_order));

  let avgDaysBetweenOrders = null;
  if (sorted.length >= 2) {
    const first = new Date(sorted[0].date_order);
    const last = new Date(sorted[sorted.length - 1].date_order);
    avgDaysBetweenOrders = ((last - first) / (1000 * 60 * 60 * 24)) / (sorted.length - 1);
  }

  const byMonth = {};
  for (const o of sorted) {
    const d = new Date(o.date_order);
    const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!byMonth[monthKey]) {
      byMonth[monthKey] = {
        monthKey,
        monthLabel: d.toLocaleDateString(undefined, { year: 'numeric', month: 'long' }),
        count: 0,
        revenue: 0
      };
    }
    byMonth[monthKey].count += 1;
    byMonth[monthKey].revenue += o.amount_total || 0;
  }
  const months = Object.values(byMonth);
  const busiestMonth = months.length ? months.reduce((max, m) => (m.count > max.count ? m : max)) : null;

  return { avgDaysBetweenOrders, busiestMonth };
}

// Most-purchased parts for a single customer, from sale.order.line rows -
// sorted by quantity, same shape convention as part-data's topCustomersForPart.
function shapeTopProducts(saleLines) {
  const byProduct = {};
  for (const l of saleLines) {
    const productId = Array.isArray(l.product_id) ? l.product_id[0] : null;
    const productName = Array.isArray(l.product_id) ? l.product_id[1] : 'Unknown';
    const key = productId !== null ? productId : productName;
    if (!byProduct[key]) {
      byProduct[key] = { productId, product: productName, qty: 0, revenue: 0, orders: 0 };
    }
    byProduct[key].qty += l.product_uom_qty || 0;
    byProduct[key].revenue += l.price_subtotal || 0;
    byProduct[key].orders += 1;
  }
  return Object.values(byProduct).sort((a, b) => b.qty - a.qty);
}

// Strips characters that would break a TSV cell (tabs/newlines), same
// convention as the sibling aged-receivables extension's copy-table feature.
function tsvCell(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[\t\r\n]+/g, ' ').trim();
}

// Tab-separated order table for the "Copy orders" button - pastes directly
// into Excel/Google Sheets.
function buildOrdersSpreadsheetText(orders) {
  const header = ['Order', 'Date', 'Amount', 'Status'];
  const rows = [header.join('\t')];
  for (const o of orders) {
    rows.push([
      tsvCell(o.name),
      tsvCell(o.date_order),
      (o.amount_total || 0).toFixed(2),
      tsvCell(o.state)
    ].join('\t'));
  }
  return rows.join('\n');
}

// Plain-text identity + totals summary for the "Copy summary" button.
function buildCustomerSummaryText(card) {
  const lines = [
    `Customer: ${card.name}`,
    card.phone ? `Phone: ${card.phone}` : null,
    card.email ? `Email: ${card.email}` : null,
    card.branch ? `Branch: ${card.branch}` : null,
    card.salesperson ? `Salesperson: ${card.salesperson}` : null,
    `Pricelist: ${card.pricelist}`,
    `Total Orders: ${card.totalOrders}`,
    `Total Revenue: ${(card.totalRevenue || 0).toFixed(2)}`,
    `Last Order: ${card.lastOrderDate || 'N/A'}`
  ].filter((l) => l !== null);
  return lines.join('\n');
}

const CUSTOMER_DATA_EXPORTS = {
  shapeCustomerCard, sortOrders, buyingPattern, shapeTopProducts,
  buildOrdersSpreadsheetText, buildCustomerSummaryText
};

// Exposed for popup.js (classic script, no bundler/module system in this build).
if (typeof window !== 'undefined') {
  window.CustomerData = CUSTOMER_DATA_EXPORTS;
}
// Exposed for Node-based unit testing (see lib/customer-data.test.js).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = CUSTOMER_DATA_EXPORTS;
}

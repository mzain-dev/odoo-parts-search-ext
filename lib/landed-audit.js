// Pure functions: no DOM, no chrome.* calls. Powers the "Landed Cost" mode -
// a company-wide check for foreign-purchase receipts whose landed cost is
// missing, or was posted too late to reach the product's cost.
//
// Input comes pre-joined from content-scripts/odoo-bridge.js's
// getLandedCostAudit(); nothing in this file makes Odoo calls.

const AUDIT_RANGES = { '30': 30, '60': 60, all: null };

// Tolerances for "is this really nonzero" - Odoo stores qty to 2-3 decimals
// and OMR to 3, so anything below these is rounding noise, not a real
// remaining unit or a real diverted amount.
const QTY_EPSILON = 0.0001;
const VALUE_EPSILON = 0.0005;

// '30' / '60' / 'all' -> the 'YYYY-MM-DD' lower bound to query from, or null
// for all time. Unknown ranges fall back to 30 days rather than silently
// meaning "everything" (which is the slowest possible query).
function sinceDateForRange(range, now = new Date()) {
  const days = Object.prototype.hasOwnProperty.call(AUDIT_RANGES, range) ? AUDIT_RANGES[range] : 30;
  if (days === null) return null;
  const d = new Date(now);
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function byDateAsc(field) {
  return (a, b) => new Date(a[field] || 0) - new Date(b[field] || 0);
}

function byDateDesc(field) {
  return (a, b) => new Date(b[field] || 0) - new Date(a[field] || 0);
}

// Splits the bridge's raw audit data into the three lists the UI shows:
//
//   fixNow       - foreign receipt, no POSTED landed cost, units still in
//                  stock. Posting the landed cost now still reaches product
//                  cost (for the remaining units). Oldest first: the longer
//                  it waits, the more likely the stock sells before it's fixed.
//   alreadySold  - foreign receipt, no posted landed cost, nothing left in
//                  stock. When the bill arrives it will go 100% to COGS.
//   wentToCogs   - a posted landed cost where some or all of this product's
//                  share was diverted to COGS because units had already left
//                  stock (allocated share minus what reached a valuation layer).
//
// receiptLines: [{ pickingId, pickingName, dateDone, poName, vendor,
//   productId, product, receivedQty, remainingQty, receivedValue,
//   draftLandedCosts: [name] }]
// divertedLines: [{ costId, costName, costDate, pickingName, poName, vendor,
//   productId, product, allocated, intoStock }]
function auditLandedCosts({ receiptLines = [], divertedLines = [] } = {}) {
  const fixNow = [];
  const alreadySold = [];

  for (const line of receiptLines) {
    const remaining = typeof line.remainingQty === 'number' ? line.remainingQty : 0;
    const row = {
      ...line,
      remainingQty: remaining,
      soldQty: Math.max(0, (line.receivedQty || 0) - remaining),
      draftLandedCosts: line.draftLandedCosts || []
    };
    if (remaining > QTY_EPSILON) fixNow.push(row);
    else alreadySold.push(row);
  }

  const wentToCogs = [];
  for (const line of divertedLines) {
    const allocated = typeof line.allocated === 'number' ? line.allocated : 0;
    const intoStock = typeof line.intoStock === 'number' ? line.intoStock : 0;
    const diverted = allocated - intoStock;
    if (diverted <= VALUE_EPSILON) continue;
    wentToCogs.push({
      ...line,
      allocated,
      intoStock,
      divertedValue: diverted,
      fullyDiverted: intoStock <= VALUE_EPSILON
    });
  }

  fixNow.sort(byDateAsc('dateDone'));
  alreadySold.sort(byDateDesc('dateDone'));
  wentToCogs.sort(byDateDesc('costDate'));

  const countReceipts = (rows) => new Set(rows.map((r) => r.pickingId)).size;

  return {
    fixNow,
    alreadySold,
    wentToCogs,
    totals: {
      fixNowLines: fixNow.length,
      fixNowReceipts: countReceipts(fixNow),
      alreadySoldLines: alreadySold.length,
      alreadySoldReceipts: countReceipts(alreadySold),
      wentToCogsLines: wentToCogs.length,
      wentToCogsValue: wentToCogs.reduce((s, r) => s + r.divertedValue, 0)
    }
  };
}

function fmt3(n) {
  return (typeof n === 'number' ? n : 0).toFixed(3);
}

function fmtQty(n) {
  return (typeof n === 'number' ? n : 0).toFixed(2);
}

function clean(value) {
  // Tab-separated output - a stray tab/newline inside a name would break columns.
  return String(value === null || value === undefined ? '' : value).replace(/[\t\r\n]+/g, ' ');
}

// Tab-separated text of all three lists, ready to paste into Excel.
function buildAuditSpreadsheetText(audit) {
  const header = ['List', 'Part', 'Receipt', 'Purchase Order', 'Vendor', 'Date',
    'Received Qty', 'In Stock Qty', 'Landed Cost', 'Went to COGS (OMR)', 'Note'];
  const rows = [header];

  for (const r of audit.fixNow) {
    rows.push(['Missing - still in stock', r.product, r.pickingName, r.poName, r.vendor, (r.dateDone || '').slice(0, 10),
      fmtQty(r.receivedQty), fmtQty(r.remainingQty), '', '',
      r.draftLandedCosts.length ? `Draft: ${r.draftLandedCosts.join(', ')}` : '']);
  }
  for (const r of audit.alreadySold) {
    rows.push(['Missing - already sold', r.product, r.pickingName, r.poName, r.vendor, (r.dateDone || '').slice(0, 10),
      fmtQty(r.receivedQty), fmtQty(r.remainingQty), '', '',
      r.draftLandedCosts.length ? `Draft: ${r.draftLandedCosts.join(', ')}` : '']);
  }
  for (const r of audit.wentToCogs) {
    rows.push(['Posted late - went to COGS', r.product, r.pickingName, r.poName, r.vendor, (r.costDate || '').slice(0, 10),
      '', '', r.costName, fmt3(r.divertedValue), r.fullyDiverted ? 'Fully to COGS' : 'Partly to COGS']);
  }

  return rows.map((cols) => cols.map(clean).join('\t')).join('\n');
}

const LANDED_AUDIT_EXPORTS = { sinceDateForRange, auditLandedCosts, buildAuditSpreadsheetText };

if (typeof window !== 'undefined') {
  window.LandedAudit = LANDED_AUDIT_EXPORTS;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = LANDED_AUDIT_EXPORTS;
}

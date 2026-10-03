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
function auditLandedCosts({
  receiptLines = [], divertedLines = [], historyReceipts = [], bills = [], negativeRows = [], errors = {}
} = {}) {
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

  const incomplete = findIncompleteReceipts(historyReceipts);
  const unappliedBills = summarizeUnappliedBills(bills);
  const negativeSales = shapeNegativeStockSales(negativeRows);

  return {
    fixNow,
    alreadySold,
    wentToCogs,
    incomplete,
    bills: unappliedBills,
    negativeSales,
    errors: errors || {},
    totals: {
      incompleteReceipts: incomplete.length,
      billsCount: unappliedBills.length,
      billsValue: unappliedBills.reduce((s, r) => s + r.unapplied, 0),
      negativeWaiting: negativeSales.filter((r) => r.status === 'waiting').length,
      negativeCount: negativeSales.length,
      fixNowLines: fixNow.length,
      fixNowReceipts: countReceipts(fixNow),
      alreadySoldLines: alreadySold.length,
      alreadySoldReceipts: countReceipts(alreadySold),
      wentToCogsLines: wentToCogs.length,
      wentToCogsValue: wentToCogs.reduce((s, r) => s + r.divertedValue, 0)
    }
  };
}

// ---------------- Receipts missing one of several landed costs ----------------

// A receipt is "covered" once any landed cost is posted on it - but many
// shipments need more than one (transport + customs + LC charges). There's no
// Odoo setting that says which charges a shipment should have, so this learns
// it per vendor from history: a cost product counts as "expected" for a
// vendor when it appears on at least `minShare` of that vendor's receipts
// (and on at least 2 of them), once the vendor has `minReceipts` receipts
// with landed costs. Receipts in the period missing an expected product are
// flagged - a strong hint, not proof (a shipment may genuinely skip a charge).
//
// receipts: [{ pickingId, pickingName, dateDone, poName, vendor, vendorKey,
//   inPeriod, costProducts: [name], landedCosts: [name] }] - only receipts
//   that already have at least one POSTED landed cost.
function findIncompleteReceipts(receipts, { minReceipts = 3, minShare = 0.5 } = {}) {
  const byVendor = {};
  for (const r of receipts) {
    const key = r.vendorKey === null || r.vendorKey === undefined ? `name:${r.vendor}` : r.vendorKey;
    if (!byVendor[key]) byVendor[key] = { total: 0, counts: {} };
    const v = byVendor[key];
    v.total += 1;
    for (const p of new Set(r.costProducts || [])) v.counts[p] = (v.counts[p] || 0) + 1;
  }

  const expectedByVendor = {};
  for (const [key, v] of Object.entries(byVendor)) {
    if (v.total < minReceipts) { expectedByVendor[key] = []; continue; }
    const threshold = Math.max(2, Math.ceil(v.total * minShare));
    expectedByVendor[key] = Object.entries(v.counts)
      .filter(([, count]) => count >= threshold)
      .map(([product, count]) => ({ product, seen: count, of: v.total }));
  }

  const rows = [];
  for (const r of receipts) {
    if (!r.inPeriod) continue;
    const key = r.vendorKey === null || r.vendorKey === undefined ? `name:${r.vendor}` : r.vendorKey;
    const present = new Set(r.costProducts || []);
    const missing = (expectedByVendor[key] || []).filter((e) => !present.has(e.product));
    if (!missing.length) continue;
    rows.push({ ...r, costProducts: [...present], landedCosts: r.landedCosts || [], missing });
  }
  return rows.sort(byDateDesc('dateDone'));
}

// ---------------- Vendor bills with landed-cost lines not applied ----------------

// bills: [{ billId, billName, date, vendor, lcLines: [{ product, amount }],
//   appliedCosts: [{ name, amount }], draftCosts: [name] }]
// Amounts are company currency (OMR). A bill is flagged when its landed-cost
// lines total more than the posted landed costs created from it.
function summarizeUnappliedBills(bills) {
  const rows = [];
  for (const b of bills || []) {
    const lcTotal = (b.lcLines || []).reduce((s, l) => s + (l.amount || 0), 0);
    const appliedTotal = (b.appliedCosts || []).reduce((s, c) => s + (c.amount || 0), 0);
    const unapplied = lcTotal - appliedTotal;
    if (unapplied <= VALUE_EPSILON) continue;
    rows.push({
      ...b,
      lcTotal,
      appliedTotal,
      unapplied,
      status: appliedTotal > VALUE_EPSILON ? 'partial' : 'none',
      products: [...new Set((b.lcLines || []).map((l) => l.product).filter(Boolean))],
      draftCosts: b.draftCosts || []
    });
  }
  return rows.sort(byDateAsc('date')); // oldest first - been waiting longest
}

// ---------------- Sales made with negative stock ----------------

// rows: [{ outLayerId, product, qty, unitCost, date, waitingQty, correction,
//   coveredAt, sale: { saleOrderId, saleOrderName, customer, pickingName } | null }]
// Keeps sales only (a return to vendor or inventory adjustment that went
// negative isn't a margin problem), still-waiting ones first.
function shapeNegativeStockSales(rows) {
  const sales = (rows || []).filter((r) => r.sale && r.sale.saleOrderId);
  const shaped = sales.map((r) => ({
    ...r,
    status: (r.waitingQty || 0) > QTY_EPSILON ? 'waiting' : 'covered',
    correction: typeof r.correction === 'number' ? r.correction : 0
  }));
  shaped.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'waiting' ? -1 : 1;
    return new Date(b.date || 0) - new Date(a.date || 0);
  });
  return shaped;
}

// Odoo datetime (UTC, 'YYYY-MM-DD HH:MM:SS') -> the user's local 'YYYY-MM-DD'.
// offsetMinutes is the offset from UTC (Muscat/Dubai: +240), so a delivery at
// 22:00 UTC counts on the next local day.
function utcToLocalDay(utc, offsetMinutes = 0) {
  if (!utc) return null;
  const t = Date.parse(`${String(utc).replace(' ', 'T')}Z`);
  if (Number.isNaN(t)) return null;
  return new Date(t + offsetMinutes * 60000).toISOString().slice(0, 10);
}

// Local 'YYYY-MM-DD' -> the UTC datetime of its local midnight, for querying
// Odoo ("created on or after this local day").
function localDayStartUtc(day, offsetMinutes = 0) {
  const t = Date.parse(`${day}T00:00:00Z`) - offsetMinutes * 60000;
  return new Date(t).toISOString().slice(0, 19).replace('T', ' ');
}

// Sales made with negative stock on one local day ('YYYY-MM-DD'), plus how
// many distinct parts, sales and units. rows: as for shapeNegativeStockSales.
function negativeSalesOnDay(rows, day, offsetMinutes = 0) {
  const sales = shapeNegativeStockSales(rows).filter((r) => utcToLocalDay(r.date, offsetMinutes) === day);
  return {
    sales,
    totals: {
      parts: new Set(sales.map((r) => r.productId || r.product)).size,
      sales: sales.length,
      units: sales.reduce((s, r) => s + (r.qty || 0), 0),
      waiting: sales.filter((r) => r.status === 'waiting').length
    }
  };
}

// ---------------- Which sales used a receipt's units (FIFO replay) ----------------

function compareLayers(a, b) {
  if (a.createDate !== b.createDate) return (a.createDate || '') < (b.createDate || '') ? -1 : 1;
  return a.id - b.id;
}

// Odoo doesn't store which delivery consumed which receipt, so this replays
// the product's valuation layers the way Odoo does (AVCO and FIFO both track
// per-receipt remaining qty oldest-first): each outgoing layer takes from the
// oldest receipts that still have quantity; a shortfall (negative stock)
// waits and is filled by the next receipt the moment it arrives.
//
// layers: [{ id, moveId, quantity, createDate }] (quantity > 0 in, < 0 out)
// Returns consumption records plus the replayed remaining qty per in-layer
// (compare with Odoo's own remaining_qty to know if the replay is exact).
function replayFifo(layers) {
  const sorted = [...(layers || [])].filter((l) => l.quantity).sort(compareLayers);
  const candidates = [];
  const negatives = [];
  const consumption = [];

  function take(out, qty, consumedAt, viaNegative) {
    let need = qty;
    for (const c of candidates) {
      if (need <= QTY_EPSILON) break;
      if (c.remaining <= QTY_EPSILON) continue;
      const q = Math.min(need, c.remaining);
      c.remaining -= q;
      need -= q;
      consumption.push({
        outLayerId: out.id, outMoveId: out.moveId, outDate: out.createDate,
        inLayerId: c.layer.id, inMoveId: c.layer.moveId, qty: q, consumedAt, viaNegative
      });
    }
    return need;
  }

  for (const l of sorted) {
    if (l.quantity > 0) {
      candidates.push({ layer: l, remaining: l.quantity });
      for (const n of negatives) {
        if (n.outstanding > QTY_EPSILON) n.outstanding = take(n.layer, n.outstanding, l.createDate, true);
      }
    } else {
      const short = take(l, -l.quantity, l.createDate, false);
      if (short > QTY_EPSILON) negatives.push({ layer: l, outstanding: short });
    }
  }

  const remainingByLayer = {};
  for (const c of candidates) remainingByLayer[c.layer.id] = c.remaining;
  return { consumption, remainingByLayer };
}

// True when the replay's remaining qty for this receipt's layers matches what
// Odoo itself stored - i.e. the sales list below is exact, not approximate.
function replayMatchesOdoo(layers, remainingByLayer, receiptMoveIds) {
  const ids = new Set(receiptMoveIds || []);
  return (layers || [])
    .filter((l) => l.quantity > 0 && ids.has(l.moveId))
    .every((l) => Math.abs((remainingByLayer[l.id] || 0) - (l.remainingQty || 0)) <= 0.01);
}

// Sales (outgoing moves) that took units from the given receipt moves,
// grouped per outgoing move. cutoff ('YYYY-MM-DD HH:MM:SS') keeps only units
// consumed before a landed cost was validated - those are the units whose
// share went to COGS. When divertedValue is given, it's split across the
// affected moves by quantity.
function affectedSales({ consumption, receiptMoveIds, cutoff = null, divertedValue = null }) {
  const ids = new Set(receiptMoveIds || []);
  const byMove = {};
  for (const c of consumption || []) {
    if (!ids.has(c.inMoveId)) continue;
    if (cutoff && (c.consumedAt || '') > cutoff) continue;
    if (!byMove[c.outMoveId]) {
      byMove[c.outMoveId] = { outMoveId: c.outMoveId, qty: 0, outDate: c.outDate, viaNegative: false };
    }
    byMove[c.outMoveId].qty += c.qty;
    if (c.viaNegative) byMove[c.outMoveId].viaNegative = true;
  }
  const rows = Object.values(byMove).sort(byDateAsc('outDate'));
  const totalQty = rows.reduce((s, r) => s + r.qty, 0);
  for (const r of rows) {
    r.share = typeof divertedValue === 'number' && totalQty > 0 ? (divertedValue * r.qty) / totalQty : null;
    r.perUnit = r.share !== null && r.qty > 0 ? r.share / r.qty : null;
  }
  return rows;
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

// Tab-separated text of every list, ready to paste into Excel.
function buildAuditSpreadsheetText(audit) {
  const header = ['List', 'Part', 'Document', 'Purchase/Sale Order', 'Vendor/Customer', 'Date',
    'Received Qty', 'In Stock Qty', 'Landed Cost', 'Amount (OMR)', 'Note'];
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
  for (const r of audit.incomplete || []) {
    rows.push(['Landed cost possibly missing', '', r.pickingName, r.poName, r.vendor, (r.dateDone || '').slice(0, 10),
      '', '', r.landedCosts.join(', '), '',
      `Posted: ${r.costProducts.join(', ') || '-'}; usually also: ${r.missing.map((m) => m.product).join(', ')}`]);
  }
  for (const r of audit.bills || []) {
    rows.push(['Bill not applied', r.products.join(', '), r.billName, '', r.vendor, (r.date || '').slice(0, 10),
      '', '', (r.appliedCosts || []).map((c) => c.name).join(', '), fmt3(r.unapplied),
      r.status === 'partial' ? `Partly applied (${fmt3(r.appliedTotal)} of ${fmt3(r.lcTotal)})` : 'Not applied']);
  }
  for (const r of audit.negativeSales || []) {
    rows.push(['Sold with negative stock', r.product, r.sale.pickingName, r.sale.saleOrderName, r.sale.customer,
      (r.date || '').slice(0, 10), fmtQty(r.qty), '', '', fmt3(r.correction),
      r.status === 'waiting' ? `Waiting for receipt (${fmtQty(r.waitingQty)} short)` : 'Covered by later receipt']);
  }

  return rows.map((cols) => cols.map(clean).join('\t')).join('\n');
}

const LANDED_AUDIT_EXPORTS = {
  sinceDateForRange, auditLandedCosts, buildAuditSpreadsheetText,
  findIncompleteReceipts, summarizeUnappliedBills, shapeNegativeStockSales,
  utcToLocalDay, localDayStartUtc, negativeSalesOnDay,
  replayFifo, replayMatchesOdoo, affectedSales
};

if (typeof window !== 'undefined') {
  window.LandedAudit = LANDED_AUDIT_EXPORTS;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = LANDED_AUDIT_EXPORTS;
}

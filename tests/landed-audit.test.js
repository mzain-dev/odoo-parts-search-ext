// Run with: node tests/landed-audit.test.js
const assert = require('assert');
const {
  sinceDateForRange, auditLandedCosts, buildAuditSpreadsheetText,
  findIncompleteReceipts, summarizeUnappliedBills, shapeNegativeStockSales,
  utcToLocalDay, localDayStartUtc, negativeSalesOnDay,
  replayFifo, replayMatchesOdoo, affectedSales
} = require('../lib/landed-audit.js');

// sinceDateForRange
{
  const now = new Date('2026-09-27T10:00:00Z');
  assert.strictEqual(sinceDateForRange('30', now), '2026-08-28');
  assert.strictEqual(sinceDateForRange('60', now), '2026-07-29');
  assert.strictEqual(sinceDateForRange('all', now), null);
  // unknown range -> safe 30-day default, never "all time"
  assert.strictEqual(sinceDateForRange('bogus', now), '2026-08-28');
}

// auditLandedCosts - receipts split by whether stock remains
{
  const audit = auditLandedCosts({
    receiptLines: [
      { pickingId: 1, pickingName: 'IN/1', dateDone: '2026-09-20', product: 'A', receivedQty: 50, remainingQty: 10 },
      { pickingId: 1, pickingName: 'IN/1', dateDone: '2026-09-20', product: 'B', receivedQty: 1, remainingQty: 0 },
      { pickingId: 2, pickingName: 'IN/2', dateDone: '2026-09-01', product: 'C', receivedQty: 5, remainingQty: 5,
        draftLandedCosts: ['LC/9'] },
      { pickingId: 3, pickingName: 'IN/3', dateDone: '2026-09-25', product: 'D', receivedQty: 2, remainingQty: 0.00001 }
    ]
  });
  assert.deepStrictEqual(audit.fixNow.map((r) => r.product), ['C', 'A']); // oldest first
  assert.deepStrictEqual(audit.alreadySold.map((r) => r.product), ['D', 'B']); // newest first, rounding noise = sold
  assert.strictEqual(audit.fixNow[1].soldQty, 40);
  assert.deepStrictEqual(audit.fixNow[0].draftLandedCosts, ['LC/9']);
  assert.deepStrictEqual(audit.fixNow[1].draftLandedCosts, []);
  assert.strictEqual(audit.totals.fixNowReceipts, 2);
  assert.strictEqual(audit.totals.alreadySoldReceipts, 2);
}

// auditLandedCosts - diverted amount = allocated minus what reached stock
{
  const audit = auditLandedCosts({
    divertedLines: [
      { costName: 'LC/1026', costDate: '2026-09-27', product: 'BL20', allocated: 11.779, intoStock: 0 },
      { costName: 'LC/2000', costDate: '2026-09-26', product: 'X', allocated: 200, intoStock: 40 },
      { costName: 'LC/1016', costDate: '2026-09-17', product: 'BL20', allocated: 4.822, intoStock: 4.822 },
      { costName: 'LC/3000', costDate: '2026-09-18', product: 'Y', allocated: 1.0, intoStock: 0.9999 }
    ]
  });
  assert.deepStrictEqual(audit.wentToCogs.map((r) => r.costName), ['LC/1026', 'LC/2000']);
  assert.ok(Math.abs(audit.wentToCogs[0].divertedValue - 11.779) < 1e-9);
  assert.strictEqual(audit.wentToCogs[0].fullyDiverted, true);
  assert.strictEqual(audit.wentToCogs[1].divertedValue, 160);
  assert.strictEqual(audit.wentToCogs[1].fullyDiverted, false);
  assert.ok(Math.abs(audit.totals.wentToCogsValue - 171.779) < 1e-9);
}

// auditLandedCosts - empty input
{
  const audit = auditLandedCosts();
  assert.deepStrictEqual(audit.fixNow, []);
  assert.strictEqual(audit.totals.wentToCogsValue, 0);
}

// buildAuditSpreadsheetText - one header + one row per line, tab-safe
{
  const audit = auditLandedCosts({
    receiptLines: [{ pickingId: 1, pickingName: 'IN/1', poName: 'PO1', vendor: 'Ven\tdor', dateDone: '2026-09-20 08:00:00',
      product: 'A', receivedQty: 3, remainingQty: 1 }],
    divertedLines: [{ costName: 'LC/1', costDate: '2026-09-21', product: 'B', allocated: 5, intoStock: 0 }]
  });
  const lines = buildAuditSpreadsheetText(audit).split('\n');
  assert.strictEqual(lines.length, 3);
  assert.strictEqual(lines[0].split('\t').length, 11);
  const first = lines[1].split('\t');
  assert.strictEqual(first.length, 11);
  assert.strictEqual(first[4], 'Ven dor');
  assert.strictEqual(first[5], '2026-09-20');
  assert.strictEqual(lines[2].split('\t')[9], '5.000');
}

// findIncompleteReceipts - learns each vendor's usual charges from history
{
  const mk = (id, vendorKey, products, inPeriod, date) => ({
    pickingId: id, pickingName: `IN/${id}`, dateDone: date || `2026-09-${10 + id}`, vendor: `V${vendorKey}`,
    vendorKey, inPeriod, costProducts: products, landedCosts: [`LC/${id}`]
  });
  const receipts = [
    mk(1, 1, ['TRANSPORT', 'LC Charges'], false),
    mk(2, 1, ['TRANSPORT', 'LC Charges'], false),
    mk(3, 1, ['TRANSPORT', 'LC Charges', 'Customs'], false),
    mk(4, 1, ['TRANSPORT'], true), // missing LC Charges
    mk(5, 1, ['TRANSPORT', 'LC Charges'], true), // complete
    mk(6, 2, ['TRANSPORT'], true), // vendor 2: only 2 receipts - not enough history
    mk(7, 2, [], true)
  ];
  const rows = findIncompleteReceipts(receipts);
  assert.deepStrictEqual(rows.map((r) => r.pickingName), ['IN/4']);
  assert.deepStrictEqual(rows[0].missing, [{ product: 'LC Charges', seen: 4, of: 5 }]);
  // Customs seen on 1 of 5 - not expected
  assert.ok(!rows[0].missing.some((m) => m.product === 'Customs'));
}

// summarizeUnappliedBills - none / partial / fully applied
{
  const rows = summarizeUnappliedBills([
    { billId: 1, billName: 'BILL/1', date: '2026-09-20', lcLines: [{ product: 'TRANSPORT', amount: 295.65 }], appliedCosts: [] },
    { billId: 2, billName: 'BILL/2', date: '2026-09-10', lcLines: [{ product: 'TRANSPORT', amount: 200 }, { product: 'Customs', amount: 100 }],
      appliedCosts: [{ name: 'LC/1', amount: 200 }], draftCosts: ['LC/9'] },
    { billId: 3, billName: 'BILL/3', date: '2026-09-05', lcLines: [{ product: 'LC Charges', amount: 121.03 }],
      appliedCosts: [{ name: 'LC/2', amount: 121.03 }] }
  ]);
  assert.deepStrictEqual(rows.map((r) => r.billName), ['BILL/2', 'BILL/1']); // oldest first, BILL/3 fully applied
  assert.strictEqual(rows[0].status, 'partial');
  assert.strictEqual(rows[0].unapplied, 100);
  assert.deepStrictEqual(rows[0].products, ['TRANSPORT', 'Customs']);
  assert.deepStrictEqual(rows[0].draftCosts, ['LC/9']);
  assert.strictEqual(rows[1].status, 'none');
}

// shapeNegativeStockSales - sales only, waiting first
{
  const rows = shapeNegativeStockSales([
    { outLayerId: 1, date: '2026-09-21', waitingQty: 0, correction: 1.34, sale: { saleOrderId: 5, saleOrderName: 'S5' } },
    { outLayerId: 2, date: '2026-09-01', waitingQty: 3, sale: { saleOrderId: 6, saleOrderName: 'S6' } },
    { outLayerId: 3, date: '2026-09-25', waitingQty: 1, sale: null } // return to vendor, not a sale
  ]);
  assert.deepStrictEqual(rows.map((r) => r.outLayerId), [2, 1]);
  assert.strictEqual(rows[0].status, 'waiting');
  assert.strictEqual(rows[0].correction, 0);
  assert.strictEqual(rows[1].status, 'covered');
}

// replayFifo + affectedSales - the "sold 40 before receiving 50" example
{
  const layers = [
    { id: 1, moveId: 101, quantity: -25, createDate: '2026-09-01 10:00:00', remainingQty: 0 }, // sale A, negative
    { id: 2, moveId: 102, quantity: -15, createDate: '2026-09-02 10:00:00', remainingQty: 0 }, // sale B, negative
    { id: 3, moveId: 200, quantity: 50, createDate: '2026-09-05 10:00:00', remainingQty: 6 },  // receipt of 50
    { id: 4, moveId: 103, quantity: -4, createDate: '2026-09-06 10:00:00', remainingQty: 0 },  // sale C, normal
    { id: 5, moveId: 104, quantity: -2, createDate: '2026-09-20 10:00:00', remainingQty: 0 }   // sale D, after LC
  ];
  const { consumption, remainingByLayer } = replayFifo(layers);
  assert.strictEqual(remainingByLayer[3], 4);
  assert.strictEqual(replayMatchesOdoo(layers, remainingByLayer, [200]), false); // Odoo says 6 -> approximate
  assert.strictEqual(replayMatchesOdoo(layers, { 3: 6 }, [200]), true);

  // LC of 200 validated on 10 Sep: 44 units already out (40 negative + 4 normal)
  const rows = affectedSales({ consumption, receiptMoveIds: [200], cutoff: '2026-09-10 00:00:00', divertedValue: 176 });
  assert.deepStrictEqual(rows.map((r) => [r.outMoveId, r.qty, r.viaNegative]), [[101, 25, true], [102, 15, true], [103, 4, false]]);
  assert.strictEqual(rows[0].share, 100);
  assert.strictEqual(rows[0].perUnit, 4);
  assert.strictEqual(rows[2].share, 16);

  // no cutoff / no value: every sale that used the receipt, quantities only
  const all = affectedSales({ consumption, receiptMoveIds: [200] });
  assert.deepStrictEqual(all.map((r) => r.outMoveId), [101, 102, 103, 104]);
  assert.strictEqual(all[3].share, null);
}

// replayFifo - oldest receipt used first, across two receipts
{
  const { consumption } = replayFifo([
    { id: 1, moveId: 1, quantity: 1, createDate: '2026-01-01 00:00:00' },
    { id: 2, moveId: 2, quantity: 3, createDate: '2026-02-01 00:00:00' },
    { id: 3, moveId: 9, quantity: -2, createDate: '2026-03-01 00:00:00' }
  ]);
  assert.deepStrictEqual(consumption.map((c) => [c.inMoveId, c.qty]), [[1, 1], [2, 1]]);
}

// auditLandedCosts carries the new lists + spreadsheet includes them
{
  const audit = auditLandedCosts({
    bills: [{ billId: 1, billName: 'BILL/1', date: '2026-09-20', vendor: 'Fwd', lcLines: [{ product: 'TRANSPORT', amount: 50 }] }],
    negativeRows: [{ outLayerId: 1, product: 'P', qty: 2, date: '2026-09-21', waitingQty: 2,
      sale: { saleOrderId: 1, saleOrderName: 'S1', customer: 'C', pickingName: 'DO/1' } }]
  });
  assert.strictEqual(audit.totals.billsCount, 1);
  assert.strictEqual(audit.totals.billsValue, 50);
  assert.strictEqual(audit.totals.negativeWaiting, 1);
  const lines = buildAuditSpreadsheetText(audit).split('\n');
  assert.strictEqual(lines.length, 3);
  assert.ok(lines.every((l) => l.split('\t').length === 11));
}

// Negative stock sales on one local day (Muscat, UTC+4)
{
  assert.strictEqual(utcToLocalDay('2026-09-27 21:30:00', 240), '2026-09-28');
  assert.strictEqual(utcToLocalDay('2026-09-27 19:59:59', 240), '2026-09-27');
  assert.strictEqual(utcToLocalDay(null, 240), null);
  assert.strictEqual(localDayStartUtc('2026-09-28', 240), '2026-09-27 20:00:00');

  const sale = (id, productId, date, qty, waitingQty) => ({
    outLayerId: id, productId, product: `P${productId}`, qty, unitCost: 1, date, waitingQty,
    sale: { saleOrderId: 100 + id, saleOrderName: `S${id}`, customer: 'C', pickingName: `OUT/${id}` }
  });
  const rows = [
    sale(1, 1, '2026-09-27 21:30:00', 2, 2), // 28th local, waiting
    sale(2, 1, '2026-09-28 08:00:00', 1, 0), // 28th local, covered
    sale(3, 2, '2026-09-28 10:00:00', 3, 1), // 28th local, waiting
    sale(4, 3, '2026-09-27 19:00:00', 5, 5), // 27th local - excluded
    { ...sale(5, 4, '2026-09-28 10:00:00', 4, 4), sale: null } // not a sale - excluded
  ];
  const { sales, totals } = negativeSalesOnDay(rows, '2026-09-28', 240);
  assert.deepStrictEqual(sales.map((r) => r.outLayerId).sort(), [1, 2, 3]);
  assert.deepStrictEqual(totals, { parts: 2, sales: 3, units: 6, waiting: 2 });
  assert.strictEqual(negativeSalesOnDay(rows, '2026-09-26', 240).sales.length, 0);
}

console.log('landed-audit tests passed');

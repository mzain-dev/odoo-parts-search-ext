// Run with: node lib/landed-audit.test.js
const assert = require('assert');
const { sinceDateForRange, auditLandedCosts, buildAuditSpreadsheetText } = require('./landed-audit.js');

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

console.log('landed-audit tests passed');

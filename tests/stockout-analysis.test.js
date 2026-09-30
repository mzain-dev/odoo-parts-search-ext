// Run with: node tests/stockout-analysis.test.js
const assert = require('assert');
const {
  localDay, localMidnightUtc, resolveDateRange, buildDailyStock, summarizeParts, summaryTotals,
  filterParts, sortRows, rankParts, dayRowsFor, toDelimited
} = require('../lib/stockout-analysis.js');

const DUBAI = 240;
const locations = {
  1: { usage: 'internal', warehouseId: 10 }, // Muscat stock
  2: { usage: 'internal', warehouseId: 20 }, // Salalah stock
  8: { usage: 'supplier' }, 9: { usage: 'customer' }, 7: { usage: 'inventory' }
};
const sale = (id, productId, qty, date, src = 1) => ({ id, productId, qty, date, src, dest: 9, reference: `DO/${id}` });
const receipt = (id, productId, qty, date, dest = 1) => ({ id, productId, qty, date, src: 8, dest, reference: `IN/${id}` });

// localDay / localMidnightUtc - Odoo UTC -> Muscat day
{
  assert.strictEqual(localDay('2026-09-01 19:59:59', DUBAI), '2026-09-01');
  assert.strictEqual(localDay('2026-09-01 20:00:00', DUBAI), '2026-09-02');
  assert.strictEqual(localMidnightUtc('2026-09-02', DUBAI), '2026-09-01 20:00:00');
}

// resolveDateRange - every preset
{
  const t = '2026-09-30';
  assert.deepStrictEqual(resolveDateRange('today', t), { from: t, to: t });
  assert.deepStrictEqual(resolveDateRange('yesterday', t), { from: '2026-09-29', to: '2026-09-29' });
  assert.deepStrictEqual(resolveDateRange('last7', t), { from: '2026-09-24', to: t });
  assert.deepStrictEqual(resolveDateRange('last30', t), { from: '2026-09-01', to: t });
  assert.deepStrictEqual(resolveDateRange('date', t, { date: '2026-09-02' }), { from: '2026-09-02', to: '2026-09-02' });
  assert.deepStrictEqual(resolveDateRange('range', t, { from: '2026-09-10', to: '2026-09-05' }), { from: '2026-09-05', to: '2026-09-10' });
  assert.deepStrictEqual(resolveDateRange('range', t, { from: '2026-09-10', to: '2026-12-01' }), { from: '2026-09-10', to: t });
}

// The example from the request: ABC-123, 01-04 Sep
const example = {
  moves: [
    sale(1, 100, 3, '2026-09-01 06:00:00'),
    sale(2, 100, 4, '2026-09-02 06:00:00'),
    sale(3, 100, 3, '2026-09-03 06:00:00')
  ],
  locations,
  onHand: [{ productId: 100, locationId: 1, quantity: -5 }],
  products: { 100: { code: 'ABC-123', name: 'Hydraulic Filter' } }
};
{
  const daily = buildDailyStock(example, { from: '2026-09-01', to: '2026-09-04', offsetMinutes: DUBAI });
  const d = daily[100].days;
  assert.deepStrictEqual(d.map((x) => [x.date, x.opening, x.sold, x.closing, x.negativeQty]), [
    ['2026-09-01', 5, 3, 2, 0],
    ['2026-09-02', 2, 4, -2, -2],
    ['2026-09-03', -2, 3, -5, -5],
    ['2026-09-04', -5, 0, -5, -5]
  ]);
  assert.deepStrictEqual(d.map((x) => x.soldWithoutStock), [0, 2, 3, 0]);

  const [row] = summarizeParts(daily);
  assert.strictEqual(row.code, 'ABC-123');
  assert.strictEqual(row.timesNegative, 1);
  assert.strictEqual(row.stockOuts, 0);
  assert.strictEqual(row.negativeDays, 3);
  assert.strictEqual(row.longestNegativeStretch, 3);
  assert.strictEqual(row.soldWithoutStock, 5);
  assert.strictEqual(row.salesWithoutStock, 2);
  assert.strictEqual(row.totalSold, 10);
  assert.strictEqual(row.maxShortage, 5);
  assert.strictEqual(row.firstNegativeDate, '2026-09-02');
  assert.strictEqual(row.negativeNow, true);
  assert.strictEqual(row.repeated, false); // went negative once and stayed there
}

// Repeated offender: sells out, restocked, goes negative, restocked, negative again
{
  const data = {
    moves: [
      sale(1, 200, 2, '2026-09-01 05:00:00'),      // 2 -> 0 (sold out)
      receipt(2, 200, 3, '2026-09-02 05:00:00'),   // 0 -> 3
      sale(3, 200, 4, '2026-09-03 05:00:00'),      // 3 -> -1 (negative #1)
      receipt(4, 200, 5, '2026-09-05 05:00:00'),   // -1 -> 4
      sale(5, 200, 6, '2026-09-06 05:00:00'),      // 4 -> -2 (negative #2)
      receipt(6, 200, 2, '2026-09-06 09:00:00')    // -2 -> 0 same day
    ],
    locations,
    onHand: [{ productId: 200, locationId: 1, quantity: 0 }],
    products: { 200: { code: 'F-9', name: 'Filter' } }
  };
  const daily = buildDailyStock(data, { from: '2026-09-01', to: '2026-09-07', offsetMinutes: DUBAI });
  const [row] = summarizeParts(daily);
  assert.strictEqual(daily[200].days[0].opening, 2);
  assert.strictEqual(row.stockOuts, 1);
  assert.strictEqual(row.timesNegative, 2);
  assert.strictEqual(row.repeated, true);
  assert.strictEqual(row.needsReplenishment, true); // repeated and nothing on hand now
  assert.strictEqual(row.negativeDays, 2);          // 3 and 4 Sep closed negative; 6 Sep recovered same day
  assert.deepStrictEqual(row.negativeDates, ['2026-09-03', '2026-09-04', '2026-09-06']);
  assert.deepStrictEqual(row.wentNegativeDates, ['2026-09-03', '2026-09-06']);
  assert.deepStrictEqual(row.soldOutDates, ['2026-09-01']);
  assert.strictEqual(row.soldWithoutStock, 3);      // 1 on 3 Sep + 2 on 6 Sep
  const sixth = daily[200].days[5];
  assert.deepStrictEqual([sixth.minBalance, sixth.closing, sixth.negativeQty, sixth.wentNegative], [-2, 0, 0, 1]);

  // problem days only vs all days - 5 Sep counts: it opened at -1 before the receipt
  assert.deepStrictEqual(dayRowsFor(daily, [row]).map((r) => r.date), ['2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06']);
  assert.strictEqual(dayRowsFor(daily, [row], { onlyProblemDays: false }).length, 7);
}

// Warehouse scope: a transfer between warehouses moves stock in/out of each,
// but nets to zero for all warehouses together.
{
  const data = {
    moves: [
      { id: 1, productId: 300, qty: 2, date: '2026-09-02 05:00:00', src: 1, dest: 2, reference: 'INT/1' },
      sale(2, 300, 3, '2026-09-03 05:00:00', 2)
    ],
    locations,
    onHand: [{ productId: 300, locationId: 1, quantity: 1 }, { productId: 300, locationId: 2, quantity: -1 }],
    products: { 300: { code: 'S-1', name: 'Seal' } }
  };
  const all = buildDailyStock(data, { from: '2026-09-01', to: '2026-09-03', offsetMinutes: DUBAI });
  assert.deepStrictEqual(all[300].days.map((d) => d.closing), [3, 3, 0]);
  assert.strictEqual(summarizeParts(all)[0].stockOuts, 1);

  const salalah = buildDailyStock(data, { from: '2026-09-01', to: '2026-09-03', offsetMinutes: DUBAI, warehouseId: 20 });
  assert.deepStrictEqual(salalah[300].days.map((d) => [d.received, d.closing]), [[0, 0], [2, 2], [0, -1]]);
  assert.strictEqual(summarizeParts(salalah)[0].timesNegative, 1);
}

// Customer returns count as returned, not received; a product negative
// before the period with no moves in it still shows (negative every day).
{
  const data = {
    moves: [{ id: 1, productId: 400, qty: 1, date: '2026-09-02 05:00:00', src: 9, dest: 1 }],
    locations,
    onHand: [{ productId: 400, locationId: 1, quantity: 1 }, { productId: 401, locationId: 1, quantity: -2 }],
    products: { 400: { code: 'R', name: 'Returned' }, 401: { code: 'N', name: 'Always negative' } }
  };
  const daily = buildDailyStock(data, { from: '2026-09-01', to: '2026-09-03', offsetMinutes: DUBAI });
  assert.strictEqual(daily[400].days[1].returned, 1);
  assert.strictEqual(daily[400].days[1].received, 0);
  const rows = summarizeParts(daily);
  assert.deepStrictEqual(rows.map((r) => r.code), ['N']);
  assert.strictEqual(rows[0].negativeAtStart, true);
  assert.strictEqual(rows[0].timesNegative, 0);
  assert.strictEqual(rows[0].negativeDays, 3);
}

// Filters, sorting, ranking, totals, export
{
  const rows = [
    { productId: 1, code: 'A-10', name: 'Pump', timesNegative: 1, stockOuts: 0, soldWithoutStock: 5, negativeDays: 3, repeated: false, negativeNow: true, needsReplenishment: false, lastNegativeDate: '2026-09-02' },
    { productId: 2, code: 'A-9', name: 'Filter', timesNegative: 3, stockOuts: 1, soldWithoutStock: 2, negativeDays: 1, repeated: true, negativeNow: false, needsReplenishment: true, lastNegativeDate: null },
    { productId: 3, code: 'B-1', name: 'Seal kit', timesNegative: 3, stockOuts: 2, soldWithoutStock: 1, negativeDays: 2, repeated: true, negativeNow: false, needsReplenishment: false, lastNegativeDate: '2026-09-05' }
  ];
  assert.deepStrictEqual(filterParts(rows, { search: 'fil' }).map((r) => r.productId), [2]);
  assert.deepStrictEqual(filterParts(rows, { search: 'a-' }).map((r) => r.productId), [1, 2]);
  assert.deepStrictEqual(filterParts(rows, { onlyRepeated: true }).map((r) => r.productId), [2, 3]);
  assert.deepStrictEqual(filterParts(rows, { onlyNegativeNow: true }).map((r) => r.productId), [1]);
  assert.deepStrictEqual(filterParts(rows, { onlyNeedsReplenishment: true }).map((r) => r.productId), [2]);
  assert.deepStrictEqual(filterParts(rows, { minTimes: 2 }).map((r) => r.productId), [2, 3]);

  assert.deepStrictEqual(rankParts(rows).map((r) => r.productId), [3, 2, 1]); // tie on 3 -> more stock-outs first
  assert.deepStrictEqual(sortRows(rows, 'code', 'asc').map((r) => r.code), ['A-9', 'A-10', 'B-1']); // natural order
  assert.deepStrictEqual(sortRows(rows, 'lastNegativeDate', 'asc').map((r) => r.productId), [1, 3, 2]); // blank last
  assert.deepStrictEqual(sortRows(rows, 'lastNegativeDate', 'desc').map((r) => r.productId), [3, 1, 2]); // blank last

  const totals = summaryTotals(rows.map((r) => ({ ...r })));
  assert.deepStrictEqual([totals.parts, totals.repeated, totals.negativeNow, totals.negativeEvents, totals.soldWithoutStock, totals.needsReplenishment],
    [3, 2, 1, 7, 8, 1]);

  const cols = [{ key: 'code', label: 'Part Number' }, { key: 'name', label: 'Part Name' },
    { key: 'timesNegative', label: 'Times', format: (v) => `${v}x` }];
  const csv = toDelimited([{ code: 'A,1', name: 'Say "hi"', timesNegative: 2 }], cols, ',').split('\r\n');
  assert.deepStrictEqual(csv, ['Part Number,Part Name,Times', '"A,1","Say ""hi""",2x']);
  const tsv = toDelimited([{ code: 'A\t1', name: 'x', timesNegative: 1 }], cols, '\t').split('\n');
  assert.strictEqual(tsv[1], 'A 1\tx\t1x');
}

console.log('stockout-analysis tests passed');

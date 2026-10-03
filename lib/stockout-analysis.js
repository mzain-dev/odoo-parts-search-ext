// Pure functions: no DOM, no chrome.* calls. Powers the Stock-outs report -
// which parts get sold when their stock is already zero or negative, and
// how often.
//
// Odoo keeps no day-by-day stock history, so it is rebuilt here: start from
// today's actual on-hand (stock.quant) and walk every completed stock move
// backwards in time. That gives the balance before and after each move, so
// the end-of-day balance for every day and the stock available at the moment
// of every sale are both exact (as exact as the moves themselves).
//
// Input comes from content-scripts/odoo-bridge.js's getStockoutData().

const SO_EPS = 0.0001;

function round4(n) {
  const r = Math.round(n * 10000) / 10000;
  return Object.is(r, -0) ? 0 : r;
}

// ---------------- Dates ----------------

function pad2(n) {
  return String(n).padStart(2, '0');
}

function dayString(d) {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return dayString(d);
}

function daysBetween(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

// Odoo stores datetimes in UTC ('YYYY-MM-DD HH:MM:SS'). offsetMinutes is the
// user's offset from UTC (Muscat/Dubai: +240), so a sale at 22:00 UTC counts
// on the next local day - the day the user actually saw it.
function localDay(utc, offsetMinutes) {
  if (!utc) return null;
  const t = Date.parse(`${String(utc).replace(' ', 'T')}Z`);
  if (Number.isNaN(t)) return null;
  return dayString(new Date(t + offsetMinutes * 60000));
}

// Local 'YYYY-MM-DD' day -> the UTC datetime string of its local midnight,
// for querying Odoo ("moves on or after this local day").
function localMidnightUtc(day, offsetMinutes) {
  const t = Date.parse(`${day}T00:00:00Z`) - offsetMinutes * 60000;
  return new Date(t).toISOString().slice(0, 19).replace('T', ' ');
}

// today: local 'YYYY-MM-DD'. preset: today | yesterday | last7 | last30 |
// date (uses opts.date) | range (uses opts.from / opts.to). Always returns
// from <= to, never later than today.
function resolveDateRange(preset, today, opts = {}) {
  let from;
  let to;
  switch (preset) {
    case 'today': from = today; to = today; break;
    case 'yesterday': from = addDays(today, -1); to = from; break;
    case 'last7': from = addDays(today, -6); to = today; break;
    case 'last30': from = addDays(today, -29); to = today; break;
    case 'date': from = opts.date || today; to = from; break;
    case 'range': from = opts.from || addDays(today, -29); to = opts.to || today; break;
    default: from = addDays(today, -29); to = today;
  }
  if (to > today) to = today;
  if (from > to) [from, to] = [to, from];
  return { from, to };
}

// ---------------- Day-wise reconstruction ----------------

// data: {
//   moves:     [{ id, productId, qty, date, src, dest, reference }]   done moves on/after `from`
//                (stock.move.line rows, so src/dest are the exact shelves)
//   locations: { [id]: { usage, warehouseId, name } }
//   onHand:    [{ productId, locationId, quantity }]                   current stock.quant rows
//   products:  { [id]: { code, name } }
// }
// options: { from, to, offsetMinutes, warehouseId (null = all warehouses),
//   byLocation }
//
// byLocation false: one stock pool per part - all internal locations in the
//   scope added together; moves between them don't count.
// byLocation true: one pool per part AND location - the way Odoo deducts a
//   sale (from the shelf it was picked from). A part at +2, -3 and +5 in three
//   locations shows the -3 location going negative even though the total is 4.
//   Transfers between locations count as moved out of one, into the other.
//
// Returns { [key]: { key, productId, locationId, location, code, name, current,
//   onHandByLocation, days: [...], events: {...} } } - key is the product id
// ('12'), or product@location ('12@8') by location. Each day is { date,
// opening, received, sold, returned, issued, movedIn, movedOut, closing,
// minBalance, negativeQty, soldWithoutStock, salesWithoutStock, wentNegative }.
function buildDailyStock(data, { from, to, offsetMinutes = 0, warehouseId = null, byLocation = false } = {}) {
  const locations = data.locations || {};
  const inside = (locId) => {
    const loc = locations[locId];
    return !!loc && loc.usage === 'internal' && (warehouseId === null || loc.warehouseId === warehouseId);
  };
  const usage = (locId) => (locations[locId] ? locations[locId].usage : null);
  const locName = (locId) => (locations[locId] && locations[locId].name) || (locId ? `Location ${locId}` : '');
  const poolKey = (pid, locId) => (byLocation ? `${pid}@${locId}` : String(pid));

  const pools = {}; // key -> { productId, locationId }
  const addPool = (pid, locId) => {
    const key = poolKey(pid, locId);
    if (!pools[key]) pools[key] = { productId: pid, locationId: byLocation ? locId : null };
    return key;
  };

  // Current on-hand per pool within the chosen scope, and per location for
  // the "on hand by location now" breakdown.
  const current = {};
  const byLocNow = {}; // productId -> { locationId: qty }
  for (const q of data.onHand || []) {
    if (!inside(q.locationId)) continue;
    const key = addPool(q.productId, q.locationId);
    current[key] = (current[key] || 0) + (q.quantity || 0);
    const locs = byLocNow[q.productId] || (byLocNow[q.productId] = {});
    locs[q.locationId] = (locs[q.locationId] || 0) + (q.quantity || 0);
  }

  // Moves that change stock within each pool.
  const movesByPool = {};
  const push = (key, entry) => (movesByPool[key] = movesByPool[key] || []).push(entry);
  for (const m of data.moves || []) {
    const inSrc = inside(m.src);
    const inDest = inside(m.dest);
    const day = localDay(m.date, offsetMinutes);
    if (!byLocation) {
      if (inSrc === inDest) continue; // moved within the scope (or never touched it)
      push(addPool(m.productId, null), {
        ...m, day, delta: inDest ? m.qty : -m.qty,
        isSale: inSrc && usage(m.dest) === 'customer',
        isReturn: inDest && usage(m.src) === 'customer',
        isTransfer: false
      });
      continue;
    }
    if (!inSrc && !inDest) continue;
    if (m.src === m.dest) continue;
    if (inSrc) {
      push(addPool(m.productId, m.src), {
        ...m, day, delta: -m.qty, isSale: usage(m.dest) === 'customer', isReturn: false, isTransfer: inDest
      });
    }
    if (inDest) {
      push(addPool(m.productId, m.dest), {
        ...m, day, delta: m.qty, isSale: false, isReturn: usage(m.src) === 'customer', isTransfer: inSrc
      });
    }
  }

  const days = daysBetween(from, to);
  const result = {};

  for (const [key, pool] of Object.entries(pools)) {
    const pid = pool.productId;
    const moves = (movesByPool[key] || []).sort((a, b) =>
      (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.id || 0) - (b.id || 0)));

    // Walk backwards from today's on-hand to get the balance around each move.
    let balance = current[key] || 0;
    for (let i = moves.length - 1; i >= 0; i--) {
      moves[i].after = round4(balance);
      balance -= moves[i].delta;
      moves[i].before = round4(balance);
    }
    let running = round4(balance); // balance at local midnight starting `from`

    const byDay = {};
    for (const m of moves) (byDay[m.day] = byDay[m.day] || []).push(m);

    const dayRows = [];
    const events = { negative: [], stockOut: [] };
    for (const day of days) {
      const dayMoves = byDay[day] || [];
      const row = {
        date: day, opening: running, received: 0, sold: 0, returned: 0, issued: 0, movedIn: 0, movedOut: 0,
        closing: running, minBalance: running, soldWithoutStock: 0, salesWithoutStock: 0, wentNegative: 0
      };
      for (const m of dayMoves) {
        if (m.isSale) row.sold += m.qty;
        else if (m.isReturn) row.returned += m.qty;
        else if (m.isTransfer) row[m.delta > 0 ? 'movedIn' : 'movedOut'] += m.qty;
        else if (m.delta > 0) row.received += m.qty;
        else row.issued += m.qty;

        if (m.isSale) {
          const short = Math.min(m.qty, Math.max(0, m.qty - Math.max(0, m.before)));
          if (short > SO_EPS) {
            row.soldWithoutStock += short;
            row.salesWithoutStock += 1;
          }
          // Sold out: this sale took the last units, leaving exactly zero.
          // (Going below zero is counted once, as a negative event, below.)
          if (m.before > SO_EPS && Math.abs(m.after) <= SO_EPS) events.stockOut.push({ date: day, reference: m.reference || null });
        }
        if (m.before >= -SO_EPS && m.after < -SO_EPS) {
          row.wentNegative += 1;
          events.negative.push({ date: day, reference: m.reference || null, balance: m.after });
        }
        row.minBalance = Math.min(row.minBalance, m.after);
        running = m.after;
      }
      row.closing = round4(running);
      row.minBalance = round4(row.minBalance);
      row.negativeQty = row.closing < -SO_EPS ? row.closing : 0;
      for (const k of ['received', 'sold', 'returned', 'issued', 'movedIn', 'movedOut', 'soldWithoutStock']) row[k] = round4(row[k]);
      dayRows.push(row);
    }

    const product = (data.products || {})[pid] || {};
    const onHandByLocation = Object.entries(byLocNow[pid] || {})
      .map(([locId, q]) => ({ locationId: Number(locId), location: locName(Number(locId)), quantity: round4(q) }))
      .filter((l) => Math.abs(l.quantity) > SO_EPS)
      .sort((a, b) => a.quantity - b.quantity || a.location.localeCompare(b.location));
    result[key] = {
      key,
      productId: pid,
      locationId: pool.locationId,
      location: pool.locationId ? locName(pool.locationId) : '',
      code: product.code || '',
      name: product.name || '',
      current: round4(current[key] || 0),
      onHandByLocation,
      days: dayRows,
      events
    };
  }
  return result;
}

// ---------------- Part summary ----------------

// One row per part that had a stock problem in the period: went negative,
// ran out through a sale, sold without stock, or sat negative.
function summarizeParts(daily) {
  const rows = [];
  for (const p of Object.values(daily)) {
    const negDays = p.days.filter((d) => d.closing < -SO_EPS);
    const timesNegative = p.events.negative.length;
    const stockOuts = p.events.stockOut.length;
    const soldWithoutStock = round4(p.days.reduce((s, d) => s + d.soldWithoutStock, 0));
    const salesWithoutStock = p.days.reduce((s, d) => s + d.salesWithoutStock, 0);
    if (!negDays.length && !timesNegative && !stockOuts && soldWithoutStock <= SO_EPS) continue;

    let longest = 0;
    let streak = 0;
    for (const d of p.days) {
      streak = d.closing < -SO_EPS ? streak + 1 : 0;
      longest = Math.max(longest, streak);
    }
    const lowest = Math.min(...p.days.map((d) => d.minBalance));
    const wentNegativeDates = [...new Set(p.events.negative.map((e) => e.date))].sort();
    const negativeDates = [...new Set([
      ...p.events.negative.map((e) => e.date),
      ...negDays.map((d) => d.date)
    ])].sort();

    const onHandByLocation = p.onHandByLocation || [];
    rows.push({
      key: p.key || String(p.productId),
      productId: p.productId,
      locationId: p.locationId || null,
      location: p.location || '',
      code: p.code,
      name: p.name,
      current: p.current,
      onHandByLocation,
      // "WH/Stock/B -3 · WH/Stock 2" - most negative first
      onHandByLocationText: onHandByLocation.map((l) => `${l.location} ${l.quantity}`).join(' · '),
      negativeLocationsNow: onHandByLocation.filter((l) => l.quantity < -SO_EPS).length,
      timesNegative,
      stockOuts,
      negativeDays: negDays.length,
      longestNegativeStretch: longest,
      soldWithoutStock,
      salesWithoutStock,
      totalSold: round4(p.days.reduce((s, d) => s + d.sold, 0)),
      lowestBalance: round4(lowest),
      maxShortage: lowest < -SO_EPS ? round4(-lowest) : 0,
      firstNegativeDate: negativeDates[0] || null,
      lastNegativeDate: negativeDates[negativeDates.length - 1] || null,
      negativeDates,
      wentNegativeDates,
      soldOutDates: [...new Set(p.events.stockOut.map((e) => e.date))].sort(),
      negativeNow: p.current < -SO_EPS,
      negativeAtStart: p.days.length > 0 && p.days[0].opening < -SO_EPS,
      // "Repeatedly": went negative or sold out at least twice in the period.
      repeated: timesNegative + stockOuts >= 2,
      needsReplenishment: (timesNegative + stockOuts >= 2) && p.current <= SO_EPS
    });
  }
  return rows;
}

function summaryTotals(rows) {
  return {
    parts: new Set(rows.map((r) => r.productId)).size,
    rows: rows.length, // = parts, or part+location rows when by location
    repeated: rows.filter((r) => r.repeated).length,
    negativeNow: rows.filter((r) => r.negativeNow).length,
    negativeEvents: rows.reduce((s, r) => s + r.timesNegative, 0),
    soldWithoutStock: round4(rows.reduce((s, r) => s + r.soldWithoutStock, 0)),
    needsReplenishment: rows.filter((r) => r.needsReplenishment).length
  };
}

// ---------------- Filtering, sorting ----------------

// filters: { search, onlyRepeated, onlyNegativeNow, onlyNeedsReplenishment,
//   onlySoldNegative, minTimes }. onlySoldNegative keeps parts that had at
// least one sale bigger than the stock on hand in the period (sold into or
// while in negative) - not parts that merely sat negative or sold out to 0.
function filterParts(rows, filters = {}) {
  const q = (filters.search || '').trim().toLowerCase();
  return rows.filter((r) => {
    if (q && !`${r.code} ${r.name} ${r.location || ''}`.toLowerCase().includes(q)) return false;
    if (filters.onlySoldNegative && !(r.soldWithoutStock > SO_EPS)) return false;
    if (filters.onlyRepeated && !r.repeated) return false;
    if (filters.onlyNegativeNow && !r.negativeNow) return false;
    if (filters.onlyNeedsReplenishment && !r.needsReplenishment) return false;
    if (filters.minTimes && r.timesNegative < filters.minTimes) return false;
    return true;
  });
}

const isBlank = (v) => v === null || v === undefined || v === '';

function compareValues(a, b) {
  if (a === b) return 0;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' || typeof b === 'boolean') return (a ? 1 : 0) - (b ? 1 : 0);
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

// Stable sort by `key` in `dir`; ties broken by `fallbacks` (always highest
// first). Blank values always go last, whichever direction.
function sortRows(rows, key, dir = 'desc', fallbacks = []) {
  const sign = dir === 'asc' ? 1 : -1;
  return rows
    .map((r, i) => ({ r, i }))
    .sort((x, y) => {
      for (const k of [key, ...fallbacks]) {
        const a = x.r[k];
        const b = y.r[k];
        if (isBlank(a) !== isBlank(b)) return isBlank(a) ? 1 : -1;
        const c = compareValues(a, b);
        if (c !== 0) return k === key ? sign * c : -c;
      }
      return x.i - y.i;
    })
    .map((x) => x.r);
}

// Default ranking for "which parts go negative most": most occurrences, then
// most units sold without stock, then most days negative.
function rankParts(rows) {
  return sortRows(rows, 'timesNegative', 'desc', ['stockOuts', 'soldWithoutStock', 'negativeDays']);
}

// Flat day-wise rows for the table. keys: limit to these rows of `daily`
// (product ids, or product@location keys; null = every row in `summaryRows`).
// onlyProblemDays keeps days where the part was negative, went negative, or
// sold without stock.
function dayRowsFor(daily, summaryRows, { keys = null, productIds = null, onlyProblemDays = true } = {}) {
  const wanted = new Set((keys || productIds || summaryRows.map((r) => r.key || r.productId)).map(String));
  const out = [];
  for (const key of wanted) {
    const p = daily[key];
    if (!p) continue;
    for (const d of p.days) {
      const problem = d.closing < -SO_EPS || d.minBalance < -SO_EPS || d.wentNegative > 0 || d.soldWithoutStock > SO_EPS;
      if (onlyProblemDays && !problem) continue;
      out.push({ ...d, key, productId: p.productId, code: p.code, name: p.name, location: p.location || '', problem });
    }
  }
  return out;
}

// ---------------- Export ----------------

// columns: [{ key, label, format? }] - format(value, row) -> string
function toDelimited(rows, columns, delimiter) {
  const esc = (v) => {
    const s = String(v === null || v === undefined ? '' : v);
    if (delimiter === '\t') return s.replace(/[\t\r\n]+/g, ' ');
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map((c) => esc(c.label)).join(delimiter)];
  for (const r of rows) {
    lines.push(columns.map((c) => esc(c.format ? c.format(r[c.key], r) : r[c.key])).join(delimiter));
  }
  return lines.join(delimiter === '\t' ? '\n' : '\r\n');
}

const STOCKOUT_EXPORTS = {
  localDay, localMidnightUtc, addDays, daysBetween, resolveDateRange,
  buildDailyStock, summarizeParts, summaryTotals, filterParts, sortRows, rankParts, dayRowsFor, toDelimited
};

if (typeof window !== 'undefined') {
  window.StockoutAnalysis = STOCKOUT_EXPORTS;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = STOCKOUT_EXPORTS;
}

// Pure functions: no DOM, no chrome.* calls. Shared by popup.js and testable
// in isolation. Operates on customer-card objects already shaped by
// lib/customer-data.js's shapeCustomerCard (branch/salesperson/totalRevenue/
// lastOrderDate/openQuotations all present).

function filterCustomers(customers, { dormantDays, minRevenue, branch, salesperson, hasOpenQuotes, nameText } = {}) {
  const now = new Date();
  return customers.filter((c) => {
    if (dormantDays) {
      const last = c.lastOrderDate ? new Date(c.lastOrderDate) : null;
      const daysSinceLast = last ? Math.floor((now - last) / (1000 * 60 * 60 * 24)) : Infinity;
      if (daysSinceLast < dormantDays) return false;
    }
    if (minRevenue && c.totalRevenue < minRevenue) return false;
    // Branch/salesperson come from free text or a real Odoo string - matched
    // case-insensitively and by substring rather than exact equality, since
    // the actual field value ("Muscat Branch", full salesperson name) rarely
    // matches a short typed keyword exactly.
    if (branch && !(c.branch || '').toLowerCase().includes(branch.toLowerCase())) return false;
    if (salesperson && !(c.salesperson || '').toLowerCase().includes(salesperson.toLowerCase())) return false;
    if (hasOpenQuotes && c.openQuotations.length === 0) return false;
    if (nameText && !c.name.toLowerCase().includes(nameText.toLowerCase())) return false;
    return true;
  });
}

// Parses free text like "Muscat customers over OMR 5000" or "90+ days no
// order" into structured filters. Any leftover words (after stripping the
// recognized patterns/keywords) are treated as a plain name search.
function parseCustomerSearchText(text) {
  const filters = {};
  let remaining = text || '';

  const dormantMatch = remaining.match(/(\d+)\+?\s*days?\s*(no order|inactive|dormant)/i);
  if (dormantMatch) {
    filters.dormantDays = parseInt(dormantMatch[1], 10);
    remaining = remaining.replace(dormantMatch[0], '');
  }

  const revenueMatch = remaining.match(/(above|over)\s*(omr)?\s*(\d+)/i);
  if (revenueMatch) {
    filters.minRevenue = parseInt(revenueMatch[3], 10);
    remaining = remaining.replace(revenueMatch[0], '');
  }

  if (/muscat/i.test(remaining)) {
    filters.branch = 'Muscat';
    remaining = remaining.replace(/muscat/i, '');
  }
  if (/salalah/i.test(remaining)) {
    filters.branch = 'Salalah';
    remaining = remaining.replace(/salalah/i, '');
  }
  if (/open quot\w*/i.test(remaining)) {
    filters.hasOpenQuotes = true;
    remaining = remaining.replace(/open quot\w*/i, '');
  }

  remaining = remaining
    .replace(/\bcustomers?\b/gi, '')
    .trim()
    .replace(/\s{2,}/g, ' ');
  if (remaining) filters.nameText = remaining;

  return filters;
}

const FILTERS_EXPORTS = { filterCustomers, parseCustomerSearchText };

// Exposed for popup.js (classic script, no bundler/module system in this build).
if (typeof window !== 'undefined') {
  window.Filters = FILTERS_EXPORTS;
}
// Exposed for Node-based unit testing (see lib/filters.test.js).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = FILTERS_EXPORTS;
}

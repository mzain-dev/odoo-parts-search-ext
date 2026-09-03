// Run with: node lib/filters.test.js
const assert = require("assert");
const { filterCustomers, parseCustomerSearchText } = require("./filters.js");

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function customer(overrides) {
  return Object.assign(
    {
      name: "Test Co",
      branch: "Muscat Branch",
      salesperson: "Fatima Al Balushi",
      totalRevenue: 1000,
      lastOrderDate: daysAgo(10),
      openQuotations: [],
    },
    overrides,
  );
}

// parseCustomerSearchText
{
  const f1 = parseCustomerSearchText("90+ days no order");
  assert.strictEqual(f1.dormantDays, 90);

  const f2 = parseCustomerSearchText("Muscat customers over OMR 5000");
  assert.strictEqual(f2.branch, "Muscat");
  assert.strictEqual(f2.minRevenue, 5000);

  const f3 = parseCustomerSearchText("open quotes");
  assert.strictEqual(f3.hasOpenQuotes, true);

  const f4 = parseCustomerSearchText("Al Rawahi Trading");
  assert.strictEqual(f4.nameText, "Al Rawahi Trading");
  assert.strictEqual(f4.branch, undefined);
}

// filterCustomers - dormant
{
  const customers = [
    customer({ lastOrderDate: daysAgo(120) }),
    customer({ lastOrderDate: daysAgo(5) }),
  ];
  const result = filterCustomers(customers, { dormantDays: 90 });
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].lastOrderDate, daysAgo(120));
}

// filterCustomers - never-ordered customer counts as dormant
{
  const customers = [customer({ lastOrderDate: null })];
  const result = filterCustomers(customers, { dormantDays: 90 });
  assert.strictEqual(result.length, 1);
}

// filterCustomers - minRevenue
{
  const customers = [
    customer({ totalRevenue: 100 }),
    customer({ totalRevenue: 6000 }),
  ];
  const result = filterCustomers(customers, { minRevenue: 5000 });
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].totalRevenue, 6000);
}

// filterCustomers - branch is case-insensitive substring, not exact match
{
  const customers = [
    customer({ branch: "Muscat Branch" }),
    customer({ branch: "Salalah Branch" }),
  ];
  const result = filterCustomers(customers, { branch: "muscat" });
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].branch, "Muscat Branch");
}

// filterCustomers - hasOpenQuotes
{
  const customers = [
    customer({ openQuotations: [] }),
    customer({ openQuotations: [{ name: "SO1" }] }),
  ];
  const result = filterCustomers(customers, { hasOpenQuotes: true });
  assert.strictEqual(result.length, 1);
}

// filterCustomers - combined filters (AND)
{
  const customers = [
    customer({ branch: "Muscat Branch", totalRevenue: 6000 }),
    customer({ branch: "Muscat Branch", totalRevenue: 100 }),
    customer({ branch: "Salalah Branch", totalRevenue: 7000 }),
  ];
  const result = filterCustomers(customers, {
    branch: "Muscat",
    minRevenue: 5000,
  });
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].totalRevenue, 6000);
}

console.log("filters.test.js: all assertions passed");

// Runs every *.test.js in this folder. No dependencies - plain Node + assert.
const fs = require('fs');
const path = require('path');

const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).sort();
for (const f of files) require(path.join(__dirname, f));
console.log(`\n${files.length} test files passed.`);

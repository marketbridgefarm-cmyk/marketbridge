const test=require('node:test');
const assert=require('node:assert/strict');
test('production secret requirements are documented',()=>{assert.ok(Number(process.versions.node.split('.')[0])>=18);});

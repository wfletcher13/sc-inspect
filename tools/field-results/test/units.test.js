'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSpokenNumbers, parseQuantities, parseBareNumbers } = require('../lib/units');

const q = s => parseQuantities(normalizeSpokenNumbers(s)).map(x => [x.kind, x.value]);

test('pressure with every common unit spelling', () => {
  for (const s of ['0.05 in wc', '0.05 in. w.c.', '0.05 in. w.g.', '0.05 inches of water column', '0.05 inches of water', '0.05 inches w.g.', '0.05 in H2O', '0.05"wc', '0.05" wc', '.05 in wc', '0.05 iwc', '0.05 inch water gauge']) {
    assert.deepEqual(q(s), [['pressure', 0.05]], s);
  }
});

test('door force units', () => {
  for (const s of ['28 lbf', '28 lb', '28 lbs', '28 lbs.', '28 pounds', '28 pound-force', '28 pounds of force']) assert.deepEqual(q(s), [['force', 28]], s);
});

test('airflow with thousands separators, k suffix and words', () => {
  assert.deepEqual(q('12,500 CFM'), [['airflow', 12500]]);
  assert.deepEqual(q('12500 cfm'), [['airflow', 12500]]);
  assert.deepEqual(q('12.5k CFM'), [['airflow', 12500]]);
  assert.deepEqual(q('12 thousand 500 cfm'), [['airflow', 12500]]);
  assert.deepEqual(q('twelve thousand five hundred CFM'), [['airflow', 12500]]);
  assert.deepEqual(q('9,000 cubic feet per minute'), [['airflow', 9000]]);
});

test('spoken decimals and integers', () => {
  assert.equal(normalizeSpokenNumbers('point zero five inches'), '0.05 inches');
  assert.equal(normalizeSpokenNumbers('zero point oh six in wc'), '0.06 in wc');
  assert.equal(normalizeSpokenNumbers('twenty eight pounds'), '28 pounds');
  assert.equal(normalizeSpokenNumbers('one hundred and five pounds'), '105 pounds');
  assert.equal(normalizeSpokenNumbers('level twelve, stair A'), 'level 12, stair A');
  assert.equal(normalizeSpokenNumbers('SPF one override on'), 'SPF 1 override on');
});

test('SI units are converted to the units the app records', () => {
  const [p] = parseQuantities('12.5 Pa');
  assert.equal(p.kind, 'pressure'); assert.equal(p.value, 0.05); assert.match(p.converted.from, /12.5 Pa/);
  const [f] = parseQuantities('133 newtons');
  assert.equal(f.kind, 'force'); assert.equal(f.value, 29.9);
});

test('negative pressure keeps its sign', () => {
  assert.deepEqual(q('negative 0.02 in. w.g.'), [['pressure', -0.02]]);
  assert.deepEqual(q('minus 0.02 in wc'), [['pressure', -0.02]]);
});

test('no quantities from levels, tags, times or plain words', () => {
  assert.deepEqual(q('Level 12, stair A, SPF-1 at 10:15'), []);
  assert.deepEqual(q('the door is in the stair'), []);
  assert.deepEqual(q('inspection in progress'), []);
});

test('several values in one sentence keep their order', () => {
  assert.deepEqual(q('0.08 in wc, break 22 pounds, swing 12 pounds'), [['pressure', 0.08], ['force', 22], ['force', 12]]);
});

test('bare numbers skip unit-bearing numbers and excluded spans', () => {
  const text = 'level 12 pressure 0.06, break 22 lbf';
  const bare = parseBareNumbers(text, [[0, 8]]);
  assert.deepEqual(bare.map(b => b.value), [0.06]);
});

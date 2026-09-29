'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadAppModel } = require('../lib/appModel');
const { buildVocabulary } = require('../lib/matcher');
const { extractChecklist, normResult } = require('../lib/checklist');
const { readPhotoIndex, extractPhotos } = require('../lib/photos');
const { parseCsv, readTable } = require('../lib/tabular');
const { fixture, tmpDir, makeXlsx } = require('./helpers');

const model = loadAppModel();
const project = model.normalizeProject(JSON.parse(fs.readFileSync(fixture('pretest.json'), 'utf8')));
const vocab = buildVocabulary(project, model);

test('CSV parsing: quotes, embedded commas and newlines, tabs', () => {
  assert.deepEqual(parseCsv('a,b\n"x, y","line1\nline2"\n'), [['a', 'b'], ['x, y', 'line1\nline2']]);
  assert.deepEqual(parseCsv('a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv('a,b\n"he said ""hi""",2'), [['a', 'b'], ['he said "hi"', '2']]);
});

test('checklist answers', () => {
  assert.equal(normResult('Y').value, 'pass');
  assert.equal(normResult('✓').value, 'pass');
  assert.equal(normResult('No').value, 'fail');
  assert.equal(normResult('N/A').value, 'na');
  assert.ok(normResult('').blank);
  assert.ok(normResult('deferred').notTested);
  assert.equal(normResult('maybe').unknown, 'maybe');
});

test('CSV checklist maps rows to device tests and Table 1 items at medium confidence', () => {
  const out = extractChecklist(fixture('checklist.csv'), vocab);
  const byPath = Object.fromEntries(out.candidates.map(c => [c.path, c.value]));
  assert.deepEqual(byPath, { 'seqResults.SPF-1_0': 'pass', 'seqResults.SPF-2_3': 'pass', 'seqResults.SD-1_0': 'pass', 'seqResults.v7': 'fail', 'seqResults.v2': 'pass' });
  assert.ok(out.candidates.every(c => c.confidence === 'medium' && c.evidence[0].source === 'checklist'));
  assert.deepEqual(out.unmapped.map(u => u.row), [8]);
  assert.ok(out.openItems.some(o => /"maybe"/.test(o.reason)));
  assert.equal(out.deficiencies.length, 1);
  assert.equal(out.deficiencies[0].deficiency.loc, 'Stair B, Level 7');
});

test('XLSX checklist gives the same result as the CSV', () => {
  const dir = tmpDir();
  const rows = readTable(fixture('checklist.csv')).sheets[0].rows;
  const file = path.join(dir, 'checklist.xlsx');
  fs.writeFileSync(file, makeXlsx(rows));
  const t = readTable(file);
  assert.equal(t.sheets[0].name, 'Fans & Dampers');
  assert.deepEqual(t.sheets[0].rows.map(r => r.map(String)), rows.map(r => { const x = r.map(String); while (x.length && x[x.length - 1] === '') x.pop(); return x; }));
  const a = extractChecklist(fixture('checklist.csv'), vocab), b = extractChecklist(file, vocab);
  assert.deepEqual(b.candidates.map(c => [c.path, c.value]), a.candidates.map(c => [c.path, c.value]));
});

test('photo captions are read one at a time and capped at medium', () => {
  const idx = readPhotoIndex(fixture('photos.csv'));
  assert.equal(idx.photos.length, 4);
  const out = extractPhotos(idx, vocab);
  const cl = out.candidates.find(c => c.path === 'floors.Stair B_12.cl');
  assert.equal(cl.value, 'fail');
  assert.equal(cl.confidence, 'medium');
  assert.equal(cl.evidence[0].photo, 'IMG_0102.jpg');
  assert.ok(out.candidates.every(c => c.confidence !== 'high'));
  assert.ok(out.deficiencies.some(d => d.deficiency.desc === 'Zone 12 EF-12 fan failed to start'));
});

test('photo index as JSON', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'photos.json');
  fs.writeFileSync(file, JSON.stringify([{ file: 'a.jpg', caption: 'Level 4 stair A 0.07 in wc' }]));
  const out = extractPhotos(readPhotoIndex(file), vocab);
  assert.deepEqual(out.candidates.map(c => [c.path, c.value, c.confidence]), [['floors.Stair A_4.dp', '0.07', 'medium']]);
});

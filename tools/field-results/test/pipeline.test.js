'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { run, writeOutputs } = require('../lib/pipeline');
const { normalizeSpokenNumbers, parseQuantities, parseBareNumbers } = require('../lib/units');
const { fixture, tmpDir } = require('./helpers');

const CLI = path.join(__dirname, '..', 'cli.js');
const hash = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

// Copy fixtures to a scratch dir so the test can prove the inputs are never written.
function scratch() {
  const dir = tmpDir();
  for (const f of ['pretest.json', 'transcript-pocket.txt', 'transcript-export.json', 'checklist.csv', 'photos.csv']) fs.copyFileSync(fixture(f), path.join(dir, f));
  const p = f => path.join(dir, f);
  return { dir, p, opts: { pretest: p('pretest.json'), transcripts: [p('transcript-pocket.txt'), p('transcript-export.json')], checklist: p('checklist.csv'), photos: p('photos.csv') } };
}

test('full fixture: expected patch, open items and validation', async () => {
  const { opts } = scratch();
  const r = await run(opts);
  const P = r.proposal.patch;
  assert.ok(r.validation.ok, JSON.stringify(r.validation));
  assert.deepEqual(P.seqResults, { 'SPF-1_0': 'pass', 'SPF-1_1': 'pass', 'SPF-1_2': 'pass', 'SPF-1_3': 'pass', 'EPF-1_0': 'pass', 'SEF-1_3': 'pass', 'SD-1_1': 'pass', 'SD-1_0': 'pass', v7: 'fail', v2: 'pass' });
  assert.deepEqual(P.matrixResults, { '8_fan_SPF-1': 'pass', '8_fan_SPF-2': 'pass', '8_corr_dampers': 'fail' });
  assert.deepEqual(P.zoneResults, { '11_fans': 'pass', '11_dampers': 'pass', '11_isolate': 'pass', '12_fans': 'fail' });
  assert.deepEqual(P.floors, {
    'Stair A_12': { dp: '0.08', brk: '22', swg: '12', cl: 'pass' },
    'Stair B_12': { dp: '0.04', brk: '31', swg: '14', cl: 'fail' },
    'Stair A_11': { dp: '0.07' },
    'EL_EL-1_11': { dp: '0.06' },
    'Stair A_3': { brk: '18', swg: '10', cl: 'pass' },
  });
  const open = r.proposal.openItems.map(o => o.path || o.label);
  assert.ok(open.includes('seqResults.SPF-2_3'), 'transcript fail vs checklist pass is left empty');
  assert.ok(open.includes('floors.Stair A_3.dp'), 'two transcripts disagree on this reading');
  assert.ok(r.proposal.openItems.some(o => /question/.test(o.reason)));
  assert.ok(r.proposal.openItems.some(o => /Level 14/.test(o.reason)));
  assert.ok(r.proposal.openItems.some(o => /break.*swing/.test(o.reason)));
  assert.equal(P['SPF-2_0'], undefined);
  assert.ok(r.proposal.unchanged.some(u => u.path === 'seqResults.SPF-2_0'), 'value already in the pre-test JSON is not re-proposed');
  assert.deepEqual(r.proposal.notTested.map(n => n.path), ['seqResults.EPF-1_2']);
  const descs = P.deficiencies.map(d => `${d.sev}|${d.loc}|${d.desc}`);
  assert.ok(descs.includes('Deficiency|Stair B, Level 12|Measured pressure difference of 0.04 in. w.g. at Stair B, Level 12 is below the 0.05 in. w.g. minimum.'));
  assert.ok(descs.includes('Deficiency|Stair B, Level 12|Door at Stair B, Level 12 did not close and latch.'));
  assert.ok(descs.includes('Observation|Zone 12|Zone 12 exhaust grille partially blocked by storage.'));
  assert.ok(descs.includes('Deficiency|Stair B, Level 7|Stair B level 7 gasket torn at latch side'));
  assert.ok(P.deficiencies.every(d => d.action === '' && Array.isArray(d.photos)));
  const gasket = r.proposal.deficiencyEvidence.find(d => P.deficiencies.find(x => x.id === d.id).desc.startsWith('Stair B level 7'));
  assert.deepEqual(gasket.photos.map(p => p.file), ['IMG_0104.jpg']);
  const airflow = r.proposal.measurements.filter(m => m.kind === 'airflow').map(m => [m.tag, m.value, m.design]);
  assert.deepEqual(airflow, [['SPF-1', 12500, '12000'], ['SEF-1', 12500, '15000']]);
  assert.equal(r.proposal._proposal.llm.enabled, false);
});

test('no guessed values: every filled value is backed by evidence that contains it', async () => {
  const { opts } = scratch();
  const r = await run(opts);
  for (const e of r.proposal.evidence) {
    assert.ok(['high', 'medium'].includes(e.confidence), e.path);
    assert.ok(e.evidence.length && e.evidence.every(x => x.excerpt && x.file), e.path);
    if (/\.(dp|brk|swg)$/.test(e.path)) {
      const nums = e.evidence.flatMap(x => { const t = normalizeSpokenNumbers(x.excerpt); return [...parseQuantities(t).map(q => q.value), ...parseBareNumbers(t).map(b => b.value)]; });
      assert.ok(nums.includes(+e.value), `${e.path}=${e.value} not in its excerpt`);
    }
  }
  for (const d of r.proposal.deficiencyEvidence) assert.ok(d.evidence.length, d.id);
});

test('every proposed value and open item appears in the review table', async () => {
  const { opts } = scratch();
  const r = await run(opts);
  for (const e of r.proposal.evidence) assert.ok(r.review.includes('`' + e.path + '`'), e.path);
  for (const d of r.proposal.patch.deficiencies) assert.ok(r.review.includes(d.id), d.id);
  assert.match(r.review, /## Open items/);
  assert.match(r.review, /Validation against the app schema \| PASS/);
  assert.match(r.review, /Language-model step \| off/);
});

test('CLI writes three new files and never touches the inputs', () => {
  const { dir, p, opts } = scratch();
  const before = Object.fromEntries(fs.readdirSync(dir).map(f => [f, hash(p(f))]));
  const args = [CLI, '--pretest', opts.pretest, '-t', opts.transcripts[0], '-t', opts.transcripts[1], '--checklist', opts.checklist, '--photos', opts.photos];
  const res = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr + res.stdout);
  for (const [f, h] of Object.entries(before)) assert.equal(hash(p(f)), h, `${f} changed`);
  const outDir = path.join(dir, 'pretest.field-results');
  assert.deepEqual(fs.readdirSync(outDir).sort(), ['pretest.field-results-review.md', 'pretest.proposed-patch.json', 'pretest.proposed-post-test.json']);
  const merged = JSON.parse(fs.readFileSync(path.join(outDir, 'pretest.proposed-post-test.json'), 'utf8'));
  const src = JSON.parse(fs.readFileSync(opts.pretest, 'utf8'));
  assert.equal(merged.id, src.id);
  assert.equal(merged.seqResults['SPF-2_0'], 'pass');
  assert.equal(merged.floors['Stair A_12'].dp, '0.08');
  assert.deepEqual(merged.equipment, src.equipment);
  const again = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already exists.*--force/);
  assert.equal(spawnSync(process.execPath, [...args, '--force'], { encoding: 'utf8' }).status, 0);
});

test('refuses to write over an input', async () => {
  const { dir, p, opts } = scratch();
  fs.copyFileSync(p('pretest.json'), p('x.proposed-patch.json'));
  const o = { ...opts, pretest: p('x.proposed-patch.json').replace('.proposed-patch', ''), outDir: dir };
  fs.copyFileSync(p('pretest.json'), o.pretest);
  const r = await run(o);
  assert.throws(() => writeOutputs({ ...o, checklist: p('x.proposed-patch.json'), force: true }, r), /Refusing to write/);
});

test('CLI usage errors', () => {
  const r = spawnSync(process.execPath, [CLI, '--pretest', fixture('pretest.json')], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /at least one --transcript/);
  assert.equal(spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' }).status, 0);
});

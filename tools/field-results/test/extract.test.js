'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { loadAppModel } = require('../lib/appModel');
const { buildVocabulary } = require('../lib/matcher');
const { extractSegments, resultOf } = require('../lib/extract');
const { parseTextTranscript } = require('../lib/transcript');
const { fixture } = require('./helpers');

const model = loadAppModel();
const base = JSON.parse(fs.readFileSync(fixture('pretest.json'), 'utf8'));
const vocabFor = patch => { const p = model.normalizeProject({ ...JSON.parse(JSON.stringify(base)), ...patch }); return buildVocabulary(p, model); };
const vocab = vocabFor({});
const run = (lines, v = vocab) => extractSegments(parseTextTranscript(lines.map((l, i) => `[00:${String(10 + i).padStart(2, '0')}:00] Speaker 1: ${l}`).join('\n'), 't.txt'), v);
const cands = out => Object.fromEntries(out.candidates.map(c => [c.path, [c.value, c.confidence]]));

test('result words', () => {
  assert.equal(resultOf('pass').value, 'pass');
  assert.equal(resultOf('Passed.').value, 'pass');
  assert.equal(resultOf('it did not pass').value, 'fail');
  assert.equal(resultOf('failed to start. Fail.').value, 'fail');
  assert.equal(resultOf('N/A for this one').value, 'na');
  assert.equal(resultOf('not tested').value, null);
  assert.ok(resultOf('not tested').notTested);
  assert.ok(resultOf('pass then fail').ambiguous);
  assert.equal(resultOf('fan running').any, false);
});

test('device test: tag + test + result in one sentence is high confidence', () => {
  assert.deepEqual(cands(run(['SPF-1 manual override on, pass.'])), { 'seqResults.SPF-1_0': ['pass', 'high'] });
});

test('device test: result in the next sentence is medium, with both sentences as evidence', () => {
  const out = run(['SEF-1 duct detector activation.', 'Fan shut down. Pass.']);
  assert.deepEqual(cands(out), { 'seqResults.SEF-1_3': ['pass', 'medium'] });
  assert.equal(out.candidates[0].evidence.length, 2);
});

test('device result without a test and no floor in alarm is an open item, not a guess', () => {
  const out = run(['SPF-1 pass.']);
  assert.equal(out.candidates.length, 0);
  assert.match(out.openItems[0].reason, /not which test/);
});

test('more than one device with one result is an open item', () => {
  const out = run(['SPF-1 and SPF-2 override on, pass.']);
  assert.equal(out.candidates.length, 0);
  assert.equal(out.openItems.length, 1);
});

test('ambiguous test wording is an open item', () => {
  const out = run(['SD-1 opened, then back to auto, pass.']);
  assert.equal(out.candidates.length, 0);
  assert.match(out.openItems[0].reason, /more than one test/);
});

test('pressure readings: stated shaft and level are high; carried level is medium', () => {
  const out = run(['Level 12, stair A, 0.08 in wc, break 22 lbf, swing 12 lbf, closed and latched.', 'Stair B 0.06 in wc.']);
  assert.deepEqual(cands(out), {
    'floors.Stair A_12.dp': ['0.08', 'high'], 'floors.Stair A_12.brk': ['22', 'high'], 'floors.Stair A_12.swg': ['12', 'high'], 'floors.Stair A_12.cl': ['pass', 'high'],
    'floors.Stair B_12.dp': ['0.06', 'medium'],
  });
});

test('carried context expires after five minutes', () => {
  const segs = parseTextTranscript('[00:10:00] A: Level 12.\n[00:16:00] A: Stair A 0.07 in wc.', 't.txt');
  const out = extractSegments(segs, vocab);
  assert.equal(out.candidates.length, 0);
  assert.match(out.openItems[0].reason, /No level named/);
});

test('door force without break or swing is not assigned', () => {
  const out = run(['Level 11, stair A, door opening force 25 lbf.']);
  assert.equal(out.candidates.length, 0);
  assert.match(out.openItems[0].reason, /break.*swing/);
});

test('unitless numbers only after a pressure or force word and in range', () => {
  assert.deepEqual(cands(run(['Level 5 stair A delta p point zero six, break 20, swing 11.'])), {
    'floors.Stair A_5.dp': ['0.06', 'medium'], 'floors.Stair A_5.brk': ['20', 'medium'], 'floors.Stair A_5.swg': ['11', 'medium'],
  });
  assert.deepEqual(cands(run(['Level 5 stair A 6.'])), {});
});

test('questions never become values', () => {
  const out = run(['Stair B level 11, is that 0.05 in wc?']);
  assert.equal(out.candidates.length, 0);
  assert.match(out.openItems[0].reason, /question/);
});

test('levels outside the pre-test floor range are rejected', () => {
  const out = run(['Level 14 stair A 0.06 in wc.']);
  assert.equal(out.candidates.length, 0);
  assert.match(out.openItems[0].reason, /not in the building's floor range/);
});

test('two different pressures in one sentence are not assigned', () => {
  const out = run(['Level 4 stair A 0.05 in wc, sorry, 0.06 in wc.']);
  assert.ok(!out.candidates.some(c => c.field === 'dp'));
  assert.ok(out.openItems.some(o => /More than one pressure/.test(o.reason)));
});

test('vestibule buildings need "stair door" or "vestibule door"', () => {
  const v = vocabFor({ systems: { ...base.systems, vest: true } });
  assert.deepEqual(cands(run(['Level 6 stair A vestibule door 0.07 in wc.'], v)), { 'floors.VEST_Stair_A_6.dp': ['0.07', 'high'] });
  assert.deepEqual(cands(run(['Level 6 stair A stair door 0.09 in wc.'], v)), { 'floors.Stair A_6.dp': ['0.09', 'high'] });
  const out = run(['Level 6 stair A 0.07 in wc.'], v);
  assert.equal(out.candidates.length, 0);
  assert.match(out.openItems[0].reason, /vestibule/);
});

test('elevator hoistway and corridor readings', () => {
  assert.deepEqual(cands(run(['Elevator 1, level 11, 0.06 inches w.c.'])), { 'floors.EL_EL-1_11.dp': ['0.06', 'high'] });
  assert.deepEqual(cands(run(['Corridor level 9 0.03 in wc.'])), { 'floors.CORR_9.dp': ['0.03', 'high'] });
});

test('floor matrix: results after a smoke detector activation, cleared by reset', () => {
  const out = run(['Smoke detector on level 8.', 'SPF-1 pass.', 'Corridor dampers failed.', 'Resetting the panel.', 'SPF-2 pass.']);
  assert.deepEqual(cands(out), { 'matrixResults.8_fan_SPF-1': ['pass', 'medium'], 'matrixResults.8_corr_dampers': ['fail', 'medium'] });
  assert.ok(out.openItems.some(o => o.label === 'SPF-2'), 'after reset SPF-2 pass has no floor or test');
});

test('floor matrix: "all pass" fills the whole row at medium', () => {
  const out = run(['Alarm on level 10, all columns pass.']);
  assert.equal(out.candidates.length, vocab.matrixCols.length);
  assert.ok(out.candidates.every(c => c.map === 'matrixResults' && c.key.startsWith('10_') && c.confidence === 'medium'));
});

test('zones: one column per statement; "all" fills three; no column is an open item', () => {
  assert.deepEqual(cands(run(['Zone 11 purge, fans started, pass.'])), { 'zoneResults.11_fans': ['pass', 'high'] });
  assert.deepEqual(cands(run(['Zone 11 adjacent zones isolated, pass.'])), { 'zoneResults.11_isolate': ['pass', 'high'] });
  assert.equal(run(['Zone 12 all three pass.']).candidates.length, 3);
  const out = run(['Zone 12 pass.']);
  assert.equal(out.candidates.length, 0);
  assert.match(out.openItems[0].reason, /which column/);
});

test('"not tested" is recorded as a status, not as a value', () => {
  const out = run(['EPF-1 disconnect not tested, locked out.']);
  assert.equal(out.candidates.length, 0);
  assert.equal(out.notTested[0].path, 'seqResults.EPF-1_2');
});

test('airflow and equipment state go to measurements, not the patch', () => {
  const out = run(['SPF-1 measured airflow 12,500 CFM.', 'SEF-1 is running.']);
  assert.equal(out.candidates.length, 0);
  assert.deepEqual(out.measurements.map(m => [m.kind, m.tag, m.value]), [['airflow', 'SPF-1', 12500], ['state', 'SEF-1', 'running']]);
  assert.equal(out.measurements[0].design, '12000');
});

test('spoken deficiencies keep the wording and take the location from the sentence or context', () => {
  const out = run(['Level 7, stair B.', 'Write that up as a deficiency, the door gasket is torn.', 'Observation: Zone 12 exhaust grille blocked by storage.']);
  assert.equal(out.deficiencies.length, 2);
  assert.deepEqual(out.deficiencies[0].deficiency, { loc: 'Stair B, Level 7', sev: 'Deficiency', desc: 'The door gasket is torn.', action: '' });
  assert.equal(out.deficiencies[0].confidence, 'medium');
  assert.deepEqual([out.deficiencies[1].deficiency.sev, out.deficiencies[1].deficiency.loc, out.deficiencies[1].confidence], ['Observation', 'Zone 12', 'high']);
});

test('Pa and newtons are converted and the conversion is noted', () => {
  const out = run(['Level 4 stair A 15 Pa.']);
  assert.equal(out.candidates[0].value, '0.06');
  assert.match(out.candidates[0].note, /15 Pa/);
});

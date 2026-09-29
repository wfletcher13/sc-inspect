'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { loadAppModel } = require('../lib/appModel');
const { validatePatch, validateMerged } = require('../lib/validate');
const { applyPatch } = require('../lib/pipeline');
const { fixture } = require('./helpers');

const model = loadAppModel();
const raw = JSON.parse(fs.readFileSync(fixture('pretest.json'), 'utf8'));
const project = model.normalizeProject(JSON.parse(JSON.stringify(raw)));
const empty = () => ({ seqResults: {}, matrixResults: {}, zoneResults: {}, floors: {}, deficiencies: [] });

test('a well-formed patch passes', () => {
  const patch = { ...empty(), seqResults: { 'SPF-1_0': 'pass', v7: 'fail' }, matrixResults: { '8_fan_SPF-1': 'pass' }, zoneResults: { '11_fans': 'na' },
    floors: { 'Stair A_12': { dp: '0.08', cl: 'pass' }, 'EL_EL-1_11': { dp: '0.06' } }, deficiencies: [{ id: 'dfr1', loc: 'Stair A', sev: 'Deficiency', desc: 'x', action: '', photos: [] }] };
  assert.deepEqual(validatePatch(project, patch, model), []);
});

test('keys the app would never generate are rejected', () => {
  const patch = { ...empty(), seqResults: { 'SPF-9_0': 'pass', 'SPF-1_7': 'pass' }, matrixResults: { '99_fan_SPF-1': 'pass', '8_fan_EF-11': 'pass' }, zoneResults: { '40_fans': 'pass' }, floors: { 'Stair C_5': { dp: '0.1' }, 'Stair A_14': { dp: '0.1' } } };
  const paths = validatePatch(project, patch, model).map(e => e.path).sort();
  assert.deepEqual(paths, ['floors.Stair A_14', 'floors.Stair C_5', 'matrixResults.8_fan_EF-11', 'matrixResults.99_fan_SPF-1', 'seqResults.SPF-1_7', 'seqResults.SPF-9_0', 'zoneResults.40_fans']);
});

test('values outside the app domains are rejected', () => {
  const patch = { ...empty(), seqResults: { 'SPF-1_0': 'ok' }, floors: { 'Stair A_12': { dp: 'low', brk: '22', xx: '1' }, 'EL_EL-1_11': { cl: 'pass' } },
    deficiencies: [{ id: 'd1', loc: '', sev: 'Bad', desc: '', action: '', photos: [] }, { id: 'd1', loc: '', sev: 'Note', desc: 'y', action: '', photos: 'no' }] };
  const msgs = validatePatch(project, patch, model).map(e => `${e.path}: ${e.msg}`);
  assert.ok(msgs.some(m => m.startsWith('seqResults.SPF-1_0')));
  assert.ok(msgs.some(m => m.startsWith('floors.Stair A_12.dp')));
  assert.ok(msgs.some(m => m.startsWith('floors.Stair A_12.xx')));
  assert.ok(msgs.some(m => m.startsWith('floors.EL_EL-1_11.cl') && /no close\/latch/.test(m)));
  assert.ok(msgs.some(m => m.startsWith('deficiencies[0].sev')));
  assert.ok(msgs.some(m => m.startsWith('deficiencies[0].desc')));
  assert.ok(msgs.some(m => m.startsWith('deficiencies[1].id') && /duplicate/.test(m)));
  assert.ok(msgs.some(m => m.startsWith('deficiencies[1].photos')));
});

test('merged record survives normalizeProject and keeps existing values', () => {
  const patch = { ...empty(), seqResults: { 'SPF-1_0': 'pass' }, floors: { 'Stair A_12': { dp: '0.08' } }, deficiencies: [{ id: 'dfr1', loc: 'L1', sev: 'Note', desc: 'z', action: '', photos: [] }] };
  const merged = applyPatch(raw, patch, { generatedAt: '2026-01-01T00:00:00Z', by: 't' });
  const r = validateMerged(merged.project, patch, model);
  assert.deepEqual(r.errors, []);
  assert.equal(merged.project.seqResults['SPF-2_0'], 'pass');
  assert.deepEqual(merged.project.floors['Stair A_12'], { dp: '0.08', brk: '', swg: '', cl: '' });
  assert.equal(raw.seqResults['SPF-1_0'], undefined, 'source object not mutated');
});

test('wrapped exports ({ project: ... }) are patched in place of the inner record', () => {
  const merged = applyPatch({ project: raw }, { ...empty(), seqResults: { 'SPF-1_0': 'pass' } }, { generatedAt: 'x', by: 'y' });
  assert.equal(merged.doc.project.seqResults['SPF-1_0'], 'pass');
});

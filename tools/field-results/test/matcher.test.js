'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { loadAppModel } = require('../lib/appModel');
const { buildVocabulary, findMentions, matchTests, tagRegex, TEST_PATTERNS, matchTableItem } = require('../lib/matcher');
const { fixture } = require('./helpers');

const model = loadAppModel();
const project = model.normalizeProject(JSON.parse(fs.readFileSync(fixture('pretest.json'), 'utf8')));
const vocab = buildVocabulary(project, model);
const tagsIn = s => findMentions(s, vocab).tags.map(t => t.tag);

test('app model loads from index.html and derives this building', () => {
  assert.equal(model.SCHEMA_VERSION, 2);
  assert.deepEqual(vocab.floors, ['12', '11', '10', '9', '8', '7', '6', '5', '4', '3', '2', '1', 'Lobby']);
  assert.deepEqual(vocab.blocks.map(b => b.prefix), ['Stair A', 'Stair B', 'EL_EL-1', 'CORR']);
  assert.deepEqual(vocab.zones.map(z => z.zone), ['11', '12']);
  assert.ok(vocab.matrixCols.some(c => c.key === 'fan_SPF-1'));
  assert.ok(!vocab.matrixCols.some(c => c.key === 'fan_EF-11'), 'zone fans are not matrix columns');
});

test('equipment tags: spelling variants, no partial matches', () => {
  assert.deepEqual(tagsIn('SPF-1 pass'), ['SPF-1']);
  assert.deepEqual(tagsIn('spf 1 pass'), ['SPF-1']);
  assert.deepEqual(tagsIn('S.P.F. 1 pass'), ['SPF-1']);
  assert.deepEqual(tagsIn('SPF-01 pass'), ['SPF-1']);
  assert.deepEqual(tagsIn('SPF-10 pass'), []);
  assert.deepEqual(tagsIn('XSPF-1 pass'), []);
  assert.deepEqual(tagsIn('EF-11 and SD-11'), ['EF-11', 'SD-11']);
  assert.ok(tagRegex('SEF-2A').test('sef 2a'));
});

test('levels: level/floor words, ordinals, lobby; out-of-range kept but flagged by caller', () => {
  const f = s => findMentions(s, vocab).floors.map(x => x.label);
  assert.deepEqual(f('Level 12, stair A'), ['12']);
  assert.deepEqual(f('on the 3rd floor'), ['3']);
  assert.deepEqual(f('floor number 7'), ['7']);
  assert.deepEqual(f('in the lobby'), ['Lobby']);
  assert.deepEqual(f('Level 14'), ['14']);
  assert.ok(!vocab.floorSet.has('14'));
  assert.deepEqual(f('0.05 in wc'), []);
});

test('alarm floor needs an initiation cue', () => {
  assert.equal(findMentions('Smoke detector on level 8, panel in alarm.', vocab).alarmFloor.label, '8');
  assert.equal(findMentions('alarm on 9', vocab).alarmFloor.label, '9');
  assert.equal(findMentions('Level 8 stair A 0.06 in wc', vocab).alarmFloor, null);
});

test('shafts, hoistways, zones', () => {
  const m = findMentions('Stair B and stairwell A', vocab);
  assert.deepEqual(m.stairs.map(s => s.name).sort(), ['Stair A', 'Stair B']);
  assert.deepEqual(findMentions('Elevator 1, level 11', vocab).hoistways.map(h => h.name), ['EL-1']);
  assert.deepEqual(findMentions('EL-1 lobby door', vocab).hoistways.map(h => h.name), ['EL-1']);
  assert.deepEqual(findMentions('Zone 11 purge', vocab).zones.map(z => [z.zone, z.valid]), [['11', true]]);
  assert.deepEqual(findMentions('Zone 11 adjacent zones isolated', vocab).zones.map(z => z.zone), ['11']);
  assert.deepEqual(findMentions('Zone 40', vocab).zones.map(z => z.valid), [false]);
});

test('every per-device test the app generates has a phrase pattern', () => {
  const full = { tag: 'X-1', type: 'Smoke exhaust fan', hasVFD: true, hasBelt: true, hasDuctDet: true };
  const damper = { tag: 'D-1', type: 'Smoke control damper' };
  for (const e of [full, damper]) for (const t of model.getSeqTests(e)) assert.ok(TEST_PATTERNS[`${t.event}|${t.action}`], `missing pattern for ${t.event}|${t.action}`);
});

test('test phrases map to exactly one test, or to several when ambiguous', () => {
  const spf1 = vocab.tags.find(t => t.tag === 'SPF-1');
  const sef1 = vocab.tags.find(t => t.tag === 'SEF-1');
  const sd1 = vocab.tags.find(t => t.tag === 'SD-1');
  const act = (t, s) => matchTests(t, s).map(i => t.tests[i].action);
  assert.deepEqual(act(spf1, 'manual override on, pass'), ['Manual override ON']);
  assert.deepEqual(act(spf1, 'override off, back to auto'), ['Manual override OFF']);
  assert.deepEqual(act(spf1, 'disconnect opened'), ['Disconnect switch']);
  assert.deepEqual(act(spf1, 'VFD power loss'), ['VFD power loss']);
  assert.deepEqual(act(sef1, 'duct detector activation, fan shut down'), ['Fan shutdown']);
  assert.deepEqual(act(sef1, 'duct detector override on'), ['Manual override ON']);
  assert.equal(matchTests(sef1, 'duct detector override on')[0], 4);
  assert.deepEqual(act(sd1, 'switch to closed'), ['Switch to CLOSED']);
  assert.equal(matchTests(sd1, 'opened then returned to auto').length, 2);
  assert.deepEqual(act(spf1, 'fan running'), []);
});

test('checklist wording maps to Table 1 items only when clear', () => {
  assert.equal(matchTableItem(vocab, 'Smoke gasket seals at door frames').item.id, 'v7');
  assert.equal(matchTableItem(vocab, 'Fire stopping at penetrations').item.id, 'v2');
  assert.equal(matchTableItem(vocab, 'Controller firmware version').item, null);
});

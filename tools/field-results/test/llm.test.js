'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadAppModel } = require('../lib/appModel');
const { buildVocabulary } = require('../lib/matcher');
const { verifySuggestions, adapterFromSpec, targetsFor } = require('../lib/llm');
const { parseTextTranscript } = require('../lib/transcript');
const { run } = require('../lib/pipeline');
const { fixture, tmpDir } = require('./helpers');

const model = loadAppModel();
const project = model.normalizeProject(JSON.parse(fs.readFileSync(fixture('pretest.json'), 'utf8')));
const vocab = buildVocabulary(project, model);
const segs = parseTextTranscript([
  '[00:01:00] Speaker 1: So on SPF-2, with the switch flipped over to off, it spun down and came back to auto, that one is good, passes.',
  '[00:02:00] Speaker 1: Over at twelve on the B stair I got about point zero six on the gauge.',
  '[00:03:00] Speaker 1: That closer on the B stair door at twelve is shot, somebody needs to replace it.',
].join('\n'), 't.txt');

test('off by default, and unknown specs are refused', () => {
  assert.equal(adapterFromSpec(undefined), null);
  assert.equal(adapterFromSpec('off'), null);
  assert.throws(() => adapterFromSpec('gpt'), /Unknown --llm/);
});

test('verified suggestions become medium candidates', () => {
  const out = verifySuggestions([
    { target: 'seqResults.SPF-2_1', value: 'pass', segment: { file: 't.txt', index: 1 }, excerpt: 'switch flipped over to off, it spun down and came back to auto, that one is good, passes' },
    { target: 'floors.Stair B_12.dp', value: '0.06', segment: { file: 't.txt', index: 2 }, excerpt: 'point zero six on the gauge' },
    { target: 'deficiency', sev: 'Deficiency', loc: 'Stair B, Level 12', segment: { file: 't.txt', index: 3 }, excerpt: 'That closer on the B stair door at twelve is shot' },
  ], segs, vocab, 'fake');
  assert.deepEqual(out.candidates.map(c => [c.path, c.value, c.confidence]), [['seqResults.SPF-2_1', 'pass', 'medium'], ['floors.Stair B_12.dp', '0.06', 'medium']]);
  assert.ok(out.candidates.every(c => c.method.startsWith('llm:fake')));
  assert.equal(out.deficiencies.length, 1);
  assert.equal(out.deficiencies[0].deficiency.desc, 'That closer on the B stair door at twelve is shot');
});

test('unverifiable suggestions are rejected into open items', () => {
  const out = verifySuggestions([
    { target: 'seqResults.SPF-2_1', value: 'pass', segment: { file: 't.txt', index: 1 }, excerpt: 'SPF-2 passed the override off test' },
    { target: 'floors.Stair B_12.dp', value: '0.08', segment: { file: 't.txt', index: 2 }, excerpt: 'point zero six on the gauge' },
    { target: 'seqResults.SPF-9_0', value: 'pass', segment: { file: 't.txt', index: 1 }, excerpt: 'passes' },
    { target: 'seqResults.SPF-2_2', value: 'fail', segment: { file: 't.txt', index: 1 }, excerpt: 'passes' },
    { target: 'floors.Stair B_12.dp', value: '0.06', segment: { file: 't.txt', index: 9 }, excerpt: 'x' },
    { target: 'floors.Stair A_12.dp', value: '0.06', segment: { file: 't.txt', index: 2 }, excerpt: 'point zero six on the gauge' },
    { target: 'floors.Stair B_11.dp', value: '0.06', segment: { file: 't.txt', index: 2 }, excerpt: 'point zero six on the gauge' },
    { target: 'seqResults.SPF-1_1', value: 'pass', segment: { file: 't.txt', index: 1 }, excerpt: 'passes' },
  ], segs, vocab, 'fake');
  assert.equal(out.candidates.length, 0);
  const where = 'the device, zone, shaft or level in the target is not named in the quoted segment or the three before it';
  assert.deepEqual(out.openItems.map(o => o.reason.replace(/^Not used: /, '')), [
    'quoted excerpt is not in the transcript segment',
    'value 0.08 not found as a number in the quote',
    'not a test key of this building',
    'quote does not contain an unambiguous "fail" result word',
    'segment reference does not exist',
    where, where, where,
  ]);
});

test('the request sent to an adapter lists only this building\'s targets', () => {
  const t = targetsFor(vocab);
  assert.ok(t.seqResults.some(x => x.target === 'seqResults.SPF-1_0'));
  assert.deepEqual(t.floors.prefixes.map(p => p.prefix), ['Stair A', 'Stair B', 'EL_EL-1', 'CORR']);
});

test('pipeline with a fake adapter: verified values merge, disagreements become open items', async () => {
  const dir = tmpDir();
  const tpath = path.join(dir, 't.txt');
  fs.writeFileSync(tpath, '[00:01:00] Speaker 1: Level 12 stair A 0.08 in wc.\n[00:02:00] Speaker 1: Over on the B stair at twelve, point zero six on the gauge.\n');
  const fake = { name: 'fake', async propose(req) {
    assert.ok(req.segments.length === 2 && req.targets);
    return [
      { target: 'floors.Stair B_12.dp', value: '0.06', segment: { file: 't.txt', index: 2 }, excerpt: 'point zero six on the gauge' },
      { target: 'floors.Stair A_12.dp', value: '0.08', segment: { file: 't.txt', index: 1 }, excerpt: 'Level 12 stair A 0.08 in wc' },
    ];
  } };
  const r = await run({ pretest: fixture('pretest.json'), transcripts: [tpath], llm: fake });
  assert.equal(r.proposal._proposal.llm.enabled, true);
  assert.equal(r.proposal.patch.floors['Stair B_12'].dp, '0.06');
  const a = r.proposal.evidence.find(e => e.path === 'floors.Stair A_12.dp');
  assert.equal(a.confidence, 'high');
  assert.equal(a.corroborated, true);
  assert.ok(r.validation.ok);

  const liar = { name: 'liar', async propose() { return [{ target: 'floors.Stair A_12.dp', value: '0.09', segment: { file: 't.txt', index: 1 }, excerpt: 'Level 12 stair A 0.08 in wc' }]; } };
  const r2 = await run({ pretest: fixture('pretest.json'), transcripts: [tpath], llm: liar });
  assert.equal(r2.proposal.patch.floors['Stair A_12'].dp, '0.08', 'rule value kept; the bad suggestion is rejected');
  assert.ok(r2.proposal.openItems.some(o => /^LLM suggestion/.test(o.label)));
});

test('a failing adapter does not stop the rule-based result', async () => {
  const boom = { name: 'boom', async propose() { throw new Error('network down'); } };
  const r = await run({ pretest: fixture('pretest.json'), transcripts: [fixture('transcript-pocket.txt')], llm: boom });
  assert.equal(r.proposal._proposal.llm.error, 'network down');
  assert.ok(r.proposal.evidence.length > 10);
  assert.ok(r.validation.ok);
});

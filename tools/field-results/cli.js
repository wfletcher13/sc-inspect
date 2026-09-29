#!/usr/bin/env node
'use strict';
// Field results -> proposed SC Inspect post-test JSON. See README.md in this folder.
const { run, writeOutputs } = require('./lib/pipeline');

const USAGE = `Usage:
  node tools/field-results/cli.js --pretest <project.json> --transcript <file> [--transcript <file> ...]
       [--checklist <checklist.csv|xlsx>] [--photos <photo-index.csv|xlsx|json>]
       [--out-dir <dir>] [--force] [--llm off|anthropic|command:<shell command>] [--index <index.html>]

Writes three files (never the inputs):
  <name>.proposed-patch.json      new values only, with evidence, open items and validation
  <name>.proposed-post-test.json  the pre-test record with the patch applied (importable as a new building)
  <name>.field-results-review.md  review table: every value with source, excerpt and confidence
Exit code 0 = written and valid, 2 = written but failed validation, 1 = error.`;

function parseArgs(argv) {
  const o = { transcripts: [], llm: 'off' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v == null) throw new Error(`${a} needs a value`); return v; };
    if (a === '--pretest') o.pretest = next();
    else if (a === '--transcript' || a === '-t') o.transcripts.push(next());
    else if (a === '--checklist') o.checklist = next();
    else if (a === '--photos') o.photos = next();
    else if (a === '--out-dir' || a === '-o') o.outDir = next();
    else if (a === '--llm') o.llm = next();
    else if (a === '--index') o.indexPath = next();
    else if (a === '--force') o.force = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`Unknown argument ${a}`);
  }
  return o;
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message + '\n\n' + USAGE); process.exit(1); }
  if (opts.help) { console.log(USAGE); return; }
  if (!opts.pretest || !opts.transcripts.length) { console.error('--pretest and at least one --transcript are required.\n\n' + USAGE); process.exit(1); }
  try {
    const result = await run(opts);
    const out = writeOutputs(opts, result);
    const p = result.proposal;
    console.log(`Proposed ${p.evidence.length} values, ${p.patch.deficiencies.length} deficiencies, ${p.openItems.length} open items.`);
    console.log(`Validation: ${result.validation.ok ? 'PASS' : 'FAIL'}${p._proposal.llm.enabled ? ` | LLM: ${p._proposal.llm.adapter}${p._proposal.llm.error ? ' (failed: ' + p._proposal.llm.error + ')' : ''}` : ' | LLM: off'}`);
    console.log(`Review:   ${out.review}\nPatch:    ${out.patch}\nMerged:   ${out.merged}`);
    process.exit(result.validation.ok ? 0 : 2);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { parseArgs };

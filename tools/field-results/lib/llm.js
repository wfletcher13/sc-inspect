'use strict';
// OPTIONAL language-model step. Off unless --llm is passed. The rule-based extractor does not depend on it.
//
// An adapter is { name, propose({ segments, targets, building }) -> Promise<Suggestion[]> } where
//   Suggestion = { target, value, segment: { file, index }, excerpt, loc?, sev? }
//   target     = "seqResults.<key>" | "matrixResults.<key>" | "zoneResults.<key>" | "floors.<prefix>_<level>.<dp|brk|swg|cl>" | "deficiency"
//   excerpt    = the words in that segment the suggestion rests on, quoted verbatim
//
// Every suggestion is re-checked here by plain code before it can become a candidate: the segment must exist,
// the excerpt must appear verbatim in it, the target must be a key the app generates for this building, and
// the value must be re-derivable from the excerpt by the deterministic parsers (a result word for pass/fail/na,
// a number with the right unit for dp/brk/swg, a latch phrase for cl), and the device, zone, shaft and level the
// target points at must be named in that segment or the three before it. Anything that fails a check becomes an
// open item. Verified suggestions are rated "medium" at most and still lose to any disagreeing source.
const { spawnSync } = require('child_process');
const { normalizeSpokenNumbers, parseQuantities, parseBareNumbers, formatValue } = require('./units');
const { resultOf, evidenceOf } = require('./extract');
const { validKeys } = require('./validate');
const { findMentions, tagRegex } = require('./matcher');

const squash = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

function targetsFor(vocab) {
  const { project, model } = vocab;
  const seq = [];
  project.equipment.forEach(e => model.getSeqTests(e).forEach((t, ti) => seq.push({ target: `seqResults.${e.tag}_${ti}`, label: `${e.tag} ${t.event}: ${t.action}` })));
  return {
    results: 'pass | fail | na',
    seqResults: seq,
    zoneResults: vocab.zones.flatMap(z => ['fans', 'dampers', 'isolate'].map(k => ({ target: `zoneResults.${z.zone}_${k}`, label: `Zone ${z.zone} ${k}` }))),
    matrixResults: { pattern: 'matrixResults.<level>_<column>', levels: vocab.floors, columns: vocab.matrixCols.map(c => ({ key: c.key, label: c.label })) },
    floors: { pattern: 'floors.<prefix>_<level>.<dp|brk|swg|cl>', levels: vocab.floors, prefixes: vocab.blocks.map(b => ({ prefix: b.prefix, label: b.label, latch: b.cl })), units: 'dp in. w.g.; brk (break-away) and swg (swing) door force in lbf; cl pass|fail' },
  };
}

function parseTarget(t) {
  if (t === 'deficiency') return { map: 'deficiency' };
  const i = t.indexOf('.'); if (i < 0) return null;
  const map = t.slice(0, i), rest = t.slice(i + 1);
  if (map === 'floors') { const j = rest.lastIndexOf('.'); if (j < 0) return null; return { map, key: rest.slice(0, j), field: rest.slice(j + 1) }; }
  return { map, key: rest, field: null };
}

// The device, zone, shaft and level a suggestion points at must be named in its segment or the three before it.
function locationSupported(tg, seg, segments, vocab) {
  const win = segments.filter(s => s.file === seg.file && s.index <= seg.index && s.index >= seg.index - 3).map(s => normalizeSpokenNumbers(s.text)).join(' \n ');
  const level = l => (l === 'Lobby' ? /\blobby\b/i : new RegExp(`(?<![\\d.])${l}(?![\\d.])`)).test(win);
  const tagIn = t => { const re = tagRegex(t); return !!re && re.test(win); };
  if (tg.map === 'seqResults') { const us = tg.key.lastIndexOf('_'); return us < 0 || !vocab.tags.some(t => t.tag === tg.key.slice(0, us)) ? true : tagIn(tg.key.slice(0, us)); }
  if (tg.map === 'zoneResults') return new RegExp(`\\bzone\\s*#?\\s*${tg.key.slice(0, tg.key.lastIndexOf('_'))}(?![A-Za-z0-9])`, 'i').test(win);
  if (tg.map === 'matrixResults') {
    const us = tg.key.indexOf('_'); const fl = tg.key.slice(0, us), col = tg.key.slice(us + 1);
    return level(fl) && (col.startsWith('fan_') ? tagIn(col.slice(4)) : col === 'corr_dampers' ? /\bcorridor\b/i.test(win) : true);
  }
  if (tg.map === 'floors') {
    const us = tg.key.lastIndexOf('_'); const prefix = tg.key.slice(0, us), fl = tg.key.slice(us + 1);
    const blk = vocab.blocks.find(b => b.prefix === prefix); if (!blk || !level(fl)) return false;
    if (blk.kind === 'corr') return /\bcorridor\b/i.test(win);
    if (blk.kind === 'elev') { const d = blk.label.replace(/\D/g, ''); return tagIn(blk.label) || (/\b(?:elevator|hoistway|car)\b/i.test(win) && (!d || new RegExp(`(?<![\\d.])0*${+d}(?![\\d.])`).test(win))); }
    const distinct = blk.short.replace(/ vest$/, '').replace(/^stair(?:well|way|case)?\s*/i, '').trim();
    const shaftOk = /\bstair/i.test(win) && (!distinct || new RegExp(`(?<![A-Za-z0-9])${distinct.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`, 'i').test(win));
    const doorOk = blk.kind === 'stair' || (blk.kind === 'vest' ? /\bvest/i.test(win) : /\bstair(?:well)?\s+door\b/i.test(win));
    return shaftOk && doorOk;
  }
  return true;
}

function verifySuggestions(suggestions, segments, vocab, adapterName) {
  const K = validKeys(vocab.project, vocab.model);
  const out = { candidates: [], openItems: [], deficiencies: [] };
  const reject = (s, why, seg) => out.openItems.push({ label: `LLM suggestion: ${s && s.target} = ${s && s.value}`, reason: `Not used: ${why}`, evidence: seg ? [{ ...evidenceOf(seg, 'llm'), excerpt: seg.text }] : [] });
  for (const s of Array.isArray(suggestions) ? suggestions : []) {
    if (!s || typeof s !== 'object') continue;
    const seg = segments.find(x => s.segment && x.file === s.segment.file && x.index === +s.segment.index);
    if (!seg) { reject(s, 'segment reference does not exist'); continue; }
    if (!s.excerpt || !squash(seg.text).includes(squash(s.excerpt))) { reject(s, 'quoted excerpt is not in the transcript segment', seg); continue; }
    const tg = parseTarget(String(s.target || ''));
    if (!tg) { reject(s, 'target is not in a recognised form', seg); continue; }
    const ex = normalizeSpokenNumbers(s.excerpt);
    const ev = { ...evidenceOf(seg, 'llm'), excerpt: seg.text, quote: s.excerpt };
    const method = `llm:${adapterName} (verified: quote found in transcript, target valid, value re-parsed from quote)`;
    if (tg.map === 'deficiency') {
      const sev = ['Deficiency', 'Observation', 'Note'].includes(s.sev) ? s.sev : 'Deficiency';
      const locM = s.loc ? findMentions(String(s.loc), vocab) : null;
      const segM = findMentions(normalizeSpokenNumbers(seg.text), vocab);
      const locOk = locM && (locM.tags.some(t => segM.tags.some(u => u.tag === t.tag)) || locM.stairs.some(t => segM.stairs.some(u => u.name === t.name)) || locM.zones.some(t => segM.zones.some(u => u.zone === t.zone)));
      out.deficiencies.push({ deficiency: { loc: locOk ? String(s.loc) : '', sev, desc: s.excerpt.trim(), action: '' }, confidence: 'medium', method, evidence: [ev], keys: { tags: segM.tags.map(t => t.tag), zones: segM.zones.filter(z => z.valid).map(z => 'Zone ' + z.zone), stairs: segM.stairs.filter(x => !x.generic).map(x => x.name), floors: segM.floors.map(f => f.label) } });
      if (!locOk) out.openItems.push({ label: 'New deficiency: location', reason: 'LLM-proposed deficiency location was not supported by names in the quoted segment; left blank.', evidence: [ev] });
      continue;
    }
    const value = String(s.value ?? '');
    let ok = false, why = '';
    if (tg.map === 'floors') {
      if (!K.press.has(tg.key)) why = 'not a shaft/level of this building';
      else if (tg.field === 'cl') { const blk = K.press.get(tg.key); ok = blk.cl && ((value === 'fail' && /\b(?:not|no|didn'?t|did not|doesn'?t|fail\w*)\b[^.]{0,20}latch/i.test(ex)) || (value === 'pass' && /latch(?:ed|es)\b/i.test(ex) && !/\b(?:not|no|didn'?t|did not)\b[^.]{0,20}latch/i.test(ex))); why = ok ? '' : 'latch phrase not found in quote'; }
      else if (['dp', 'brk', 'swg'].includes(tg.field)) {
        const kind = tg.field === 'dp' ? 'pressure' : 'force';
        const nums = [...parseQuantities(ex).filter(q => q.kind === kind).map(q => formatValue(kind, q.value)), ...parseBareNumbers(ex).map(b => formatValue(kind, b.value))];
        ok = nums.includes(formatValue(kind, +value)) && !isNaN(+value); why = ok ? '' : `value ${value} not found as a number in the quote`;
      } else why = 'unknown field';
    } else if (tg.map === 'seqResults' && !K.seq.has(tg.key)) why = 'not a test key of this building';
    else if (tg.map === 'matrixResults' && !K.matrix.has(tg.key)) why = 'not a matrix cell of this building';
    else if (tg.map === 'zoneResults' && !K.zone.has(tg.key)) why = 'not a zone result of this building';
    else if (!['seqResults', 'matrixResults', 'zoneResults'].includes(tg.map)) why = 'unknown record section';
    else { ok = resultOf(ex).value === value; why = ok ? '' : `quote does not contain an unambiguous "${value}" result word`; }
    if (ok && !locationSupported(tg, seg, segments, vocab)) { ok = false; why = 'the device, zone, shaft or level in the target is not named in the quoted segment or the three before it'; }
    if (!ok) { reject(s, why, seg); continue; }
    const finalValue = tg.field && tg.field !== 'cl' ? formatValue(tg.field === 'dp' ? 'pressure' : 'force', +value) : value;
    out.candidates.push({ path: tg.field ? `floors.${tg.key}.${tg.field}` : `${tg.map}.${tg.key}`, map: tg.map, key: tg.key, field: tg.field, value: finalValue, confidence: 'medium', method, label: String(s.target), evidence: [ev] });
  }
  return out;
}

// ── adapters ──
function commandAdapter(cmd) {
  return {
    name: 'command',
    async propose(request) {
      const r = spawnSync(cmd, { shell: true, input: JSON.stringify(request), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
      if (r.status !== 0) throw new Error(`LLM command exited ${r.status}: ${(r.stderr || '').slice(0, 400)}`);
      const data = JSON.parse(r.stdout);
      return Array.isArray(data) ? data : data.suggestions || [];
    },
  };
}

const INSTRUCTIONS = `You read a smoke control field-test transcript and propose values for an inspection record.
Return ONLY a JSON array. Each element: {"target": "...", "value": "...", "segment": {"file": "...", "index": N}, "excerpt": "exact words copied from that segment"}.
For deficiencies use {"target": "deficiency", "sev": "Deficiency|Observation|Note", "loc": "...", "segment": {...}, "excerpt": "..."}.
Rules: use only targets from the list provided. Propose a value only when the speaker clearly states it. Never infer a result from an equipment state alone. If unsure, leave it out. Copy the excerpt verbatim.`;

function anthropicAdapter({ apiKey = process.env.ANTHROPIC_API_KEY, model = process.env.SC_FIELD_LLM_MODEL || 'claude-sonnet-5' } = {}) {
  return {
    name: `anthropic:${model}`,
    async propose(request) {
      if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
      const body = { model, max_tokens: 8000, system: INSTRUCTIONS, messages: [{ role: 'user', content: JSON.stringify(request) }] };
      const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`Anthropic API ${r.status}: ${(await r.text()).slice(0, 400)}`);
      const j = await r.json();
      const text = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
      const m = /\[[\s\S]*\]/.exec(text);
      return m ? JSON.parse(m[0]) : [];
    },
  };
}

function adapterFromSpec(spec) {
  if (!spec || spec === 'off' || spec === 'none') return null;
  if (typeof spec === 'object' && typeof spec.propose === 'function') return spec;
  if (spec === 'anthropic') return anthropicAdapter();
  if (String(spec).startsWith('command:')) return commandAdapter(String(spec).slice(8));
  throw new Error(`Unknown --llm value "${spec}". Use off, anthropic, or command:<shell command>.`);
}

async function runLlm(adapter, segments, vocab) {
  const request = { building: vocab.project.name, targets: targetsFor(vocab), segments: segments.map(s => ({ file: s.file, index: s.index, time: s.startLabel, speaker: s.speaker, text: s.text })) };
  const suggestions = await adapter.propose(request);
  return verifySuggestions(suggestions, segments, vocab, adapter.name);
}

module.exports = { adapterFromSpec, runLlm, verifySuggestions, targetsFor, commandAdapter, anthropicAdapter, INSTRUCTIONS };

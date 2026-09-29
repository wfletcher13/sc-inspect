'use strict';
// Combines candidates from every source into one patch. A value is filled only when every source that
// speaks to it agrees, it is rated high or medium, and the pre-test JSON has nothing different there.
const crypto = require('crypto');
const { findMentions } = require('./matcher');
const { FIELD_LABEL, ZONE_LABEL, seqLabel, blockLabel, matrixColLabel } = require('./extract');

const RANK = { low: 0, medium: 1, high: 2 };

function existingValue(project, c) {
  if (c.map === 'floors') { const d = project.floors[c.key]; return d && d[c.field] != null && d[c.field] !== '' ? String(d[c.field]) : null; }
  const v = (project[c.map] || {})[c.key];
  return v ? String(v) : null;
}

function defId(d) { return 'dfr' + crypto.createHash('sha1').update(`${d.loc}|${d.sev}|${d.desc}`).digest('hex').slice(0, 10); }
const normText = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function resolve({ project, vocab, sources, photoIndex }) {
  const model = vocab.model;
  const all = { candidates: [], openItems: [], measurements: [], deficiencies: [], notTested: [], unmapped: [] };
  for (const s of sources) for (const k of Object.keys(all)) if (s[k]) all[k].push(...s[k]);

  const groups = new Map();
  for (const c of all.candidates) { if (!groups.has(c.path)) groups.set(c.path, []); groups.get(c.path).push(c); }

  const patch = { seqResults: {}, matrixResults: {}, zoneResults: {}, floors: {}, deficiencies: [] };
  const accepted = [], unchanged = [], openItems = [...all.openItems];
  for (const [path, cs] of groups) {
    const first = cs[0];
    const values = [...new Set(cs.map(c => String(c.value)))];
    const evidence = cs.flatMap(c => c.evidence);
    const label = first.label;
    if (values.length > 1) {
      openItems.push({ path, label, reason: `Sources disagree: ${cs.map(c => `${c.value} (${c.evidence[0].source} ${c.evidence[0].file}${c.evidence[0].line ? ':' + c.evidence[0].line : ''})`).join(' vs ')}. Left empty.`, evidence, values });
      continue;
    }
    const best = cs.reduce((a, c) => (RANK[c.confidence] > RANK[a.confidence] ? c : a), cs[0]);
    if (RANK[best.confidence] < RANK.medium) { openItems.push({ path, label, reason: 'Only low-confidence evidence; left empty.', evidence, values }); continue; }
    const value = values[0];
    const prior = existingValue(project, first);
    if (prior != null) {
      if (prior === value) unchanged.push({ path, label, value, evidence });
      else openItems.push({ path, label, reason: `Pre-test JSON already has "${prior}" here; field notes say "${value}". Not overwritten.`, evidence, values: [prior, value] });
      continue;
    }
    const sourcesSeen = new Set(cs.map(c => c.evidence[0].source + ':' + c.evidence[0].file));
    const entry = { path, map: first.map, key: first.key, field: first.field, value, confidence: best.confidence, label, method: [...new Set(cs.map(c => c.method))].join('; '), evidence, corroborated: sourcesSeen.size > 1, note: cs.map(c => c.note).filter(Boolean).join('; ') };
    accepted.push(entry);
    if (first.map === 'floors') { patch.floors[first.key] = patch.floors[first.key] || {}; patch.floors[first.key][first.field] = value; }
    else patch[first.map][first.key] = value;
  }

  // ── deficiencies: stated ones first, then ones that follow from accepted out-of-range or failed values ──
  const defs = [];
  const seen = new Set();
  for (const d of all.deficiencies) {
    const k = normText(d.deficiency.desc) + '|' + normText(d.deficiency.loc);
    if (seen.has(k)) { const prev = defs.find(x => x.k === k); prev.evidence.push(...d.evidence); continue; }
    seen.add(k);
    defs.push({ k, ...d, confidence: d.deficiency.loc ? d.confidence : 'medium', generated: false });
  }
  const stated = defs.map(d => d.keys || {});
  const coveredTag = tag => stated.some(s => (s.tags || []).includes(tag));
  const coveredZone = z => stated.some(s => (s.zones || []).includes('Zone ' + z));
  const coveredShaftFloor = (name, fl) => stated.some(s => (s.stairs || []).includes(name) && (s.floors || []).includes(fl));
  const evKey = e => `${e.source}|${e.file}|${e.line ?? ''}|${e.index ?? ''}`;
  const statedEv = new Set(defs.flatMap(d => d.evidence.map(evKey)));
  const gen = (loc, desc, from, keys) => from.evidence.some(e => statedEv.has(evKey(e))) ? null : defs.push({ k: normText(desc), deficiency: { loc, sev: 'Deficiency', desc, action: '' }, confidence: from.confidence, method: `rule:generated from accepted value ${from.path}`, evidence: from.evidence, keys, generated: true });
  for (const a of accepted) {
    if (a.map === 'floors') {
      const i = a.key.lastIndexOf('_'); const prefix = a.key.slice(0, i), fl = a.key.slice(i + 1);
      const blk = vocab.blocks.find(b => b.prefix === prefix); const bl = blk ? blk.label : prefix; const shaft = blk ? blk.short.replace(/ vest$/, '') : prefix;
      if (coveredShaftFloor(shaft, fl)) continue;
      const where = `${bl}, ${fl === 'Lobby' ? 'Lobby' : 'Level ' + fl}`;
      const keys = { stairs: [shaft], floors: [fl] };
      if (a.field === 'dp' && model.pressFlag('dp', a.value)) gen(where, `Measured pressure difference of ${a.value} in. w.g. at ${where} is below the ${model.DP_MIN} in. w.g. minimum.`, a, keys);
      if ((a.field === 'brk' || a.field === 'swg') && model.pressFlag(a.field, a.value)) gen(where, `Measured door ${a.field === 'brk' ? 'break-away' : 'swing'} force of ${a.value} lbf at ${where} exceeds the ${model.FORCE_MAX} lbf maximum.`, a, keys);
      if (a.field === 'cl' && a.value === 'fail') gen(where, `Door at ${where} did not close and latch.`, a, keys);
    } else if (a.value === 'fail' && a.map === 'seqResults') {
      const us = a.key.lastIndexOf('_'); const tag = a.key.slice(0, us);
      const t = vocab.tags.find(x => x.tag === tag);
      if (t) { if (coveredTag(tag)) continue; const test = t.tests[+a.key.slice(us + 1)]; gen(tag, `${tag} (${t.eq.type}) failed the ${test.event.toLowerCase()} test "${test.action}". Expected: ${test.exp}.`, a, { tags: [tag] }); }
      else { const it = vocab.tableItems.find(x => x.id === a.key); if (it) gen('', `${it.cat ? it.cat + ': ' : ''}${it.lbl} recorded as failing.`, a, {}); }
    } else if (a.value === 'fail' && a.map === 'zoneResults') {
      const us = a.key.lastIndexOf('_'); const z = a.key.slice(0, us), item = a.key.slice(us + 1);
      if (coveredZone(z)) continue;
      const zz = vocab.zones.find(x => x.zone === z);
      gen(`Zone ${z}${zz && zz.room ? ' (' + zz.room + ')' : ''}`, `Zone ${z} failed "${ZONE_LABEL[item] || item}" on zone alarm.`, a, { zones: ['Zone ' + z] });
    } else if (a.value === 'fail' && a.map === 'matrixResults') {
      const us = a.key.indexOf('_'); const fl = a.key.slice(0, us), col = a.key.slice(us + 1);
      const tag = col.startsWith('fan_') ? col.slice(4) : null;
      if (tag && coveredTag(tag)) continue;
      if (stated.some(s => (s.floors || []).includes(fl))) continue;
      gen(`Level ${fl}`, `Floor sequence matrix: ${matrixColLabel(vocab, col)} recorded as failing on smoke detector activation at Level ${fl}.`, a, { floors: [fl], tags: tag ? [tag] : [] });
    }
  }
  // photos whose caption names the same place or device
  const photoMentions = (photoIndex ? photoIndex.photos : []).filter(p => p.caption).map(p => ({ p, m: findMentions(p.caption, vocab) }));
  const existingIds = new Set(project.deficiencies.map(d => d.id));
  const deficiencies = [];
  for (const d of defs) {
    const keys = d.keys || {};
    const photos = photoMentions.filter(({ m }) => {
      const tags = m.tags.map(t => t.tag), zones = m.zones.filter(z => z.valid).map(z => 'Zone ' + z.zone), stairs = m.stairs.filter(s => !s.generic).map(s => s.name), fls = m.floors.map(f => f.label);
      return (keys.tags || []).some(t => tags.includes(t)) || (keys.zones || []).some(z => zones.includes(z)) || ((keys.stairs || []).some(s => stairs.includes(s)) && (keys.floors || []).some(f => fls.includes(f)));
    }).map(({ p }) => ({ file: p.file, caption: p.caption }));
    const rec = { id: defId(d.deficiency), loc: d.deficiency.loc, sev: d.deficiency.sev, desc: d.deficiency.desc, action: '', photos: [] };
    if (existingIds.has(rec.id)) continue;
    const dup = project.deficiencies.find(x => normText(x.desc) === normText(rec.desc));
    if (dup) { unchanged.push({ path: `deficiencies.${dup.id}`, label: `Deficiency ${dup.loc || ''}`.trim(), value: dup.desc, evidence: d.evidence }); continue; }
    existingIds.add(rec.id);
    patch.deficiencies.push(rec);
    deficiencies.push({ ...rec, confidence: d.confidence, method: d.method, generated: d.generated, evidence: d.evidence, photoRefs: photos });
  }
  return { patch, accepted, unchanged, openItems, deficiencies, measurements: all.measurements, notTested: all.notTested, unmapped: all.unmapped };
}

module.exports = { resolve, RANK, existingValue, labels: { FIELD_LABEL, ZONE_LABEL, seqLabel, blockLabel } };

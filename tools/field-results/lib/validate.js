'use strict';
// Validates a proposed patch and the merged record against the app's own rules (index.html): the result keys
// the app generates (getSeqTests, getMatrixCols, getFloors, pressBlocks, getZones), the value domains its
// editing tools accept (pass / fail / na; numeric dp, brk, swg; cl pass / fail), and normalizeProject.

const RESULT_VALUES = new Set(['pass', 'fail', 'na']);
const SEVERITIES = new Set(['Deficiency', 'Observation', 'Note']);
const isNumStr = v => typeof v === 'string' && v.trim() !== '' && !isNaN(+v);

function validKeys(project, model) {
  const seq = new Set();
  project.equipment.forEach(e => model.getSeqTests(e).forEach((_, ti) => seq.add(`${e.tag}_${ti}`)));
  [...model.FAULT_TESTS, ...model.EMERG_TESTS, ...model.INIT_TESTS, ...model.VISUAL_ITEMS].forEach(t => seq.add(t.id));
  const floors = model.getFloors(project);
  const matrix = new Set();
  model.getMatrixCols(project).forEach(c => floors.forEach(f => matrix.add(`${f}_${c.key}`)));
  const zone = new Set(), zoneText = new Set();
  model.getZones(project).forEach(z => { ['fans', 'dampers', 'isolate'].forEach(k => zone.add(`${z.zone}_${k}`)); ['note', 'seq'].forEach(k => zoneText.add(`${z.zone}_${k}`)); });
  const press = new Map();
  model.pressBlocks(project).forEach(b => floors.forEach(f => press.set(`${b.prefix}_${f}`, b)));
  return { seq, matrix, zone, zoneText, press };
}

function validatePatch(project, patch, model, { existingDeficiencyIds = [] } = {}) {
  const errors = [];
  const K = validKeys(project, model);
  const err = (path, msg) => errors.push({ path, msg });
  for (const [k, v] of Object.entries(patch.seqResults || {})) {
    if (!K.seq.has(k)) err(`seqResults.${k}`, 'not a result key the app generates for this building');
    if (!RESULT_VALUES.has(v)) err(`seqResults.${k}`, `value "${v}" is not pass, fail or na`);
  }
  for (const [k, v] of Object.entries(patch.matrixResults || {})) {
    if (!K.matrix.has(k)) err(`matrixResults.${k}`, 'not a floor/column cell of this building\'s matrix');
    if (!RESULT_VALUES.has(v)) err(`matrixResults.${k}`, `value "${v}" is not pass, fail or na`);
  }
  for (const [k, v] of Object.entries(patch.zoneResults || {})) {
    if (K.zone.has(k)) { if (!RESULT_VALUES.has(v)) err(`zoneResults.${k}`, `value "${v}" is not pass, fail or na`); }
    else if (K.zoneText.has(k)) { if (typeof v !== 'string') err(`zoneResults.${k}`, 'zone note / sequence must be text'); }
    else err(`zoneResults.${k}`, 'not a zone result key of this building');
  }
  for (const [k, d] of Object.entries(patch.floors || {})) {
    const blk = K.press.get(k);
    if (!blk) { err(`floors.${k}`, 'not a shaft/level of this building (pressBlocks x getFloors)'); continue; }
    if (!d || typeof d !== 'object') { err(`floors.${k}`, 'must be an object'); continue; }
    for (const [f, v] of Object.entries(d)) {
      if (!['dp', 'brk', 'swg', 'cl'].includes(f)) err(`floors.${k}.${f}`, 'unknown field (dp, brk, swg, cl)');
      else if (f === 'cl') { if (!['pass', 'fail', ''].includes(v)) err(`floors.${k}.cl`, 'must be pass, fail or empty'); if (v && !blk.cl) err(`floors.${k}.cl`, 'this shaft has no close/latch column in the app'); }
      else if (v !== '' && !isNumStr(v)) err(`floors.${k}.${f}`, `"${v}" is not a number`);
    }
  }
  const ids = new Set(existingDeficiencyIds);
  (patch.deficiencies || []).forEach((d, i) => {
    const p = `deficiencies[${i}]`;
    if (!d || typeof d !== 'object') return err(p, 'must be an object');
    if (typeof d.id !== 'string' || !d.id) err(p + '.id', 'missing id');
    else if (ids.has(d.id)) err(p + '.id', `duplicate id ${d.id}`);
    ids.add(d.id);
    if (!SEVERITIES.has(d.sev)) err(p + '.sev', 'must be Deficiency, Observation or Note');
    if (typeof d.desc !== 'string' || !d.desc.trim()) err(p + '.desc', 'observed condition is empty');
    for (const f of ['loc', 'action']) if (typeof d[f] !== 'string') err(`${p}.${f}`, 'must be text');
    if (!Array.isArray(d.photos)) err(p + '.photos', 'must be an array');
  });
  return errors;
}

// The merged record must survive the app's import normalisation unchanged in every result field.
function validateMerged(merged, patch, model) {
  const errors = [];
  let norm;
  try { norm = model.normalizeProject(JSON.parse(JSON.stringify(merged))); } catch (e) { return [{ path: '', msg: 'normalizeProject threw: ' + e.message }]; }
  if (norm.schemaVersion !== model.SCHEMA_VERSION) errors.push({ path: 'schemaVersion', msg: `expected ${model.SCHEMA_VERSION}` });
  for (const map of ['seqResults', 'matrixResults', 'zoneResults']) for (const [k, v] of Object.entries(patch[map] || {})) if (norm[map][k] !== v) errors.push({ path: `${map}.${k}`, msg: 'value lost or changed by normalizeProject' });
  for (const [k, d] of Object.entries(patch.floors || {})) for (const [f, v] of Object.entries(d)) if (!norm.floors[k] || norm.floors[k][f] !== v) errors.push({ path: `floors.${k}.${f}`, msg: 'value lost or changed by normalizeProject' });
  for (const d of patch.deficiencies || []) { const n = norm.deficiencies.find(x => x.id === d.id); if (!n || n.desc !== d.desc || n.sev !== d.sev || n.loc !== d.loc) errors.push({ path: `deficiencies.${d.id}`, msg: 'deficiency lost or changed by normalizeProject' }); }
  const pr = model.progress(norm);
  return { errors, progress: { done: pr.done, total: pr.total, fails: pr.fails, pct: pr.pct } };
}

module.exports = { validatePatch, validateMerged, validKeys, RESULT_VALUES, SEVERITIES };

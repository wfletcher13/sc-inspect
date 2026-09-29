'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadAppModel } = require('./appModel');
const { buildVocabulary } = require('./matcher');
const { readTranscript } = require('./transcript');
const { extractSegments } = require('./extract');
const { extractChecklist } = require('./checklist');
const { readPhotoIndex, extractPhotos } = require('./photos');
const { resolve } = require('./resolve');
const { validatePatch, validateMerged } = require('./validate');
const { adapterFromSpec, runLlm } = require('./llm');
const { renderReview } = require('./review');

const TOOL = 'sc-inspect field-results';
const VERSION = '1.0.0';

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

function applyPatch(sourceDoc, patch, meta) {
  const wrapped = !!(sourceDoc && sourceDoc.project);
  const out = JSON.parse(JSON.stringify(sourceDoc));
  const p = wrapped ? out.project : out;
  for (const k of ['seqResults', 'matrixResults', 'zoneResults', 'floors']) if (!p[k] || typeof p[k] !== 'object') p[k] = {};
  if (!Array.isArray(p.deficiencies)) p.deficiencies = [];
  for (const k of ['seqResults', 'matrixResults', 'zoneResults']) Object.assign(p[k], patch[k]);
  for (const [k, d] of Object.entries(patch.floors)) p.floors[k] = { dp: '', brk: '', swg: '', cl: '', ...(p.floors[k] || {}), ...d };
  for (const d of patch.deficiencies) p.deficiencies.push({ ...d, ts: meta.generatedAt, by: meta.by });
  return { doc: out, project: p };
}

async function run(opts) {
  const generatedAt = opts.now || new Date().toISOString();
  const model = loadAppModel(opts.indexPath);
  const srcBuf = fs.readFileSync(opts.pretest);
  let raw; try { raw = JSON.parse(srcBuf.toString('utf8')); } catch (e) { throw new Error(`${opts.pretest}: not valid JSON (${e.message})`); }
  const project = model.normalizeProject(JSON.parse(JSON.stringify(raw)));
  const vocab = buildVocabulary(project, model);

  const sources = [];
  const inputs = [];
  const allSegments = [];
  for (const t of opts.transcripts || []) {
    const segs = readTranscript(t);
    allSegments.push(...segs);
    sources.push(extractSegments(segs, vocab, { source: 'transcript' }));
    inputs.push({ kind: 'transcript', file: path.basename(t), sha256: sha256(fs.readFileSync(t)), segments: segs.length });
  }
  let checklistInfo = null;
  if (opts.checklist) {
    const c = extractChecklist(opts.checklist, vocab);
    sources.push(c);
    checklistInfo = { rows: c.rows, sheets: c.sheets };
    inputs.push({ kind: 'checklist', file: path.basename(opts.checklist), sha256: sha256(fs.readFileSync(opts.checklist)), rows: c.rows, sheets: c.sheets });
  }
  let photoIndex = null;
  if (opts.photos) {
    photoIndex = readPhotoIndex(opts.photos);
    sources.push(extractPhotos(photoIndex, vocab));
    inputs.push({ kind: 'photos', file: path.basename(opts.photos), sha256: sha256(fs.readFileSync(opts.photos)), photos: photoIndex.photos.length });
  }
  const adapter = adapterFromSpec(opts.llm);
  let llmInfo = { enabled: false };
  if (adapter) {
    try { const r = await runLlm(adapter, allSegments, vocab); sources.push(r); llmInfo = { enabled: true, adapter: adapter.name, suggestionsUsed: r.candidates.length + r.deficiencies.length, suggestionsRejected: r.openItems.filter(o => /^LLM suggestion/.test(o.label)).length }; }
    catch (e) { llmInfo = { enabled: true, adapter: adapter.name, error: e.message }; }
  }

  const R = resolve({ project, vocab, sources, photoIndex });
  const by = `${TOOL} (proposed)`;
  const patchErrors = validatePatch(project, R.patch, model, { existingDeficiencyIds: project.deficiencies.map(d => d.id) });
  const merged = applyPatch(raw, R.patch, { generatedAt, by });
  const mergedCheck = validateMerged(merged.project, R.patch, model);
  const before = model.progress(project);
  const validation = { ok: !patchErrors.length && !mergedCheck.errors.length, patchErrors, mergedErrors: mergedCheck.errors, validator: 'index.html data model (normalizeProject, getSeqTests, getMatrixCols, getFloors, pressBlocks, getZones) + assistant tool value rules' };

  const proposal = {
    _proposal: {
      tool: TOOL, version: VERSION, generatedAt, schemaVersion: model.SCHEMA_VERSION,
      source: { file: path.basename(opts.pretest), sha256: sha256(srcBuf), projectId: project.id, building: project.name },
      inputs, llm: llmInfo,
      note: 'Proposed values only. The source JSON was not modified. Review every row in the review table before applying.',
    },
    patch: { ...R.patch, deficiencies: R.patch.deficiencies.map(d => ({ ...d, ts: generatedAt, by })) },
    evidence: R.accepted.map(a => ({ path: a.path, label: a.label, value: a.value, confidence: a.confidence, corroborated: a.corroborated, method: a.method, note: a.note || undefined, evidence: a.evidence })),
    deficiencyEvidence: R.deficiencies.map(d => ({ id: d.id, confidence: d.confidence, generated: d.generated, method: d.method, evidence: d.evidence, photos: d.photoRefs })),
    measurements: R.measurements,
    notTested: R.notTested,
    openItems: R.openItems,
    unchanged: R.unchanged,
    checklistUnmapped: R.unmapped,
    validation,
    progress: { before: { done: before.done, total: before.total, fails: before.fails }, after: mergedCheck.progress },
  };
  const review = renderReview({ proposal, R, vocab, project, checklistInfo, photoIndex });
  return { proposal, merged: merged.doc, review, validation };
}

function outputPaths(opts) {
  const base = path.basename(opts.pretest).replace(/\.json$/i, '');
  const dir = path.resolve(opts.outDir || path.join(path.dirname(opts.pretest), `${base}.field-results`));
  return { dir, patch: path.join(dir, `${base}.proposed-patch.json`), merged: path.join(dir, `${base}.proposed-post-test.json`), review: path.join(dir, `${base}.field-results-review.md`) };
}

function writeOutputs(opts, result) {
  const out = outputPaths(opts);
  const protectedPaths = new Set([opts.pretest, ...(opts.transcripts || []), opts.checklist, opts.photos, opts.indexPath].filter(Boolean).map(p => path.resolve(p)));
  for (const p of [out.patch, out.merged, out.review]) {
    if (protectedPaths.has(p)) throw new Error(`Refusing to write ${p}: it is one of the inputs.`);
    if (fs.existsSync(p) && !opts.force) throw new Error(`${p} already exists. Use --force to replace a previous proposal (inputs are never touched).`);
  }
  fs.mkdirSync(out.dir, { recursive: true });
  fs.writeFileSync(out.patch, JSON.stringify(result.proposal, null, 2) + '\n');
  fs.writeFileSync(out.merged, JSON.stringify(result.merged, null, 2) + '\n');
  fs.writeFileSync(out.review, result.review);
  return out;
}

module.exports = { run, writeOutputs, outputPaths, applyPatch, TOOL, VERSION };

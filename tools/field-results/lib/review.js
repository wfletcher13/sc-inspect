'use strict';
// Markdown review table: every proposed value with its source, excerpt and confidence, plus open items.
const { ZONE_LABEL, FIELD_LABEL } = require('./extract');

const md = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
const clip = (s, n = 180) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

function srcRef(e) {
  const where = e.line != null ? `:${e.line}` : e.jsonIndex != null ? ` #${e.jsonIndex}` : e.index != null ? ` #${e.index}` : '';
  const bits = [`${e.source} \`${e.file}${where}\``];
  if (e.timestamp) bits.push(`@ ${e.timestamp}`);
  if (e.speaker && e.source === 'transcript') bits.push(`(${e.speaker})`);
  if (e.photo) bits.push(`photo \`${e.photo}\``);
  return bits.join(' ');
}
const srcs = ev => (ev || []).map(srcRef).join('<br>');
const excerpts = ev => (ev || []).map(e => `"${md(clip(e.quote || e.excerpt))}"`).join('<br>');
const confTxt = (c, corr) => (c ? c + (corr ? ' (corroborated)' : '') : '');
const table = (head, rows) => rows.length ? [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map(r => `| ${r.map(x => (x === '' || x == null ? ' ' : x)).join(' | ')} |`)].join('\n') : '_None._';

function renderReview({ proposal, R, vocab, project }) {
  const P = proposal._proposal;
  const acceptedBy = new Map(R.accepted.map(a => [a.path, a]));
  const openBy = new Map(); R.openItems.forEach(o => { if (o.path) openBy.set(o.path, o); });
  const unchangedBy = new Map(R.unchanged.map(u => [u.path, u]));
  const ntBy = new Map(); R.notTested.forEach(n => ntBy.set(n.path, n));
  const hi = R.accepted.filter(a => a.confidence === 'high').length, me = R.accepted.filter(a => a.confidence === 'medium').length;
  const L = [];
  L.push(`# Field results review: ${md(project.name)}`, '');
  L.push(`Proposed post-test values for SC Inspect record \`${md(project.id)}\`, taken from the field recording and notes. **Nothing has been written to the source JSON.** Check every row, correct or strike anything wrong, then apply the values (see "Applying" at the end).`, '');
  L.push(table(['Item', 'Value'], [
    ['Source (pre-test JSON)', `\`${md(P.source.file)}\` sha256 \`${P.source.sha256.slice(0, 16)}…\``],
    ...P.inputs.map(i => [i.kind[0].toUpperCase() + i.kind.slice(1), `\`${md(i.file)}\`${i.segments != null ? ` (${i.segments} statements)` : i.rows != null ? ` (${i.rows} rows)` : i.photos != null ? ` (${i.photos} photos)` : ''}`]),
    ['Language-model step', P.llm.enabled ? `ON (${md(P.llm.adapter)})${P.llm.error ? ` failed: ${md(P.llm.error)}` : `: ${P.llm.suggestionsUsed} verified suggestions used, ${P.llm.suggestionsRejected} rejected`}` : 'off (rule-based extraction only)'],
    ['Validation against the app schema', proposal.validation.ok ? 'PASS' : `**FAIL** (${proposal.validation.patchErrors.length + proposal.validation.mergedErrors.length} errors, listed below)`],
    ['Generated', P.generatedAt],
  ]), '');

  L.push('## Summary', '');
  L.push(table(['Proposed values', 'High', 'Medium', 'New deficiencies', 'Open items', 'Stated not tested', 'Already in pre-test'], [[R.accepted.length, hi, me, R.deficiencies.length, R.openItems.length, R.notTested.length, R.unchanged.length]]), '');
  L.push(`Results recorded: ${proposal.progress.before.done} of ${proposal.progress.before.total} before, ${proposal.progress.after.done} of ${proposal.progress.after.total} with these values applied (${proposal.progress.after.fails} fail).`, '');
  if (!proposal.validation.ok) {
    L.push('### Validation errors', '');
    L.push(table(['Field', 'Problem'], [...proposal.validation.patchErrors, ...proposal.validation.mergedErrors].map(e => [`\`${md(e.path)}\``, md(e.msg)])), '');
  }

  L.push('## Proposed values', '');
  const order = { seqResults: 0, zoneResults: 1, matrixResults: 2, floors: 3 };
  const acc = [...R.accepted].sort((a, b) => order[a.map] - order[b.map] || a.label.localeCompare(b.label, 'en', { numeric: true }));
  L.push(table(['#', 'Record field', 'Proposed', 'Confidence', 'Source', 'Evidence (transcript excerpt)', 'How it was read'],
    acc.map((a, i) => [i + 1, `${md(a.label)}<br>\`${md(a.path)}\``, `**${md(a.value)}**${a.note ? ` (${md(a.note)})` : ''}`, confTxt(a.confidence, a.corroborated), srcs(a.evidence), excerpts(a.evidence), md(a.method)])), '');

  // device-by-device status
  L.push('## Equipment tests by device (Appendix A-1)', '');
  const devRows = [];
  for (const t of vocab.tags) for (const test of t.tests) {
    const path = `seqResults.${t.tag}_${test.ti}`;
    const a = acceptedBy.get(path), o = openBy.get(path), u = unchangedBy.get(path), n = ntBy.get(path) || ntBy.get(`seqResults.${t.tag}_*`);
    const prior = project.seqResults[`${t.tag}_${test.ti}`];
    const status = a ? `proposed: **${a.value}** (${confTxt(a.confidence, a.corroborated)})` : o ? 'open item, left empty' : u ? `already recorded: ${u.value}` : prior ? `already recorded: ${prior}` : n ? 'stated not tested' : 'not tested (no evidence)';
    devRows.push([md(t.tag), md(`${test.event}: ${test.action}`), md(test.exp), status, a ? srcs(a.evidence) : o ? srcs(o.evidence) : n ? srcs(n.evidence) : '']);
  }
  L.push(table(['Device', 'Test', 'Expected', 'Status', 'Source'], devRows), '');

  if (vocab.zones.length) {
    L.push('## Lower-level zones (A-2(b))', '');
    const cell = (z, k) => { const p = `zoneResults.${z}_${k}`; const a = acceptedBy.get(p); if (a) return `**${a.value}** (${a.confidence})`; if (openBy.has(p)) return 'open item'; if (project.zoneResults[`${z}_${k}`]) return `recorded: ${project.zoneResults[`${z}_${k}`]}`; if (ntBy.has(`zoneResults.${z}_*`)) return 'stated not tested'; return 'not tested'; };
    L.push(table(['Zone', 'Room', 'Floor', ZONE_LABEL.fans, ZONE_LABEL.dampers, ZONE_LABEL.isolate], vocab.zones.map(z => [md(z.zone), md(z.room), md(z.floor), cell(z.zone, 'fans'), cell(z.zone, 'dampers'), cell(z.zone, 'isolate')])), '');
  }

  const mx = R.accepted.filter(a => a.map === 'matrixResults');
  const mxOpen = R.openItems.filter(o => /^Matrix /.test(o.label));
  L.push('## Floor sequence matrix (A-2)', '');
  if (mx.length || mxOpen.length) {
    const floors = [...new Set(mx.map(a => a.key.slice(0, a.key.indexOf('_'))))];
    L.push(table(['Alarm level', ...vocab.matrixCols.map(c => md(c.label))], floors.map(f => [f, ...vocab.matrixCols.map(c => { const a = acceptedBy.get(`matrixResults.${f}_${c.key}`); return a ? `**${a.value}** (${a.confidence})` : project.matrixResults[`${f}_${c.key}`] ? `recorded: ${project.matrixResults[`${f}_${c.key}`]}` : '—'; })])), '');
    L.push(`Levels with no evidence in the recording are not listed (${vocab.floors.length - floors.length} of ${vocab.floors.length}).`, '');
  } else L.push('_No floor matrix results found in the recording._', '');

  L.push('## Pressure difference and door force (A-2b)', '');
  const pKeys = [...new Set([...R.accepted.filter(a => a.map === 'floors').map(a => a.key)])];
  const pRows = [];
  for (const b of vocab.blocks) for (const f of vocab.floors) {
    const k = `${b.prefix}_${f}`; if (!pKeys.includes(k)) continue;
    const cell = fld => { const a = acceptedBy.get(`floors.${k}.${fld}`); if (!a) return (project.floors[k] || {})[fld] ? `recorded: ${project.floors[k][fld]}` : '—'; const flag = vocab.model.pressFlag(fld, a.value) ? (fld === 'dp' ? ' below 0.05 min' : ' over 30 lbf max') : (fld === 'cl' && a.value === 'fail' ? ' no latch' : ''); return `**${md(a.value)}**${flag ? ` _(${flag.trim()})_` : ''} (${a.confidence})`; };
    pRows.push([md(b.label), f, cell('dp'), cell('brk'), cell('swg'), b.cl ? cell('cl') : 'n/a']);
  }
  L.push(pRows.length ? table(['Shaft / door', 'Level', FIELD_LABEL.dp, FIELD_LABEL.brk, FIELD_LABEL.swg, FIELD_LABEL.cl], pRows) : '_No pressure or door force readings found in the recording._', '');
  L.push('Limits: minimum 0.05 in. w.g.; maximum door force 30 lbf (NFPA 92 §6.4.2), as flagged by the app.', '');

  const tbl = R.accepted.filter(a => a.map === 'seqResults' && vocab.tableItems.some(t => t.id === a.key));
  if (tbl.length) { L.push('## Table 1 / Table 2 items', ''); L.push(table(['Item', 'Proposed', 'Confidence', 'Source'], tbl.map(a => [md(a.label), `**${a.value}**`, confTxt(a.confidence, a.corroborated), srcs(a.evidence)])), ''); }

  L.push('## Measurements with no field in the record', '');
  L.push('Schema v2 has no field for measured airflow or observed equipment state. These are listed for the report narrative and are not in the patch.', '');
  L.push(table(['Device', 'Kind', 'Measured', 'Design CFM (pre-test)', 'Confidence', 'Source', 'Evidence'], R.measurements.map(m => [md(m.tag || '(not identified)'), m.kind, `${md(m.kind === 'airflow' ? Number(m.value).toLocaleString('en-US') + ' CFM' : m.value)}`, md(m.design || ''), m.confidence, srcs(m.evidence), excerpts(m.evidence)])), '');

  L.push('## Proposed new deficiencies (Appendix C)', '');
  L.push('Observed condition is the recorded wording (or generated from a failed or out-of-range value) and should be rewritten into report language. Corrective action is left for the engineer to write.', '');
  L.push(table(['#', 'Id', 'Severity', 'Location', 'Observed condition', 'Corrective action', 'Confidence', 'Source', 'Photos naming the same device or place'], R.deficiencies.map((d, i) => [i + 1, `\`${d.id}\``, d.sev, md(d.loc) || '_(blank: see open items)_', md(d.desc), '_(to be written)_', `${d.confidence}${d.generated ? ' (generated)' : ''}`, srcs(d.evidence), (d.photoRefs || []).map(p => `\`${md(p.file)}\``).join('<br>')])), '');

  L.push('## Open items (left empty on purpose)', '');
  L.push(table(['#', 'Item', 'Why it was left empty', 'Values heard', 'Source', 'Evidence'], R.openItems.map((o, i) => [i + 1, md(o.label), md(o.reason), md((o.values || []).join(', ')), srcs(o.evidence), excerpts(o.evidence)])), '');

  if (R.notTested.length) { L.push('## Stated as not tested', ''); L.push(table(['Item', 'Source', 'Evidence'], R.notTested.map(n => [md(n.label), srcs(n.evidence), excerpts(n.evidence)])), ''); }
  if (R.unmapped.length) { L.push('## Checklist rows not mapped to a record field', ''); L.push(table(['Row', 'Row text', 'Why'], R.unmapped.map(u => [u.row, md(clip(u.text)), md(u.reason)])), ''); }
  if (R.unchanged.length) { L.push('## Already in the pre-test JSON (unchanged)', ''); L.push(table(['Field', 'Value', 'Source'], R.unchanged.map(u => [md(u.label), md(clip(u.value, 80)), srcs(u.evidence)])), ''); }

  L.push('## How confidence is rated', '');
  L.push('- **high**: the device/shaft, the level and the value (with its unit) or the pass/fail word were all stated in the same sentence of the recording.');
  L.push('- **medium**: one part was carried from an earlier sentence (for example "Level 12" said once before several readings), the unit was not said but a pressure or force word was and the number is in the plausible range, or the value came from a vendor checklist, a photo caption, or a verified language-model suggestion.');
  L.push('- Anything weaker, contradictory, or asked as a question is not filled in and appears under open items.', '');
  L.push('## Applying', '');
  L.push('- `*.proposed-patch.json` holds only the new values (`patch`) with the evidence for each one. The Claude session building the results report can apply it to the building record.');
  L.push('- `*.proposed-post-test.json` is the pre-test record with the patch applied. In SC Inspect, Reports > Record & data transfer > "Import JSON as new building" opens it as a separate building for review; it never replaces the original.');
  L.push('- Photos listed here are file names from the photo index. Attach them to the deficiency in the app so they travel with the export.');
  return L.join('\n') + '\n';
}

module.exports = { renderReview };

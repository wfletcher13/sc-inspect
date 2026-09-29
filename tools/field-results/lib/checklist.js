'use strict';
// Filled-in pretest checklist (CSV or XLSX) -> candidates. A vendor's checklist answer is reported, not
// witnessed, so nothing from here is ever rated above "medium".
const path = require('path');
const { readTable, rowsToRecords } = require('./tabular');
const { findMentions, matchTests, matchTableItem, matchZoneItems } = require('./matcher');
const { seqLabel, ZONE_LABEL } = require('./extract');

const ALIASES = {
  tag: [/^(?:equipment|device|equip\.?|unit|fan|damper)?\s*tag$/, /^(?:device|equipment|equip\.?|unit|system\s*\/\s*device|device\s*\/\s*system|component)$/],
  item: [/^(?:test|check)\s*\/\s*(?:test|check|verification|inspection)$/, /^(?:test|check|checklist\s+item|item\s+description|description|task|requirement|verification|procedure|inspection\s+item|item)$/, /^(?:test|check)\s*(?:item|description|step)$/, /description|requirement/],
  result: [/^(?:result|status|pass\s*\/\s*fail|p\s*\/\s*f|verified|complete[d]?|response|y\s*\/\s*n|yes\s*\/\s*no|ok\??|answer)$/, /result|status/],
  floor: [/^(?:floor|level|flr|lvl)$/],
  location: [/^(?:location|area|shaft|stair|zone)$/],
  notes: [/note|comment|remark|observ|explain/],
};

const PASS = /^(?:y|yes|pass(?:ed)?|p|ok(?:ay)?|✓|✔|☑|true|complete[d]?|done|verified|good)$/i;
const FAIL = /^(?:n|no|fail(?:ed)?|f|✗|✘|☒|false|not\s+ok|deficient)$/i;
const NA = /^(?:n\/a|na|not\s+applicable)$/i;
const NT = /^(?:not\s+tested|nt|skip(?:ped)?|deferred|pending)$/i;

function normResult(v) {
  const s = String(v || '').trim();
  if (!s) return { value: null, blank: true };
  if (PASS.test(s)) return { value: 'pass' };
  if (FAIL.test(s)) return { value: 'fail' };
  if (NA.test(s)) return { value: 'na' };
  if (NT.test(s)) return { value: null, notTested: true };
  return { value: null, unknown: s };
}

function extractChecklist(filePath, vocab) {
  const out = { candidates: [], openItems: [], deficiencies: [], notTested: [], unmapped: [], rows: 0, sheets: [] };
  const table = readTable(filePath);
  const file = path.basename(filePath);
  for (const sheet of table.sheets) {
    const parsed = rowsToRecords(sheet.rows, ALIASES);
    if (!parsed || !('result' in parsed.map)) { out.sheets.push({ name: sheet.name, skipped: 'no header row with a result column' }); continue; }
    out.sheets.push({ name: sheet.name, headerRow: parsed.headerRow, columns: Object.fromEntries(Object.entries(parsed.map).map(([k, i]) => [k, parsed.header[i]])) });
    for (const r of parsed.records) {
      const res = normResult(r.result);
      const itemText = [r.item, r.location, r.floor ? 'level ' + r.floor : ''].filter(Boolean).join(' ');
      const allText = [r.tag, itemText].filter(Boolean).join(' ');
      if (!allText.trim()) continue;
      out.rows++;
      const ev = { source: 'checklist', file: `${file}${table.sheets.length > 1 ? ' [' + sheet.name + ']' : ''}`, line: r._row, index: r._row, timestamp: '', speaker: 'checklist', excerpt: r._cells.filter(Boolean).join(' | ') };
      if (res.blank) continue;
      if (res.unknown) { out.openItems.push({ label: `Checklist row ${r._row}`, reason: `Result "${res.unknown}" is not a recognised answer (yes/no, pass/fail, N/A).`, evidence: [ev] }); continue; }
      const tagM = findMentions(r.tag || '', vocab).tags;
      const m = findMentions(allText, vocab);
      const tags = [...new Set((tagM.length ? tagM : m.tags).map(t => t.tag))];
      let mapped = false;
      const add = (path, map, key, label) => {
        if (res.notTested) out.notTested.push({ label, path, evidence: [ev] });
        else out.candidates.push({ path, map, key, field: null, value: res.value, confidence: 'medium', method: 'checklist:row mapped by tag + test wording', label, evidence: [ev] });
        mapped = true;
      };
      if (tags.length === 1) {
        const t = vocab.tags.find(x => x.tag === tags[0]);
        const tis = matchTests(t, r.item || allText);
        if (tis.length === 1) add(`seqResults.${t.tag}_${tis[0]}`, 'seqResults', `${t.tag}_${tis[0]}`, seqLabel(vocab, t.tag, tis[0]));
        else out.unmapped.push({ row: r._row, text: ev.excerpt, reason: tis.length ? 'wording matches more than one test for ' + t.tag : 'no test for ' + t.tag + ' matches the wording' });
      } else if (tags.length > 1) {
        out.unmapped.push({ row: r._row, text: ev.excerpt, reason: 'more than one device named' });
      } else {
        const zv = m.zones.filter(z => z.valid);
        const items = matchZoneItems(r.item || '');
        const ti = matchTableItem(vocab, r.item || allText);
        if (zv.length === 1 && items.length === 1) add(`zoneResults.${zv[0].zone}_${items[0]}`, 'zoneResults', `${zv[0].zone}_${items[0]}`, `Zone ${zv[0].zone} · ${ZONE_LABEL[items[0]]}`);
        else if (ti.item) add(`seqResults.${ti.item.id}`, 'seqResults', ti.item.id, `Table item ${ti.item.id} · ${ti.item.lbl}`);
        else out.unmapped.push({ row: r._row, text: ev.excerpt, reason: ti.ambiguous ? `wording fits both "${ti.ambiguous[0].lbl}" and "${ti.ambiguous[1].lbl}"` : 'no device, zone or Table 1/2 item matches the wording' });
      }
      if (res.value === 'fail' && r.notes) {
        const nm = findMentions(r.notes, vocab);
        const floorsHere = [...new Set([...m.floors, ...nm.floors].map(f => f.label))].filter(f => vocab.floorSet.has(f));
        const stairsHere = [...new Set([...m.stairs, ...nm.stairs].filter(s => !s.generic).map(s => s.name))];
        const zonesHere = [...new Set([...m.zones, ...nm.zones].filter(z => z.valid).map(z => 'Zone ' + z.zone))];
        const defTags = [...new Set([...tags, ...nm.tags.map(t => t.tag)])];
        const loc = [...new Set([r.location, ...stairsHere, ...defTags, ...zonesHere, ...floorsHere.map(f => (f === 'Lobby' ? 'Lobby' : 'Level ' + f))].filter(Boolean))].join(', ');
        out.deficiencies.push({ deficiency: { loc, sev: 'Deficiency', desc: r.notes, action: '' }, confidence: 'medium', method: 'checklist:failed row with a comment', evidence: [ev],
          keys: { tags: defTags, zones: zonesHere, stairs: stairsHere, floors: floorsHere } });
        if (!loc) out.openItems.push({ label: 'New deficiency: location', reason: 'Failed checklist row has a comment but no location; location left blank.', evidence: [ev] });
      }
      void mapped;
    }
  }
  return out;
}

module.exports = { extractChecklist, normResult, CHECKLIST_ALIASES: ALIASES };

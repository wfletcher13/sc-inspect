'use strict';
// Rule-based extraction: walks transcript segments in order and turns what was said into candidate
// values for exact keys of the SC Inspect record. Nothing here guesses: when the target or the value
// is not clear, the statement becomes an open item instead of a candidate.
const { normalizeSpokenNumbers, parseQuantities, parseBareNumbers, formatValue } = require('./units');
const { findMentions, matchTests, matchZoneItems } = require('./matcher');

const RESULT = {
  notTested: /\b(?:not\s+tested|untested|did\s*n[o']?t\s+test|could\s*n[o']?t\s+test|unable\s+to\s+test|not\s+able\s+to\s+test|skip(?:ped|ping)?|defer(?:red)?|come\s+back\s+to)\b/i,
  failNeg: /\b(?:did\s*n[o']?t|does\s*n[o']?t|do\s+not|not|never|wo\s*n[o']?t|did\s+not)\s+pass(?:es|ed)?\b/i,
  fail: /\b(?:fail(?:s|ed|ing|ure)?|no\s+good)\b/i,
  pass: /\b(?:pass(?:es|ed|ing)?)\b/i,
  na: /\b(?:n\/a|not\s+applicable)\b/i,
};
const ALL_RE = /\b(?:all|everything|every\s+column|all\s+columns|all\s+three)\b[^.;]{0,30}\b(?:pass(?:es|ed)?|fail(?:s|ed)?)\b/i;
const RESET_RE = /\b(?:reset(?:ting)?\s+(?:the\s+)?(?:panel|system|alarm|fa|fire\s+alarm)|panel\s+reset|system\s+reset|reset)\b/i;
const DEFIC_RE = /\b(?:deficiency|deficient|write\s+(?:that|this|it)\s+up|write-?\s?up|observation|note\s+that|noting)\b|^\s*note\s*[:,-]/i;
const LATCH_FAIL = /\b(?:did\s*n[o']?t|does\s*n[o']?t|not|no|fail(?:s|ed)?\s+to|wo\s*n[o']?t|never)\s+(?:close\s+and\s+)?latch(?:ed|es|ing)?\b|\bno\s+latch\b|\bnot\s+latching\b/i;
const LATCH_OK = /\b(?:closed\s+and\s+latched|latch(?:ed|es)\b|latching\s+(?:ok|fine|good)|latch\s+ok)\b/i;
const PRESSURE_KW = /\b(?:delta\s*p|d\s?p|differential|pressure|static)\b/i;
const BRK_KW = /\bbreak(?:\s*-?\s*away)?\b|\bbreakaway\b|\binitial\b|\bunlatch\w*|\brelease\b|\bto\s+(?:start|set)\b/i;
const SWG_KW = /\bswing(?:ing)?\b|\bfull(?:y)?\s+open\w*|\bopen\s+fully\b|\bmoving\b|\btravel\b/i;
const STATE_RE = /\b(running|started|stopped|shut\s+down|(?:is|came|turned|shows|went)\s+(?:on|off)|opened|closed|in\s+auto)\b/gi;
const DEFIC_LEAD = /^\s*(?:please\s+|okay,?\s+|ok,?\s+)?(?:write\s+(?:that|this|it)\s+up(?:\s+as\s+(?:a|an)\s+(?:deficiency|observation))?|that'?s\s+(?:a|an)\s+(?:deficiency|observation)|deficiency|observation|note(?:\s+that)?)\s*[:,.-]?\s*/i;

const FIELD_LABEL = { dp: 'ΔP (in. w.g.)', brk: 'Break (lbf)', swg: 'Swing (lbf)', cl: 'Close / latch' };
const ZONE_LABEL = { fans: 'Fans start (purge)', dampers: 'Dampers operate', isolate: 'Adjacent zones isolate' };

function evidenceOf(seg, source = 'transcript') {
  return { source, file: seg.file, line: seg.line ?? null, index: seg.index, jsonIndex: seg.jsonIndex ?? null, timestamp: seg.startLabel || '', speaker: seg.speaker || '', excerpt: seg.text };
}

function withinWindow(ctxSeg, seg, maxSegs, maxSecs) {
  if (!ctxSeg || ctxSeg.file !== seg.file) return false;
  if (ctxSeg.start != null && seg.start != null) return seg.start - ctxSeg.start <= maxSecs && seg.start >= ctxSeg.start;
  return seg.index - ctxSeg.index <= maxSegs;
}

function resultOf(text) {
  const r = { notTested: RESULT.notTested.test(text), na: RESULT.na.test(text) };
  const failNeg = RESULT.failNeg.test(text);
  const t2 = text.replace(RESULT.failNeg, ' ');
  r.fail = failNeg || RESULT.fail.test(t2);
  r.pass = RESULT.pass.test(t2);
  const vals = ['pass', 'fail', 'na'].filter(k => r[k]);
  r.value = r.notTested ? null : vals.length === 1 ? vals[0] : null;
  r.ambiguous = !r.notTested && vals.length > 1;
  r.any = r.notTested || vals.length > 0;
  return r;
}

function blockLabel(vocab, prefix) { return (vocab.blocks.find(b => b.prefix === prefix) || {}).label || prefix; }
function matrixColLabel(vocab, key) { return (vocab.matrixCols.find(c => c.key === key) || {}).label || key; }

function seqLabel(vocab, tag, ti) {
  const t = vocab.tags.find(x => x.tag === tag); const test = t && t.tests[ti];
  return test ? `${tag} · ${test.event}: ${test.action}` : `${tag} · test ${ti}`;
}

// Extract from one list of segments (one transcript, or one photo caption / checklist note).
// opts: { source: 'transcript'|'photo'|'checklist', carryContext: bool, maxConfidence: 'high'|'medium' }
function extractSegments(segments, vocab, opts = {}) {
  const source = opts.source || 'transcript';
  const carry = opts.carryContext !== false;
  const cap = c => (opts.maxConfidence === 'medium' && c === 'high' ? 'medium' : c);
  const out = { candidates: [], openItems: [], measurements: [], deficiencies: [], notTested: [] };
  const ctx = { floor: null, shaft: null, door: null, tag: null, zone: null, alarm: null, pending: null };
  const WIN = { segs: 8, secs: 300 };

  for (const seg of segments) {
    const raw = seg.text;
    const text = normalizeSpokenNumbers(raw);
    const ev = evidenceOf(seg, source);
    const m = findMentions(text, vocab);
    const question = /\?\s*$/.test(raw.trim());
    const res = resultOf(text);
    const emitted = [];
    const open = (label, reason, extra = {}) => out.openItems.push({ label, reason, evidence: [ev], ...extra });
    const cand = (map, key, field, value, confidence, method, label) => {
      const c = { path: field ? `${map}.${key}.${field}` : `${map}.${key}`, map, key, field: field || null, value, confidence: cap(confidence), method, label, evidence: [ev] };
      emitted.push(c);
    };

    const validFloors = [...new Set(m.floors.map(f => f.label))];
    const invalidFloors = validFloors.filter(f => !vocab.floorSet.has(f));
    const floorsHere = validFloors.filter(f => vocab.floorSet.has(f));
    const alarmHere = m.alarmFloor && vocab.floorSet.has(m.alarmFloor.label) ? m.alarmFloor.label : null;
    const alarm = alarmHere ? { floor: alarmHere, seg, here: true } : (carry && ctx.alarm && withinWindow(ctx.alarm.seg, seg, 30, 900) ? { ...ctx.alarm, here: false } : null);
    const tagNames = [...new Set(m.tags.map(t => t.tag))];

    let consumedResult = false;

    // ── A. per-device tests (Appendix A-1) ──
    const otherSubject = m.stairs.length || m.hoistways.length || m.zones.length || m.floors.length || m.corridor || m.corridorDampers;
    if (tagNames.length === 1 || (tagNames.length === 0 && ctx.tag && carry && !otherSubject)) {
      const tagHere = tagNames.length === 1;
      const tagName = tagHere ? tagNames[0] : (withinWindow(ctx.tag.seg, seg, 3, 90) ? ctx.tag.tag : null);
      const t = tagName && vocab.tags.find(x => x.tag === tagName);
      if (t) {
        const tis = matchTests(t, text);
        if (res.any && tis.length === 1) {
          const conf = tagHere ? 'high' : 'medium';
          if (res.notTested) out.notTested.push({ label: seqLabel(vocab, t.tag, tis[0]), path: `seqResults.${t.tag}_${tis[0]}`, evidence: [ev] });
          else if (res.value) cand('seqResults', `${t.tag}_${tis[0]}`, null, res.value, conf, tagHere ? 'rule:tag+test+result' : 'rule:test+result, tag from earlier statement', seqLabel(vocab, t.tag, tis[0]));
          else if (res.ambiguous) open(seqLabel(vocab, t.tag, tis[0]), 'Both a pass and a fail word in the same statement.');
          consumedResult = true;
        } else if (res.any && tis.length > 1 && tagHere) {
          open(`${t.tag} · ${tis.map(i => t.tests[i].action).join(' / ')}`, 'Statement matches more than one test for this device; which test the result belongs to is not clear.');
          consumedResult = true;
        } else if (!res.any && tis.length === 1 && tagHere) {
          ctx.pending = { kind: 'seq', tag: t.tag, ti: tis[0], seg };
        } else if (res.any && tis.length === 0 && tagHere && !(alarm && t.isFan && !t.isZone && vocab.matrixCols.some(c => c.key === 'fan_' + t.tag)) && !m.zones.length) {
          if (res.notTested) out.notTested.push({ label: `${t.tag} (all tests)`, path: `seqResults.${t.tag}_*`, evidence: [ev] });
          else open(`${t.tag}`, 'A result was stated for this device but not which test (override on/off, disconnect, belt, duct detector, VFD) and no floor was in alarm.');
          consumedResult = true;
        }
      }
    } else if (tagNames.length > 1 && res.any && !alarm) {
      open(tagNames.join(', '), 'Result stated with more than one device named; not assigned to any of them.');
      consumedResult = true;
    }

    // ── C. lower-level zones (A-2(b)) ──
    if (!consumedResult && res.any) {
      const zHere = m.zones.filter(z => z.valid);
      const zone = zHere.length === 1 ? zHere[0].zone : (!m.zones.length && carry && ctx.zone && withinWindow(ctx.zone.seg, seg, 3, 120) ? ctx.zone.zone : null);
      if (m.zones.some(z => !z.valid)) { open(m.zones.map(z => 'Zone ' + z.zone).join(', '), 'Zone named in the recording is not a zone in the pre-test JSON.'); consumedResult = true; }
      else if (zHere.length > 1) { open(zHere.map(z => 'Zone ' + z.zone).join(', '), 'More than one zone named with a result.'); consumedResult = true; }
      else if (zone) {
        const items = ALL_RE.test(text) ? ['fans', 'dampers', 'isolate'] : matchZoneItems(text);
        const conf = zHere.length === 1 && !ALL_RE.test(text) ? 'high' : 'medium';
        if (res.notTested) out.notTested.push({ label: `Zone ${zone}${items.length ? ' · ' + items.map(i => ZONE_LABEL[i]).join(', ') : ''}`, path: `zoneResults.${zone}_*`, evidence: [ev] });
        else if (!res.value) open(`Zone ${zone}`, 'Both a pass and a fail word in the same statement.');
        else if (items.length === 1 || ALL_RE.test(text)) items.forEach(i => cand('zoneResults', `${zone}_${i}`, null, res.value, conf, ALL_RE.test(text) ? 'rule:zone+"all"+result' : (zHere.length ? 'rule:zone+item+result' : 'rule:item+result, zone from earlier statement'), `Zone ${zone} · ${ZONE_LABEL[i]}`));
        else if (items.length > 1) open(`Zone ${zone} · ${items.map(i => ZONE_LABEL[i]).join(' / ')}`, 'Statement names more than one zone column with a single result.');
        else if (zHere.length) open(`Zone ${zone}`, 'Result stated for the zone without saying which column (fans, dampers, adjacent zones isolate).');
        else open(`Zone ${zone}?`, `Result stated without a device, test or zone column. Zone ${zone} was named just before, but the result was not assigned to it.`);
        if (zone) consumedResult = true;
      }
    }

    // ── B. floor sequence matrix (A-2) ──
    if (!consumedResult && res.any && alarm) {
      const cols = [];
      const fanTags = tagNames.filter(n => vocab.matrixCols.some(c => c.key === 'fan_' + n));
      fanTags.forEach(n => cols.push('fan_' + n));
      if (m.corridorDampers && vocab.matrixCols.some(c => c.key === 'corr_dampers')) cols.push('corr_dampers');
      const all = ALL_RE.test(text) && !cols.length;
      const keys = all ? vocab.matrixCols.map(c => c.key) : cols;
      const conf = alarm.here && !all ? 'high' : 'medium';
      if (res.notTested && keys.length) out.notTested.push({ label: `Matrix L${alarm.floor} · ${keys.map(k => matrixColLabel(vocab, k)).join(', ')}`, path: `matrixResults.${alarm.floor}_*`, evidence: [ev] });
      else if (keys.length && res.value && (keys.length === 1 || all)) keys.forEach(k => cand('matrixResults', `${alarm.floor}_${k}`, null, res.value, conf, all ? 'rule:alarm floor+"all"+result' : (alarm.here ? 'rule:alarm floor+column+result' : 'rule:column+result, alarm floor from earlier statement'), `Matrix L${alarm.floor} · ${matrixColLabel(vocab, k)}`));
      else if (keys.length > 1) open(`Matrix L${alarm.floor} · ${keys.map(k => matrixColLabel(vocab, k)).join(' / ')}`, 'One result stated for several matrix columns without "all"; not assigned.');
      else if (keys.length && res.ambiguous) open(`Matrix L${alarm.floor}`, 'Both a pass and a fail word in the same statement.');
      if (keys.length) consumedResult = true;
    }

    // pending subject from the previous statement ("SPF-1 override on." ... "Pass.")
    if (!consumedResult && res.any && carry && ctx.pending && !tagNames.length && !m.zones.length && withinWindow(ctx.pending.seg, seg, 2, 60)) {
      const p = ctx.pending;
      if (res.notTested) out.notTested.push({ label: seqLabel(vocab, p.tag, p.ti), path: `seqResults.${p.tag}_${p.ti}`, evidence: [ev, evidenceOf(p.seg, source)] });
      else if (res.value) { cand('seqResults', `${p.tag}_${p.ti}`, null, res.value, 'medium', 'rule:result, device and test from the previous statement', seqLabel(vocab, p.tag, p.ti)); emitted.at(-1).evidence.unshift(evidenceOf(p.seg, source)); }
      consumedResult = true;
      ctx.pending = null;
    }

    // ── D. pressure difference, door force, close/latch (A-2b) ──
    const qs = parseQuantities(text);
    const pressureQs = qs.filter(q => q.kind === 'pressure');
    const forceQs = qs.filter(q => q.kind === 'force');
    const bare = parseBareNumbers(text, m.spans);
    const latchFail = LATCH_FAIL.test(text), latchOk = !latchFail && LATCH_OK.test(text);
    const dpBare = !pressureQs.length && PRESSURE_KW.test(text) ? bare.filter(b => Math.abs(b.value) > 0 && Math.abs(b.value) < 0.5) : [];
    const forceBare = [];
    if (!forceQs.length) for (const b of bare) {
      if (b.value < 1 || b.value > 100) continue;
      const before = text.slice(Math.max(0, b.index - 25), b.index);
      if (BRK_KW.test(before) || SWG_KW.test(before)) forceBare.push({ kind: 'force', value: b.value, raw: b.raw, index: b.index, end: b.end, bare: true });
    }
    const hasPress = pressureQs.length || forceQs.length || dpBare.length || forceBare.length || latchFail || latchOk;
    if (hasPress) {
      // which shaft/door
      let prefix = null, shaftHere = false, why = '';
      const stairsHere = [...new Set(m.stairs.map(s => s.name))];
      const hwHere = [...new Set(m.hoistways.map(h => h.name))];
      const genericOnly = m.stairs.length ? m.stairs.every(s => s.generic) : m.hoistways.every(h => h.generic);
      const doorFor = stair => {
        const blocks = vocab.blocks.filter(b => b.short === stair || b.short === stair + ' vest');
        if (!vocab.vest) return blocks.find(b => b.kind === 'stair');
        const door = m.door || (carry && ctx.door && ctx.shaft && ctx.shaft.name === stair && withinWindow(ctx.door.seg, seg, WIN.segs, WIN.secs) ? ctx.door.door : null);
        if (door === 'vest') return blocks.find(b => b.kind === 'vest');
        if (door === 'stair') return blocks.find(b => b.kind === 'stairv');
        return null;
      };
      if (stairsHere.length + hwHere.length > 1) why = `More than one shaft named (${[...stairsHere, ...hwHere].join(', ')}).`;
      else if (stairsHere.length === 1) { const b = doorFor(stairsHere[0]); if (b) { prefix = b.prefix; shaftHere = !genericOnly; } else why = `${stairsHere[0]} has a vestibule: the statement does not say stair door or vestibule door.`; }
      else if (hwHere.length === 1) { const h = vocab.hoistways.find(x => x.name === hwHere[0]); if (h && h.block) { prefix = h.block.prefix; shaftHere = !genericOnly; } }
      else if (m.corridor) { const b = vocab.blocks.find(x => x.kind === 'corr'); if (b) { prefix = b.prefix; shaftHere = true; } }
      else if (carry && ctx.shaft && withinWindow(ctx.shaft.seg, seg, WIN.segs, WIN.secs)) {
        if (ctx.shaft.kind === 'stair') { const b = doorFor(ctx.shaft.name); if (b) prefix = b.prefix; else why = `${ctx.shaft.name} has a vestibule: the statement does not say stair door or vestibule door.`; }
        else prefix = ctx.shaft.prefix;
      } else why = 'No stair, hoistway or corridor named in this or the preceding statements.';
      // which level
      let floor = null, floorHere = false;
      if (floorsHere.length === 1) { floor = floorsHere[0]; floorHere = true; }
      else if (floorsHere.length > 1) why = why || `More than one level named (${floorsHere.join(', ')}).`;
      else if (invalidFloors.length) why = why || `Level ${invalidFloors.join(', ')} is not in the building's floor range in the pre-test JSON.`;
      else if (carry && ctx.floor && withinWindow(ctx.floor.seg, seg, WIN.segs, WIN.secs)) floor = ctx.floor.floor;
      else why = why || 'No level named in this or the preceding statements.';

      const blk = prefix && vocab.blocks.find(b => b.prefix === prefix);
      const vals = [];
      const push = (field, value, raw, bareNum, conv) => vals.push({ field, value, raw, bare: bareNum, conv });
      if (pressureQs.length > 1 && new Set(pressureQs.map(q => q.value)).size > 1) open(`${blk ? blk.label : 'Pressure'}${floor ? ' · L' + floor : ''} · ΔP`, `More than one pressure value in one statement (${pressureQs.map(q => q.raw).join(', ')}); not assigned.`, { values: pressureQs.map(q => q.raw) });
      else if (pressureQs.length) push('dp', pressureQs[0].value, pressureQs[0].raw, false, pressureQs[0].converted);
      else if (dpBare.length === 1) push('dp', dpBare[0].value, dpBare[0].raw, true);
      else if (dpBare.length > 1) open('ΔP', `Several unitless numbers after a pressure word (${dpBare.map(b => b.raw).join(', ')}); not assigned.`);
      const forces = forceQs.length ? forceQs : forceBare;
      forces.forEach((q, i) => {
        const prevEnd = i === 0 ? 0 : forces[i - 1].end;
        const before = text.slice(Math.max(prevEnd, q.index - 40), q.index);
        const after = text.slice(q.end, Math.min(text.length, q.end + 20, forces[i + 1] ? forces[i + 1].index : Infinity));
        const b = BRK_KW.test(before) || (!SWG_KW.test(before) && BRK_KW.test(after));
        const s = SWG_KW.test(before) || (!BRK_KW.test(before) && SWG_KW.test(after));
        if (b && !s) push('brk', q.value, q.raw, !!q.bare, q.converted);
        else if (s && !b) push('swg', q.value, q.raw, !!q.bare, q.converted);
        else open(`${blk ? blk.label : 'Door force'}${floor ? ' · L' + floor : ''} · door force`, `Door force ${q.raw} stated without "break" or "swing" (or with both); the app records break-away and swing separately.`, { values: [q.raw] });
      });
      if (latchFail || latchOk) {
        if (blk && !blk.cl) open(`${blk.label}${floor ? ' · L' + floor : ''} · close/latch`, 'Latch stated for a shaft the app does not record latching for.');
        else push('cl', latchFail ? 'fail' : 'pass', latchFail ? 'did not latch' : 'latched', false);
      }
      for (const v of vals) {
        const label = `${blk ? blk.label : '?'} · L${floor || '?'} · ${FIELD_LABEL[v.field]}`;
        if (!prefix || !floor) { open(`${blk ? blk.label : 'Pressure / door force'}${floor ? ' · L' + floor : ''} · ${FIELD_LABEL[v.field]}`, why || 'Shaft or level not identified.', { values: [v.raw] }); continue; }
        if (question) { open(label, 'Stated as a question, not a reading.', { values: [v.raw] }); continue; }
        const conf = shaftHere && floorHere && !v.bare ? 'high' : 'medium';
        const how = [shaftHere ? 'shaft stated' : 'shaft from earlier statement', floorHere ? 'level stated' : 'level from earlier statement', v.bare ? 'unit not stated (pressure/force word + plausible range)' : 'value with unit'].join(', ');
        const value = v.field === 'cl' ? v.value : formatValue(v.field === 'dp' ? 'pressure' : 'force', v.value);
        cand('floors', `${prefix}_${floor}`, v.field, value, conf, `rule:${how}`, label);
        if (v.conv) emitted.at(-1).note = `converted from ${v.conv.from}`;
      }
    }

    // ── airflow and equipment states (no slot in the schema; reported for review) ──
    for (const q of qs.filter(x => x.kind === 'airflow')) {
      const tag = tagNames.length === 1 ? tagNames[0] : (tagNames.length === 0 && carry && ctx.tag && withinWindow(ctx.tag.seg, seg, 3, 120) ? ctx.tag.tag : null);
      const t = tag && vocab.tags.find(x => x.tag === tag);
      out.measurements.push({ kind: 'airflow', tag: tag || '', value: q.value, unit: 'CFM', raw: q.raw, design: t ? t.cfm : '', confidence: tag ? (tagNames.length === 1 ? 'high' : 'medium') : 'low', evidence: [ev], note: tag ? '' : 'Device not identified.' });
    }
    if (tagNames.length === 1 && !res.any) {
      const t = vocab.tags.find(x => x.tag === tagNames[0]);
      const states = [...new Set([...text.matchAll(STATE_RE)].map(x => x[1].toLowerCase()))].filter(s => !(s === 'on' && /override\s+on/i.test(text)) && !(s === 'off' && /override\s+off/i.test(text)));
      if (states.length && t) out.measurements.push({ kind: 'state', tag: t.tag, value: states.join(', '), unit: '', raw: states.join(', '), confidence: 'high', evidence: [ev] });
    }

    // ── deficiencies stated in the recording ──
    if (DEFIC_RE.test(text)) {
      const sev = /\bobservation\b/i.test(text) ? 'Observation' : (/^\s*note\b|\bnote\s+that\b|\bnoting\b/i.test(text) && !/\bdeficien/i.test(text)) ? 'Note' : 'Deficiency';
      const locParts = [];
      let locHere = true;
      const stairsHere = [...new Set(m.stairs.filter(s => !s.generic).map(s => s.name))];
      const hwHere = [...new Set(m.hoistways.filter(h => !h.generic).map(h => h.name))];
      const zHere = m.zones.filter(z => z.valid).map(z => 'Zone ' + z.zone);
      if ((m.corridor || m.corridorDampers) && !stairsHere.length && !hwHere.length) locParts.push('Corridor');
      locParts.push(...stairsHere, ...hwHere, ...tagNames, ...zHere);
      if (floorsHere.length) locParts.push(...floorsHere.map(f => (f === 'Lobby' ? 'Lobby' : 'Level ' + f)));
      if (!locParts.length && carry) {
        locHere = false;
        if (ctx.shaft && withinWindow(ctx.shaft.seg, seg, WIN.segs, WIN.secs)) locParts.push(ctx.shaft.name);
        if (ctx.floor && withinWindow(ctx.floor.seg, seg, WIN.segs, WIN.secs)) locParts.push('Level ' + ctx.floor.floor);
        if (!locParts.length && ctx.tag && withinWindow(ctx.tag.seg, seg, 3, 120)) locParts.push(ctx.tag.tag);
        if (!locParts.length && ctx.zone && withinWindow(ctx.zone.seg, seg, 3, 120)) locParts.push('Zone ' + ctx.zone.zone);
      }
      const loc = locParts.join(', ');
      let desc = raw.replace(DEFIC_LEAD, '').trim();
      desc = desc ? desc[0].toUpperCase() + desc.slice(1) : raw.trim();
      out.deficiencies.push({
        deficiency: { loc, sev, desc, action: '' },
        confidence: cap(loc ? (locHere ? 'high' : 'medium') : 'low'), method: loc ? (locHere ? 'rule:spoken deficiency, location stated' : 'rule:spoken deficiency, location from earlier statements') : 'rule:spoken deficiency, location not identified',
        evidence: [ev], keys: { tags: tagNames, zones: zHere, stairs: stairsHere, floors: floorsHere },
      });
      if (!loc) open('New deficiency: location', 'A deficiency was stated but no location could be identified; location left blank.', {});
    }

    // question guard: nothing asked as a question becomes a value
    for (const c of emitted) {
      if (question && c.map !== 'floors') open(c.label, 'Stated as a question, not a result.', { values: [c.value] });
      else out.candidates.push(c);
    }

    // ── update carried context ──
    if (carry) {
      if (floorsHere.length === 1) ctx.floor = { floor: floorsHere[0], seg };
      else if (floorsHere.length > 1) ctx.floor = null;
      const stairsHere = [...new Set(m.stairs.map(s => s.name))], hwHere = [...new Set(m.hoistways.map(h => h.name))];
      if (stairsHere.length + hwHere.length === 1) {
        if (stairsHere.length) ctx.shaft = { kind: 'stair', name: stairsHere[0], seg };
        else { const h = vocab.hoistways.find(x => x.name === hwHere[0]); ctx.shaft = h && h.block ? { kind: 'elev', name: h.name, prefix: h.block.prefix, seg } : null; }
      } else if (stairsHere.length + hwHere.length > 1) ctx.shaft = null;
      else if (m.corridor) { const b = vocab.blocks.find(x => x.kind === 'corr'); ctx.shaft = b ? { kind: 'corr', name: 'Corridor', prefix: b.prefix, seg } : null; }
      if (m.door === 'vest' || m.door === 'stair') ctx.door = { door: m.door, seg };
      if (tagNames.length === 1) ctx.tag = { tag: tagNames[0], seg };
      else if (tagNames.length > 1) ctx.tag = null;
      const zv = m.zones.filter(z => z.valid);
      if (zv.length === 1) ctx.zone = { zone: zv[0].zone, seg };
      if (alarmHere) ctx.alarm = { floor: alarmHere, seg };
      if (RESET_RE.test(text) && !alarmHere) ctx.alarm = null;
      if (consumedResult || (tagNames.length && !(ctx.pending && ctx.pending.seg === seg))) { if (!(ctx.pending && ctx.pending.seg === seg)) ctx.pending = null; }
    }
    if (!consumedResult && res.any && !emitted.length && !question && (res.value || res.ambiguous) && !hasPress && !DEFIC_RE.test(text)) {
      out.openItems.push({ label: 'Unassigned result', reason: `"${res.value || 'pass/fail'}" stated but no device test, zone or alarm floor could be identified.`, evidence: [ev] });
    }
  }
  return out;
}

module.exports = { extractSegments, resultOf, evidenceOf, FIELD_LABEL, ZONE_LABEL, seqLabel, blockLabel, matrixColLabel };

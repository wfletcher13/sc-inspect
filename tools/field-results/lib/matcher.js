'use strict';
// Builds the vocabulary of one building from its pre-test JSON (tags, levels, shafts, zones, tests) using
// the app's own model functions, and finds mentions of that vocabulary in a piece of text.

const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// "SPF-1" -> matches "SPF-1", "SPF 1", "spf1", "S.P.F. 1", "SPF-01"; never "SPF-10" or "SSPF-1".
function tagRegex(tag) {
  const groups = String(tag).match(/[A-Za-z]+|\d+/g) || [];
  if (!groups.length) return null;
  const body = groups.map(g => (/^\d+$/.test(g) ? `0*${+g}` : g.split('').map(escRe).join('\\.?\\s?') + '\\.?')).join('[\\s._/-]*');
  return new RegExp(`(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])`, 'gi');
}

// Phrases for each per-device test the app generates, keyed "event|action" (see getSeqTests in index.html).
const TEST_PATTERNS = {
  'FSCP|Manual override ON': /\b(?:manual\s+)?override\s+(?:to\s+|is\s+|was\s+)?on\b|\b(?:fscp|switch(?:ed)?|command(?:ed)?)\s+(?:to\s+|it\s+)?on\b|\bhand\s+on\b/i,
  'FSCP|Manual override OFF': /\b(?:manual\s+)?override\s+(?:to\s+|is\s+|was\s+)?off\b|\b(?:fscp|switch(?:ed)?|command(?:ed)?)\s+(?:to\s+|it\s+)?off\b|\b(?:back|return(?:ed|s)?)\s+to\s+auto\b/i,
  'Power loss|Disconnect switch': /\bdisconnect/i,
  'Power loss|VFD power loss': /\bvfd\b|\bvariable\s+(?:frequency|speed)\s+drive\b/i,
  'Belt-off test|Remove belt, confirm shutdown': /\bbelt/i,
  'Duct detector activation|Fan shutdown': /\bduct\s+det(?:ector)?s?\b/i,
  'Duct det. override|Manual override ON': /\bduct\s+det(?:ector)?s?\b[^.;]*\boverride|\boverride\b[^.;]*\bduct\s+det/i,
  'FSCP|Switch to OPEN': /\b(?:switch(?:ed)?|command(?:ed)?|fscp|override)\s+(?:to\s+)?open\b|\bopen(?:ed|s)?\b/i,
  'FSCP|Switch to CLOSED': /\bclos(?:e|ed|es|ing)\b/i,
  'FSCP|Return to AUTO': /\bauto(?:matic)?\b/i,
  'Power loss|Disconnect': /\bdisconnect|\bpower\s+loss\b/i,
};

const ZONE_ITEM_PATTERNS = {
  isolate: /\bisolat\w*|\badjacent\b/i,
  dampers: /\bdampers?\b/i,
  fans: /\bfans?\b|\bpurge\w*|\bexhaust\w*/i,
};

function buildVocabulary(project, model) {
  const floors = model.getFloors(project);
  const tags = project.equipment.filter(e => e.tag).map(e => {
    const tests = model.getSeqTests(e).map((t, ti) => ({ ti, ...t, key: `${t.event}|${t.action}`, re: TEST_PATTERNS[`${t.event}|${t.action}`] || null }));
    return { tag: e.tag, eq: e, re: tagRegex(e.tag), isZone: model.isZoneEq(e), isFan: model.isFan(e), zone: model.zoneInfo(e).zone, tests, cfm: e.cfm || '' };
  }).filter(t => t.re);
  const blocks = model.pressBlocks(project);
  const vest = !!project.systems.vest;
  const stairNames = (project.systems.stair || vest) ? (project.stairwells || []) : [];
  const stairs = stairNames.map(name => {
    const words = name.trim().split(/\s+/);
    let re;
    if (/^stair/i.test(words[0])) {
      const rest = words.slice(1).join(' ');
      const restRe = rest ? (rest.match(/[A-Za-z]+|\d+/g) || []).map(g => (/^\d+$/.test(g) ? `0*${+g}` : escRe(g))).join('[\\s-]*') : '';
      re = new RegExp(`\\bstair(?:well|way|case)?${restRe ? `\\s*(?:#|no\\.?|number)?\\s*${restRe}(?![A-Za-z0-9])` : '\\b'}`, 'gi');
    } else if (/^[A-Za-z0-9]{1,3}$/.test(name)) {
      re = new RegExp(`\\bstair(?:well|way|case)?\\s*${escRe(name)}(?![A-Za-z0-9])`, 'gi');
    } else re = new RegExp(`\\b${words.map(escRe).join('\\s+')}(?![A-Za-z0-9])`, 'gi');
    return { name, re, blocks: blocks.filter(b => b.short === name || b.short === name + ' vest') };
  });
  const hoistways = model.getHoistwayNames(project).map(name => {
    const digits = name.replace(/\D/g, '');
    const alts = [tagRegex(name).source];
    if (digits) alts.push(`\\b(?:elevator|hoistway|car|shaft|el)\\s*(?:#|no\\.?|number)?\\s*0*${+digits}(?![A-Za-z0-9])`);
    return { name, re: new RegExp(alts.join('|'), 'gi'), block: blocks.find(b => b.kind === 'elev' && b.label === name) };
  });
  const zones = model.getZones(project).map(z => ({ zone: z.zone, room: z.room, floor: z.floor, tags: z.tags }));
  const matrixCols = model.getMatrixCols(project);
  const tableItems = [...model.VISUAL_ITEMS, ...model.FAULT_TESTS, ...model.EMERG_TESTS, ...model.INIT_TESTS].map(t => ({ id: t.id, lbl: t.lbl, cat: t.cat || '' }));
  return { project, model, floors, floorSet: new Set(floors), tags, blocks, vest, corr: !!project.systems.corr, stairs, hoistways, zones, matrixCols, tableItems };
}

function allMatches(re, text) {
  const out = []; re.lastIndex = 0; let m;
  while ((m = re.exec(text))) { out.push({ index: m.index, end: m.index + m[0].length, raw: m[0], m }); if (m[0] === '') re.lastIndex++; }
  return out;
}

function floorLabelFrom(raw) {
  const s = raw.replace(/\s+/g, '').toUpperCase();
  if (/^\d+$/.test(s)) return String(+s);
  return s;
}

const FLOOR_RES = [
  /\b(?:level|floor|flr|lvl|story|storey)\s*(?:number\s*|no\.?\s*|#\s*)?(B\s?\d{1,2}|P\s?\d{1,2}|\d{1,3})(?![\d.]*\s*(?:in\b|inch|"|lb|pound|cfm|pa\b|%))(?![A-Za-z0-9])/gi,
  /\b(\d{1,3})(?:st|nd|rd|th)\s+(?:floor|level)\b/gi,
];
const ALARM_CUE = /\b(?:smoke\s+detector|detector|in\s+alarm|alarm\s+(?:on|at|for)|initiat\w*|pull\s+station)\b/i;
const ALARM_BARE_FLOOR = /\b(?:alarm|detector|initiat\w*)\s+(?:on|at|for)\s+(?:level\s+|floor\s+)?(\d{1,3}|lobby)(?![\d.A-Za-z])/i;

function findMentions(text, vocab) {
  const spans = [];
  const floors = [];
  for (const re of FLOOR_RES) for (const x of allMatches(re, text)) { floors.push({ label: floorLabelFrom(x.m[1]), index: x.index, end: x.end, raw: x.raw }); spans.push([x.index, x.end]); }
  for (const x of allMatches(/\b(?:lobby|ground\s+(?:floor|level))\b/gi, text)) { floors.push({ label: 'Lobby', index: x.index, end: x.end, raw: x.raw }); spans.push([x.index, x.end]); }
  for (const x of allMatches(/\bbasement\s*(?:level\s*)?(\d)\b/gi, text)) { floors.push({ label: 'B' + x.m[1], index: x.index, end: x.end, raw: x.raw }); spans.push([x.index, x.end]); }
  let alarmFloor = null;
  if (ALARM_CUE.test(text)) {
    const bare = ALARM_BARE_FLOOR.exec(text);
    if (bare) { const label = /lobby/i.test(bare[1]) ? 'Lobby' : String(+bare[1]); alarmFloor = { label, raw: bare[0] }; if (!floors.some(f => f.label === label)) { floors.push({ label, index: bare.index, end: bare.index + bare[0].length, raw: bare[0] }); spans.push([bare.index, bare.index + bare[0].length]); } }
    else { const uniq = [...new Set(floors.map(f => f.label))]; if (uniq.length === 1) alarmFloor = { label: uniq[0], raw: floors[0].raw }; }
  }
  const tags = [];
  for (const t of vocab.tags) for (const x of allMatches(t.re, text)) tags.push({ tag: t.tag, t, index: x.index, end: x.end, raw: x.raw });
  // a longer tag that overlaps a shorter one wins ("SPF-1A" over "SPF-1")
  const tagsKept = tags.filter(a => !tags.some(b => b !== a && b.index <= a.index && b.end >= a.end && (b.end - b.index) > (a.end - a.index)));
  tagsKept.forEach(t => spans.push([t.index, t.end]));
  const stairs = [];
  for (const s of vocab.stairs) for (const x of allMatches(s.re, text)) { stairs.push({ name: s.name, s, index: x.index, end: x.end, raw: x.raw, generic: false }); spans.push([x.index, x.end]); }
  if (!stairs.length && vocab.stairs.length === 1) {
    const g = /\bstair(?:well|way|case)?s?\b/i.exec(text);
    if (g) stairs.push({ name: vocab.stairs[0].name, s: vocab.stairs[0], index: g.index, end: g.index + g[0].length, raw: g[0], generic: true });
  }
  const hoistways = [];
  for (const h of vocab.hoistways) for (const x of allMatches(h.re, text)) { hoistways.push({ name: h.name, h, index: x.index, end: x.end, raw: x.raw, generic: false }); spans.push([x.index, x.end]); }
  if (!hoistways.length && vocab.hoistways.length === 1) {
    const g = /\b(?:elevator|hoistway)s?\b/i.exec(text);
    if (g && !/\belevator\s+(?:recall|lobby\s+door)\b/i.test(text)) hoistways.push({ name: vocab.hoistways[0].name, h: vocab.hoistways[0], index: g.index, end: g.index + g[0].length, raw: g[0], generic: true });
  }
  const corridor = vocab.corr && /\bcorridors?\b/i.test(text) && !/\bcorridor\s+dampers?\b/i.test(text);
  const zones = [];
  for (const x of allMatches(/\b[Zz][Oo][Nn][Ee](?:\s*(?:#|[Nn]o\.?|[Nn]umber)\s*|\s+)([A-Za-z]?\d{1,3}[A-Za-z]?|[A-Z])(?![A-Za-z0-9])/g, text)) {
    const label = x.m[1];
    const z = vocab.zones.find(zz => zz.zone.toLowerCase() === label.toLowerCase());
    zones.push({ zone: z ? z.zone : label, valid: !!z, index: x.index, end: x.end, raw: x.raw });
    spans.push([x.index, x.end]);
  }
  const vestDoor = /\bvest(?:ibule)?\s+door\b|\bvestibule\s+to\s+corridor\b/i.test(text);
  const stairDoor = /\bstair(?:well)?\s+door\b|\bstair(?:well)?\s+to\s+vestibule\b/i.test(text);
  return {
    floors, alarmFloor, tags: tagsKept, stairs, hoistways, corridor, zones,
    door: vestDoor && stairDoor ? 'both' : vestDoor ? 'vest' : stairDoor ? 'stair' : null,
    corridorDampers: /\bcorridor\s+dampers?\b/i.test(text), spans,
  };
}

// Which of a device's tests does this text name? Returns the list of matching test indexes.
function matchTests(tagEntry, text) {
  let hits = tagEntry.tests.filter(t => t.re && t.re.test(text));
  const has = k => hits.some(t => t.key === k);
  if (has('Duct det. override|Manual override ON')) hits = hits.filter(t => t.key !== 'Duct detector activation|Fan shutdown' && t.key !== 'FSCP|Manual override ON');
  if (has('Power loss|VFD power loss') && has('Power loss|Disconnect switch') && /\bvfd\b[^.;]{0,20}\bpower\s+loss|\bpower\s+loss\b[^.;]{0,20}\bvfd\b/i.test(text) && !/\bdisconnect/i.test(text.replace(/\bvfd\b/ig, ''))) hits = hits.filter(t => t.key !== 'Power loss|Disconnect switch');
  return hits.map(t => t.ti);
}

function matchZoneItems(text) {
  const items = Object.entries(ZONE_ITEM_PATTERNS).filter(([, re]) => re.test(text)).map(([k]) => k);
  if (items.includes('isolate')) return ['isolate'];
  return items;
}

// Token overlap between a free-text checklist item and the app's Table 1 / Table 2 labels.
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'at', 'to', 'in', 'on', 'for', 'are', 'is', 'be', 'by', 'with', 'all', 'if', 'per']);
const tokens = s => new Set(String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w && !STOP.has(w)).map(w => w.replace(/(?:es|s)$/, '')));
function matchTableItem(vocab, text) {
  const tt = tokens(text);
  if (!tt.size) return { item: null, score: 0 };
  const scored = vocab.tableItems.map(it => { const lt = tokens(it.lbl); const inter = [...lt].filter(w => tt.has(w)).length; return { it, score: inter / Math.max(lt.size, 1), inter }; })
    .filter(s => s.inter >= 2).sort((a, b) => b.score - a.score);
  if (!scored.length || scored[0].score < 0.6) return { item: null, score: scored.length ? scored[0].score : 0 };
  if (scored[1] && scored[1].score === scored[0].score) return { item: null, score: scored[0].score, ambiguous: [scored[0].it, scored[1].it] };
  return { item: scored[0].it, score: scored[0].score };
}

module.exports = { buildVocabulary, findMentions, matchTests, matchZoneItems, matchTableItem, tagRegex, TEST_PATTERNS, ZONE_ITEM_PATTERNS };

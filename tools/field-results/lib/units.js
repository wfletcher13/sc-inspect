'use strict';
// Deterministic parsing of spoken or typed quantities: pressure difference, door force, airflow.
// Canonical units are the ones the app records: in. w.g. for pressure, lbf for force, CFM for airflow.

const PA_PER_IN_WC = 248.84;
const N_PER_LBF = 4.44822;

const ONES = { zero:0, oh:0, one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10,
  eleven:11, twelve:12, thirteen:13, fourteen:14, fifteen:15, sixteen:16, seventeen:17, eighteen:18, nineteen:19 };
const TENS = { twenty:20, thirty:30, forty:40, fifty:50, sixty:60, seventy:70, eighty:80, ninety:90 };
const SCALES = { hundred:100, thousand:1000 };
const DIGIT_WORDS = { zero:'0', oh:'0', o:'0', one:'1', two:'2', three:'3', four:'4', five:'5', six:'6', seven:'7', eight:'8', nine:'9' };

const isNumWord = w => w in ONES || w in TENS || w in SCALES;

// Turns spoken numbers into digits: "point zero five" -> "0.05", "twenty eight" -> "28",
// "twelve thousand five hundred" -> "12500", "12 thousand 500" -> "12500", "12.5k CFM" -> "12500 CFM".
function normalizeSpokenNumbers(text) {
  const parts = String(text).split(/(\s+)/);
  const words = [];
  for (let i = 0; i < parts.length; i += 2) {
    const raw = parts[i];
    const m = /^(.*?)([,.;:!?]*)$/.exec(raw);
    words.push({ raw, core: m[1], lw: m[1].toLowerCase(), punct: m[2], ws: parts[i + 1] || '' });
  }
  const isDigits = w => /^\d[\d,]*(\.\d+)?$/.test(w.core);
  const out = [];
  let i = 0;
  // Reads an integer spoken as words starting at k. Returns { value, last } or null.
  const readWords = k => {
    let total = 0, current = 0, last = -1;
    for (let j = k; j < words.length; j++) {
      const x = words[j].lw;
      if (x in ONES && x !== 'oh') current += ONES[x];
      else if (x in TENS) current += TENS[x];
      else if (x === 'hundred' && last >= 0) current = (current || 1) * 100;
      else if (x === 'thousand' && last >= 0) { total += (current || 1) * 1000; current = 0; }
      else if (x === 'and' && last >= 0 && j + 1 < words.length && isNumWord(words[j + 1].lw) && !words[j - 1].punct) continue;
      else break;
      last = j;
      if (words[j].punct) break;
    }
    return last < 0 ? null : { value: total + current, last };
  };
  // Reads "point <digit words>" starting at k (k is the "point" word). Returns { digits, last } or null.
  const readDecimal = k => {
    if (!words[k] || words[k].lw !== 'point') return null;
    let digits = '', last = k;
    for (let j = k + 1; j < words.length; j++) {
      const x = words[j].lw;
      if (x in DIGIT_WORDS) digits += DIGIT_WORDS[x];
      else if (!digits && /^\d+$/.test(words[j].core)) digits = words[j].core;
      else break;
      last = j;
      if (words[j].punct) break;
    }
    return digits ? { digits, last } : null;
  };
  while (i < words.length) {
    const w = words[i];
    if (isDigits(w) && !w.punct && words[i + 1] && (words[i + 1].lw === 'thousand' || words[i + 1].lw === 'hundred')) {
      let value = parseFloat(w.core.replace(/,/g, '')) * SCALES[words[i + 1].lw];
      let last = i + 1;
      if (!words[last].punct && words[last + 1]) {
        if (/^\d+$/.test(words[last + 1].core) && words[i + 1].lw === 'thousand') { value += +words[last + 1].core; last += 1; }
        else { const r = readWords(last + 1); if (r && r.value < 1000) { value += r.value; last = r.last; } }
      }
      out.push(String(value) + words[last].punct + words[last].ws);
      i = last + 1; continue;
    }
    const startsInt = w.lw in ONES && w.lw !== 'oh' || w.lw in TENS;
    const dec0 = w.lw === 'point' ? readDecimal(i) : null;
    if (!startsInt && !dec0) { out.push(w.raw + w.ws); i++; continue; }
    let intVal = 0, last = i - 1, dec = dec0;
    if (startsInt) {
      const r = readWords(i); intVal = r.value; last = r.last;
      if (!words[last].punct) dec = readDecimal(last + 1);
    }
    if (dec) last = dec.last;
    out.push((dec ? `${intVal}.${dec.digits}` : String(intVal)) + words[last].punct + words[last].ws);
    i = last + 1;
  }
  return out.join('')
    .replace(/(\d+(?:\.\d+)?)\s?k\b(?=\s*(?:cfm|c\.f\.m))/gi, (_, n) => String(Math.round(parseFloat(n) * 1000)));
}

const NUM = String.raw`(?<sign>(?:negative|minus|-)\s*)?(?<num>\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d*\.\d+|\d+)`;
const UNIT_PATTERNS = [
  { kind:'pressure', unit:'in_wc', re: String.raw`(?:"|in(?:ches|ch)?\.?)\s*(?:of\s+)?(?:w\.?\s?c\.?|w\.?\s?g\.?|water(?:\s+(?:column|gauge|gage))?|h\s?2\s?o)(?![a-z])|(?:iwc|inwc|in\.?wc|"\s?wc|wc|w\.c\.|w\.g\.|wg)(?![a-z])` },
  { kind:'pressure', unit:'pa', re: String.raw`(?:pa|pascals?)(?![a-z])` },
  { kind:'force', unit:'lbf', re: String.raw`(?:lbf|lbs?\.?|pounds?(?:[\s-]?(?:of\s+)?force)?)(?![a-z])` },
  { kind:'force', unit:'n', re: String.raw`(?:newtons?)(?![a-z])` },
  { kind:'airflow', unit:'cfm', re: String.raw`(?:cfm|c\.f\.m\.?|cubic\s+feet\s+(?:per|a)\s+minute)(?![a-z])` },
];
const QTY_RE = new RegExp(`${NUM}\\s?(?:-\\s?)?(?<unit>${UNIT_PATTERNS.map(u => `(?<u_${u.unit}>${u.re})`).join('|')})`, 'gi');

function round(n, d) { const f = 10 ** d; return Math.round(n * f) / f; }

// Returns every number that carries an explicit unit. `text` should already be spoken-number normalised.
function parseQuantities(text) {
  const out = [];
  QTY_RE.lastIndex = 0;
  let m;
  while ((m = QTY_RE.exec(text))) {
    const g = m.groups;
    const u = UNIT_PATTERNS.find(p => g['u_' + p.unit] !== undefined);
    const before = text.slice(Math.max(0, m.index - 1), m.index);
    if (/[\w.]/.test(before) && !g.sign) continue;
    let value = parseFloat(g.num.replace(/,/g, ''));
    if (isNaN(value)) continue;
    const negative = !!g.sign;
    if (negative) value = -value;
    let converted = null;
    if (u.unit === 'pa') { converted = { from: `${value} Pa` }; value = round(value / PA_PER_IN_WC, 3); }
    if (u.unit === 'n') { converted = { from: `${value} N` }; value = round(value / N_PER_LBF, 1); }
    const canonical = { pressure:'in. w.g.', force:'lbf', airflow:'CFM' }[u.kind];
    out.push({ kind: u.kind, value, unit: canonical, raw: m[0].trim(), index: m.index, end: m.index + m[0].length, converted, negative });
  }
  return out;
}

// Numbers without a unit, excluding anything already claimed by parseQuantities and anything that is
// part of a floor/zone/tag reference (caller passes those spans in `exclude`).
function parseBareNumbers(text, exclude = []) {
  const claimed = [...parseQuantities(text).map(q => [q.index, q.end]), ...exclude];
  const re = new RegExp(NUM, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(text))) {
    const s = m.index, e = s + m[0].length;
    if (claimed.some(([a, b]) => s < b && e > a)) continue;
    const prev = text.slice(Math.max(0, s - 1), s), next = text.slice(e, e + 1);
    if (/[A-Za-z\d:-]/.test(prev) && !m.groups.sign) continue;
    if (/[A-Za-z\d:]/.test(next)) continue;
    let value = parseFloat(m.groups.num.replace(/,/g, ''));
    if (m.groups.sign) value = -value;
    out.push({ value, raw: m[0].trim(), index: s, end: e });
  }
  return out;
}

function formatValue(kind, v) {
  if (kind === 'pressure') return String(round(v, 3));
  if (kind === 'force') return String(round(v, 1));
  return String(Math.round(v));
}

module.exports = { normalizeSpokenNumbers, parseQuantities, parseBareNumbers, formatValue, PA_PER_IN_WC, N_PER_LBF };

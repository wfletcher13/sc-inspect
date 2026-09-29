'use strict';
// Minimal CSV and XLSX readers (no dependencies). Both return { sheets: [{ name, rows: string[][] }] }.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function parseCsv(text) {
  text = String(text).replace(/^\uFEFF/, '');
  const delim = (text.split(/\r?\n/, 1)[0].match(/\t/g) || []).length > (text.split(/\r?\n/, 1)[0].match(/,/g) || []).length ? '\t' : ',';
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"' && field === '') q = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => String(c).trim() !== ''));
}

function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip/xlsx file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip central directory');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    const lnlen = buf.readUInt16LE(off + 26), lelen = buf.readUInt16LE(off + 28);
    const data = buf.slice(off + 30 + lnlen + lelen, off + 30 + lnlen + lelen + csize);
    files[name] = method === 0 ? data : method === 8 ? zlib.inflateRawSync(data) : null;
    p += 46 + nlen + elen + clen;
  }
  return files;
}

const decodeXml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');
const textOf = xml => { const out = []; const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g; let m; while ((m = re.exec(xml))) out.push(decodeXml(m[1])); return out.join(''); };
const colIndex = ref => { const letters = /^[A-Z]+/.exec(ref)[0]; let n = 0; for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

function parseXlsx(buf) {
  const files = unzip(buf);
  const str = n => (files[n] ? files[n].toString('utf8') : '');
  const shared = [];
  const ss = str('xl/sharedStrings.xml');
  { const re = /<si>([\s\S]*?)<\/si>/g; let m; while ((m = re.exec(ss))) shared.push(textOf(m[1])); }
  const rels = {};
  { const re = /<Relationship\b[^>]*>/g; let m; const x = str('xl/_rels/workbook.xml.rels'); while ((m = re.exec(x))) { const id = /Id="([^"]+)"/.exec(m[0]), t = /Target="([^"]+)"/.exec(m[0]); if (id && t) rels[id[1]] = t[1].replace(/^\/?(xl\/)?/, 'xl/'); } }
  const sheets = [];
  const wb = str('xl/workbook.xml');
  const re = /<sheet\b[^>]*>/g; let m;
  while ((m = re.exec(wb))) {
    const name = decodeXml((/name="([^"]*)"/.exec(m[0]) || [])[1] || `Sheet${sheets.length + 1}`);
    const rid = (/r:id="([^"]+)"/.exec(m[0]) || [])[1];
    const target = rels[rid] || `xl/worksheets/sheet${sheets.length + 1}.xml`;
    const xml = str(target);
    const rows = [];
    const rre = /<row\b[^>]*>([\s\S]*?)<\/row>/g; let r;
    while ((r = rre.exec(xml))) {
      const row = [];
      const cre = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g; let c;
      while ((c = cre.exec(r[1]))) {
        const attrs = c[1], inner = c[2] || '';
        const ref = (/r="([A-Z]+\d+)"/.exec(attrs) || [])[1];
        const t = (/t="([^"]+)"/.exec(attrs) || [])[1];
        const v = (/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1];
        let val = '';
        if (t === 's') val = shared[+v] ?? '';
        else if (t === 'inlineStr') val = textOf(inner);
        else if (t === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
        else if (v != null) val = decodeXml(v);
        const idx = ref ? colIndex(ref) : row.length;
        while (row.length < idx) row.push('');
        row[idx] = val;
      }
      if (row.some(x => String(x).trim() !== '')) rows.push(row);
    }
    sheets.push({ name, rows });
  }
  return { sheets };
}

function readTable(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.xlsx' || ext === '.xlsm') return parseXlsx(fs.readFileSync(filePath));
  if (ext === '.json') {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const arr = Array.isArray(data) ? data : (data.photos || data.items || data.rows || []);
    const keys = [...new Set(arr.flatMap(o => Object.keys(o)))];
    return { sheets: [{ name: path.basename(filePath), rows: [keys, ...arr.map(o => keys.map(k => (o[k] == null ? '' : String(o[k]))))] }] };
  }
  return { sheets: [{ name: path.basename(filePath), rows: parseCsv(fs.readFileSync(filePath, 'utf8')) }] };
}

// Finds the header row (the first row with at least two recognised column names) and maps rows to objects
// keyed by our canonical field names. `aliases` = { field: [regex, ...] }.
function rowsToRecords(rows, aliases) {
  for (let h = 0; h < Math.min(rows.length, 15); h++) {
    const header = rows[h].map(c => String(c || '').trim().toLowerCase());
    const map = {};
    for (const [field, res] of Object.entries(aliases)) {
      const idx = header.findIndex((c, i) => c && !Object.values(map).includes(i) && res.some(re => re.test(c)));
      if (idx >= 0) map[field] = idx;
    }
    if (Object.keys(map).length >= 2) {
      return { header: rows[h], headerRow: h + 1, map, records: rows.slice(h + 1).map((r, i) => {
        const o = { _row: h + 2 + i };
        for (const [f, idx] of Object.entries(map)) o[f] = String(r[idx] ?? '').trim();
        o._cells = r.map(x => String(x ?? '').trim());
        return o;
      }) };
    }
  }
  return null;
}

module.exports = { parseCsv, parseXlsx, readTable, rowsToRecords, unzip };

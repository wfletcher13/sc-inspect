'use strict';
// Photo index (CSV, XLSX or JSON list of { file, caption, time }) -> caption statements run through the same
// rules as the transcript, one caption at a time (no context carried between photos), capped at "medium".
const path = require('path');
const { readTable, rowsToRecords } = require('./tabular');
const { extractSegments } = require('./extract');

const ALIASES = {
  file: [/^(?:file|file\s*name|filename|photo|image|img|name|path)$/],
  caption: [/caption|description|desc|note|comment|title|label/],
  time: [/^(?:time|taken|timestamp|date|date\s*taken|datetime)$/],
};

function readPhotoIndex(filePath) {
  const table = readTable(filePath);
  const photos = [];
  for (const sheet of table.sheets) {
    const parsed = rowsToRecords(sheet.rows, ALIASES);
    if (!parsed || !('caption' in parsed.map)) continue;
    for (const r of parsed.records) if (r.caption || r.file) photos.push({ file: r.file || `row ${r._row}`, caption: r.caption || '', time: r.time || '', row: r._row });
  }
  return { index: path.basename(filePath), photos };
}

function extractPhotos(photoIndex, vocab) {
  const segs = photoIndex.photos.filter(p => p.caption).map(p => ({ file: photoIndex.index, index: p.row, line: p.row, start: null, startLabel: p.time, speaker: `photo ${p.file}`, text: p.caption, photo: p.file }));
  const out = extractSegments(segs, vocab, { source: 'photo', carryContext: false, maxConfidence: 'medium' });
  const addPhoto = e => { const s = segs.find(x => x.index === e.index); if (s) e.photo = s.photo; };
  [...out.candidates, ...out.openItems, ...out.measurements, ...out.deficiencies, ...out.notTested].forEach(x => (x.evidence || []).forEach(addPhoto));
  return out;
}

module.exports = { readPhotoIndex, extractPhotos };

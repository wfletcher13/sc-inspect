'use strict';
// Reads voice-recorder transcripts (plain text or JSON export) into a flat list of segments:
// { file, index, line, start, startLabel, speaker, text }.  `start` is seconds from the start of the
// recording (or seconds since midnight for wall-clock stamps), null when the transcript has none.
const fs = require('fs');
const path = require('path');

const TS = String.raw`(?:\d{4}-\d{2}-\d{2}[ T])?\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?(?:\s?[AaPp]\.?[Mm]\.?)?`;
const RE_TS_SPK_TEXT = new RegExp(String.raw`^\[?(${TS})\]?\s*[-–—|]?\s*([A-Za-z][\w .'()-]{0,40}?)\s*:\s+(.+)$`);
const RE_TS_TEXT = new RegExp(String.raw`^\[(${TS})\]\s*[-–—|]?\s*(.+)$|^(${TS})\s+[-–—|]\s*(.+)$`);
const RE_SPK_TS = new RegExp(String.raw`^([A-Za-z][\w .'-]{0,40}?)\s*[\[(]?\s*(${TS})\s*[\])]?\s*:?\s*(.*)$`);
const RE_SPK_TEXT = /^([A-Za-z][\w .'-]{0,30}?):\s+(.+)$/;
const RE_SRT_TIME = new RegExp(String.raw`^(${TS})\s*-->\s*(${TS})`);

function parseTimestamp(label) {
  if (label == null || label === '') return null;
  if (typeof label === 'number') return label;
  let s = String(label).trim();
  const date = /^\d{4}-\d{2}-\d{2}[ T]/.exec(s); if (date) s = s.slice(date[0].length);
  const ampm = /\s?([AaPp])\.?[Mm]\.?$/.exec(s); if (ampm) s = s.slice(0, ampm.index);
  const parts = s.replace(',', '.').split(':').map(Number);
  if (parts.some(isNaN)) return null;
  let secs;
  if (parts.length === 3) secs = parts[0] * 3600 + parts[1] * 60 + parts[2];
  else if (ampm) secs = parts[0] * 3600 + parts[1] * 60;
  else secs = parts[0] * 60 + parts[1];
  if (ampm) { const pm = ampm[1].toLowerCase() === 'p'; const h = Math.floor(secs / 3600); if (pm && h < 12) secs += 12 * 3600; if (!pm && h === 12) secs -= 12 * 3600; }
  return secs;
}

function parseTextTranscript(text, file) {
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);
  const segs = [];
  let pending = null; // header with speaker/time whose text follows on the next lines
  const push = (lineNo, startLabel, speaker, body) => {
    segs.push({ file, index: segs.length + 1, line: lineNo, start: parseTimestamp(startLabel), startLabel: startLabel || '', speaker: (speaker || '').trim(), text: body.trim() });
  };
  const flush = () => { if (pending && pending.body.trim()) push(pending.line, pending.ts, pending.speaker, pending.body); pending = null; };
  for (let n = 0; n < lines.length; n++) {
    const raw = lines[n].trim();
    const lineNo = n + 1;
    if (!raw) { if (pending && pending.body) flush(); continue; }
    if (/^WEBVTT/.test(raw) || /^\d+$/.test(raw)) continue;
    let m;
    if ((m = RE_SRT_TIME.exec(raw))) { flush(); pending = { line: lineNo, ts: m[1], speaker: '', body: '' }; continue; }
    if ((m = RE_TS_SPK_TEXT.exec(raw)) && !/\d:\d/.test(m[2])) { flush(); push(lineNo, m[1], m[2], m[3]); continue; }
    if ((m = RE_TS_TEXT.exec(raw))) { flush(); push(lineNo, m[1] || m[3], '', m[2] || m[4]); continue; }
    if ((m = RE_SPK_TS.exec(raw)) && m[1].trim().split(/\s+/).length <= 4) {
      flush();
      if (m[3].trim()) push(lineNo, m[2], m[1], m[3]);
      else pending = { line: lineNo, ts: m[2], speaker: m[1], body: '' };
      continue;
    }
    if (pending) { pending.body += (pending.body ? ' ' : '') + raw; if (!pending.line) pending.line = lineNo; continue; }
    if ((m = RE_SPK_TEXT.exec(raw)) && m[1].trim().split(/\s+/).length <= 4) { push(lineNo, '', m[1], m[2]); continue; }
    push(lineNo, '', '', raw);
  }
  flush();
  return segs;
}

const TEXT_KEYS = ['text', 'content', 'transcript', 'sentence', 'utterance', 'value', 'body'];
const START_KEYS = ['start', 'startTime', 'start_time', 'begin', 'offset', 'timestamp', 'time', 'ts', 'start_ms', 'startMs', 'start_seconds', 'startSeconds'];
const SPEAKER_KEYS = ['speaker', 'speaker_label', 'speakerLabel', 'speaker_name', 'speakerName', 'participant', 'name', 'author'];

function segText(o) {
  for (const k of TEXT_KEYS) if (typeof o[k] === 'string' && o[k].trim()) return o[k];
  if (Array.isArray(o.words)) return o.words.map(w => (typeof w === 'string' ? w : w.word || w.text || '')).join(' ').replace(/\s+([,.?!])/g, '$1');
  return null;
}
function segStart(o) {
  for (const k of START_KEYS) {
    if (o[k] == null || o[k] === '') continue;
    const v = o[k];
    if (typeof v === 'number') return { secs: /ms$/i.test(k) ? v / 1000 : v, label: /ms$/i.test(k) ? fmtSecs(v / 1000) : fmtSecs(v) };
    if (typeof v === 'string') {
      if (/^\d+(\.\d+)?$/.test(v)) return { secs: +v, label: fmtSecs(+v) };
      const iso = /^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}:\d{2})/.exec(v);
      if (iso) return { secs: parseTimestamp(iso[1]), label: iso[1] };
      const s = parseTimestamp(v); if (s != null) return { secs: s, label: v };
    }
  }
  return { secs: null, label: '' };
}
function segSpeaker(o, speakers) {
  for (const k of SPEAKER_KEYS) {
    const v = o[k];
    if (v == null || v === '') continue;
    if (typeof v === 'object') return String(v.name || v.label || v.id || '');
    if (speakers && speakers[v] != null) return String(typeof speakers[v] === 'object' ? speakers[v].name || v : speakers[v]);
    return String(v);
  }
  if (o.speaker_id != null || o.speakerId != null) { const id = o.speaker_id ?? o.speakerId; return String((speakers && speakers[id]) || `Speaker ${id}`); }
  return '';
}
function fmtSecs(s) { s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60; return (h ? String(h).padStart(2, '0') + ':' : '') + String(m).padStart(2, '0') + ':' + String(x).padStart(2, '0'); }

function findSegmentArray(node, depth = 0) {
  if (depth > 5 || node == null) return null;
  if (Array.isArray(node)) {
    if (node.length && node.every(x => x && typeof x === 'object' && !Array.isArray(x)) && node.some(x => segText(x) != null)) return node;
    for (const x of node) { const r = findSegmentArray(x, depth + 1); if (r) return r; }
    return null;
  }
  if (typeof node === 'object') {
    for (const k of ['segments', 'utterances', 'transcript', 'transcription', 'results', 'items', 'entries', 'data', 'paragraphs', 'monologues']) {
      if (k in node) { const r = findSegmentArray(node[k], depth + 1); if (r) return r; }
    }
    for (const v of Object.values(node)) { const r = findSegmentArray(v, depth + 1); if (r) return r; }
  }
  return null;
}

function parseJsonTranscript(obj, file) {
  const arr = findSegmentArray(obj);
  if (!arr) {
    const t = obj && (typeof obj.text === 'string' ? obj.text : typeof obj.transcript === 'string' ? obj.transcript : null);
    if (t) return parseTextTranscript(t, file);
    throw new Error(`${file}: no transcript segments found in the JSON`);
  }
  const speakers = obj && !Array.isArray(obj) && obj.speakers && typeof obj.speakers === 'object'
    ? (Array.isArray(obj.speakers) ? Object.fromEntries(obj.speakers.map((s, i) => [s.id ?? i, s.name ?? s.label ?? s])) : obj.speakers) : null;
  const segs = [];
  arr.forEach((o, i) => {
    const text = segText(o); if (text == null || !text.trim()) return;
    const st = segStart(o);
    segs.push({ file, index: segs.length + 1, line: null, jsonIndex: i, start: st.secs, startLabel: st.label, speaker: segSpeaker(o, speakers), text: text.trim() });
  });
  return segs;
}

function readTranscript(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const file = path.basename(filePath);
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  if (/\.json$/i.test(filePath) || /^[[{]/.test(trimmed)) {
    let obj; try { obj = JSON.parse(trimmed); } catch (e) { if (/\.json$/i.test(filePath)) throw new Error(`${file}: not valid JSON (${e.message})`); return parseTextTranscript(text, file); }
    return parseJsonTranscript(obj, file);
  }
  return parseTextTranscript(text, file);
}

module.exports = { readTranscript, parseTextTranscript, parseJsonTranscript, parseTimestamp, fmtSecs };

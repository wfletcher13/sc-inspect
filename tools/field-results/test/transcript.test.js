'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTextTranscript, parseJsonTranscript, readTranscript, parseTimestamp } = require('../lib/transcript');
const { fixture } = require('./helpers');

test('bracketed timestamp + speaker lines (Pocket text export)', () => {
  const s = parseTextTranscript('[00:01:05] Speaker 1: Level 12, stair A.\n[00:01:20] Speaker 2: Break 22 pounds.', 't.txt');
  assert.equal(s.length, 2);
  assert.deepEqual([s[0].start, s[0].startLabel, s[0].speaker, s[0].text, s[0].line], [65, '00:01:05', 'Speaker 1', 'Level 12, stair A.', 1]);
  assert.equal(s[1].speaker, 'Speaker 2');
});

test('speaker + timestamp header with the text on following lines', () => {
  const s = parseTextTranscript('Speaker 1  00:02:30\nBelt test on SPF-2 failed.\nFan kept running.\n\nSpeaker 2 (00:03:00): Copy.', 't.txt');
  assert.equal(s.length, 2);
  assert.equal(s[0].text, 'Belt test on SPF-2 failed. Fan kept running.');
  assert.equal(s[0].start, 150);
  assert.equal(s[1].speaker, 'Speaker 2');
  assert.equal(s[1].text, 'Copy.');
});

test('plain lines, speaker-only lines, SRT blocks and wall-clock times', () => {
  const s = parseTextTranscript('Inspector: SPF-1 pass\njust notes\n1\n00:00:01,000 --> 00:00:04,000\nSRT text\n[10:14 AM] Zone 11 fans pass', 't.txt');
  assert.deepEqual(s.map(x => x.text), ['SPF-1 pass', 'just notes', 'SRT text', 'Zone 11 fans pass']);
  assert.equal(s[0].speaker, 'Inspector');
  assert.equal(s[1].speaker, '');
  assert.equal(s[3].start, 10 * 3600 + 14 * 60);
});

test('JSON exports: segments with speaker map, words arrays, millisecond starts', () => {
  const s = parseJsonTranscript({ speakers: { A: 'Inspector' }, segments: [
    { start: 65.2, speaker: 'A', text: 'SPF-1 pass' },
    { start_ms: 70000, speaker: { name: 'Tech' }, words: [{ word: 'Pass' }, { word: '.' }] },
  ] }, 'x.json');
  assert.equal(s.length, 2);
  assert.equal(s[0].speaker, 'Inspector');
  assert.equal(s[1].start, 70);
  assert.equal(s[1].text, 'Pass.');
});

test('JSON export as a bare array and nested under transcript.utterances', () => {
  assert.equal(parseJsonTranscript([{ time: '00:00:05', content: 'hello' }], 'a.json')[0].start, 5);
  assert.equal(parseJsonTranscript({ transcript: { utterances: [{ offset: 3, speaker_label: 'S1', transcript: 'x' }] } }, 'b.json')[0].speaker, 'S1');
});

test('fixture files parse', () => {
  const txt = readTranscript(fixture('transcript-pocket.txt'));
  assert.ok(txt.length >= 30);
  assert.ok(txt.every(s => s.startLabel && s.speaker));
  const js = readTranscript(fixture('transcript-export.json'));
  assert.equal(js.length, 5);
  assert.equal(js[0].speaker, 'Inspector');
});

test('timestamp parsing', () => {
  assert.equal(parseTimestamp('01:02:03'), 3723);
  assert.equal(parseTimestamp('02:03'), 123);
  assert.equal(parseTimestamp('2:15 PM'), 14 * 3600 + 15 * 60);
  assert.equal(parseTimestamp('12:05 AM'), 5 * 60);
  assert.equal(parseTimestamp(''), null);
});

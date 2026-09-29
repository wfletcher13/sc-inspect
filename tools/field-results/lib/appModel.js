'use strict';
// Loads the data-model <script> block straight out of the app's index.html and runs it in a
// sandbox, so result keys, floors, pressure prefixes and normalisation always match the app.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DEFAULT_INDEX = path.resolve(__dirname, '..', '..', '..', 'index.html');

const EXPORTS = [
  'SCHEMA_VERSION', 'FAN_TYPES', 'blankProject', 'normalizeProject', 'zoneInfo', 'isZoneEq', 'isFan', 'isDamper',
  'getFloors', 'typicalFloors', 'lowerFloors', 'typicalLow', 'getStairNames', 'getHoistwayNames',
  'getMatrixCols', 'getZones', 'getSeqTests', 'seqKey', 'pressBlocks', 'pressFlag', 'progress', 'hasResults',
  'FAULT_TESTS', 'EMERG_TESTS', 'INIT_TESTS', 'VISUAL_ITEMS', 'DP_MIN', 'FORCE_MAX', 'clone',
];

const cache = new Map();

function extractModelScript(html) {
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[1].includes('const SCHEMA_VERSION') && m[1].includes('function normalizeProject')) return m[1];
  }
  throw new Error('Could not find the data-model script (SCHEMA_VERSION / normalizeProject) in index.html');
}

function loadAppModel(indexPath = DEFAULT_INDEX) {
  const key = path.resolve(indexPath);
  if (cache.has(key)) return cache.get(key);
  const html = fs.readFileSync(key, 'utf8');
  const src = extractModelScript(html);
  const sandbox = { console };
  vm.createContext(sandbox);
  vm.runInContext(`${src}\n;this.__model = { ${EXPORTS.join(', ')} };`, sandbox, { filename: 'index.html#data-model' });
  // Values created inside the sandbox have the sandbox's Array/Object prototypes; hand back plain copies.
  const host = v => (v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v);
  const model = {};
  for (const [k, v] of Object.entries(sandbox.__model)) model[k] = typeof v === 'function' ? (...args) => host(v(...args)) : host(v);
  cache.set(key, model);
  return model;
}

module.exports = { loadAppModel, extractModelScript, DEFAULT_INDEX };

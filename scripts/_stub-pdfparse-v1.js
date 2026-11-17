'use strict';
// Preload (-r) helper: makes require('pdf-parse') return a v1-style callable export,
// so the v1 branch of extractTextFromFile can be exercised without installing v1.
// Underscore prefix: not a test suite.
const Module = require('module');
const orig = Module._load;
Module._load = function (request) {
  if (request === 'pdf-parse') {
    return async (_buffer) => ({ text: 'V1_STUB_TEXT', numpages: 1 });
  }
  return orig.apply(this, arguments);
};

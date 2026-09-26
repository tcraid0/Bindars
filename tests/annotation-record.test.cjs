const test = require('node:test');
const assert = require('node:assert/strict');
const { readAnnotationRecord, storedAnnotationRecord } = require('../.tmp/workspace-tests/src/lib/annotation-record.js');

test('recognizable future records ask for a newer app without changing the record', () => {
  const record = { version: 4, futureNotes: ['keep'] };
  assert.throws(() => readAnnotationRecord(record), /newer version of Bindars/);
  assert.deepEqual(record, { version: 4, futureNotes: ['keep'] });
});

test('malformed version values are not described as coming from a newer app', () => {
  for (const version of ['4', -1, 4.5, Infinity, {}]) {
    assert.throws(() => readAnnotationRecord({ version, highlights: [], bookmarks: [] }), /damaged or unsupported/);
  }
});

test('a headingless highlight remains visible and survives saving', () => {
  const highlight = { id: 'h', exact: 'Passage', prefix: '', suffix: '', color: 'yellow', nearestHeadingId: null, createdAt: 1 };
  const record = readAnnotationRecord({ version: 3, highlights: [highlight], bookmarks: [] });
  assert.deepEqual(record.annotations.highlights, [highlight]);
  assert.deepEqual(storedAnnotationRecord(record).highlights, [highlight]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { guideViewport, guideCanvasPosition, guideRequests, GUIDE_HOUR_WIDTH, GUIDE_BLOCK_SECONDS } from '../src/client/src/lib/guideWindow.js';
import { loadGuidePrograms } from '../src/server/guidePrograms.js';

test('guide virtualizes thousands of channel rows and recenters time without jumping', () => {
  const originalStart = 1792200000;
  const left = 28000;
  const viewport = guideViewport({ left, top: 100000, width: 1500, height: 800, start: originalStart, channelWidth: 255, count: 10000 });
  assert.ok(viewport.last - viewport.first < 20);
  const rebased = guideCanvasPosition(viewport.start);
  const after = guideViewport({ left: rebased.left, top: 100000, width: 1500, height: 800, start: rebased.start, channelWidth: 255, count: 10000 });
  assert.equal(after.start, viewport.start);
  assert.equal(after.end, viewport.end);
  assert.equal(after.first, viewport.first);
  assert.equal(after.last, viewport.last);
  for (const day of [-1000, 1000]) {
    const time = originalStart + day * 86400;
    const positioned = guideCanvasPosition(time);
    assert.equal(positioned.start + positioned.left * 3600 / GUIDE_HOUR_WIDTH, time);
  }
});

test('guide fetches bounded channel/time blocks and reuses requests within a block', () => {
  const channels = Array.from({ length: 10000 }, (_, index) => ({ id: index + 1 }));
  const view = { start: 1792200000, end: 1792207200, channelIds: [33, 34, 35] };
  const requests = guideRequests(channels, view);
  assert.ok(requests.length <= 2);
  for (const request of requests) {
    assert.equal(request.ids.length, 32);
    assert.ok(request.ids.includes(33));
    assert.equal(request.end - request.start, GUIDE_BLOCK_SECONDS);
  }
  assert.deepEqual(guideRequests(channels, { ...view, channelIds: [34, 35] }), requests);
  assert.deepEqual(guideRequests(channels, { ...view, channelIds: [] }), []);
});

test('optional EPG channel filtering preserves unfiltered endpoint behavior and overlap boundaries', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE channels(id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE epg_programs(id INTEGER PRIMARY KEY, channel_id INTEGER, start_at INTEGER, end_at INTEGER);
      INSERT INTO channels VALUES(1,'One'), (2,'Two');
      INSERT INTO epg_programs VALUES(1,1,100,200), (2,2,100,200), (3,1,200,300), (4,1,300,400);`);
    assert.deepEqual(loadGuidePrograms(db, 150, 300).map(p => p.id), [1, 2, 3]);
    assert.deepEqual(loadGuidePrograms(db, 150, 300, '1').map(p => p.id), [1, 3]);
    assert.deepEqual(loadGuidePrograms(db, 200, 300, '1').map(p => p.id), [3]);
    assert.deepEqual(loadGuidePrograms(db, 150, 300, '999'), []);
    for (const value of ['', '1 OR 1=1', '0', '-1', ['1'], '1,', '9007199254740992', Array.from({ length: 65 }, (_, i) => i + 1).join(',')]) {
      assert.throws(() => loadGuidePrograms(db, 150, 300, value), /Invalid channelIds/);
    }
    assert.throws(() => loadGuidePrograms(db, 0, 172800, '1'), /Invalid guide window/);
    assert.throws(() => loadGuidePrograms(db, 300, 100, '1'), /Invalid guide window/);
  } finally { db.close(); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScheduleEvents } from '../src/client/src/lib/shareSchedule.js';

const base = { programs: [], channel: { id: 7, name: 'Sports channel' }, start: 100, end: 200 };
test('channel time windows can be added to a static schedule without an ESPN game', () => {
  assert.deepEqual(buildScheduleEvents(base), [{ channelId: 7, title: 'Sports channel', startsAt: 100, endsAt: 200, espn: null }]);
  assert.equal(buildScheduleEvents({ ...base, title: '  My event  ' })[0].title, 'My event');
});
test('programme selections retain their EPG IDs and optional ESPN link', () => {
  const espn = { id: 'game' };
  assert.deepEqual(buildScheduleEvents({ programs: [{ id: 11 }, { id: 12 }], espn }), [
    { programId: 11, espn }, { programId: 12, espn },
  ]);
});
test('an ESPN-only scheduled event uses its actual kickoff and league duration', () => {
  const espn = { id: 'game', name: 'Texans at Jaguars', shortName: 'HOU @ JAX', date: '2026-10-18T13:30:00Z' };
  const [event] = buildScheduleEvents({ ...base, espn, league: 'nfl' });
  assert.equal(event.title, espn.name);
  assert.equal(event.startsAt, Date.parse(espn.date) / 1000);
  assert.equal(event.endsAt - event.startsAt, 4 * 3600);
  assert.equal(buildScheduleEvents({ ...base, espn, league: 'nba' })[0].endsAt - event.startsAt, 3 * 3600);
});
test('missing channels, invalid time windows and missing ESPN dates are rejected', () => {
  assert.throws(() => buildScheduleEvents({ ...base, channel: null }), /Choose a channel/);
  for (const [start, end] of [[100, 100], [200, 100], [NaN, 200]]) assert.throws(() => buildScheduleEvents({ ...base, start, end }), /End time/);
  assert.throws(() => buildScheduleEvents({ ...base, espn: { id: 'game' } }), /kickoff/);
});

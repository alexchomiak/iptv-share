import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmpDir = mkdtempSync(path.join(tmpdir(), "iptv-snap-test-"));
process.env.DATABASE_PATH = path.join(tmpDir, "snap.sqlite");
process.on("exit", () => rmSync(tmpDir, { recursive: true, force: true }));

const { db, initDb } = await import("../src/server/db.js");
initDb();
const {
  cleanExpiredEspnSnapshots,
  __resetSnapshotCleanup,
  __lastSnapshotCleanupAt,
} = await import("../src/server/snapshotCleanup.js");

const T0 = 1_700_000_000; // fixed reference "now"
const RETENTION = 86400;

function seed(createdAgo, eventId) {
  db.prepare(
    "INSERT INTO espn_game_snapshots(league,event_id,source,payload,fetched_at,created_at) VALUES (?,?,?,?,?,?)",
  ).run("mlb", eventId, "espn", "{}", T0 - createdAgo, T0 - createdAgo);
}
function count(eventId) {
  return db.prepare("SELECT COUNT(*) c FROM espn_game_snapshots WHERE event_id = ?").get(eventId).c;
}

test("first cleanup call deletes expired rows and records the timestamp", () => {
  __resetSnapshotCleanup();
  seed(RETENTION + 100, "old");
  seed(10, "fresh");
  const ran = cleanExpiredEspnSnapshots(db, () => T0, RETENTION);
  assert.equal(ran, true);
  assert.equal(count("old"), 0, "expired snapshot should be deleted");
  assert.equal(count("fresh"), 1, "fresh snapshot should be kept");
  assert.equal(__lastSnapshotCleanupAt(), T0);
});

test("cleanup within 60s of a success is skipped", () => {
  __resetSnapshotCleanup();
  cleanExpiredEspnSnapshots(db, () => T0, RETENTION); // success at T0, ts=T0
  seed(RETENTION + 100, "late-old"); // seeded after the success, still expired
  const ran = cleanExpiredEspnSnapshots(db, () => T0 + 30, RETENTION);
  assert.equal(ran, false, "should be throttled within the 60s window");
  assert.equal(__lastSnapshotCleanupAt(), T0, "timestamp must not move on a skipped run");
  assert.equal(count("late-old"), 1, "a skipped run must not delete anything");
});

test("cleanup runs again once 60s have elapsed", () => {
  __resetSnapshotCleanup();
  cleanExpiredEspnSnapshots(db, () => T0, RETENTION); // success at T0
  seed(RETENTION + 100, "old2");
  const ran = cleanExpiredEspnSnapshots(db, () => T0 + 60, RETENTION);
  assert.equal(ran, true, "should run once the 60s window has elapsed");
  assert.equal(count("old2"), 0);
  assert.equal(__lastSnapshotCleanupAt(), T0 + 60);
});

test("a failed cleanup does not count as a success and retries next call", () => {
  __resetSnapshotCleanup();
  const failingDb = { prepare: () => ({ run: () => { throw new Error("db down"); } }) };
  seed(RETENTION + 100, "retry-old");
  const firstAttempt = cleanExpiredEspnSnapshots(failingDb, () => T0, RETENTION);
  assert.equal(firstAttempt, false, "failed cleanup should report not-ran");
  assert.equal(__lastSnapshotCleanupAt(), 0, "timestamp must stay unset after failure");
  assert.equal(count("retry-old"), 1, "failed cleanup must not have deleted rows");
  // Next call with a working db must actually run (throttle wasn't consumed by the failure).
  const secondAttempt = cleanExpiredEspnSnapshots(db, () => T0, RETENTION);
  assert.equal(secondAttempt, true);
  assert.equal(count("retry-old"), 0);
  assert.equal(__lastSnapshotCleanupAt(), T0);
});

test("the created_at index is present on a freshly initialized database", () => {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_espn_snapshots_created'").get();
  assert.ok(row, "idx_espn_snapshots_created should exist after initDb on a fresh db");
});

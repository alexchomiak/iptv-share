import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { findActiveShareProgram } from "../src/server/sharePrograms.js";

test("currently airing program wins over the previous program's grace period", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`
      CREATE TABLE channels (id INTEGER PRIMARY KEY, stream_url TEXT);
      CREATE TABLE epg_programs (id INTEGER PRIMARY KEY, channel_id INTEGER, start_at INTEGER, end_at INTEGER);
      CREATE TABLE share_link_items (share_id INTEGER, program_id INTEGER);
      INSERT INTO channels VALUES (1, 'http://source/first'), (2, 'http://source/second');
      INSERT INTO epg_programs VALUES (10, 1, 1000, 2000), (11, 2, 2000, 3000);
      INSERT INTO share_link_items VALUES (7, 10), (7, 11);
    `);
    assert.equal(findActiveShareProgram(db, 7, 600, 1900).id, 10);
    assert.equal(findActiveShareProgram(db, 7, 600, 2050).id, 11);
    assert.equal(findActiveShareProgram(db, 7, 600, 2500).stream_url, "http://source/second");
  } finally {
    db.close();
  }
});

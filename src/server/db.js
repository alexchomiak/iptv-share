import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "./config.js";
import { hashPassword } from "./crypto.js";

fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });

export const db = new Database(config.databasePath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

export function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY,
      tvg_id TEXT UNIQUE,
      name TEXT NOT NULL,
      logo TEXT,
      group_name TEXT,
      channel_number TEXT,
      channel_sort INTEGER,
      stream_url TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS epg_programs (
      id INTEGER PRIMARY KEY,
      channel_key TEXT NOT NULL,
      channel_id INTEGER,
      title TEXT NOT NULL,
      subtitle TEXT,
      description TEXT,
      category TEXT,
      icon TEXT,
      start_at INTEGER NOT NULL,
      end_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_epg_range ON epg_programs(start_at, end_at);
    CREATE INDEX IF NOT EXISTS idx_epg_channel ON epg_programs(channel_id, start_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_tvg_id ON channels(tvg_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_epg_unique ON epg_programs(channel_key, start_at, end_at, title);
    CREATE TABLE IF NOT EXISTS share_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      title TEXT,
      channel_id INTEGER NOT NULL,
      mode TEXT NOT NULL,
      starts_at INTEGER NOT NULL,
      ends_at INTEGER NOT NULL,
      password_hash TEXT,
      max_viewers INTEGER,
      opened_count INTEGER NOT NULL DEFAULT 0,
      last_opened_at INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS share_link_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      share_id INTEGER NOT NULL,
      program_id INTEGER NOT NULL,
      position INTEGER NOT NULL,
      FOREIGN KEY(share_id) REFERENCES share_links(id) ON DELETE CASCADE,
      FOREIGN KEY(program_id) REFERENCES epg_programs(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS static_shares (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      icon TEXT,
      password_hash TEXT,
      max_viewers INTEGER,
      opened_count INTEGER NOT NULL DEFAULT 0,
      last_opened_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS static_share_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      static_share_id INTEGER NOT NULL,
      program_id INTEGER,
      channel_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      icon TEXT,
      starts_at INTEGER NOT NULL,
      ends_at INTEGER NOT NULL,
      espn_league TEXT,
      espn_event_id TEXT,
      espn_name TEXT,
      espn_short_name TEXT,
      espn_date TEXT,
      espn_status TEXT,
      espn_home_name TEXT,
      espn_home_abbreviation TEXT,
      espn_home_logo TEXT,
      espn_away_name TEXT,
      espn_away_abbreviation TEXT,
      espn_away_logo TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(static_share_id) REFERENCES static_shares(id) ON DELETE CASCADE,
      FOREIGN KEY(program_id) REFERENCES epg_programs(id) ON DELETE SET NULL,
      FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_static_events_share_time ON static_share_events(static_share_id, starts_at);
    CREATE INDEX IF NOT EXISTS idx_static_events_time ON static_share_events(starts_at, ends_at);
    CREATE TABLE IF NOT EXISTS espn_cache (
      cache_key TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      payload TEXT NOT NULL,
      fetched_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_espn_cache_expires ON espn_cache(expires_at);
    CREATE TABLE IF NOT EXISTS espn_request_log (
      id INTEGER PRIMARY KEY,
      cache_key TEXT NOT NULL,
      requested_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_espn_request_log_time ON espn_request_log(requested_at);
    CREATE TABLE IF NOT EXISTS refresh_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_refresh_at INTEGER,
      last_error TEXT
    );
    CREATE TABLE IF NOT EXISTS share_viewers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT UNIQUE NOT NULL,
      share_kind TEXT NOT NULL,
      share_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      stream_last_seen_at INTEGER,
      wants_stream INTEGER NOT NULL DEFAULT 0,
      waitlist_joined_at INTEGER,
      stream_granted_at INTEGER,
      kicked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_share_viewers_share ON share_viewers(share_kind, share_id, last_seen_at);
    CREATE TABLE IF NOT EXISTS share_chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      share_kind TEXT NOT NULL,
      share_id INTEGER NOT NULL,
      viewer_token TEXT NOT NULL,
      username TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_share_chat_share ON share_chat_messages(share_kind, share_id, created_at);
    INSERT OR IGNORE INTO refresh_state(id) VALUES(1);
  `);

  ensureColumn("share_links", "opened_count", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("share_links", "last_opened_at", "INTEGER");
  ensureColumn("share_links", "max_viewers", "INTEGER");
  ensureColumn("static_shares", "icon", "TEXT");
  ensureColumn("static_shares", "max_viewers", "INTEGER");
  ensureColumn("epg_programs", "updated_at", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("share_viewers", "wants_stream", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("share_viewers", "waitlist_joined_at", "INTEGER");
  ensureColumn("share_viewers", "stream_granted_at", "INTEGER");
  ensureColumn("channels", "channel_number", "TEXT");
  ensureColumn("channels", "channel_sort", "INTEGER");

  const now = Math.floor(Date.now() / 1000);
  const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(config.appUsername);
  if (existing) {
    db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").run(
      hashPassword(config.appPassword),
      now,
      existing.id,
    );
  } else {
    db.prepare("INSERT INTO users(username, password_hash, updated_at) VALUES (?, ?, ?)").run(
      config.appUsername,
      hashPassword(config.appPassword),
      now,
    );
  }
}

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
  if (!columns.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

import path from "node:path";
import crypto from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import express from "express";
import cookie from "cookie";
import { WebSocketServer } from "ws";
import { config } from "./config.js";
import { db, initDb } from "./db.js";
import { refreshSources } from "./importers.js";
import { hashPassword, randomToken, safeCompare, signedShareCookie, signStreamTarget, verifyPassword } from "./crypto.js";
import {
  espnFastcastDebug,
  espnLeagues,
  espnFastcastRefreshSeconds,
  espnSummaryRefreshSeconds,
  getEspnGameSummary,
  getEspnRawGamePackage,
  searchEspnGames,
  watchEspnFastcastGame,
} from "./espn.js";
import {
  decodeTarget,
  inferStreamKind,
  proxyFmp4Stream,
  proxyStream,
  serveHlsRemuxPlaylist,
  serveHlsRemuxSegment,
  shareIsStreamable,
  shareIsUnlocked,
} from "./stream.js";

const app = express();
const distDir = path.join(config.rootDir, "dist");
const viewerSockets = new Map();
const adminSockets = new Set();
const activeStreamResponses = new Map();
const lastPresenceSignatures = new Map();
const delayedSportsTimers = new Map();
const lastSportsPayloadSignatures = new Map();
const viewerActiveSeconds = 45;
const offlineViewerVisibleSeconds = 3600;
const kickedViewerVisibleSeconds = 86400;
const sportsEventOverrunLookupSeconds = 18 * 60 * 60;

app.use(express.json({ limit: "1mb" }));
app.use((req, _res, next) => {
  req.cookies = cookie.parse(req.headers.cookie || "");
  next();
});

function now() {
  return Math.floor(Date.now() / 1000);
}

function cleanupDelaySeconds() {
  return Math.max(config.shareAutoDeleteSeconds, config.streamGraceSeconds);
}

function cleanDelaySeconds(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(600, Math.floor(parsed));
}

function publicShareUrl(share) {
  const base = config.publicBaseUrl.replace(/\/$/, "");
  return base ? `${base}/s/${share.slug}` : `/s/${share.slug}`;
}

function setCookie(res, name, value, options = {}) {
  res.setHeader(
    "Set-Cookie",
    cookie.serialize(name, value, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.COOKIE_SECURE === "true",
      ...options,
    }),
  );
}

function currentUser(req) {
  const token = req.cookies.iptv_session;
  if (!token) return null;
  return db
    .prepare(
      "SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token = ? AND sessions.expires_at > ?",
    )
    .get(token, now());
}

function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  req.user = user;
  next();
}

function cleanupExpiredShares() {
  const cleanupDelay = cleanupDelaySeconds();
  const expiredShares = db.prepare("SELECT id FROM share_links WHERE ends_at + ? < ?").all(cleanupDelay, now());
  for (const share of expiredShares) cleanupTemporaryShareArtifacts(share.id);
  db.prepare("DELETE FROM share_links WHERE ends_at + ? < ?").run(cleanupDelay, now());
  archiveExpiredStaticEvents();
  db.prepare(
    `
    DELETE FROM static_share_events
    WHERE (
        espn_event_id IS NULL
        AND ends_at + ? < ?
      )
      OR (
        espn_event_id IS NOT NULL
        AND espn_final_fetched_at IS NOT NULL
        AND espn_final_fetched_at + ? < ?
      )
  `,
  ).run(cleanupDelay, now(), cleanupDelay, now());
  cleanupOrphanShareArtifacts();
}

function cleanSlug(slug) {
  return String(slug || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

function cleanViewerName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 40) || "Viewer";
}

function cleanViewerToken(value) {
  const token = String(value || "").trim();
  return /^[a-f0-9]{32,64}$/i.test(token) ? token : crypto.randomBytes(24).toString("hex");
}

function shareKindColumn(kind) {
  return kind === "static" ? "static" : "temporary";
}

function archiveExpiredStaticEvents() {
  db.prepare(
    `
    INSERT INTO static_share_past_games(
      static_share_id, original_event_id, title, description, icon, starts_at, ends_at,
      espn_league, espn_event_id, espn_name, espn_short_name, espn_final_summary, espn_final_fetched_at, archived_at
    )
    SELECT
      static_share_id, id, title, description, icon, starts_at, ends_at,
      espn_league, espn_event_id, espn_name, espn_short_name, espn_final_summary, espn_final_fetched_at, ?
    FROM static_share_events
    WHERE espn_event_id IS NOT NULL
      AND espn_final_summary IS NOT NULL
    ON CONFLICT(static_share_id, original_event_id) DO UPDATE SET
      title = excluded.title,
      description = excluded.description,
      icon = excluded.icon,
      starts_at = excluded.starts_at,
      ends_at = excluded.ends_at,
      espn_league = excluded.espn_league,
      espn_event_id = excluded.espn_event_id,
      espn_name = excluded.espn_name,
      espn_short_name = excluded.espn_short_name,
      espn_final_summary = excluded.espn_final_summary,
      espn_final_fetched_at = excluded.espn_final_fetched_at,
      archived_at = excluded.archived_at
  `,
  ).run(now());
}

function archiveStaticEventSnapshot(staticEventId) {
  db.prepare(
    `
    INSERT INTO static_share_past_games(
      static_share_id, original_event_id, title, description, icon, starts_at, ends_at,
      espn_league, espn_event_id, espn_name, espn_short_name, espn_final_summary, espn_final_fetched_at, archived_at
    )
    SELECT
      static_share_id, id, title, description, icon, starts_at, ends_at,
      espn_league, espn_event_id, espn_name, espn_short_name, espn_final_summary, espn_final_fetched_at, ?
    FROM static_share_events
    WHERE id = ?
      AND espn_event_id IS NOT NULL
      AND espn_final_summary IS NOT NULL
    ON CONFLICT(static_share_id, original_event_id) DO UPDATE SET
      title = excluded.title,
      description = excluded.description,
      icon = excluded.icon,
      starts_at = excluded.starts_at,
      ends_at = excluded.ends_at,
      espn_league = excluded.espn_league,
      espn_event_id = excluded.espn_event_id,
      espn_name = excluded.espn_name,
      espn_short_name = excluded.espn_short_name,
      espn_final_summary = excluded.espn_final_summary,
      espn_final_fetched_at = excluded.espn_final_fetched_at,
      archived_at = excluded.archived_at
  `,
  ).run(now(), staticEventId);
}

function destroyViewerStreams(tokens) {
  for (const token of tokens) {
    for (const res of activeStreamResponses.get(token) || []) {
      if (!res.destroyed) res.destroy();
    }
    activeStreamResponses.delete(token);
  }
}

function cleanupShareArtifacts(kind, shareId, destroyStreams = true) {
  const shareKind = shareKindColumn(kind);
  const linkedSportsEvents = shareKind === "static"
    ? db.prepare("SELECT espn_league, espn_event_id FROM static_share_events WHERE static_share_id = ? AND espn_event_id IS NOT NULL").all(shareId)
    : [];
  const tokens = db
    .prepare("SELECT token FROM share_viewers WHERE share_kind = ? AND share_id = ?")
    .all(shareKind, shareId)
    .map((row) => row.token);
  if (destroyStreams) destroyViewerStreams(tokens);
  db.prepare("DELETE FROM share_chat_messages WHERE share_kind = ? AND share_id = ?").run(shareKind, shareId);
  db.prepare("DELETE FROM share_viewers WHERE share_kind = ? AND share_id = ?").run(shareKind, shareId);
  if (shareKind === "static") {
    db.prepare("DELETE FROM discord_webhook_deliveries WHERE static_share_id = ?").run(shareId);
    db.prepare("DELETE FROM static_share_past_games WHERE static_share_id = ?").run(shareId);
    db.prepare("DELETE FROM static_share_events WHERE static_share_id = ?").run(shareId);
  }
  cleanupDelayedSportsUpdates(shareKind, shareId, linkedSportsEvents);
  broadcastShareState(kind, shareId);
}

function cleanupDelayedSportsUpdates(shareKind, shareId, linkedSportsEvents = []) {
  const prefix = `${shareKind}:${shareId}:`;
  for (const key of delayedSportsTimers.keys()) {
    if (!key.startsWith(prefix)) continue;
    const timer = delayedSportsTimers.get(key);
    if (timer) clearTimeout(timer);
    delayedSportsTimers.delete(key);
    lastSportsPayloadSignatures.delete(key);
  }
  for (const event of linkedSportsEvents) {
    if (!event.espn_event_id) continue;
    const league = normalizeEspnSnapshotLeague(event.espn_league || "mlb");
    const remaining = db
      .prepare("SELECT espn_league FROM static_share_events WHERE espn_event_id = ?")
      .all(String(event.espn_event_id))
      .some((row) => normalizeEspnSnapshotLeague(row.espn_league || "mlb") === league);
    if (!remaining) {
      db.prepare("DELETE FROM espn_game_snapshots WHERE event_id = ? AND league = ?").run(String(event.espn_event_id), league);
    }
  }
}

function cleanupDelayedSportsEvent(kind, shareId, eventId) {
  const key = sportsDelayKey(kind, shareId, eventId);
  const timer = delayedSportsTimers.get(key);
  if (timer) clearTimeout(timer);
  delayedSportsTimers.delete(key);
  lastSportsPayloadSignatures.delete(key);
}

function cleanupTemporaryShareArtifacts(shareId, destroyStreams = true) {
  cleanupShareArtifacts("temporary", shareId, destroyStreams);
  db.prepare("DELETE FROM share_link_items WHERE share_id = ?").run(shareId);
}

function cleanupOrphanShareArtifacts() {
  db.prepare(
    `
    DELETE FROM share_chat_messages
    WHERE share_kind = 'temporary'
      AND NOT EXISTS (SELECT 1 FROM share_links WHERE share_links.id = share_chat_messages.share_id)
  `,
  ).run();
  db.prepare(
    `
    DELETE FROM share_chat_messages
    WHERE share_kind = 'static'
      AND NOT EXISTS (SELECT 1 FROM static_shares WHERE static_shares.id = share_chat_messages.share_id)
  `,
  ).run();
  db.prepare(
    `
    DELETE FROM share_viewers
    WHERE share_kind = 'temporary'
      AND NOT EXISTS (SELECT 1 FROM share_links WHERE share_links.id = share_viewers.share_id)
  `,
  ).run();
  db.prepare(
    `
    DELETE FROM share_viewers
    WHERE share_kind = 'static'
      AND NOT EXISTS (SELECT 1 FROM static_shares WHERE static_shares.id = share_viewers.share_id)
  `,
  ).run();
  db.prepare(
    `
    DELETE FROM share_link_items
    WHERE NOT EXISTS (SELECT 1 FROM share_links WHERE share_links.id = share_link_items.share_id)
      OR NOT EXISTS (SELECT 1 FROM epg_programs WHERE epg_programs.id = share_link_items.program_id)
  `,
  ).run();
  db.prepare(
    `
    DELETE FROM static_share_events
    WHERE NOT EXISTS (SELECT 1 FROM static_shares WHERE static_shares.id = static_share_events.static_share_id)
  `,
  ).run();
  db.prepare(
    `
    DELETE FROM static_share_past_games
    WHERE NOT EXISTS (SELECT 1 FROM static_shares WHERE static_shares.id = static_share_past_games.static_share_id)
  `,
  ).run();
  db.prepare(
    `
    DELETE FROM discord_webhook_deliveries
    WHERE NOT EXISTS (SELECT 1 FROM static_shares WHERE static_shares.id = discord_webhook_deliveries.static_share_id)
  `,
  ).run();
}

function resolveShareBySlug(slug) {
  const staticShare = db.prepare("SELECT * FROM static_shares WHERE slug = ?").get(slug);
  if (staticShare) return { kind: "static", share: staticShare };
  const share = loadShare(slug);
  if (share) return { kind: "temporary", share };
  return null;
}

function viewerPublicRow(viewer) {
  return {
    id: viewer.id,
    ids: [viewer.id],
    username: viewer.username,
    first_seen_at: viewer.first_seen_at,
    last_seen_at: viewer.last_seen_at,
    stream_last_seen_at: viewer.stream_last_seen_at,
    wants_stream: Boolean(viewer.wants_stream),
    waitlist_joined_at: viewer.waitlist_joined_at,
    stream_granted_at: viewer.stream_granted_at,
    online: !viewer.kicked_at && viewer.last_seen_at >= now() - viewerActiveSeconds,
    streaming: !viewer.kicked_at && Number(viewer.stream_last_seen_at || 0) >= now() - viewerActiveSeconds,
    waiting: !viewer.kicked_at && Boolean(viewer.wants_stream),
    kicked: Boolean(viewer.kicked_at),
    duplicate_count: 1,
  };
}

function loadViewers(kind, shareId) {
  const viewers = db
    .prepare(
      `
      SELECT id, username, first_seen_at, last_seen_at, stream_last_seen_at, wants_stream, waitlist_joined_at, stream_granted_at, kicked_at
      FROM share_viewers
      WHERE share_kind = ? AND share_id = ? AND (last_seen_at >= ? OR kicked_at >= ?)
      ORDER BY kicked_at IS NOT NULL, wants_stream DESC, waitlist_joined_at, stream_last_seen_at DESC, last_seen_at DESC, username
    `,
    )
    .all(shareKindColumn(kind), shareId, now() - offlineViewerVisibleSeconds, now() - kickedViewerVisibleSeconds)
    .map(viewerPublicRow);
  const grouped = new Map();
  for (const viewer of viewers) {
    const key = viewer.username.trim().toLowerCase();
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, viewer);
      continue;
    }
    existing.ids.push(viewer.id);
    existing.duplicate_count += 1;
    existing.first_seen_at = Math.min(existing.first_seen_at, viewer.first_seen_at);
    existing.last_seen_at = Math.max(existing.last_seen_at, viewer.last_seen_at);
    existing.stream_last_seen_at = Math.max(Number(existing.stream_last_seen_at || 0), Number(viewer.stream_last_seen_at || 0)) || null;
    existing.waitlist_joined_at = existing.waitlist_joined_at && viewer.waitlist_joined_at
      ? Math.min(existing.waitlist_joined_at, viewer.waitlist_joined_at)
      : existing.waitlist_joined_at || viewer.waitlist_joined_at;
    existing.stream_granted_at = Math.max(Number(existing.stream_granted_at || 0), Number(viewer.stream_granted_at || 0)) || null;
    existing.wants_stream = existing.wants_stream || viewer.wants_stream;
    existing.online = existing.online || viewer.online;
    existing.streaming = existing.streaming || viewer.streaming;
    existing.waiting = existing.waiting || viewer.waiting;
    existing.kicked = existing.kicked && viewer.kicked;
    if (viewer.streaming || (!existing.online && viewer.online)) {
      existing.id = viewer.id;
      existing.username = viewer.username;
    }
  }
  return Array.from(grouped.values()).sort((a, b) => {
    if (a.kicked !== b.kicked) return a.kicked ? 1 : -1;
    if (a.streaming !== b.streaming) return a.streaming ? -1 : 1;
    if (a.waiting !== b.waiting) return a.waiting ? -1 : 1;
    return b.last_seen_at - a.last_seen_at;
  });
}

function loadRecentChat(kind, shareId) {
  return db
    .prepare(
      `
      SELECT id, username, message, created_at
      FROM share_chat_messages
      WHERE share_kind = ? AND share_id = ?
      ORDER BY created_at DESC
      LIMIT 80
    `,
    )
    .all(shareKindColumn(kind), shareId)
    .reverse();
}

function upsertViewer(kind, shareId, token, username) {
  db.prepare(
    `
    INSERT INTO share_viewers(token, share_kind, share_id, username, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(token) DO UPDATE SET
      share_kind = excluded.share_kind,
      share_id = excluded.share_id,
      username = excluded.username,
      last_seen_at = excluded.last_seen_at
  `,
  ).run(token, shareKindColumn(kind), shareId, username, now(), now());
  promoteWaitlist(kind, shareId);
  return db
    .prepare("SELECT id, username, first_seen_at, last_seen_at, stream_last_seen_at, wants_stream, waitlist_joined_at, stream_granted_at, kicked_at FROM share_viewers WHERE token = ?")
    .get(token);
}

function touchViewer(token) {
  db.prepare("UPDATE share_viewers SET last_seen_at = ? WHERE token = ? AND kicked_at IS NULL").run(now(), token);
}

function shareMaxViewers(kind, shareId) {
  const shareTable = kind === "static" ? "static_shares" : "share_links";
  const share = db.prepare(`SELECT max_viewers FROM ${shareTable} WHERE id = ?`).get(shareId);
  return Number(share?.max_viewers || 0);
}

function activeStreamCount(kind, shareId) {
  return db
    .prepare(
      `
      SELECT COUNT(*) AS total
      FROM (
        SELECT LOWER(username)
        FROM share_viewers
        WHERE share_kind = ? AND share_id = ? AND kicked_at IS NULL AND (stream_last_seen_at >= ? OR stream_granted_at >= ?)
        GROUP BY LOWER(username)
      )
    `,
    )
    .get(shareKindColumn(kind), shareId, now() - viewerActiveSeconds, now() - viewerActiveSeconds).total;
}

function actualStreamingCount(kind, shareId) {
  return db
    .prepare(
      `
      SELECT COUNT(*) AS total
      FROM (
        SELECT LOWER(username)
        FROM share_viewers
        WHERE share_kind = ? AND share_id = ? AND kicked_at IS NULL AND stream_last_seen_at >= ?
        GROUP BY LOWER(username)
      )
    `,
    )
    .get(shareKindColumn(kind), shareId, now() - viewerActiveSeconds).total;
}

function waitingViewers(kind, shareId) {
  const rows = db
    .prepare(
      `
      SELECT id, token, username
      FROM share_viewers
      WHERE share_kind = ? AND share_id = ? AND kicked_at IS NULL AND wants_stream = 1 AND last_seen_at >= ?
      ORDER BY waitlist_joined_at, id
    `,
    )
    .all(shareKindColumn(kind), shareId, now() - viewerActiveSeconds);
  const seen = new Set();
  return rows.filter((viewer) => {
    const key = viewer.username.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function waitlistPosition(kind, shareId, token) {
  const waiting = waitingViewers(kind, shareId);
  const index = waiting.findIndex((viewer) => viewer.token === token);
  return index >= 0 ? index + 1 : null;
}

function sendViewerSlot(kind, shareId, token, payload) {
  for (const ws of viewerSockets.get(shareSocketKey(kind, shareId)) || []) {
    if (ws.viewerToken === token) sendJson(ws, { type: "streamSlot", ...payload });
  }
}

function promoteWaitlist(kind, shareId) {
  const maxViewers = shareMaxViewers(kind, shareId);
  if (maxViewers <= 0) return 0;
  const available = maxViewers - activeStreamCount(kind, shareId);
  if (available <= 0) return 0;
  const promoted = waitingViewers(kind, shareId).slice(0, available);
  for (const viewer of promoted) {
    db.prepare("UPDATE share_viewers SET wants_stream = 0, waitlist_joined_at = NULL, stream_granted_at = ? WHERE id = ?").run(now(), viewer.id);
    sendViewerSlot(kind, shareId, viewer.token, { status: "ready" });
  }
  return promoted.length;
}

function requestViewerStream(kind, shareId, token) {
  const current = now();
  const viewer = db
    .prepare("SELECT * FROM share_viewers WHERE token = ? AND share_kind = ? AND share_id = ?")
    .get(token, shareKindColumn(kind), shareId);
  if (!viewer) return { ok: false, status: 403, message: "Join the share before starting the stream" };
  if (viewer.kicked_at) return { ok: false, status: 403, message: "You were removed from this stream" };
  promoteWaitlist(kind, shareId);
  const maxViewers = shareMaxViewers(kind, shareId);
  const alreadyStreaming = Number(viewer.stream_last_seen_at || 0) >= current - viewerActiveSeconds;
  const wasGranted = Number(viewer.stream_granted_at || 0) >= current - viewerActiveSeconds;
  if (maxViewers > 0 && !alreadyStreaming && !wasGranted && activeStreamCount(kind, shareId) >= maxViewers) {
    db.prepare(
      `
      UPDATE share_viewers
      SET last_seen_at = ?, wants_stream = 1, waitlist_joined_at = COALESCE(waitlist_joined_at, ?), stream_last_seen_at = NULL
      WHERE token = ?
    `,
    ).run(current, current, token);
    broadcastShareState(kind, shareId);
    sendViewerSlot(kind, shareId, token, { status: "waiting", position: waitlistPosition(kind, shareId, token) });
    return { ok: false, status: 429, message: "Stream is full. You are on the waitlist.", waiting: true, position: waitlistPosition(kind, shareId, token) };
  }
  db.prepare(
    "UPDATE share_viewers SET last_seen_at = ?, stream_last_seen_at = ?, wants_stream = 0, waitlist_joined_at = NULL, stream_granted_at = ? WHERE token = ?",
  ).run(current, current, current, token);
  broadcastShareState(kind, shareId);
  return { ok: true };
}

function sendJson(ws, payload) {
  if (ws.readyState === 1) ws.send(JSON.stringify(payload));
}

function shareSocketKey(kind, shareId) {
  return `${shareKindColumn(kind)}:${shareId}`;
}

function viewerStateSignature(viewers) {
  return JSON.stringify(viewers.map((viewer) => ({
    id: viewer.id,
    ids: viewer.ids,
    username: viewer.username,
    online: viewer.online,
    streaming: viewer.streaming,
    waiting: viewer.waiting,
    kicked: viewer.kicked,
    duplicate_count: viewer.duplicate_count,
  })));
}

function broadcastShareState(kind, shareId, options = {}) {
  const key = shareSocketKey(kind, shareId);
  const viewers = loadViewers(kind, shareId);
  const signature = viewerStateSignature(viewers);
  if (!options.force && lastPresenceSignatures.get(key) === signature) return false;
  lastPresenceSignatures.set(key, signature);
  const payload = { type: "presence", viewers };
  for (const ws of viewerSockets.get(key) || []) sendJson(ws, payload);
  for (const ws of adminSockets) {
    if (!ws.shareFilter || ws.shareFilter === key) sendJson(ws, { ...payload, shareKind: shareKindColumn(kind), shareId });
  }
  return true;
}

function broadcastChat(kind, shareId, message) {
  const key = shareSocketKey(kind, shareId);
  for (const ws of viewerSockets.get(key) || []) sendJson(ws, { type: "chat", message });
  for (const ws of adminSockets) {
    if (!ws.shareFilter || ws.shareFilter === key) sendJson(ws, { type: "chat", shareKind: shareKindColumn(kind), shareId, message });
  }
}

function broadcastChatHistory(kind, shareId) {
  const key = shareSocketKey(kind, shareId);
  const shareKind = shareKindColumn(kind);
  const messages = loadRecentChat(shareKind, shareId);
  for (const ws of viewerSockets.get(key) || []) sendJson(ws, { type: "chatHistory", messages });
  for (const ws of adminSockets) {
    if (!ws.shareFilter || ws.shareFilter === key) sendJson(ws, { type: "chatHistory", shareKind, shareId, messages });
  }
}

function broadcastSportsUpdate(kind, shareId, eventId, result) {
  const payload = sportsUpdatePayload(kind, shareId, eventId, result);
  const delayedPayload = delayedSportsPayload(kind, shareId, eventId, payload);
  if (!delayedPayload) return;
  sendSportsPayload(kind, shareId, delayedPayload);
}

function sendSportsPayload(kind, shareId, payload) {
  const key = shareSocketKey(kind, shareId);
  const signatureKey = sportsDelayKey(kind, shareId, payload.eventId);
  const signature = `${payload.fetchedAt || 0}:${payload.source || ""}:${crypto.createHash("sha1").update(JSON.stringify(payload.summary || {})).digest("hex").slice(0, 12)}`;
  if (lastSportsPayloadSignatures.get(signatureKey) === signature) return;
  lastSportsPayloadSignatures.set(signatureKey, signature);
  for (const ws of viewerSockets.get(key) || []) sendJson(ws, payload);
  for (const ws of adminSockets) {
    if (!ws.shareFilter || ws.shareFilter === key) sendJson(ws, payload);
  }
}

function sportsUpdatePayload(kind, shareId, eventId, result) {
  return {
    type: "sportsUpdate",
    shareKind: shareKindColumn(kind),
    shareId,
    eventId,
    summary: result.summary,
    refreshSeconds: espnFastcastRefreshSeconds(result.summary?.league || result.summary?.sport || "mlb"),
    fetchedAt: result.fetchedAt,
    source: result.source || result.summary?.source || "espn",
  };
}

function sportsDelayKey(kind, shareId, eventId) {
  return `${shareKindColumn(kind)}:${shareId}:${eventId}`;
}

function sportsSpoilerDelaySeconds(kind, shareId) {
  if (shareKindColumn(kind) !== "static") return 0;
  const row = db.prepare("SELECT spoiler_delay_seconds FROM static_shares WHERE id = ?").get(shareId);
  return cleanDelaySeconds(row?.spoiler_delay_seconds);
}

function sportsPayloadTimestamp(payload) {
  return Number(payload?.fetchedAt || payload?.summary?.fetchedAt || now());
}

function delayedSportsPayload(kind, shareId, eventId, payload) {
  const delaySeconds = sportsSpoilerDelaySeconds(kind, shareId);
  storeEspnGameSnapshot(payload);
  const currentPayload = withSpoilerDelay(payload, delaySeconds);
  if (!delaySeconds) return currentPayload;
  scheduleDelayedSportsFlush(kind, shareId, eventId);
  return latestAvailableSportsPayload(kind, shareId, eventId, delaySeconds);
}

function withSpoilerDelay(payload, delaySeconds) {
  return {
    ...payload,
    spoilerDelaySeconds: delaySeconds,
    summary: payload.summary ? { ...payload.summary, spoilerDelaySeconds: delaySeconds } : payload.summary,
  };
}

function espnSnapshotIdentity(payload) {
  const summary = payload?.summary || {};
  const league = normalizeEspnSnapshotLeague(summary.league || summary.sport || "mlb");
  const eventId = String(summary.id || summary.eventId || "").trim();
  if (!eventId) return null;
  return { league, eventId };
}

function normalizeEspnSnapshotLeague(value) {
  const league = String(value || "mlb").toLowerCase();
  if (league === "baseball") return "mlb";
  if (league === "basketball") return "nba";
  return league;
}

function storeEspnGameSnapshot(payload) {
  const identity = espnSnapshotIdentity(payload);
  if (!identity || !payload?.summary) return false;
  const fetchedAt = sportsPayloadTimestamp(payload);
  payload.summary = mergeWithPreviousSportsSummary(identity, payload.summary);
  db.prepare(
    `
    INSERT INTO espn_game_snapshots(league, event_id, source, payload, fetched_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(league, event_id, source, fetched_at)
    DO UPDATE SET payload = excluded.payload, created_at = excluded.created_at
  `,
  ).run(identity.league, identity.eventId, payload.source || "espn", JSON.stringify(payload.summary), fetchedAt, now());
  db.prepare("DELETE FROM espn_game_snapshots WHERE created_at < ?").run(now() - 86400);
  return true;
}

function mergeWithPreviousSportsSummary(identity, summary) {
  const previous = db
    .prepare(
      `
      SELECT payload
      FROM espn_game_snapshots
      WHERE league = ? AND event_id = ?
      ORDER BY fetched_at DESC, id DESC
      LIMIT 1
    `,
    )
    .get(identity.league, identity.eventId);
  if (!previous?.payload) return summary;
  try {
    return mergeSportsSummary(JSON.parse(previous.payload), summary);
  } catch {
    return summary;
  }
}

function mergeSportsSummary(previous, current) {
  if (!previous || !current) return current;
  const previousCompetitors = previous.competitors || [];
  const competitors = (current.competitors || []).map((competitor) => {
    const prior = previousCompetitors.find((entry) => String(entry.id || entry.team?.id || entry.team?.abbreviation) === String(competitor.id || competitor.team?.id || competitor.team?.abbreviation))
      || previousCompetitors.find((entry) => entry.team?.abbreviation && entry.team.abbreviation === competitor.team?.abbreviation);
    return {
      ...competitor,
      linescores: mergeLinescores(prior?.linescores || [], competitor.linescores || []),
    };
  });
  return { ...current, competitors };
}

function lineScoreHasValue(line) {
  const value = line?.value ?? line?.displayValue;
  return value !== undefined && value !== null && value !== "";
}

function mergeLinescores(previous = [], current = []) {
  const maxLength = Math.max(previous.length, current.length);
  return Array.from({ length: maxLength }, (_item, index) => {
    const next = current[index];
    if (lineScoreHasValue(next)) return next;
    return previous[index] || next;
  }).filter(Boolean);
}

function newestEspnSnapshot(event) {
  if (!event?.espn_event_id) return null;
  return db
    .prepare(
      `
      SELECT fetched_at, source
      FROM espn_game_snapshots
      WHERE league = ? AND event_id = ?
      ORDER BY fetched_at DESC, id DESC
      LIMIT 1
    `,
    )
    .get(normalizeEspnSnapshotLeague(event.espn_league || "mlb"), String(event.espn_event_id));
}

function latestAvailableSportsPayload(kind, shareId, eventId, delaySeconds = sportsSpoilerDelaySeconds(kind, shareId)) {
  if (shareKindColumn(kind) !== "static") return null;
  const event = db
    .prepare("SELECT espn_league, espn_event_id FROM static_share_events WHERE static_share_id = ? AND id = ?")
    .get(shareId, eventId);
  if (!event?.espn_event_id) return null;
  const row = db
    .prepare(
      `
      SELECT *
      FROM espn_game_snapshots
      WHERE league = ? AND event_id = ? AND fetched_at <= ?
      ORDER BY fetched_at DESC, id DESC
      LIMIT 1
    `,
    )
    .get(normalizeEspnSnapshotLeague(event.espn_league || "mlb"), String(event.espn_event_id), now() - delaySeconds);
  if (!row) return null;
  try {
    const summary = JSON.parse(row.payload);
    return withSpoilerDelay(sportsUpdatePayload(kind, shareId, eventId, {
      summary,
      fetchedAt: row.fetched_at,
      source: row.source,
    }), delaySeconds);
  } catch {
    return null;
  }
}

function nextDelayedSportsAvailableIn(kind, shareId, eventId) {
  if (shareKindColumn(kind) !== "static") return null;
  const delaySeconds = sportsSpoilerDelaySeconds(kind, shareId);
  if (!delaySeconds) return null;
  const event = db
    .prepare("SELECT espn_league, espn_event_id FROM static_share_events WHERE static_share_id = ? AND id = ?")
    .get(shareId, eventId);
  if (!event?.espn_event_id) return null;
  const nextEntry = db
    .prepare(
      `
      SELECT fetched_at
      FROM espn_game_snapshots
      WHERE league = ? AND event_id = ? AND fetched_at > ?
      ORDER BY fetched_at ASC
      LIMIT 1
    `,
    )
    .get(normalizeEspnSnapshotLeague(event.espn_league || "mlb"), String(event.espn_event_id), now() - delaySeconds);
  return nextEntry ? Math.max(1, nextEntry.fetched_at + delaySeconds - now()) : null;
}

function scheduleDelayedSportsFlush(kind, shareId, eventId) {
  const key = sportsDelayKey(kind, shareId, eventId);
  if (delayedSportsTimers.has(key)) return;
  const waitSeconds = nextDelayedSportsAvailableIn(kind, shareId, eventId);
  if (!waitSeconds) return;
  const timer = setTimeout(() => {
    delayedSportsTimers.delete(key);
    const payload = latestAvailableSportsPayload(kind, shareId, eventId);
    if (payload) sendSportsPayload(kind, shareId, payload);
    scheduleDelayedSportsFlush(kind, shareId, eventId);
  }, Math.max(1000, waitSeconds * 1000));
  delayedSportsTimers.set(key, timer);
}

function ensureStaticSportsLiveFeed(event, reason = "viewer") {
  if (!event?.static_share_id || !event?.id || !event?.espn_event_id) return null;
  const league = event.espn_league || "nfl";
  return watchEspnFastcastGame({
    league,
    eventId: event.espn_event_id,
    watcherId: `static:${event.static_share_id}:event:${event.id}:${reason}`,
    ttlSeconds: Math.max(120, espnFastcastRefreshSeconds(league) * 12),
    onUpdate: (result) => {
      storeFinalSportsSummary(event.id, result.summary, result.fetchedAt);
      broadcastSportsUpdate("static", event.static_share_id, event.id, result);
    },
  });
}

let sportsTrackerTickRunning = false;

function loadTrackableStaticSportsEvents() {
  const current = now();
  return db
    .prepare(
      `
      SELECT static_share_events.*, static_shares.discord_webhook_url
      FROM static_share_events
      JOIN static_shares ON static_shares.id = static_share_events.static_share_id
      WHERE static_share_events.espn_event_id IS NOT NULL
        AND static_share_events.espn_final_summary IS NULL
        AND static_share_events.starts_at - ? <= ?
        AND static_share_events.starts_at >= ?
      ORDER BY static_share_events.starts_at
      LIMIT 50
    `,
    )
    .all(config.streamGraceSeconds, current, current - sportsEventOverrunLookupSeconds);
}

async function runSportsTrackerTick() {
  if (sportsTrackerTickRunning) return;
  sportsTrackerTickRunning = true;
  try {
    for (const event of loadTrackableStaticSportsEvents()) {
      ensureStaticSportsLiveFeed(event, "tracker");
      const league = normalizeEspnSnapshotLeague(event.espn_league || "mlb");
      const fallbackSeconds = espnSummaryRefreshSeconds(league);
      const latest = newestEspnSnapshot(event);
      if (latest && now() - Number(latest.fetched_at || 0) < fallbackSeconds) continue;
      try {
        const result = await getEspnGameSummary({ league, eventId: event.espn_event_id });
        storeFinalSportsSummary(event.id, result.summary, result.fetchedAt);
        const payload = delayedSportsPayload("static", event.static_share_id, event.id, sportsUpdatePayload("static", event.static_share_id, event.id, {
          summary: result.summary,
          fetchedAt: result.fetchedAt,
          source: result.source || "summary",
        }));
        if (payload) sendSportsPayload("static", event.static_share_id, payload);
      } catch (error) {
        console.error(`Sports tracker failed for ${league}:${event.espn_event_id}: ${error.message}`);
      }
    }
  } finally {
    sportsTrackerTickRunning = false;
  }
}

function ensureSportsPushForSocket(ws, eventId, reason = "viewer", options = {}) {
  if (ws.shareKind !== "static" || !eventId) return;
  const event = db
    .prepare("SELECT * FROM static_share_events WHERE static_share_id = ? AND id = ?")
    .get(ws.shareId, eventId);
  if (!event?.espn_event_id) return;
  const feed = ensureStaticSportsLiveFeed(event, reason);
  if (options.sendSnapshot !== false && feed?.summary) {
    const payload = delayedSportsPayload("static", ws.shareId, event.id, sportsUpdatePayload("static", ws.shareId, event.id, {
      summary: feed.summary,
      fetchedAt: feed.fetchedAt,
      source: "fastcast",
    }));
    if (payload) sendJson(ws, payload);
  }
}

function fastcastIsReady(feed) {
  return Boolean(feed?.summary);
}

function sportsPollAfterSeconds(refreshSeconds) {
  return Math.max(30, Number(refreshSeconds || 60));
}

function sportsSummaryResponse(kind, shareId, eventId, result, options = {}) {
  const payload = delayedSportsPayload(kind, shareId, eventId, sportsUpdatePayload(kind, shareId, eventId, result));
  const delaySeconds = sportsSpoilerDelaySeconds(kind, shareId);
  const delayedWaitSeconds = !payload && delaySeconds ? nextDelayedSportsAvailableIn(kind, shareId, eventId) : null;
  return {
    summary: payload?.summary || null,
    skipped: !payload,
    reason: !payload && delaySeconds ? "Waiting for spoiler delay" : undefined,
    refreshSeconds: options.refreshSeconds,
    pollAfterSeconds: delayedWaitSeconds || sportsPollAfterSeconds(options.refreshSeconds),
    realtime: options.realtime,
    realtimeStatus: options.realtimeStatus || null,
    fetchedAt: payload?.fetchedAt || null,
    spoilerDelaySeconds: delaySeconds,
    delayedWaitSeconds,
  };
}

function storedSportsSummaryResponse(kind, shareId, eventId, options = {}) {
  const delaySeconds = sportsSpoilerDelaySeconds(kind, shareId);
  const payload = latestAvailableSportsPayload(kind, shareId, eventId, delaySeconds);
  const delayedWaitSeconds = !payload && delaySeconds ? nextDelayedSportsAvailableIn(kind, shareId, eventId) : null;
  return {
    summary: payload?.summary || null,
    skipped: !payload,
    reason: !payload && delaySeconds ? "Waiting for spoiler delay" : "No tracked sports snapshot yet",
    refreshSeconds: options.refreshSeconds,
    pollAfterSeconds: delayedWaitSeconds || sportsPollAfterSeconds(options.refreshSeconds),
    realtime: options.realtime,
    realtimeStatus: options.realtimeStatus || null,
    fetchedAt: payload?.fetchedAt || null,
    spoilerDelaySeconds: delaySeconds,
    delayedWaitSeconds,
  };
}

function skippedSportsSummaryResponse(kind, shareId, refreshSeconds, reason) {
  return {
    summary: null,
    skipped: true,
    reason,
    refreshSeconds,
    pollAfterSeconds: sportsPollAfterSeconds(refreshSeconds),
    realtime: false,
    fetchedAt: null,
    spoilerDelaySeconds: sportsSpoilerDelaySeconds(kind, shareId),
  };
}

function kickViewer(kind, shareId, viewerId) {
  const viewer = db
    .prepare("SELECT username FROM share_viewers WHERE share_kind = ? AND share_id = ? AND id = ?")
    .get(shareKindColumn(kind), shareId, viewerId);
  if (!viewer) return { changes: 0 };
  const tokens = db
    .prepare("SELECT token FROM share_viewers WHERE share_kind = ? AND share_id = ? AND LOWER(username) = LOWER(?)")
    .all(shareKindColumn(kind), shareId, viewer.username)
    .map((row) => row.token);
  const result = db
    .prepare("UPDATE share_viewers SET kicked_at = ?, stream_last_seen_at = NULL WHERE share_kind = ? AND share_id = ? AND LOWER(username) = LOWER(?)")
    .run(now(), shareKindColumn(kind), shareId, viewer.username);
  for (const token of tokens) {
    for (const res of activeStreamResponses.get(token) || []) {
      if (!res.destroyed) res.destroy();
    }
    activeStreamResponses.delete(token);
    for (const ws of viewerSockets.get(shareSocketKey(kind, shareId)) || []) {
      if (ws.viewerToken === token) {
        sendJson(ws, { type: "kicked" });
        ws.close();
      }
    }
  }
  broadcastShareState(kind, shareId);
  return result;
}

function unkickViewer(kind, shareId, viewerId) {
  const viewer = db
    .prepare("SELECT username FROM share_viewers WHERE share_kind = ? AND share_id = ? AND id = ?")
    .get(shareKindColumn(kind), shareId, viewerId);
  if (!viewer) return { changes: 0 };
  const result = db
    .prepare(
      `
      UPDATE share_viewers
      SET kicked_at = NULL, wants_stream = 0, waitlist_joined_at = NULL, stream_granted_at = NULL, stream_last_seen_at = NULL, last_seen_at = ?
      WHERE share_kind = ? AND share_id = ? AND LOWER(username) = LOWER(?)
    `,
    )
    .run(now(), shareKindColumn(kind), shareId, viewer.username);
  promoteWaitlist(kind, shareId);
  broadcastShareState(kind, shareId);
  return result;
}

function streamCutoffWindow(entitlement) {
  if (!entitlement?.usesSportsClock) return entitlement?.event || entitlement;
  return { ...entitlement.event, open_ended_cutoff: true };
}

async function withShareCutoff(cutoff, res, action) {
  let timer = null;
  let checking = false;
  if (cutoff?.open_ended_cutoff) {
    const intervalMs = Math.max(30000, espnSummaryRefreshSeconds(cutoff.espn_league || "nfl") * 1000);
    timer = setInterval(async () => {
      if (checking || res.destroyed) return;
      checking = true;
      try {
        const entitlement = await resolveScheduledStreamEntitlement(cutoff);
        if (!entitlement.streamable && !res.destroyed) res.destroy();
      } finally {
        checking = false;
      }
    }, intervalMs);
  } else {
    const millisecondsRemaining = Math.max(0, ((cutoff?.ends_at || 0) + config.streamGraceSeconds - now()) * 1000);
    timer = setTimeout(() => {
      if (!res.destroyed) res.destroy();
    }, millisecondsRemaining);
  }
  try {
    await action();
  } finally {
    if (cutoff?.open_ended_cutoff) clearInterval(timer);
    else clearTimeout(timer);
  }
}

async function withViewerStream(token, res, action) {
  if (!activeStreamResponses.has(token)) activeStreamResponses.set(token, new Set());
  activeStreamResponses.get(token).add(res);
  try {
    await action();
  } finally {
    const responses = activeStreamResponses.get(token);
    if (responses) {
      responses.delete(res);
      if (!responses.size) activeStreamResponses.delete(token);
    }
    const viewer = db.prepare("SELECT share_kind, share_id FROM share_viewers WHERE token = ?").get(token);
    if (viewer) {
      promoteWaitlist(viewer.share_kind, viewer.share_id);
      broadcastShareState(viewer.share_kind, viewer.share_id);
    }
  }
}

async function proxyImage(res, url, options = {}) {
  const response = await fetch(url);
  if (!response.ok) {
    res.status(502).end();
    return;
  }
  res.setHeader("Content-Type", response.headers.get("content-type") || "image/png");
  res.setHeader("Cache-Control", options.cacheControl || "public, max-age=86400");
  Readable.fromWeb(response.body).pipe(res);
}

function versionedImageUrl(path, version) {
  return version ? `${path}?v=${encodeURIComponent(version)}` : path;
}

function staticShareIsUnlocked(req, share) {
  if (!share.password_hash) return true;
  return safeCompare(req.cookies[`static_share_${share.id}`], signedShareCookie(`static:${share.id}`));
}

function candidateStaticEvents(shareId) {
  return db
    .prepare(
      `
      SELECT static_share_events.*, channels.name AS channel_name, channels.stream_url
      FROM static_share_events
      JOIN channels ON channels.id = static_share_events.channel_id
      WHERE static_share_events.static_share_id = ?
        AND static_share_events.starts_at - ? <= ?
        AND (
          ? <= static_share_events.ends_at + ?
          OR (
            static_share_events.espn_event_id IS NOT NULL
            AND static_share_events.starts_at >= ?
          )
        )
      ORDER BY static_share_events.starts_at
    `,
    )
    .all(shareId, config.streamGraceSeconds, now(), now(), config.streamGraceSeconds, now() - sportsEventOverrunLookupSeconds);
}

function epgEventIsStreamable(event) {
  const current = now();
  return event.starts_at - config.streamGraceSeconds <= current && current <= event.ends_at + config.streamGraceSeconds;
}

function scheduledItemHasSportsLink(item) {
  return Boolean(item?.espn_event_id);
}

async function resolveScheduledStreamEntitlement(event) {
  if (!scheduledItemHasSportsLink(event)) {
    return { event, streamable: epgEventIsStreamable(event), source: "epg", usesSportsClock: false };
  }
  if (now() < event.starts_at - config.streamGraceSeconds) {
    return { event, streamable: false, source: "epg-before-start", usesSportsClock: false };
  }
  try {
    const result = await getEspnGameSummary({
      league: event.espn_league || "nfl",
      eventId: event.espn_event_id,
    });
    storeFinalSportsSummary(event.id, result.summary, result.fetchedAt);
    if (sportsSummaryIsFinal(result.summary)) {
      const finalObservedAt = sportsFinalObservedAt(result.summary, event.espn_final_fetched_at || result.fetchedAt || now());
      return {
        event,
        streamable: now() <= finalObservedAt + config.streamGraceSeconds,
        source: "sports-final",
        usesSportsClock: true,
        summary: result.summary,
      };
    }
    if (String(result.summary?.state || "").toLowerCase() === "in") {
      return { event, streamable: true, source: "sports-live", usesSportsClock: true, summary: result.summary };
    }
    return { event, streamable: epgEventIsStreamable(event), source: "epg-sports-state", usesSportsClock: false, summary: result.summary };
  } catch {
    return { event, streamable: epgEventIsStreamable(event), source: "epg-sports-error", usesSportsClock: false };
  }
}

async function scheduledEventIsStreamable(event) {
  return (await resolveScheduledStreamEntitlement(event)).streamable;
}

async function findActiveStaticEvent(shareId) {
  for (const event of candidateStaticEvents(shareId)) {
    if (await scheduledEventIsStreamable(event)) return event;
  }
  return null;
}

function findActiveShareProgram(shareId) {
  return db
    .prepare(
      `
      SELECT
        epg_programs.*,
        epg_programs.start_at AS starts_at,
        epg_programs.end_at AS ends_at,
        channels.stream_url
      FROM share_link_items
      JOIN epg_programs ON epg_programs.id = share_link_items.program_id
      JOIN channels ON channels.id = epg_programs.channel_id
      WHERE share_link_items.share_id = ?
        AND epg_programs.start_at - ? <= ?
        AND ? <= epg_programs.end_at + ?
      ORDER BY epg_programs.start_at
      LIMIT 1
    `,
    )
    .get(shareId, config.streamGraceSeconds, now(), now(), config.streamGraceSeconds);
}

function restoreMissingTemporaryShareItems(share) {
  if (!share || share.mode !== "programs") return;
  const existing = db.prepare("SELECT COUNT(*) AS total FROM share_link_items WHERE share_id = ?").get(share.id).total;
  if (existing > 0 || !share.title) return;
  const requestedTitles = String(share.title)
    .split(" + ")
    .map((title) => title.trim().toLowerCase())
    .filter(Boolean);
  if (!requestedTitles.length) return;
  const remaining = new Map();
  for (const title of requestedTitles) remaining.set(title, (remaining.get(title) || 0) + 1);
  const candidates = db
    .prepare(
      `
      SELECT id, title
      FROM epg_programs
      WHERE channel_id = ?
        AND start_at >= ?
        AND end_at <= ?
      ORDER BY start_at
    `,
    )
    .all(share.channel_id, share.starts_at, share.ends_at);
  const insertItem = db.prepare("INSERT INTO share_link_items(share_id, program_id, position) VALUES (?, ?, ?)");
  let position = 0;
  for (const program of candidates) {
    const key = String(program.title || "").trim().toLowerCase();
    const count = remaining.get(key) || 0;
    if (!count) continue;
    insertItem.run(share.id, program.id, position);
    position += 1;
    if (count === 1) remaining.delete(key);
    else remaining.set(key, count - 1);
  }
}

app.get("/api/me", (req, res) => {
  const user = currentUser(req);
  res.json({ authenticated: Boolean(user), username: user?.username || null });
});

app.post("/api/login", (req, res) => {
  const { username = "", password = "" } = req.body || {};
  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
  if (!user || !verifyPassword(password, user.password_hash)) {
    res.status(401).json({ error: "Invalid username or password" });
    return;
  }
  const token = randomToken();
  db.prepare("INSERT INTO sessions(token, user_id, expires_at) VALUES (?, ?, ?)").run(token, user.id, now() + 1209600);
  setCookie(res, "iptv_session", token, { maxAge: 1209600 });
  res.status(204).end();
});

app.post("/api/logout", (req, res) => {
  if (req.cookies.iptv_session) db.prepare("DELETE FROM sessions WHERE token = ?").run(req.cookies.iptv_session);
  setCookie(res, "iptv_session", "", { maxAge: 0 });
  res.status(204).end();
});

app.get("/api/state", requireAuth, (_req, res) => {
  const state = db.prepare("SELECT * FROM refresh_state WHERE id = 1").get();
  const channels = db.prepare("SELECT COUNT(*) AS total FROM channels").get().total;
  const programs = db.prepare("SELECT COUNT(*) AS total FROM epg_programs").get().total;
  res.json({ state, channels, programs });
});

app.post("/api/refresh", requireAuth, async (_req, res) => {
  try {
    await refreshSources();
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/channels", requireAuth, (_req, res) => {
  const channels = db
    .prepare(
      `SELECT * FROM channels
       ORDER BY channel_sort IS NULL, channel_sort, group_name COLLATE NOCASE, name COLLATE NOCASE`,
    )
    .all()
    .map((channel) => ({
      ...channel,
      original_logo: channel.logo,
      logo: channel.logo ? `/api/channel-logo/${channel.id}` : null,
    }));
  res.json({ channels });
});

app.get("/api/channel-logo/:id", requireAuth, async (req, res) => {
  const channel = db.prepare("SELECT logo FROM channels WHERE id = ?").get(req.params.id);
  if (!channel?.logo) {
    res.status(404).end();
    return;
  }
  try {
    await proxyImage(res, channel.logo);
  } catch {
    res.status(502).end();
  }
});

app.get("/api/epg", requireAuth, (req, res) => {
  const start = Number(req.query.start || now() - 3600);
  const end = Number(req.query.end || now() + 21600);
  const programs = db
    .prepare(
      `
      SELECT epg_programs.*, channels.name AS channel_name
      FROM epg_programs
      LEFT JOIN channels ON channels.id = epg_programs.channel_id
      WHERE end_at > ? AND start_at < ?
      ORDER BY start_at
    `,
    )
    .all(start, end);
  res.json({
    programs: programs.map((program) => ({
      ...program,
      icon_url: program.icon ? `/api/program-image/${program.id}` : null,
    })),
  });
});

app.get("/api/program-image/:id", requireAuth, async (req, res) => {
  const program = db.prepare("SELECT icon FROM epg_programs WHERE id = ?").get(req.params.id);
  if (!program?.icon) {
    res.status(404).end();
    return;
  }
  try {
    await proxyImage(res, program.icon);
  } catch {
    res.status(502).end();
  }
});

app.get("/api/search", requireAuth, (req, res) => {
  const q = String(req.query.q || "").trim();
  if (q.length < 2) {
    res.json({ results: [] });
    return;
  }
  const needle = `%${q.replace(/[%_]/g, "\\$&")}%`;
  const results = db
    .prepare(
      `
      SELECT epg_programs.*, channels.name AS channel_name, channels.logo AS channel_logo
      FROM epg_programs
      LEFT JOIN channels ON channels.id = epg_programs.channel_id
      WHERE epg_programs.title LIKE ? ESCAPE '\\'
        OR epg_programs.subtitle LIKE ? ESCAPE '\\'
        OR epg_programs.description LIKE ? ESCAPE '\\'
        OR channels.name LIKE ? ESCAPE '\\'
      ORDER BY epg_programs.start_at
      LIMIT 40
    `,
    )
    .all(needle, needle, needle, needle)
    .map((program) => ({
      ...program,
      channel_logo: program.channel_logo ? `/api/channel-logo/${program.channel_id}` : null,
      icon_url: program.icon ? `/api/program-image/${program.id}` : null,
    }));
  res.json({ results });
});

app.get("/api/sports/espn/leagues", requireAuth, (_req, res) => {
  res.json({ leagues: espnLeagues() });
});

app.get("/api/sports/espn/search", requireAuth, async (req, res) => {
  try {
    const result = await searchEspnGames({
      league: String(req.query.league || "nfl"),
      q: String(req.query.q || ""),
      start: req.query.start,
      end: req.query.end,
    });
    res.json(result);
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.get("/api/sports/espn/cache", requireAuth, (_req, res) => {
  const current = now();
  const dayStart = Math.floor(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()) / 1000);
  const requestsToday = db.prepare("SELECT COUNT(*) AS total FROM espn_request_log WHERE requested_at >= ?").get(dayStart).total;
  const cacheRows = db.prepare("SELECT COUNT(*) AS total FROM espn_cache WHERE expires_at > ?").get(current).total;
  const staleRows = db.prepare("SELECT COUNT(*) AS total FROM espn_cache WHERE expires_at <= ?").get(current).total;
  res.json({
    requestsToday,
    maxRequestsPerDay: config.espnMaxRequestsPerDay,
    freshCacheEntries: cacheRows,
    staleCacheEntries: staleRows,
    searchCacheSeconds: config.espnSearchCacheSeconds,
    liveCacheSeconds: config.espnLiveCacheSeconds,
    liveCacheSecondsByLeague: config.espnLiveCacheSecondsByLeague,
  });
});

app.get("/api/sports/espn/summary", requireAuth, async (req, res) => {
  const eventId = String(req.query.eventId || "").trim();
  if (!eventId) {
    res.status(400).json({ error: "eventId is required" });
    return;
  }
  try {
    const result = await getEspnGameSummary({
      league: String(req.query.league || "nfl"),
      eventId,
    });
    res.json(result);
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.get("/api/sports/espn/game-package-debug", requireAuth, async (req, res) => {
  const eventId = String(req.query.eventId || "").trim();
  const league = String(req.query.league || "mlb");
  if (!eventId) {
    res.status(400).json({ error: "eventId is required" });
    return;
  }
  try {
    res.json(await getEspnRawGamePackage({ league, eventId }));
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.get("/api/sports/espn/fastcast-debug", requireAuth, (_req, res) => {
  res.json({ feeds: espnFastcastDebug() });
});

app.get("/api/stream/:channelId", requireAuth, async (req, res) => {
  const channel = db.prepare("SELECT stream_url FROM channels WHERE id = ?").get(req.params.channelId);
  if (!channel) {
    res.status(404).end();
    return;
  }
  await proxyStream(req, res, channel.stream_url, `admin-${req.params.channelId}`);
});

app.post("/api/shares", requireAuth, (req, res) => {
  let {
    slug = "",
    title = "",
    mode = "range",
    programIds = [],
    channelId = 0,
    startsAt = 0,
    endsAt = 0,
    password = "",
    maxViewers = null,
  } = req.body || {};

  slug = cleanSlug(slug);
  if (!slug) slug = crypto.randomUUID();
  title = String(title).trim() || null;
  password = String(password).trim();
  const passwordHash = password ? hashPassword(password) : null;
  const viewerLimit = Number(maxViewers) > 0 ? Number(maxViewers) : null;

  const tx = db.transaction(() => {
    if (db.prepare("SELECT id FROM static_shares WHERE slug = ?").get(slug)) throw new Error("That link name is already used");
    const ids = Array.isArray(programIds) ? programIds.map(Number).filter(Boolean) : [];
    let selectedPrograms = [];
    if (ids.length) {
      const placeholders = ids.map(() => "?").join(",");
      selectedPrograms = db.prepare(`SELECT * FROM epg_programs WHERE id IN (${placeholders}) ORDER BY start_at`).all(...ids);
      if (!selectedPrograms.length) throw new Error("No programs selected");
      const channels = new Set(selectedPrograms.map((program) => program.channel_id));
      if (channels.size !== 1) throw new Error("Selected events must be on one channel");
      channelId = selectedPrograms[0].channel_id;
      startsAt = Math.min(...selectedPrograms.map((program) => program.start_at));
      endsAt = Math.max(...selectedPrograms.map((program) => program.end_at));
      mode = "programs";
      title ||= selectedPrograms.slice(0, 3).map((program) => program.title).join(" + ");
    }

    if (!Number(channelId) || !Number(startsAt) || !Number(endsAt) || Number(endsAt) <= Number(startsAt)) {
      throw new Error("Pick a channel and valid time range");
    }

    const result = db
      .prepare(
        `
        INSERT INTO share_links(slug, title, channel_id, mode, starts_at, ends_at, password_hash, max_viewers, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(slug, title, Number(channelId), mode, Number(startsAt), Number(endsAt), passwordHash, viewerLimit, now());

    const insertItem = db.prepare("INSERT INTO share_link_items(share_id, program_id, position) VALUES (?, ?, ?)");
    selectedPrograms.forEach((program, index) => insertItem.run(result.lastInsertRowid, program.id, index));
    cleanupShareArtifacts("temporary", result.lastInsertRowid, false);
    return result.lastInsertRowid;
  });

  try {
    tx();
    const base = config.publicBaseUrl.replace(/\/$/, "");
    res.json({ slug, url: base ? `${base}/s/${slug}` : `/s/${slug}` });
  } catch (error) {
    const status = String(error.message).includes("UNIQUE") ? 409 : 400;
    res.status(status).json({ error: String(error.message).includes("UNIQUE") ? "That link name is already used" : error.message });
  }
});

app.post("/api/static-shares", requireAuth, (req, res) => {
  let { slug = "", title = "", description = "", icon = "", backgroundImage = "", discordWebhookUrl = "", password = "", maxViewers = null, spoilerDelaySeconds = 0 } = req.body || {};
  slug = cleanSlug(slug);
  if (!slug) slug = crypto.randomUUID();
  title = String(title).trim() || slug;
  description = String(description).trim() || null;
  icon = String(icon).trim() || null;
  backgroundImage = String(backgroundImage).trim() || null;
  discordWebhookUrl = String(discordWebhookUrl).trim() || null;
  password = String(password).trim();
  const passwordHash = password ? hashPassword(password) : null;
  const viewerLimit = Number(maxViewers) > 0 ? Number(maxViewers) : null;
  const spoilerDelay = cleanDelaySeconds(spoilerDelaySeconds);
  try {
    if (db.prepare("SELECT id FROM share_links WHERE slug = ?").get(slug)) throw new Error("That link name is already used");
    const result = db.prepare(
      `
      INSERT INTO static_shares(slug, title, description, icon, background_image, discord_webhook_url, password_hash, max_viewers, spoiler_delay_seconds, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(slug, title, description, icon, backgroundImage, discordWebhookUrl, passwordHash, viewerLimit, spoilerDelay, now(), now());
    cleanupShareArtifacts("static", result.lastInsertRowid, false);
    const base = config.publicBaseUrl.replace(/\/$/, "");
    res.json({ slug, url: base ? `${base}/s/${slug}` : `/s/${slug}` });
  } catch (error) {
    const status = String(error.message).includes("UNIQUE") ? 409 : 400;
    res.status(status).json({ error: String(error.message).includes("UNIQUE") ? "That link name is already used" : error.message });
  }
});

app.get("/api/shares", requireAuth, (_req, res) => {
  cleanupExpiredShares();
  const base = config.publicBaseUrl.replace(/\/$/, "") || "";
  const oneOffShares = db
    .prepare(
      `
      SELECT
        share_links.id,
        share_links.slug,
        share_links.title,
        share_links.mode,
        share_links.starts_at,
        share_links.ends_at,
        share_links.created_at,
        share_links.opened_count,
        share_links.last_opened_at,
        share_links.max_viewers,
        share_links.password_hash IS NOT NULL AS has_password,
        channels.name AS channel_name
      FROM share_links
      JOIN channels ON channels.id = share_links.channel_id
      ORDER BY share_links.created_at DESC
    `,
    )
    .all()
    .map((share) => ({
      ...share,
      kind: "temporary",
      event_count: null,
      next_event_at: null,
      url: `${base}/s/${share.slug}`,
      admin_ref: `temporary-${share.id}`,
      has_password: Boolean(share.has_password),
    }));
  const staticShares = db
    .prepare(
      `
      SELECT
        static_shares.id,
        static_shares.slug,
        static_shares.title,
        'static' AS mode,
        NULL AS starts_at,
        NULL AS ends_at,
        static_shares.created_at,
        static_shares.opened_count,
        static_shares.last_opened_at,
        static_shares.max_viewers,
        static_shares.spoiler_delay_seconds,
        static_shares.password_hash IS NOT NULL AS has_password,
        static_shares.discord_webhook_url IS NOT NULL AND static_shares.discord_webhook_url != '' AS has_discord_webhook,
        NULL AS channel_name,
        COUNT(static_share_events.id) AS event_count,
        MIN(CASE WHEN static_share_events.ends_at >= ? THEN static_share_events.starts_at END) AS next_event_at
      FROM static_shares
      LEFT JOIN static_share_events ON static_share_events.static_share_id = static_shares.id
      GROUP BY static_shares.id
      ORDER BY static_shares.created_at DESC
    `,
    )
    .all(now())
    .map((share) => ({
      ...share,
      kind: "static",
      url: `${base}/s/${share.slug}`,
      admin_ref: `static-${share.id}`,
      has_password: Boolean(share.has_password),
    }));
  res.json({ shares: [...staticShares, ...oneOffShares] });
});

app.delete("/api/shares/:id", requireAuth, (req, res) => {
  const share = loadShareById(req.params.id);
  if (!share) {
    res.status(404).json({ error: "not found" });
    return;
  }
  cleanupTemporaryShareArtifacts(share.id);
  const result = db.prepare("DELETE FROM share_links WHERE id = ?").run(req.params.id);
  if (!result.changes) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.status(204).end();
});

app.get("/api/share-viewers/:kind/:id", requireAuth, (req, res) => {
  const kind = req.params.kind === "static" ? "static" : "temporary";
  res.json({
    viewers: loadViewers(kind, Number(req.params.id)),
    messages: loadRecentChat(kind, Number(req.params.id)),
  });
});

app.delete("/api/share-viewers/:kind/:id/chat", requireAuth, (req, res) => {
  const kind = req.params.kind === "static" ? "static" : "temporary";
  const shareId = Number(req.params.id);
  const share = kind === "static" ? loadStaticShare(shareId) : loadShareById(shareId);
  if (!share) {
    res.status(404).json({ error: "share not found" });
    return;
  }
  db.prepare("DELETE FROM share_chat_messages WHERE share_kind = ? AND share_id = ?").run(shareKindColumn(kind), shareId);
  broadcastChatHistory(kind, shareId);
  res.status(204).end();
});

app.post("/api/share-viewers/:kind/:id/:viewerId/kick", requireAuth, (req, res) => {
  const kind = req.params.kind === "static" ? "static" : "temporary";
  const shareId = Number(req.params.id);
  const result = kickViewer(kind, shareId, Number(req.params.viewerId));
  if (!result.changes) {
    res.status(404).json({ error: "viewer not found" });
    return;
  }
  res.status(204).end();
});

app.post("/api/share-viewers/:kind/:id/:viewerId/unkick", requireAuth, (req, res) => {
  const kind = req.params.kind === "static" ? "static" : "temporary";
  const shareId = Number(req.params.id);
  const result = unkickViewer(kind, shareId, Number(req.params.viewerId));
  if (!result.changes) {
    res.status(404).json({ error: "viewer not found" });
    return;
  }
  res.status(204).end();
});

function publicBaseUrl() {
  return config.publicBaseUrl.replace(/\/$/, "") || "";
}

async function adminSafeStaticShare(share) {
  await finalizeCompletedStaticSportsEvents(share.id);
  const activeEvent = await findActiveStaticEvent(share.id);
  const streamKind = activeEvent ? inferStreamKind(activeEvent.stream_url) : null;
  const useFmp4 = config.transcodeMpegTs && streamKind === "mpegts";
  const { password_hash: _passwordHash, ...payload } = share;
  return {
    ...payload,
    kind: "static",
    has_password: Boolean(share.password_hash),
    url: `${publicBaseUrl()}/s/${share.slug}`,
    admin_ref: `static-${share.id}`,
    icon_url: share.icon ? versionedImageUrl(`/api/static-shares/${share.id}/icon`, share.updated_at) : null,
    background_image_url: share.background_image ? versionedImageUrl(`/api/static-shares/${share.id}/background`, share.updated_at) : null,
    active_event_id: activeEvent?.id || null,
    channel_name: activeEvent?.channel_name || "Scheduled stream",
    starts_at: activeEvent?.starts_at || null,
    ends_at: activeEvent?.ends_at || null,
    stream_available: Boolean(activeEvent),
    stream_url: activeEvent ? `/api/admin/stream/static-${share.id}?event=${activeEvent.id}` : null,
    hls_url: activeEvent && useFmp4 ? `/api/admin/stream/static-${share.id}?event=${activeEvent.id}&hls=1` : null,
    stream_kind: activeEvent ? streamKind : null,
    server_now: now(),
    events: loadStaticEvents(share.id),
    pastGames: loadPastGames(share.id),
    viewers: loadViewers("static", share.id),
    messages: loadRecentChat("static", share.id),
  };
}

function adminSafeTemporaryShare(share) {
  restoreMissingTemporaryShareItems(share);
  const activeProgram = share.mode === "programs" ? findActiveShareProgram(share.id) : null;
  const streamAvailable = share.mode === "programs" ? Boolean(activeProgram) : shareIsStreamable(share);
  const streamKind = inferStreamKind(activeProgram?.stream_url || share.stream_url);
  const useFmp4 = config.transcodeMpegTs && streamKind === "mpegts";
  const { password_hash: _passwordHash, stream_url: _streamUrl, ...payload } = share;
  const programs = db
    .prepare(
      `
      SELECT epg_programs.*
      FROM share_link_items
      JOIN epg_programs ON epg_programs.id = share_link_items.program_id
      WHERE share_id = ?
      ORDER BY position
    `,
    )
    .all(share.id)
    .map((program) => ({
      ...program,
      icon_url: program.icon ? `/api/public/program-image/${encodeURIComponent(share.slug)}/${program.id}` : null,
    }));
  return {
    ...payload,
    kind: "temporary",
    has_password: Boolean(share.password_hash),
    url: `${publicBaseUrl()}/s/${share.slug}`,
    admin_ref: `temporary-${share.id}`,
    active_program_id: activeProgram?.id || null,
    stream_available: streamAvailable,
    stream_url: streamAvailable ? `/api/admin/stream/temporary-${share.id}` : null,
    hls_url: streamAvailable && useFmp4 ? `/api/admin/stream/temporary-${share.id}?hls=1` : null,
    stream_kind: streamAvailable ? streamKind : null,
    server_now: now(),
    programs,
    viewers: loadViewers("temporary", share.id),
    messages: loadRecentChat("temporary", share.id),
  };
}

async function loadAdminShareByRef(ref) {
  const value = String(ref || "").trim();
  const staticMatch = value.match(/^static-(\d+)$/);
  if (staticMatch) {
    const share = loadStaticShare(staticMatch[1]);
    return share ? adminSafeStaticShare(share) : null;
  }
  const temporaryMatch = value.match(/^(temporary|temp)-(\d+)$/);
  if (temporaryMatch) {
    const share = loadShareById(temporaryMatch[2]);
    return share ? adminSafeTemporaryShare(share) : null;
  }
  const staticShare = db.prepare("SELECT * FROM static_shares WHERE slug = ?").get(value);
  if (staticShare) return adminSafeStaticShare(staticShare);
  const share = loadShare(value);
  return share ? adminSafeTemporaryShare(share) : null;
}

function loadRawShareByRef(ref) {
  const value = String(ref || "").trim();
  const staticMatch = value.match(/^static-(\d+)$/);
  if (staticMatch) {
    const share = loadStaticShare(staticMatch[1]);
    return share ? { kind: "static", share } : null;
  }
  const temporaryMatch = value.match(/^(temporary|temp)-(\d+)$/);
  if (temporaryMatch) {
    const share = loadShareById(temporaryMatch[2]);
    return share ? { kind: "temporary", share } : null;
  }
  const staticShare = db.prepare("SELECT * FROM static_shares WHERE slug = ?").get(value);
  if (staticShare) return { kind: "static", share: staticShare };
  const share = loadShare(value);
  return share ? { kind: "temporary", share } : null;
}

app.get("/api/admin/share/:ref", requireAuth, async (req, res) => {
  cleanupExpiredShares();
  const share = await loadAdminShareByRef(req.params.ref);
  if (!share) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json({ share });
});

app.get("/api/admin/share/:ref/sports-summary", requireAuth, async (req, res) => {
  const resolved = loadRawShareByRef(req.params.ref);
  if (!resolved || resolved.kind !== "static") {
    res.status(404).json({ error: "not found" });
    return;
  }
  const linkedEvent = req.query.event
    ? db
        .prepare("SELECT * FROM static_share_events WHERE static_share_id = ? AND id = ?")
        .get(resolved.share.id, req.query.event)
    : await findActiveStaticEvent(resolved.share.id);
  if (!linkedEvent?.espn_event_id) {
    res.status(404).json({ error: "No ESPN game linked" });
    return;
  }
  const refreshSeconds = espnSummaryRefreshSeconds(linkedEvent.espn_league || "nfl");
  const fastcastFeed = ensureStaticSportsLiveFeed(linkedEvent, "admin");
  const realtime = fastcastIsReady(fastcastFeed);
  res.json(storedSportsSummaryResponse("static", resolved.share.id, linkedEvent.id, {
    refreshSeconds,
    realtime,
    realtimeStatus: fastcastFeed?.status || null,
  }));
});

app.get("/api/admin/stream/:ref", requireAuth, async (req, res) => {
  const resolved = loadRawShareByRef(req.params.ref);
  if (!resolved) {
    res.status(404).end();
    return;
  }

  let targetUrl = "";
  let cutoffWindow = null;
  let streamRef = resolved.kind === "static" ? `static-${resolved.share.id}` : `temporary-${resolved.share.id}`;
  if (resolved.kind === "static") {
    const event = req.query.event
      ? db
          .prepare(
            `
            SELECT static_share_events.*, channels.stream_url
            FROM static_share_events
            JOIN channels ON channels.id = static_share_events.channel_id
            WHERE static_share_events.static_share_id = ? AND static_share_events.id = ?
          `,
          )
          .get(resolved.share.id, req.query.event)
      : await findActiveStaticEvent(resolved.share.id);
    const entitlement = event ? await resolveScheduledStreamEntitlement(event) : null;
    if (!entitlement?.streamable) {
      res.status(403).send("Scheduled event is not currently streamable");
      return;
    }
    targetUrl = event.stream_url;
    cutoffWindow = streamCutoffWindow(entitlement);
  } else {
    restoreMissingTemporaryShareItems(resolved.share);
    const activeProgram = resolved.share.mode === "programs" ? findActiveShareProgram(resolved.share.id) : null;
    if (resolved.share.mode === "programs" && !activeProgram) {
      res.status(403).send("No selected program is currently streamable");
      return;
    }
    if (resolved.share.mode !== "programs" && !shareIsStreamable(resolved.share)) {
      res.status(403).send("Share is not currently streamable");
      return;
    }
    targetUrl = activeProgram?.stream_url || resolved.share.stream_url;
    cutoffWindow = activeProgram || resolved.share;
  }

  if (req.query.hls === "1" && req.query.segment) {
    await serveHlsRemuxSegment(req, res);
    return;
  }
  if (req.query.u) {
    targetUrl = decodeTarget(String(req.query.u));
    if (!safeCompare(String(req.query.sig || ""), signStreamTarget(streamRef, targetUrl))) {
      res.status(403).send("Invalid stream signature");
      return;
    }
  }
  try {
    await withShareCutoff(cutoffWindow, res, async () => {
      if (req.query.hls === "1") {
        await serveHlsRemuxPlaylist(req, res, targetUrl, streamRef, cutoffWindow);
        return;
      }
      if (req.query.format === "fmp4") {
        await proxyFmp4Stream(req, res, targetUrl);
        return;
      }
      await proxyStream(req, res, targetUrl, streamRef, { route: "/api/admin/stream" });
    });
  } catch (error) {
    if (!res.headersSent) res.status(502).send(`Could not load stream: ${error.message}`);
  }
});

app.patch("/api/shares/:id", requireAuth, (req, res) => {
  const share = loadShareById(req.params.id);
  if (!share) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const maxViewers = Number(req.body?.maxViewers) > 0 ? Number(req.body.maxViewers) : null;
  db.prepare("UPDATE share_links SET max_viewers = ? WHERE id = ?").run(maxViewers, share.id);
  promoteWaitlist("temporary", share.id);
  broadcastShareState("temporary", share.id);
  res.json({ share: adminSafeTemporaryShare(loadShareById(share.id)) });
});

function normalizeSportsLink(value = {}) {
  if (!value?.id) return {};
  return {
    league: value.league || "",
    eventId: value.id,
    name: value.name || "",
    shortName: value.shortName || "",
    date: value.date || "",
    status: value.status || "",
    homeName: value.home?.name || "",
    homeAbbreviation: value.home?.abbreviation || "",
    homeLogo: value.home?.logo || "",
    awayName: value.away?.name || "",
    awayAbbreviation: value.away?.abbreviation || "",
    awayLogo: value.away?.logo || "",
  };
}

function sportsSummaryIsFinal(summary) {
  return Boolean(summary?.completed)
    || String(summary?.state || "").toLowerCase() === "post"
    || String(summary?.status || "").toLowerCase().includes("final")
    || String(summary?.statusDetail || "").toLowerCase().includes("final");
}

function sportsFinalObservedAt(summary, fallback = now()) {
  const timestamps = [
    summary?.completedAt,
    summary?.endDate,
    ...(Array.isArray(summary?.recentPlays) ? summary.recentPlays.map((play) => play?.wallclock) : []),
  ];
  const latest = timestamps
    .map((value) => {
      const parsed = Date.parse(value || "");
      return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
    })
    .filter(Boolean)
    .sort((a, b) => b - a)[0];
  return Number(latest || fallback || now());
}

function archiveSafeSportsSummary(summary) {
  if (!summary) return summary;
  const { recentPlays: _recentPlays, ...snapshot } = summary;
  return snapshot;
}

function storeFinalSportsSummary(staticEventId, summary, fetchedAt) {
  if (!staticEventId || !summary || !sportsSummaryIsFinal(summary)) return;
  const finalObservedAt = sportsFinalObservedAt(summary, fetchedAt);
  db.prepare("UPDATE static_share_events SET espn_final_summary = ?, espn_final_fetched_at = ?, updated_at = ? WHERE id = ?").run(
    JSON.stringify(archiveSafeSportsSummary(summary)),
    finalObservedAt,
    now(),
    staticEventId,
  );
  archiveStaticEventSnapshot(staticEventId);
}

async function finalizeCompletedStaticSportsEvents(shareId) {
  const events = db
    .prepare(
      `
      SELECT id, espn_league, espn_event_id, starts_at, ends_at
      FROM static_share_events
      WHERE static_share_id = ?
        AND espn_event_id IS NOT NULL
        AND espn_final_summary IS NULL
        AND starts_at - ? <= ?
        AND (
          ends_at + ? < ?
          OR starts_at >= ?
        )
      ORDER BY starts_at
      LIMIT 20
    `,
    )
    .all(
      shareId,
      config.streamGraceSeconds,
      now(),
      config.streamGraceSeconds,
      now(),
      now() - sportsEventOverrunLookupSeconds,
    );

  for (const event of events) {
    try {
      const result = await getEspnGameSummary({
        league: event.espn_league || "nfl",
        eventId: event.espn_event_id,
      });
      storeFinalSportsSummary(event.id, result.summary, result.fetchedAt);
    } catch (error) {
      console.warn(`ESPN finalization failed for static event ${event.id}: ${error.message}`);
    }
  }
}

function claimDelivery(key, shareId, eventId) {
  return db.prepare(
    "INSERT OR IGNORE INTO discord_webhook_deliveries(delivery_key, static_share_id, static_event_id, sent_at) VALUES (?, ?, ?, ?)",
  ).run(key, shareId, eventId || null, now()).changes > 0;
}

function releaseDelivery(key) {
  db.prepare("DELETE FROM discord_webhook_deliveries WHERE delivery_key = ?").run(key);
}

async function sendDiscordWebhook(webhookUrl, { content = "", embed }) {
  if (!webhookUrl) return false;
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "ShareTV",
      content,
      embeds: embed ? [embed] : [],
      allowed_mentions: { parse: [] },
    }),
  });
  if (!response.ok && response.status !== 204) throw new Error(`Discord webhook returned ${response.status}`);
  return true;
}

async function sendDiscordWebhookOnce(key, shareId, eventId, webhookUrl, payload) {
  if (!claimDelivery(key, shareId, eventId)) return false;
  try {
    await sendDiscordWebhook(webhookUrl, payload);
    return true;
  } catch (error) {
    releaseDelivery(key);
    throw error;
  }
}

function discordSportsKey(event) {
  if (event?.espn_event_id) return `static:${event.static_share_id}:espn:${event.espn_league || "unknown"}:${event.espn_event_id}`;
  return `static:${event.static_share_id}:event:${event.id}`;
}

function teamScoreLine(summary) {
  const competitors = [...(summary?.competitors || [])].sort((a, b) => (a.homeAway === "away" ? -1 : 1) - (b.homeAway === "away" ? -1 : 1));
  const away = competitors.find((entry) => entry.homeAway === "away") || competitors[0];
  const home = competitors.find((entry) => entry.homeAway === "home") || competitors[1];
  if (!away || !home) return summary?.shortName || summary?.name || "Game update";
  return `${away.team?.abbreviation || away.team?.name || "Away"} ${away.score ?? "-"} - ${home.score ?? "-"} ${home.team?.abbreviation || home.team?.name || "Home"}`;
}

function scoreDelta(summary) {
  const scores = (summary?.competitors || []).map((entry) => Number(entry.score)).filter(Number.isFinite);
  if (scores.length < 2) return null;
  return Math.abs(scores[0] - scores[1]);
}

function isCloseLateGame(summary) {
  const delta = scoreDelta(summary);
  if (delta === null) return false;
  if (summary.sport === "baseball" || summary.league === "mlb") return delta <= 2 && Number(summary.period || 0) >= 8;
  if (summary.sport === "basketball") return delta <= 6 && Number(summary.period || 0) >= 4;
  if (summary.sport === "football") return delta <= 8 && Number(summary.period || 0) >= 4;
  return false;
}

function ordinal(value) {
  const number = Number(value);
  const suffix = number % 100 >= 11 && number % 100 <= 13 ? "th" : { 1: "st", 2: "nd", 3: "rd" }[number % 10] || "th";
  return `${number}${suffix}`;
}

function periodLabel(summary, period) {
  const value = Number(period || 0);
  if (!value) return "period";
  if (summary.sport === "baseball" || summary.league === "mlb") return `${ordinal(value)} inning`;
  if (summary.league === "ncaamb" && value <= 2) return `${ordinal(value)} half`;
  if (summary.league === "ncaamb") {
    const overtime = value - 2;
    return overtime === 1 ? "OT" : `${overtime}OT`;
  }
  if (value <= 4) return `${ordinal(value)} quarter`;
  const overtime = value - 4;
  return overtime === 1 ? "OT" : `${overtime}OT`;
}

function explicitEndedPeriod(summary) {
  const detail = String(summary?.statusDetail || summary?.shortStatusDetail || "").trim();
  if (!/^end\b/i.test(detail)) return null;
  const period = Number(summary?.period || 0);
  if (!period) return null;
  return period;
}

function scoreKey(summary) {
  return [...(summary?.competitors || [])]
    .sort((a, b) => String(a.team?.id || a.team?.abbreviation).localeCompare(String(b.team?.id || b.team?.abbreviation)))
    .map((entry) => `${entry.team?.id || entry.team?.abbreviation || entry.homeAway}:${entry.score ?? "-"}`)
    .join("|");
}

function updateDiscordObservedState(eventId, summary) {
  db.prepare(
    `
    UPDATE static_share_events
    SET discord_last_period = ?, discord_last_state = ?, discord_last_detail = ?, discord_last_score = ?, discord_last_checked_at = ?, updated_at = ?
    WHERE id = ?
  `,
  ).run(
    Number(summary?.period || 0) || null,
    String(summary?.state || ""),
    String(summary?.statusDetail || summary?.shortStatusDetail || ""),
    scoreKey(summary),
    now(),
    now(),
    eventId,
  );
}

async function runDiscordWebhookTick() {
  const current = now();
  const events = db
    .prepare(
      `
      SELECT static_share_events.*, static_shares.slug, static_shares.title AS share_title, static_shares.discord_webhook_url
      FROM static_share_events
      JOIN static_shares ON static_shares.id = static_share_events.static_share_id
      WHERE static_share_events.espn_event_id IS NOT NULL
        AND static_shares.discord_webhook_url IS NOT NULL
        AND static_shares.discord_webhook_url != ''
        AND static_share_events.ends_at + ? >= ?
        AND static_share_events.starts_at <= ?
      ORDER BY static_share_events.starts_at
    `,
    )
    .all(config.shareAutoDeleteSeconds, current, current + config.discordWebhookLeadSeconds);

  for (const event of events) {
    const shareUrl = publicShareUrl({ slug: event.slug });
    const webhookUrl = String(event.discord_webhook_url || "").trim();
    const sportsKey = discordSportsKey(event);
    const reminderKey = `discord:reminder:${sportsKey}`;
    if (event.starts_at - current <= config.discordWebhookLeadSeconds && event.starts_at > current) {
      await sendDiscordWebhookOnce(reminderKey, event.static_share_id, event.id, webhookUrl, {
        content: `${event.title} starts in about 15 minutes: ${shareUrl}`,
        embed: {
          title: event.title,
          description: event.description || event.share_title || "Scheduled stream",
          url: shareUrl,
          color: 3261581,
        },
      });
    }

    if (event.starts_at <= current && (current <= event.ends_at + config.shareAutoDeleteSeconds || event.espn_event_id)) {
      const league = event.espn_league || "nfl";
      const interval = config.discordWebhookRefreshSecondsByLeague?.[league] || 180;
      if (Number(event.discord_last_checked_at || 0) && current - Number(event.discord_last_checked_at) < interval) continue;
      ensureStaticSportsLiveFeed(event, "discord");
      const result = await getEspnGameSummary({ league, eventId: event.espn_event_id });
      storeFinalSportsSummary(event.id, result.summary, result.fetchedAt);

      const previousPeriod = Number(event.discord_last_period || 0);
      const currentPeriod = Number(result.summary?.period || 0);
      const finalKey = `discord:final:${sportsKey}`;
      if (sportsSummaryIsFinal(result.summary)) {
        await sendDiscordWebhookOnce(finalKey, event.static_share_id, event.id, webhookUrl, {
          content: `FINAL: ${teamScoreLine(result.summary)}\n${shareUrl}`,
        });
      } else {
        const endedPeriod = explicitEndedPeriod(result.summary);
        const currentDetail = String(result.summary?.statusDetail || result.summary?.shortStatusDetail || "");
        const completedPeriod = endedPeriod || (previousPeriod && currentPeriod > previousPeriod ? currentPeriod - 1 : null);
        const alreadyObservedEnd = endedPeriod && currentDetail === String(event.discord_last_detail || "");
        if (completedPeriod && !alreadyObservedEnd) {
          const periodKey = `discord:period-end:${sportsKey}:${completedPeriod}`;
          await sendDiscordWebhookOnce(periodKey, event.static_share_id, event.id, webhookUrl, {
            content: `End of ${periodLabel(result.summary, completedPeriod)}: ${teamScoreLine(result.summary)}\n${shareUrl}`,
          });
        }
      }

      const closeKey = `discord:close:${sportsKey}`;
      if (!sportsSummaryIsFinal(result.summary) && isCloseLateGame(result.summary)) {
        await sendDiscordWebhookOnce(closeKey, event.static_share_id, event.id, webhookUrl, {
          content: `Close game alert: ${teamScoreLine(result.summary)} · ${result.summary.status || "Late game"}\n${shareUrl}`,
        });
      }
      updateDiscordObservedState(event.id, result.summary);
    }
  }
}

function loadStaticShare(idOrSlug) {
  return db.prepare("SELECT * FROM static_shares WHERE id = ? OR slug = ?").get(idOrSlug, idOrSlug);
}

function parseStoredJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function loadPastGames(shareId) {
  return db
    .prepare(
      `
      SELECT *
      FROM static_share_past_games
      WHERE static_share_id = ?
      ORDER BY starts_at DESC
      LIMIT 50
    `,
    )
    .all(shareId)
    .map((game) => ({
      ...game,
      icon_url: game.icon ? `/api/static-shares/${shareId}/past-games/${game.id}/image` : null,
      final_summary: parseStoredJson(game.espn_final_summary),
    }));
}

function loadStaticEvents(shareId, includePast = true) {
  return db
    .prepare(
      `
      SELECT static_share_events.*, channels.name AS channel_name
      FROM static_share_events
      JOIN channels ON channels.id = static_share_events.channel_id
      WHERE static_share_events.static_share_id = ?
        ${includePast ? "" : "AND static_share_events.ends_at >= ?"}
      ORDER BY static_share_events.starts_at
    `,
    )
    .all(...(includePast ? [shareId] : [shareId, now()]))
    .map((event) => ({
      ...event,
      icon_url: event.icon ? `/api/static-shares/${shareId}/events/${event.id}/image` : null,
      final_summary: parseStoredJson(event.espn_final_summary),
      espn: event.espn_event_id
        ? {
            league: event.espn_league,
            id: event.espn_event_id,
            name: event.espn_name,
            shortName: event.espn_short_name,
            date: event.espn_date,
            status: event.espn_status,
            home: { name: event.espn_home_name, abbreviation: event.espn_home_abbreviation, logo: event.espn_home_logo },
            away: { name: event.espn_away_name, abbreviation: event.espn_away_abbreviation, logo: event.espn_away_logo },
          }
        : null,
    }));
}

function publicStaticEvents(share) {
  return loadStaticEvents(share.id, true)
    .filter((event) => !event.final_summary || now() <= Number(event.espn_final_fetched_at || 0) + config.streamGraceSeconds)
    .map((event) => ({
      ...event,
      icon: undefined,
      icon_url: event.icon ? `/api/public/static-event-image/${encodeURIComponent(share.slug)}/${event.id}` : null,
    }));
}

function publicPastGames(share) {
  return loadPastGames(share.id).map((game) => ({
    ...game,
    icon_url: game.icon ? `/api/public/static-past-game-image/${encodeURIComponent(share.slug)}/${game.id}` : null,
  }));
}

app.get("/api/static-shares/:id", requireAuth, async (req, res) => {
  cleanupExpiredShares();
  const share = loadStaticShare(req.params.id);
  if (!share) {
    res.status(404).json({ error: "not found" });
    return;
  }
  await finalizeCompletedStaticSportsEvents(share.id);
  const { password_hash: _passwordHash, ...payload } = share;
  payload.has_password = Boolean(share.password_hash);
  payload.url = `${config.publicBaseUrl.replace(/\/$/, "") || ""}/s/${share.slug}`;
  payload.icon_url = share.icon ? versionedImageUrl(`/api/static-shares/${share.id}/icon`, share.updated_at) : null;
  payload.background_image_url = share.background_image ? versionedImageUrl(`/api/static-shares/${share.id}/background`, share.updated_at) : null;
  payload.events = loadStaticEvents(share.id);
  payload.pastGames = loadPastGames(share.id);
  res.json({ share: payload });
});

app.patch("/api/static-shares/:id", requireAuth, (req, res) => {
  const share = loadStaticShare(req.params.id);
  if (!share) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const title = String(req.body?.title || "").trim() || share.slug;
  const description = String(req.body?.description || "").trim() || null;
  const icon = String(req.body?.icon || "").trim() || null;
  const backgroundImage = String(req.body?.backgroundImage || "").trim() || null;
  const discordWebhookUrl = String(req.body?.discordWebhookUrl || "").trim() || null;
  const password = String(req.body?.password || "").trim();
  const clearPassword = Boolean(req.body?.clearPassword);
  const passwordHash = password ? hashPassword(password) : clearPassword ? null : share.password_hash;
  const maxViewers = Number(req.body?.maxViewers) > 0 ? Number(req.body.maxViewers) : null;
  const spoilerDelay = cleanDelaySeconds(req.body?.spoilerDelaySeconds);
  db.prepare(
    `
    UPDATE static_shares
    SET title = ?, description = ?, icon = ?, background_image = ?, discord_webhook_url = ?, password_hash = ?, max_viewers = ?, spoiler_delay_seconds = ?, updated_at = ?
    WHERE id = ?
  `,
  ).run(title, description, icon, backgroundImage, discordWebhookUrl, passwordHash, maxViewers, spoilerDelay, now(), share.id);
  const updated = loadStaticShare(share.id);
  const { password_hash: _passwordHash, ...payload } = updated;
  payload.has_password = Boolean(updated.password_hash);
  payload.url = `${config.publicBaseUrl.replace(/\/$/, "") || ""}/s/${updated.slug}`;
  payload.icon_url = updated.icon ? versionedImageUrl(`/api/static-shares/${updated.id}/icon`, updated.updated_at) : null;
  payload.background_image_url = updated.background_image ? versionedImageUrl(`/api/static-shares/${updated.id}/background`, updated.updated_at) : null;
  payload.events = loadStaticEvents(updated.id);
  payload.pastGames = loadPastGames(updated.id);
  res.json({ share: payload });
});

app.get("/api/static-shares/:id/icon", requireAuth, async (req, res) => {
  const share = loadStaticShare(req.params.id);
  if (!share?.icon) {
    res.status(404).end();
    return;
  }
  try {
    await proxyImage(res, share.icon, { cacheControl: "no-store" });
  } catch {
    res.status(502).end();
  }
});

app.get("/api/static-shares/:id/background", requireAuth, async (req, res) => {
  const share = loadStaticShare(req.params.id);
  if (!share?.background_image) {
    res.status(404).end();
    return;
  }
  try {
    await proxyImage(res, share.background_image, { cacheControl: "no-store" });
  } catch {
    res.status(502).end();
  }
});

app.delete("/api/static-shares/:id", requireAuth, (req, res) => {
  const share = loadStaticShare(req.params.id);
  if (!share) {
    res.status(404).json({ error: "not found" });
    return;
  }
  cleanupShareArtifacts("static", share.id);
  const result = db.prepare("DELETE FROM static_shares WHERE id = ?").run(share.id);
  if (!result.changes) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.status(204).end();
});

app.post("/api/static-shares/:id/events", requireAuth, (req, res) => {
  const share = loadStaticShare(req.params.id);
  if (!share) {
    res.status(404).json({ error: "not found" });
    return;
  }
  let {
    programId = null,
    channelId = 0,
    title = "",
    description = "",
    icon = "",
    startsAt = 0,
    endsAt = 0,
    espn = null,
  } = req.body || {};

  if (programId) {
    const program = db.prepare("SELECT * FROM epg_programs WHERE id = ?").get(programId);
    if (!program) {
      res.status(400).json({ error: "EPG event not found" });
      return;
    }
    channelId = program.channel_id;
    title ||= program.title;
    description ||= program.description || "";
    icon ||= program.icon || "";
    startsAt ||= program.start_at;
    endsAt ||= program.end_at;
  }

  if (!Number(channelId) || !String(title).trim() || !Number(startsAt) || !Number(endsAt) || Number(endsAt) <= Number(startsAt)) {
    res.status(400).json({ error: "Pick a channel, title, and valid event time" });
    return;
  }

  const sports = normalizeSportsLink(espn);
  const result = db
    .prepare(
      `
      INSERT INTO static_share_events(
        static_share_id, program_id, channel_id, title, description, icon, starts_at, ends_at,
        espn_league, espn_event_id, espn_name, espn_short_name, espn_date, espn_status,
        espn_home_name, espn_home_abbreviation, espn_home_logo,
        espn_away_name, espn_away_abbreviation, espn_away_logo,
        created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    )
    .run(
      share.id,
      programId ? Number(programId) : null,
      Number(channelId),
      String(title).trim(),
      String(description || "").trim() || null,
      String(icon || "").trim() || null,
      Number(startsAt),
      Number(endsAt),
      sports.league || null,
      sports.eventId || null,
      sports.name || null,
      sports.shortName || null,
      sports.date || null,
      sports.status || null,
      sports.homeName || null,
      sports.homeAbbreviation || null,
      sports.homeLogo || null,
      sports.awayName || null,
      sports.awayAbbreviation || null,
      sports.awayLogo || null,
      now(),
      now(),
    );
  db.prepare("UPDATE static_shares SET updated_at = ? WHERE id = ?").run(now(), share.id);
  const addedEvent = loadStaticEvents(share.id).find((event) => event.id === result.lastInsertRowid);
  if (addedEvent?.espn_event_id) {
    ensureStaticSportsLiveFeed(addedEvent, "schedule-add");
    runSportsTrackerTick();
  }
  res.json({ event: addedEvent });
});

app.delete("/api/static-shares/:shareId/events/:eventId", requireAuth, (req, res) => {
  const removedEvent = db
    .prepare("SELECT * FROM static_share_events WHERE static_share_id = ? AND id = ?")
    .get(req.params.shareId, req.params.eventId);
  const result = db
    .prepare("DELETE FROM static_share_events WHERE static_share_id = ? AND id = ?")
    .run(req.params.shareId, req.params.eventId);
  if (!result.changes) {
    res.status(404).json({ error: "not found" });
    return;
  }
  cleanupDelayedSportsEvent("static", Number(req.params.shareId), Number(req.params.eventId));
  cleanupDelayedSportsUpdates("static", Number(req.params.shareId), removedEvent?.espn_event_id ? [removedEvent] : []);
  db.prepare("UPDATE static_shares SET updated_at = ? WHERE id = ?").run(now(), req.params.shareId);
  res.status(204).end();
});

app.get("/api/static-shares/:shareId/events/:eventId/image", requireAuth, async (req, res) => {
  const event = db
    .prepare("SELECT icon FROM static_share_events WHERE static_share_id = ? AND id = ?")
    .get(req.params.shareId, req.params.eventId);
  if (!event?.icon) {
    res.status(404).end();
    return;
  }
  try {
    await proxyImage(res, event.icon);
  } catch {
    res.status(502).end();
  }
});

app.get("/api/static-shares/:shareId/past-games/:gameId/image", requireAuth, async (req, res) => {
  const game = db
    .prepare("SELECT icon FROM static_share_past_games WHERE static_share_id = ? AND id = ?")
    .get(req.params.shareId, req.params.gameId);
  if (!game?.icon) {
    res.status(404).end();
    return;
  }
  try {
    await proxyImage(res, game.icon);
  } catch {
    res.status(502).end();
  }
});

app.delete("/api/static-shares/:shareId/past-games/:gameId", requireAuth, (req, res) => {
  const share = loadStaticShare(req.params.shareId);
  if (!share) {
    res.status(404).json({ error: "share not found" });
    return;
  }
  const game = db
    .prepare("SELECT id, original_event_id FROM static_share_past_games WHERE static_share_id = ? AND id = ?")
    .get(share.id, req.params.gameId);
  if (!game) {
    res.status(404).json({ error: "past game not found" });
    return;
  }
  const result = db
    .prepare("DELETE FROM static_share_past_games WHERE static_share_id = ? AND id = ?")
    .run(share.id, req.params.gameId);
  if (!result.changes) {
    res.status(404).json({ error: "past game not found" });
    return;
  }
  const liveEventStillExists = game.original_event_id
    ? db.prepare("SELECT 1 FROM static_share_events WHERE static_share_id = ? AND id = ?").get(share.id, game.original_event_id)
    : null;
  if (game.original_event_id && !liveEventStillExists) {
    db.prepare("DELETE FROM discord_webhook_deliveries WHERE static_share_id = ? AND static_event_id = ?").run(share.id, game.original_event_id);
  }
  db.prepare("UPDATE static_shares SET updated_at = ? WHERE id = ?").run(now(), share.id);
  res.status(204).end();
});

function loadShare(slug) {
  return db
    .prepare(
      `
      SELECT share_links.*, channels.name AS channel_name, channels.logo, channels.stream_url
      FROM share_links
      JOIN channels ON channels.id = share_links.channel_id
      WHERE share_links.slug = ?
    `,
    )
    .get(slug);
}

function loadShareById(id) {
  return db
    .prepare(
      `
      SELECT share_links.*, channels.name AS channel_name, channels.logo, channels.stream_url
      FROM share_links
      JOIN channels ON channels.id = share_links.channel_id
      WHERE share_links.id = ?
    `,
    )
    .get(id);
}

app.get("/api/public/share/:slug", async (req, res) => {
  cleanupExpiredShares();
  const staticShare = db.prepare("SELECT * FROM static_shares WHERE slug = ?").get(req.params.slug);
  if (staticShare) {
    const locked = !staticShareIsUnlocked(req, staticShare);
    if (!locked) await finalizeCompletedStaticSportsEvents(staticShare.id);
    const activeEvent = locked ? null : await findActiveStaticEvent(staticShare.id);
    const events = publicStaticEvents(staticShare);
    const streamKind = activeEvent ? inferStreamKind(activeEvent.stream_url) : null;
    const useFmp4 = config.transcodeMpegTs && streamKind === "mpegts";
    const {
      password_hash: _passwordHash,
      discord_webhook_url: _discordWebhookUrl,
      icon: _icon,
      background_image: _backgroundImage,
      ...payload
    } = staticShare;
    payload.kind = "static";
    payload.locked = locked;
    payload.events = events;
    payload.programs = events;
    payload.pastGames = locked ? [] : publicPastGames(staticShare);
    payload.icon_url = staticShare.icon
      ? versionedImageUrl(`/api/public/static-share-icon/${encodeURIComponent(staticShare.slug)}`, staticShare.updated_at)
      : null;
    payload.background_image_url = staticShare.background_image
      ? versionedImageUrl(`/api/public/static-share-background/${encodeURIComponent(staticShare.slug)}`, staticShare.updated_at)
      : null;
    payload.server_now = now();
    payload.active_event_id = activeEvent?.id || null;
    payload.channel_name = activeEvent?.channel_name || events.find((event) => event.ends_at >= now())?.channel_name || "Scheduled stream";
    payload.starts_at = activeEvent?.starts_at || events[0]?.starts_at || null;
    payload.ends_at = activeEvent?.ends_at || events.at(-1)?.ends_at || null;
    payload.stream_available = Boolean(activeEvent);
    payload.stream_url = activeEvent ? `/api/public/stream/${encodeURIComponent(staticShare.slug)}?event=${activeEvent.id}` : null;
    payload.hls_url = activeEvent && useFmp4 ? `/api/public/stream/${encodeURIComponent(staticShare.slug)}?event=${activeEvent.id}&hls=1` : null;
    payload.stream_kind = activeEvent ? streamKind : null;
    res.json({ share: payload });
    return;
  }

  const share = loadShare(req.params.slug);
  if (!share) {
    res.status(404).json({ error: "not found" });
    return;
  }
  restoreMissingTemporaryShareItems(share);
  const locked = !shareIsUnlocked(req, share);
  const programs = locked
    ? []
    : db
        .prepare(
          `
          SELECT epg_programs.*
          FROM share_link_items
          JOIN epg_programs ON epg_programs.id = share_link_items.program_id
          WHERE share_id = ?
          ORDER BY position
        `,
        )
        .all(share.id)
        .map((program) => ({
          ...program,
          icon_url: program.icon ? `/api/public/program-image/${encodeURIComponent(share.slug)}/${program.id}` : null,
        }));
  const { password_hash: _passwordHash, stream_url: _streamUrl, ...payload } = share;
  payload.locked = locked;
  payload.programs = programs;
  payload.server_now = now();
  const activeProgram = !locked && share.mode === "programs" ? findActiveShareProgram(share.id) : null;
  payload.active_program_id = activeProgram?.id || null;
  payload.stream_available = !locked && (share.mode === "programs" ? Boolean(activeProgram) : shareIsStreamable(share));
  const streamKind = inferStreamKind(activeProgram?.stream_url || share.stream_url);
  const useFmp4 = config.transcodeMpegTs && streamKind === "mpegts";
  payload.stream_url = payload.stream_available ? `/api/public/stream/${encodeURIComponent(share.slug)}` : null;
  payload.hls_url = payload.stream_available && useFmp4 ? `/api/public/stream/${encodeURIComponent(share.slug)}?hls=1` : null;
  payload.stream_kind = payload.stream_available ? streamKind : null;
  res.json({ share: payload });
});

app.get("/api/public/program-image/:slug/:programId", async (req, res) => {
  cleanupExpiredShares();
  const share = loadShare(req.params.slug);
  if (!share || !shareIsUnlocked(req, share)) {
    res.status(404).end();
    return;
  }
  const program = db
    .prepare(
      `
      SELECT epg_programs.icon
      FROM share_link_items
      JOIN epg_programs ON epg_programs.id = share_link_items.program_id
      WHERE share_link_items.share_id = ? AND epg_programs.id = ?
    `,
    )
    .get(share.id, req.params.programId);
  if (!program?.icon) {
    res.status(404).end();
    return;
  }
  try {
    await proxyImage(res, program.icon);
  } catch {
    res.status(502).end();
  }
});

app.get("/api/public/static-event-image/:slug/:eventId", async (req, res) => {
  const share = db.prepare("SELECT * FROM static_shares WHERE slug = ?").get(req.params.slug);
  if (!share) {
    res.status(404).end();
    return;
  }
  const event = db
    .prepare("SELECT icon FROM static_share_events WHERE static_share_id = ? AND id = ?")
    .get(share.id, req.params.eventId);
  if (!event?.icon) {
    res.status(404).end();
    return;
  }
  try {
    await proxyImage(res, event.icon);
  } catch {
    res.status(502).end();
  }
});

app.get("/api/public/static-share-icon/:slug", async (req, res) => {
  const share = db.prepare("SELECT icon FROM static_shares WHERE slug = ?").get(req.params.slug);
  if (!share?.icon) {
    res.status(404).end();
    return;
  }
  try {
    await proxyImage(res, share.icon, { cacheControl: "no-store" });
  } catch {
    res.status(502).end();
  }
});

app.get("/api/public/static-share-background/:slug", async (req, res) => {
  const share = db.prepare("SELECT background_image FROM static_shares WHERE slug = ?").get(req.params.slug);
  if (!share?.background_image) {
    res.status(404).end();
    return;
  }
  try {
    await proxyImage(res, share.background_image, { cacheControl: "no-store" });
  } catch {
    res.status(502).end();
  }
});

app.get("/api/public/static-past-game-image/:slug/:gameId", async (req, res) => {
  const share = db.prepare("SELECT id FROM static_shares WHERE slug = ?").get(req.params.slug);
  if (!share) {
    res.status(404).end();
    return;
  }
  const game = db
    .prepare("SELECT icon FROM static_share_past_games WHERE static_share_id = ? AND id = ?")
    .get(share.id, req.params.gameId);
  if (!game?.icon) {
    res.status(404).end();
    return;
  }
  try {
    await proxyImage(res, game.icon);
  } catch {
    res.status(502).end();
  }
});

app.get("/api/public/share/:slug/sports-summary", async (req, res) => {
  const share = db.prepare("SELECT * FROM static_shares WHERE slug = ?").get(req.params.slug);
  if (!share || !staticShareIsUnlocked(req, share)) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const linkedEvent = req.query.event
    ? db
        .prepare("SELECT * FROM static_share_events WHERE static_share_id = ? AND id = ?")
        .get(share.id, req.query.event)
    : await findActiveStaticEvent(share.id);
  if (!linkedEvent?.espn_event_id) {
    res.status(404).json({ error: "No ESPN game linked" });
    return;
  }
  const refreshSeconds = espnSummaryRefreshSeconds(linkedEvent.espn_league || "nfl");
  if (actualStreamingCount("static", share.id) <= 0) {
    res.json(skippedSportsSummaryResponse("static", share.id, refreshSeconds, "No active stream viewers"));
    return;
  }
  const fastcastFeed = ensureStaticSportsLiveFeed(linkedEvent, "public");
  const realtime = fastcastIsReady(fastcastFeed);
  res.json(storedSportsSummaryResponse("static", share.id, linkedEvent.id, {
    refreshSeconds,
    realtime,
    realtimeStatus: fastcastFeed?.status || null,
  }));
});

app.post("/api/public/share/:slug/open", (req, res) => {
  cleanupExpiredShares();
  const staticShare = db.prepare("SELECT id FROM static_shares WHERE slug = ?").get(req.params.slug);
  if (staticShare) {
    db.prepare("UPDATE static_shares SET opened_count = opened_count + 1, last_opened_at = ? WHERE id = ?").run(now(), staticShare.id);
    res.status(204).end();
    return;
  }
  const share = loadShare(req.params.slug);
  if (!share) {
    res.status(404).json({ error: "not found" });
    return;
  }
  db.prepare("UPDATE share_links SET opened_count = opened_count + 1, last_opened_at = ? WHERE id = ?").run(now(), share.id);
  res.status(204).end();
});

app.post("/api/public/share/:slug/unlock", (req, res) => {
  cleanupExpiredShares();
  const staticShare = db.prepare("SELECT * FROM static_shares WHERE slug = ?").get(req.params.slug);
  if (staticShare) {
    if (!staticShare.password_hash || verifyPassword(req.body?.password || "", staticShare.password_hash)) {
      setCookie(res, `static_share_${staticShare.id}`, signedShareCookie(`static:${staticShare.id}`), { maxAge: 86400 });
      res.status(204).end();
      return;
    }
    res.status(401).json({ error: "Incorrect password" });
    return;
  }
  const share = loadShare(req.params.slug);
  if (!share) {
    res.status(404).json({ error: "not found" });
    return;
  }
  if (!share.password_hash || verifyPassword(req.body?.password || "", share.password_hash)) {
    setCookie(res, `share_${share.id}`, signedShareCookie(share.id), { maxAge: 86400 });
    res.status(204).end();
    return;
  }
  res.status(401).json({ error: "Incorrect password" });
});

app.get("/api/public/stream/:slug", async (req, res) => {
  cleanupExpiredShares();
  const staticShare = db.prepare("SELECT * FROM static_shares WHERE slug = ?").get(req.params.slug);
  if (staticShare) {
    if (!staticShareIsUnlocked(req, staticShare)) {
      res.status(403).send("Share is locked");
      return;
    }
    const event = req.query.event
      ? db
          .prepare(
            `
            SELECT static_share_events.*, channels.stream_url
            FROM static_share_events
            JOIN channels ON channels.id = static_share_events.channel_id
            WHERE static_share_events.static_share_id = ? AND static_share_events.id = ?
          `,
          )
          .get(staticShare.id, req.query.event)
      : await findActiveStaticEvent(staticShare.id);
    const entitlement = event ? await resolveScheduledStreamEntitlement(event) : null;
    if (!entitlement?.streamable) {
      res.status(403).send("Scheduled event is not currently streamable");
      return;
    }
    const viewerToken = String(req.query.viewer || "");
    const viewerAccess = requestViewerStream("static", staticShare.id, viewerToken);
    if (!viewerAccess.ok) {
      if (viewerAccess.waiting) res.setHeader("X-IPTV-Share-Waitlist-Position", String(viewerAccess.position || ""));
      res.status(viewerAccess.status).send(viewerAccess.message);
      return;
    }
    if (req.query.hls === "1" && req.query.segment) {
      await withViewerStream(viewerToken, res, async () => serveHlsRemuxSegment(req, res));
      return;
    }
    let targetUrl = event.stream_url;
    if (req.query.u) {
      targetUrl = decodeTarget(String(req.query.u));
      if (!safeCompare(String(req.query.sig || ""), signStreamTarget(staticShare.slug, targetUrl))) {
        res.status(403).send("Invalid stream signature");
        return;
      }
    }
    try {
      await withViewerStream(viewerToken, res, async () => {
        await withShareCutoff(streamCutoffWindow(entitlement), res, async () => {
          if (req.query.hls === "1") {
            await serveHlsRemuxPlaylist(req, res, targetUrl, staticShare.slug, streamCutoffWindow(entitlement));
            return;
          }
          if (req.query.format === "fmp4") {
            await proxyFmp4Stream(req, res, targetUrl);
            return;
          }
          await proxyStream(req, res, targetUrl, staticShare.slug);
        });
      });
    } catch (error) {
      if (!res.headersSent) res.status(502).send(`Could not load stream: ${error.message}`);
    }
    return;
  }

  const share = loadShare(req.params.slug);
  if (!share) {
    res.status(404).end();
    return;
  }
  restoreMissingTemporaryShareItems(share);
  if (!shareIsUnlocked(req, share)) {
    res.status(403).send("Share is not currently streamable");
    return;
  }
  const activeProgram = share.mode === "programs" ? findActiveShareProgram(share.id) : null;
  if (share.mode === "programs" && !activeProgram) {
    res.status(403).send("No selected program is currently streamable");
    return;
  }
  if (share.mode !== "programs" && !shareIsStreamable(share)) {
    res.status(403).send("Share is not currently streamable");
    return;
  }
  const viewerToken = String(req.query.viewer || "");
  const viewerAccess = requestViewerStream("temporary", share.id, viewerToken);
  if (!viewerAccess.ok) {
    if (viewerAccess.waiting) res.setHeader("X-IPTV-Share-Waitlist-Position", String(viewerAccess.position || ""));
    res.status(viewerAccess.status).send(viewerAccess.message);
    return;
  }
  let targetUrl = share.stream_url;
  let cutoffWindow = share;
  if (activeProgram) {
    targetUrl = activeProgram.stream_url;
    cutoffWindow = activeProgram;
  }
  if (req.query.hls === "1" && req.query.segment) {
    await withViewerStream(viewerToken, res, async () => serveHlsRemuxSegment(req, res));
    return;
  }
  if (req.query.u) {
    targetUrl = decodeTarget(String(req.query.u));
    if (!safeCompare(String(req.query.sig || ""), signStreamTarget(share.slug, targetUrl))) {
      res.status(403).send("Invalid stream signature");
      return;
    }
  }
  try {
    await withViewerStream(viewerToken, res, async () => {
      await withShareCutoff(cutoffWindow, res, async () => {
        if (req.query.hls === "1") {
          await serveHlsRemuxPlaylist(req, res, targetUrl, share.slug, cutoffWindow);
          return;
        }
        if (req.query.format === "fmp4") {
          await proxyFmp4Stream(req, res, targetUrl);
          return;
        }
        await proxyStream(req, res, targetUrl, share.slug);
      });
    });
  } catch (error) {
    if (!res.headersSent) res.status(502).send(`Could not load stream: ${error.message}`);
  }
});

const wss = new WebSocketServer({ noServer: true });

function currentUserFromUpgrade(req) {
  req.cookies = cookie.parse(req.headers.cookie || "");
  return currentUser(req);
}

function handleShareSocket(ws, req, slug) {
  req.cookies = cookie.parse(req.headers.cookie || "");
  const resolved = resolveShareBySlug(slug);
  const adminUser = currentUserFromUpgrade(req);
  if (!resolved) {
    sendJson(ws, { type: "error", error: "Share not found" });
    ws.close();
    return;
  }
  if (resolved.kind === "static" && !adminUser && !staticShareIsUnlocked(req, resolved.share)) {
    sendJson(ws, { type: "error", error: "Share is locked" });
    ws.close();
    return;
  }
  if (resolved.kind === "temporary" && !adminUser && !shareIsUnlocked(req, resolved.share)) {
    sendJson(ws, { type: "error", error: "Share is locked" });
    ws.close();
    return;
  }

  const kind = resolved.kind;
  const shareId = resolved.share.id;
  const key = shareSocketKey(kind, shareId);
  if (!viewerSockets.has(key)) viewerSockets.set(key, new Set());
  viewerSockets.get(key).add(ws);
  ws.shareKey = key;
  ws.shareKind = kind;
  ws.shareId = shareId;
  ws.viewerToken = null;

  const heartbeat = setInterval(() => {
    if (!ws.viewerToken) return;
    const viewer = db.prepare("SELECT kicked_at FROM share_viewers WHERE token = ?").get(ws.viewerToken);
    if (viewer?.kicked_at) {
      sendJson(ws, { type: "kicked" });
      ws.close();
      return;
    }
    touchViewer(ws.viewerToken);
    if (ws.streamActive) {
      db.prepare("UPDATE share_viewers SET stream_last_seen_at = ? WHERE token = ? AND kicked_at IS NULL").run(now(), ws.viewerToken);
      ensureSportsPushForSocket(ws, ws.sportsEventId, adminUser ? "admin-heartbeat" : "viewer-heartbeat", { sendSnapshot: false });
    }
    if (promoteWaitlist(kind, shareId)) broadcastShareState(kind, shareId);
  }, 15000);

  sendJson(ws, { type: "ready" });
  sendJson(ws, { type: "chatHistory", messages: loadRecentChat(kind, shareId) });
  sendJson(ws, { type: "presence", viewers: loadViewers(kind, shareId) });

  ws.on("message", (raw) => {
    let payload;
    try {
      payload = JSON.parse(raw.toString());
    } catch {
      sendJson(ws, { type: "error", error: "Bad message" });
      return;
    }

    if (payload.type === "hello") {
      const token = cleanViewerToken(payload.token);
      const username = cleanViewerName(payload.username);
      const viewer = upsertViewer(kind, shareId, token, username);
      ws.viewerToken = token;
      ws.sportsEventId = Number(payload.sportsEventId || 0) || null;
      sendJson(ws, { type: "hello", token, viewer: viewerPublicRow(viewer) });
      if (adminUser) ensureSportsPushForSocket(ws, ws.sportsEventId, "admin-socket");
      broadcastShareState(kind, shareId, { force: true });
      return;
    }

    if (payload.type === "chat") {
      if (!ws.viewerToken) {
        sendJson(ws, { type: "error", error: "Choose a username first" });
        return;
      }
      const viewer = db.prepare("SELECT * FROM share_viewers WHERE token = ?").get(ws.viewerToken);
      if (!viewer || viewer.kicked_at) {
        sendJson(ws, { type: "kicked" });
        ws.close();
        return;
      }
      const text = String(payload.message || "").trim().slice(0, 500);
      if (!text) return;
      touchViewer(ws.viewerToken);
      const result = db
        .prepare("INSERT INTO share_chat_messages(share_kind, share_id, viewer_token, username, message, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(shareKindColumn(kind), shareId, ws.viewerToken, viewer.username, text, now());
      db.prepare(
        `
        DELETE FROM share_chat_messages
        WHERE share_kind = ? AND share_id = ? AND id NOT IN (
          SELECT id
          FROM share_chat_messages
          WHERE share_kind = ? AND share_id = ?
          ORDER BY created_at DESC, id DESC
          LIMIT 500
        )
      `,
      ).run(shareKindColumn(kind), shareId, shareKindColumn(kind), shareId);
      broadcastChat(kind, shareId, {
        id: result.lastInsertRowid,
        username: viewer.username,
        message: text,
        created_at: now(),
      });
      return;
    }

    if (payload.type === "streamState") {
      if (!ws.viewerToken) return;
      ws.streamActive = Boolean(payload.active);
      ws.sportsEventId = Number(payload.sportsEventId || 0) || ws.sportsEventId || null;
      const viewer = db.prepare("SELECT stream_granted_at FROM share_viewers WHERE token = ? AND kicked_at IS NULL").get(ws.viewerToken);
      const hasRecentGrant = Number(viewer?.stream_granted_at || 0) >= now() - viewerActiveSeconds;
      if (ws.streamActive && hasRecentGrant) {
        db.prepare("UPDATE share_viewers SET stream_last_seen_at = ? WHERE token = ? AND kicked_at IS NULL").run(now(), ws.viewerToken);
      } else {
        db.prepare("UPDATE share_viewers SET stream_last_seen_at = NULL, stream_granted_at = NULL WHERE token = ? AND kicked_at IS NULL").run(ws.viewerToken);
      }
      if (!ws.streamActive) promoteWaitlist(kind, shareId);
      if (ws.streamActive) ensureSportsPushForSocket(ws, ws.sportsEventId, adminUser ? "admin-stream" : "viewer-stream");
      broadcastShareState(kind, shareId, { force: true });
    }
  });

  ws.on("close", () => {
    clearInterval(heartbeat);
    if (ws.viewerToken) {
      db.prepare("UPDATE share_viewers SET last_seen_at = ?, stream_last_seen_at = NULL, wants_stream = 0, waitlist_joined_at = NULL, stream_granted_at = NULL WHERE token = ?").run(
        now() - viewerActiveSeconds - 1,
        ws.viewerToken,
      );
    }
    const sockets = viewerSockets.get(key);
    if (sockets) {
      sockets.delete(ws);
      if (!sockets.size) viewerSockets.delete(key);
    }
    promoteWaitlist(kind, shareId);
    broadcastShareState(kind, shareId, { force: true });
  });
}

function handleAdminSocket(ws, req) {
  if (!currentUserFromUpgrade(req)) {
    sendJson(ws, { type: "error", error: "unauthorized" });
    ws.close();
    return;
  }
  adminSockets.add(ws);
  sendJson(ws, { type: "ready" });

  ws.on("message", (raw) => {
    let payload;
    try {
      payload = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (payload.type === "subscribe") {
      const kind = payload.shareKind === "static" ? "static" : "temporary";
      const shareId = Number(payload.shareId || 0);
      ws.shareFilter = shareSocketKey(kind, shareId);
      ws.shareKind = kind;
      ws.shareId = shareId;
      sendJson(ws, { type: "presence", shareKind: shareKindColumn(kind), shareId, viewers: loadViewers(kind, shareId) });
      sendJson(ws, { type: "chatHistory", shareKind: shareKindColumn(kind), shareId, messages: loadRecentChat(kind, shareId) });
      ensureSportsPushForSocket(ws, Number(payload.sportsEventId || 0), "admin-subscribe");
    }
    if (payload.type === "kick") {
      const kind = payload.shareKind === "static" ? "static" : "temporary";
      const shareId = Number(payload.shareId || 0);
      kickViewer(kind, shareId, Number(payload.viewerId || 0));
    }
    if (payload.type === "unkick") {
      const kind = payload.shareKind === "static" ? "static" : "temporary";
      const shareId = Number(payload.shareId || 0);
      unkickViewer(kind, shareId, Number(payload.viewerId || 0));
    }
  });

  ws.on("close", () => {
    adminSockets.delete(ws);
  });
}

if (config.nodeEnv === "production") {
  app.use(express.static(distDir));
  app.get(["/", "/login", "/admin", "/admin/s/:shareRef", "/s/:slug"], (_req, res) => {
    res.sendFile(path.join(distDir, "index.html"));
  });
}

initDb();
try {
  await refreshSources();
} catch (error) {
  console.error(`Initial guide refresh failed: ${error.message}`);
}
runSportsTrackerTick();

setInterval(async () => {
  cleanupExpiredShares();
  const state = db.prepare("SELECT last_refresh_at FROM refresh_state WHERE id = 1").get();
  if (!state?.last_refresh_at || now() - state.last_refresh_at > config.epgRefreshSeconds) {
    try {
      await refreshSources();
    } catch (error) {
      console.error(`Guide refresh failed: ${error.message}`);
    }
  }
  runSportsTrackerTick();
}, 60000);

let discordWebhookTickRunning = false;
setInterval(async () => {
  if (discordWebhookTickRunning) return;
  discordWebhookTickRunning = true;
  try {
    await runDiscordWebhookTick();
  } catch (error) {
    console.error(`Discord webhook tick failed: ${error.message}`);
  } finally {
    discordWebhookTickRunning = false;
  }
}, Math.max(30, config.discordWebhookTickSeconds) * 1000);

const server = createServer(app);

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", "http://localhost");
  const shareMatch = url.pathname.match(/^\/ws\/share\/([^/]+)$/);
  if (shareMatch) {
    wss.handleUpgrade(req, socket, head, (ws) => handleShareSocket(ws, req, decodeURIComponent(shareMatch[1])));
    return;
  }
  if (url.pathname === "/ws/admin") {
    wss.handleUpgrade(req, socket, head, (ws) => handleAdminSocket(ws, req));
    return;
  }
  socket.destroy();
});

server.listen(config.port, () => {
  console.log(`IPTV Share listening on http://0.0.0.0:${config.port}`);
});

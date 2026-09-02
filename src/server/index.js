import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import express from "express";
import cookie from "cookie";
import { config } from "./config.js";
import { db, initDb } from "./db.js";
import { refreshSources } from "./importers.js";
import { hashPassword, randomToken, safeCompare, signedShareCookie, signStreamTarget, verifyPassword } from "./crypto.js";
import { espnLeagues, getEspnGameSummary, searchEspnGames } from "./espn.js";
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

app.use(express.json({ limit: "1mb" }));
app.use((req, _res, next) => {
  req.cookies = cookie.parse(req.headers.cookie || "");
  next();
});

function now() {
  return Math.floor(Date.now() / 1000);
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
  db.prepare("DELETE FROM share_links WHERE ends_at + ? < ?").run(config.shareAutoDeleteSeconds, now());
}

function cleanSlug(slug) {
  return String(slug || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

async function withShareCutoff(share, res, action) {
  const millisecondsRemaining = Math.max(0, (share.ends_at + config.shareAutoDeleteSeconds - now()) * 1000);
  const timer = setTimeout(() => {
    if (!res.destroyed) res.destroy();
  }, millisecondsRemaining);
  try {
    await action();
  } finally {
    clearTimeout(timer);
  }
}

async function proxyImage(res, url) {
  const response = await fetch(url);
  if (!response.ok) {
    res.status(502).end();
    return;
  }
  res.setHeader("Content-Type", response.headers.get("content-type") || "image/png");
  res.setHeader("Cache-Control", "public, max-age=86400");
  Readable.fromWeb(response.body).pipe(res);
}

function staticShareIsUnlocked(req, share) {
  if (!share.password_hash) return true;
  return safeCompare(req.cookies[`static_share_${share.id}`], signedShareCookie(`static:${share.id}`));
}

function findActiveStaticEvent(shareId) {
  return db
    .prepare(
      `
      SELECT static_share_events.*, channels.name AS channel_name, channels.stream_url
      FROM static_share_events
      JOIN channels ON channels.id = static_share_events.channel_id
      WHERE static_share_events.static_share_id = ?
        AND static_share_events.starts_at - ? <= ?
        AND ? <= static_share_events.ends_at + ?
      ORDER BY static_share_events.starts_at
      LIMIT 1
    `,
    )
    .get(shareId, config.streamGraceSeconds, now(), now(), config.shareAutoDeleteSeconds);
}

function scheduledEventIsStreamable(event) {
  const current = now();
  return event.starts_at - config.streamGraceSeconds <= current && current <= event.ends_at + config.shareAutoDeleteSeconds;
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
    .get(shareId, config.streamGraceSeconds, now(), now(), config.shareAutoDeleteSeconds);
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
    .prepare("SELECT * FROM channels ORDER BY group_name, name")
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
  } = req.body || {};

  slug = cleanSlug(slug);
  if (!slug) slug = crypto.randomUUID();
  title = String(title).trim() || null;
  password = String(password).trim();
  const passwordHash = password ? hashPassword(password) : null;

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
        INSERT INTO share_links(slug, title, channel_id, mode, starts_at, ends_at, password_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(slug, title, Number(channelId), mode, Number(startsAt), Number(endsAt), passwordHash, now());

    const insertItem = db.prepare("INSERT INTO share_link_items(share_id, program_id, position) VALUES (?, ?, ?)");
    selectedPrograms.forEach((program, index) => insertItem.run(result.lastInsertRowid, program.id, index));
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
  let { slug = "", title = "", description = "", icon = "", password = "" } = req.body || {};
  slug = cleanSlug(slug);
  if (!slug) slug = crypto.randomUUID();
  title = String(title).trim() || slug;
  description = String(description).trim() || null;
  icon = String(icon).trim() || null;
  password = String(password).trim();
  const passwordHash = password ? hashPassword(password) : null;
  try {
    if (db.prepare("SELECT id FROM share_links WHERE slug = ?").get(slug)) throw new Error("That link name is already used");
    db.prepare(
      `
      INSERT INTO static_shares(slug, title, description, icon, password_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(slug, title, description, icon, passwordHash, now(), now());
    const base = config.publicBaseUrl.replace(/\/$/, "");
    res.json({ slug, url: base ? `${base}/s/${slug}` : `/s/${slug}` });
  } catch (error) {
    const status = String(error.message).includes("UNIQUE") ? 409 : 400;
    res.status(status).json({ error: String(error.message).includes("UNIQUE") ? "That link name is already used" : error.message });
  }
});

app.get("/api/shares", requireAuth, (_req, res) => {
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
        static_shares.password_hash IS NOT NULL AS has_password,
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
      has_password: Boolean(share.has_password),
    }));
  res.json({ shares: [...staticShares, ...oneOffShares] });
});

app.delete("/api/shares/:id", requireAuth, (req, res) => {
  const result = db.prepare("DELETE FROM share_links WHERE id = ?").run(req.params.id);
  if (!result.changes) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.status(204).end();
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

function loadStaticShare(idOrSlug) {
  return db.prepare("SELECT * FROM static_shares WHERE id = ? OR slug = ?").get(idOrSlug, idOrSlug);
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
  return loadStaticEvents(share.id, true).map((event) => ({
    ...event,
    icon_url: event.icon ? `/api/public/static-event-image/${encodeURIComponent(share.slug)}/${event.id}` : null,
  }));
}

app.get("/api/static-shares/:id", requireAuth, (req, res) => {
  const share = loadStaticShare(req.params.id);
  if (!share) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const { password_hash: _passwordHash, ...payload } = share;
  payload.has_password = Boolean(share.password_hash);
  payload.url = `${config.publicBaseUrl.replace(/\/$/, "") || ""}/s/${share.slug}`;
  payload.events = loadStaticEvents(share.id);
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
  const password = String(req.body?.password || "").trim();
  const clearPassword = Boolean(req.body?.clearPassword);
  const passwordHash = password ? hashPassword(password) : clearPassword ? null : share.password_hash;
  db.prepare(
    `
    UPDATE static_shares
    SET title = ?, description = ?, icon = ?, password_hash = ?, updated_at = ?
    WHERE id = ?
  `,
  ).run(title, description, icon, passwordHash, now(), share.id);
  const updated = loadStaticShare(share.id);
  const { password_hash: _passwordHash, ...payload } = updated;
  payload.has_password = Boolean(updated.password_hash);
  payload.url = `${config.publicBaseUrl.replace(/\/$/, "") || ""}/s/${updated.slug}`;
  payload.events = loadStaticEvents(updated.id);
  res.json({ share: payload });
});

app.get("/api/static-shares/:id/icon", requireAuth, async (req, res) => {
  const share = loadStaticShare(req.params.id);
  if (!share?.icon) {
    res.status(404).end();
    return;
  }
  try {
    await proxyImage(res, share.icon);
  } catch {
    res.status(502).end();
  }
});

app.delete("/api/static-shares/:id", requireAuth, (req, res) => {
  const result = db.prepare("DELETE FROM static_shares WHERE id = ?").run(req.params.id);
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
  res.json({ event: loadStaticEvents(share.id).find((event) => event.id === result.lastInsertRowid) });
});

app.delete("/api/static-shares/:shareId/events/:eventId", requireAuth, (req, res) => {
  const result = db
    .prepare("DELETE FROM static_share_events WHERE static_share_id = ? AND id = ?")
    .run(req.params.shareId, req.params.eventId);
  if (!result.changes) {
    res.status(404).json({ error: "not found" });
    return;
  }
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

app.get("/api/public/share/:slug", (req, res) => {
  cleanupExpiredShares();
  const staticShare = db.prepare("SELECT * FROM static_shares WHERE slug = ?").get(req.params.slug);
  if (staticShare) {
    const locked = !staticShareIsUnlocked(req, staticShare);
    const events = publicStaticEvents(staticShare);
    const activeEvent = locked ? null : findActiveStaticEvent(staticShare.id);
    const streamKind = activeEvent ? inferStreamKind(activeEvent.stream_url) : null;
    const useFmp4 = config.transcodeMpegTs && streamKind === "mpegts";
    const { password_hash: _passwordHash, ...payload } = staticShare;
    payload.kind = "static";
    payload.locked = locked;
    payload.events = events;
    payload.programs = events;
    payload.icon_url = staticShare.icon ? `/api/public/static-share-icon/${encodeURIComponent(staticShare.slug)}` : null;
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
    await proxyImage(res, share.icon);
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
    : findActiveStaticEvent(share.id);
  if (!linkedEvent?.espn_event_id) {
    res.status(404).json({ error: "No ESPN game linked" });
    return;
  }
  try {
    const result = await getEspnGameSummary({
      league: linkedEvent.espn_league || "nfl",
      eventId: linkedEvent.espn_event_id,
    });
    res.json({
      summary: result.summary,
      refreshSeconds: config.espnLiveCacheSeconds,
      fetchedAt: result.fetchedAt,
    });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
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
      : findActiveStaticEvent(staticShare.id);
    if (!event || !scheduledEventIsStreamable(event)) {
      res.status(403).send("Scheduled event is not currently streamable");
      return;
    }
    if (req.query.hls === "1" && req.query.segment) {
      serveHlsRemuxSegment(req, res);
      return;
    }
    try {
      await withShareCutoff(event, res, async () => {
        if (req.query.hls === "1") {
          await serveHlsRemuxPlaylist(req, res, event.stream_url, staticShare.slug, event);
          return;
        }
        if (req.query.format === "fmp4") {
          await proxyFmp4Stream(req, res, event.stream_url);
          return;
        }
        await proxyStream(req, res, event.stream_url, staticShare.slug);
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
  if (!shareIsUnlocked(req, share) || !shareIsStreamable(share)) {
    res.status(403).send("Share is not currently streamable");
    return;
  }
  const activeProgram = share.mode === "programs" ? findActiveShareProgram(share.id) : null;
  if (share.mode === "programs" && !activeProgram) {
    res.status(403).send("No selected program is currently streamable");
    return;
  }
  let targetUrl = share.stream_url;
  let cutoffWindow = share;
  if (activeProgram) {
    targetUrl = activeProgram.stream_url;
    cutoffWindow = activeProgram;
  }
  if (req.query.hls === "1" && req.query.segment) {
    serveHlsRemuxSegment(req, res);
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
  } catch (error) {
    if (!res.headersSent) res.status(502).send(`Could not load stream: ${error.message}`);
  }
});

if (config.nodeEnv === "production") {
  app.use(express.static(distDir));
  app.get(["/", "/login", "/s/:slug"], (_req, res) => {
    res.sendFile(path.join(distDir, "index.html"));
  });
}

initDb();
try {
  await refreshSources();
} catch (error) {
  console.error(`Initial guide refresh failed: ${error.message}`);
}

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
}, 60000);

app.listen(config.port, () => {
  console.log(`IPTV Share listening on http://0.0.0.0:${config.port}`);
});

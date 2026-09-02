import path from "node:path";
import crypto from "node:crypto";
import express from "express";
import cookie from "cookie";
import { config } from "./config.js";
import { db, initDb } from "./db.js";
import { refreshSources } from "./importers.js";
import { hashPassword, randomToken, safeCompare, signedShareCookie, signStreamTarget, verifyPassword } from "./crypto.js";
import { decodeTarget, inferStreamKind, proxyFmp4Stream, proxyStream, shareIsStreamable, shareIsUnlocked } from "./stream.js";

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
  const channels = db.prepare("SELECT * FROM channels ORDER BY group_name, name").all();
  res.json({ channels });
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
  res.json({ programs });
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

  slug = String(slug).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) slug = crypto.randomUUID();
  title = String(title).trim() || null;
  password = String(password).trim();
  const passwordHash = password ? hashPassword(password) : null;

  const tx = db.transaction(() => {
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

app.get("/api/shares", requireAuth, (_req, res) => {
  const shares = db
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
      url: `${config.publicBaseUrl.replace(/\/$/, "") || ""}/s/${share.slug}`,
      has_password: Boolean(share.has_password),
    }));
  res.json({ shares });
});

app.delete("/api/shares/:id", requireAuth, (req, res) => {
  const result = db.prepare("DELETE FROM share_links WHERE id = ?").run(req.params.id);
  if (!result.changes) {
    res.status(404).json({ error: "not found" });
    return;
  }
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

app.get("/api/public/share/:slug", (req, res) => {
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
        .all(share.id);
  const { password_hash: _passwordHash, stream_url: _streamUrl, ...payload } = share;
  payload.locked = locked;
  payload.programs = programs;
  payload.server_now = now();
  payload.stream_available = !locked && shareIsStreamable(share);
  const streamKind = inferStreamKind(share.stream_url);
  const useFmp4 = config.transcodeMpegTs && streamKind === "mpegts";
  payload.stream_url = payload.stream_available
    ? `/api/public/stream/${encodeURIComponent(share.slug)}${useFmp4 ? "?format=fmp4" : ""}`
    : null;
  payload.stream_kind = payload.stream_available ? (useFmp4 ? "native" : streamKind) : null;
  res.json({ share: payload });
});

app.post("/api/public/share/:slug/open", (req, res) => {
  const share = loadShare(req.params.slug);
  if (!share) {
    res.status(404).json({ error: "not found" });
    return;
  }
  db.prepare("UPDATE share_links SET opened_count = opened_count + 1, last_opened_at = ? WHERE id = ?").run(now(), share.id);
  res.status(204).end();
});

app.post("/api/public/share/:slug/unlock", (req, res) => {
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
  const share = loadShare(req.params.slug);
  if (!share) {
    res.status(404).end();
    return;
  }
  if (!shareIsUnlocked(req, share) || !shareIsStreamable(share)) {
    res.status(403).send("Share is not currently streamable");
    return;
  }
  let targetUrl = share.stream_url;
  if (req.query.u) {
    targetUrl = decodeTarget(String(req.query.u));
    if (!safeCompare(String(req.query.sig || ""), signStreamTarget(share.slug, targetUrl))) {
      res.status(403).send("Invalid stream signature");
      return;
    }
  }
  try {
    if (req.query.format === "fmp4") {
      await proxyFmp4Stream(req, res, targetUrl);
      return;
    }
    await proxyStream(req, res, targetUrl, share.slug);
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

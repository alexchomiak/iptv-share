import crypto from "node:crypto";
import { isIP } from "node:net";
import express from "express";
import { Readable } from "node:stream";

export const previewScope = "discord:share-preview:read";

export function initIntegrationKeys(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS integration_api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL,
    scope TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    created_by INTEGER NOT NULL,
    revoked_at INTEGER
  )`);
}

function keyHash(secret) {
  return crypto.createHash("sha256").update(secret).digest();
}

export function issueIntegrationKey(db, name, userId, current) {
  const secret = `stv_${crypto.randomBytes(32).toString("base64url")}`;
  const result = db.prepare(`INSERT INTO integration_api_keys
    (name, key_hash, scope, created_at, created_by) VALUES (?, ?, ?, ?, ?)`)
    .run(name, keyHash(secret).toString("hex"), previewScope, current, userId);
  return { key: listIntegrationKeys(db).find((key) => key.id === Number(result.lastInsertRowid)), secret };
}

export function listIntegrationKeys(db) {
  return db.prepare(`SELECT id, name, scope, created_at, created_by, revoked_at
    FROM integration_api_keys ORDER BY id DESC`).all();
}

export function revokeIntegrationKey(db, id, current) {
  return db.prepare(`UPDATE integration_api_keys SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?`)
    .run(current, id).changes > 0;
}

export function authenticateIntegrationKey(db, secret) {
  const supplied = keyHash(typeof secret === "string" ? secret : "");
  let valid = false;
  for (const key of db.prepare("SELECT key_hash, scope, revoked_at FROM integration_api_keys").all()) {
    const stored = Buffer.from(key.key_hash, "hex");
    const matches = stored.length === supplied.length && crypto.timingSafeEqual(stored, supplied);
    if (matches && key.scope === previewScope && key.revoked_at === null) valid = true;
  }
  return Boolean(secret) && valid;
}

// Only public upstream artwork, never the authenticated API or a channel logo.
export function publicImageUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (!host.includes(".") || /\.(localhost|local|internal|test|invalid)$/.test(host)) return null;
    if (isIP(host)) {
      if (isIP(host) !== 4) return null;
      const [a, b] = host.split(".").map(Number);
      if (a === 0 || a === 10 || a === 127 || a >= 224 ||
          (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
          (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return null;
    }
    if ([...url.searchParams.keys()].some((key) => /^(password|passwd|username|api[_-]?key|authorization)$/i.test(key))) return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

function imageSource(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function imageSignature(secret, slug, kind, row, expires) {
  return crypto.createHmac("sha256", secret).update(JSON.stringify(["discord-preview-image", slug, kind, row.id, row.icon, expires])).digest();
}

function programme(row, current, imageUrl = (row) => publicImageUrl(row.icon)) {
  if (!row) return null;
  const start = row.start_at ?? row.starts_at;
  const end = row.end_at ?? row.ends_at;
  if (!(start <= current && current < end)) return null;
  return { id: row.id, title: row.title, start_at: start, end_at: end, icon_url: imageUrl(row) };
}

export async function sharePreview(db, slug, current, { unlocked, activeProgram, activeEvent, imageUrl }) {
  const staticShare = db.prepare("SELECT * FROM static_shares WHERE slug = ?").get(slug);
  if (staticShare) {
    if (!unlocked("static", staticShare)) return { status: 403, body: { error: "locked" } };
    let event = await activeEvent(staticShare.id);
    if (event) event = db.prepare(`SELECT static_share_events.*, channels.name AS channel_name
      FROM static_share_events JOIN channels ON channels.id = static_share_events.channel_id
      WHERE static_share_events.static_share_id = ? AND static_share_events.id = ?`).get(staticShare.id, event.id);
    const normalized = programme(event, current, imageUrl && ((row) => staticShare.password_hash ? publicImageUrl(row.icon) : imageUrl("static", row)));
    return { status: 200, body: { preview: { channel_name: event?.channel_name || "Scheduled stream", programme: normalized } } };
  }
  const share = db.prepare(`SELECT share_links.*, channels.name AS channel_name
    FROM share_links JOIN channels ON channels.id = share_links.channel_id WHERE slug = ?`).get(slug);
  if (!share || current >= share.ends_at) return { status: 404, body: { error: "not found" } };
  if (!unlocked("temporary", share)) return { status: 403, body: { error: "locked" } };
  let row = null;
  if (share.mode === "programs" && share.starts_at <= current) {
    row = await activeProgram(share);
    // Enforce membership even when the selected programme uses another channel.
    if (row && !db.prepare("SELECT 1 FROM share_link_items WHERE share_id = ? AND program_id = ?").get(share.id, row.id)) row = null;
    if (row) row = db.prepare(`SELECT epg_programs.*, channels.name AS channel_name
      FROM epg_programs JOIN channels ON channels.id = epg_programs.channel_id WHERE epg_programs.id = ?`).get(row.id);
  } else if (share.starts_at <= current) {
    row = db.prepare(`SELECT id, title, start_at, end_at, icon FROM epg_programs
      WHERE channel_id = ? AND start_at <= ? AND ? < end_at
      ORDER BY start_at DESC, id DESC LIMIT 1`).get(share.channel_id, current, current);
  }
  return { status: 200, body: { preview: { channel_name: row?.channel_name || share.channel_name, programme: programme(row, current, imageUrl && ((row) => share.password_hash ? publicImageUrl(row.icon) : imageUrl("temporary", row))) } } };
}

export function discordPreviewRouter({ db, requireAuth, now, unlocked, activeProgram, activeEvent, imageSecret, publicBaseUrl = "" }) {
  const router = express.Router();
  router.use(["/admin/integration-keys", "/integrations/discord"], (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.get("/admin/integration-keys", requireAuth, (_req, res) => res.json({ keys: listIntegrationKeys(db) }));
  router.post("/admin/integration-keys", requireAuth, (req, res) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!name || name.length > 100) return res.status(400).json({ error: "Name must contain 1–100 characters." });
    res.status(201).json(issueIntegrationKey(db, name, req.user.id, now()));
  });
  router.delete("/admin/integration-keys/:id", requireAuth, (req, res) => {
    if (!/^\d+$/.test(req.params.id) || !revokeIntegrationKey(db, Number(req.params.id), now())) return res.status(404).json({ error: "not found" });
    res.status(204).end();
  });
  router.get("/integrations/discord/share/:slug/preview", async (req, res, next) => {
    if (!authenticateIntegrationKey(db, req.get("X-API-Key"))) return res.status(401).json({ error: "unauthorized" });
    try {
      const result = await sharePreview(db, req.params.slug, now(), {
        unlocked: (kind, share) => unlocked(req, kind, share), activeProgram, activeEvent,
        imageUrl: imageSecret ? (kind, row) => {
          if (!imageSource(row.icon)) return null;
          const expires = now() + 300;
          const base = publicBaseUrl.replace(/\/$/, "") || `${req.protocol}://${req.get("host")}`;
          let url;
          try { url = new URL(`${base}/api/public/discord-programme-image/${encodeURIComponent(req.params.slug)}/${kind}/${row.id}`); }
          catch { return null; }
          if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
          url.searchParams.set("expires", expires);
          url.searchParams.set("signature", imageSignature(imageSecret, req.params.slug, kind, row, expires).toString("hex"));
          return url.href;
        } : undefined,
      });
      res.status(result.status).json(result.body);
    } catch (error) { next(error); }
  });
  router.get("/public/discord-programme-image/:slug/:kind/:id", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const current = now();
    const expires = Number(req.query.expires);
    const signature = typeof req.query.signature === "string" && /^[a-f0-9]{64}$/.test(req.query.signature)
      ? Buffer.from(req.query.signature, "hex") : Buffer.alloc(32);
    if (!imageSecret || !Number.isInteger(expires) || expires <= current || expires > current + 300 || !/^\d+$/.test(req.params.id)) return res.status(404).end();
    let row;
    if (req.params.kind === "static") {
      row = db.prepare(`SELECT e.* FROM static_share_events e
        JOIN static_shares s ON s.id = e.static_share_id
        JOIN channels c ON c.id = e.channel_id
        WHERE s.slug = ? AND e.id = ? AND COALESCE(s.password_hash, '') = ''
          AND e.starts_at <= ? AND ? < e.ends_at`).get(req.params.slug, req.params.id, current, current);
    } else if (req.params.kind === "temporary") {
      row = db.prepare(`SELECT p.* FROM epg_programs p JOIN channels c ON c.id = p.channel_id
        JOIN share_links s ON s.slug = ?
        WHERE p.id = ? AND COALESCE(s.password_hash, '') = '' AND s.starts_at <= ? AND ? < s.ends_at
          AND p.start_at <= ? AND ? < p.end_at
          AND ((s.mode != 'programs' AND p.channel_id = s.channel_id)
            OR (s.mode = 'programs' AND EXISTS (SELECT 1 FROM share_link_items i WHERE i.share_id = s.id AND i.program_id = p.id)))`)
        .get(req.params.slug, req.params.id, current, current, current, current);
    }
    if (!row || !imageSource(row.icon) || !crypto.timingSafeEqual(signature, imageSignature(imageSecret, req.params.slug, req.params.kind, row, expires))) return res.status(404).end();
    try {
      // Fetch only stored artwork after checking its signed share/item scope. No API key or cookies are forwarded.
      const response = await fetch(imageSource(row.icon), { redirect: "error", signal: AbortSignal.timeout(1500) });
      const contentType = response.headers.get("content-type") || "";
      if (!response.ok || !/^image\//i.test(contentType) || !response.body) {
        await response.body?.cancel();
        return res.status(502).end();
      }
      res.set("Content-Type", contentType);
      res.set("X-Content-Type-Options", "nosniff");
      res.set("Content-Security-Policy", "default-src 'none'; sandbox");
      const body = Readable.fromWeb(response.body);
      body.on("error", () => res.destroy());
      res.on("close", () => body.destroy());
      body.pipe(res);
    } catch { if (!res.headersSent) res.status(502).end(); else res.destroy(); }
  });
  return router;
}

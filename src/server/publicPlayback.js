import crypto from "node:crypto";
import { config } from "./config.js";
import { safeCompare, signViewerAccess } from "./crypto.js";

function requestBaseUrl(req, configuredBaseUrl = config.publicBaseUrl) {
  const configured = String(configuredBaseUrl || "").trim().replace(/\/$/, "");
  if (configured) return configured;
  const protocol = req?.protocol === "https" ? "https" : "http";
  const host = String(req?.get?.("host") || req?.headers?.host || "").trim();
  if (!host) return "";
  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch {
    return "";
  }
}

function absoluteUrl(req, pathname, configuredBaseUrl) {
  const base = requestBaseUrl(req, configuredBaseUrl);
  return base ? new URL(pathname, `${base}/`).toString() : pathname;
}

export function publicStreamUrls(req, { kind, shareId, slug, eventId = null, useHls = false }, options = {}) {
  const viewerToken = options.viewerToken || crypto.randomBytes(24).toString("hex");
  const params = new URLSearchParams();
  if (eventId) params.set("event", String(eventId));
  params.set("viewer", viewerToken);
  params.set("vsig", signViewerAccess(kind, shareId, viewerToken));
  const pathname = `/api/public/stream/${encodeURIComponent(slug)}?${params}`;
  const streamUrl = absoluteUrl(req, pathname, options.publicBaseUrl);
  if (!useHls) return { streamUrl, hlsUrl: null };
  params.set("hls", "1");
  return {
    streamUrl,
    hlsUrl: absoluteUrl(req, `/api/public/stream/${encodeURIComponent(slug)}?${params}`, options.publicBaseUrl),
  };
}

export function registerSignedViewer({ kind, shareId, token, signature, findViewer, registerViewer }) {
  if (!token || !signature || !safeCompare(signature, signViewerAccess(kind, shareId, token))) return false;
  if (!findViewer(token, kind, shareId)) registerViewer(token, kind, shareId);
  return true;
}

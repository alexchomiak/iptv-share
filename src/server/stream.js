import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import http from "node:http";
import https from "node:https";
import { config } from "./config.js";
import { safeCompare, signedShareCookie, signStreamTarget } from "./crypto.js";

export function shareIsUnlocked(req, share) {
  if (!share.password_hash) return true;
  return safeCompare(req.cookies[`share_${share.id}`], signedShareCookie(share.id));
}

export function shareIsStreamable(share) {
  const current = Math.floor(Date.now() / 1000);
  return share.starts_at - config.streamGraceSeconds <= current && current <= share.ends_at + config.streamGraceSeconds;
}

export function encodeTarget(value) {
  return Buffer.from(value).toString("base64url");
}

export function decodeTarget(value) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function proxiedUrl(slug, targetUrl) {
  const encoded = encodeTarget(targetUrl);
  const sig = signStreamTarget(slug, targetUrl);
  return `/api/public/stream/${encodeURIComponent(slug)}?u=${encoded}&sig=${sig}`;
}

function rewriteHlsAttributeUris(line, baseUrl, slug) {
  return line.replace(/URI="([^"]+)"/g, (_match, uri) => {
    const target = new URL(uri, baseUrl).toString();
    return `URI="${proxiedUrl(slug, target)}"`;
  });
}

export function rewriteHlsPlaylist(text, baseUrl, slug) {
  return `${text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        return proxiedUrl(slug, new URL(trimmed, baseUrl).toString());
      }
      if (trimmed.startsWith("#") && trimmed.includes('URI="')) {
        return rewriteHlsAttributeUris(line, baseUrl, slug);
      }
      return line;
    })
    .join("\n")}\n`;
}

export function looksLikeHls(url, contentType) {
  return url.toLowerCase().split("?", 1)[0].endsWith(".m3u8") || String(contentType).toLowerCase().includes("mpegurl");
}

export function inferStreamKind(url, contentType = "") {
  const lowerUrl = String(url).toLowerCase().split("?", 1)[0];
  const lowerType = String(contentType).toLowerCase();
  if (looksLikeHls(url, contentType)) return "hls";
  if (lowerType.includes("mp2t") || lowerType.includes("mpegts") || lowerUrl.includes("/ts/") || lowerUrl.endsWith(".ts")) return "mpegts";
  if (lowerType.includes("mp4") || lowerUrl.endsWith(".mp4")) return "native";
  return "mpegts";
}

export async function proxyStream(req, res, targetUrl, slug) {
  return proxyStreamNative(req, res, targetUrl, slug, 0);
}

export function proxyFmp4Stream(req, res, targetUrl) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-rw_timeout",
        "15000000",
        "-i",
        targetUrl,
        "-map",
        "0:v:0?",
        "-map",
        "0:a:0?",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-ac",
        "2",
        "-f",
        "mp4",
        "-movflags",
        "frag_keyframe+empty_moov+default_base_moof",
        "-frag_duration",
        "2000000",
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let stderr = "";
    ffmpeg.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-2000);
    });

    if (res.socket) {
      res.socket.setNoDelay(true);
      res.socket.setKeepAlive(true, 30000);
    }
    res.status(200);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Accel-Buffering", "no");

    req.on("close", () => {
      if (!ffmpeg.killed) ffmpeg.kill("SIGTERM");
    });

    pipeline(ffmpeg.stdout, res)
      .then(() => resolve())
      .catch((error) => {
        if (req.destroyed || res.destroyed) resolve();
        else reject(error);
      });

    ffmpeg.on("error", reject);
    ffmpeg.on("close", (code) => {
      if (code && code !== 255 && !req.destroyed && !res.destroyed) {
        reject(new Error(stderr.trim() || `FFmpeg exited with code ${code}`));
      } else {
        resolve();
      }
    });
  });
}

function requestModule(url) {
  return url.protocol === "https:" ? https : http;
}

function proxyStreamNative(req, res, targetUrl, slug, redirectCount) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(targetUrl);
    const headers = {
      "User-Agent": "iptv-share/0.2",
      Accept: "*/*",
      Connection: "close",
    };
    if (req.headers.range) headers.Range = req.headers.range;

    const upstreamReq = requestModule(parsedUrl).request(parsedUrl, { headers }, (upstream) => {
      const location = upstream.headers.location;
      if ([301, 302, 303, 307, 308].includes(upstream.statusCode) && location && redirectCount < 5) {
        upstream.resume();
        resolve(proxyStreamNative(req, res, new URL(location, targetUrl).toString(), slug, redirectCount + 1));
        return;
      }

      if (upstream.statusCode < 200 || upstream.statusCode > 299) {
        upstream.resume();
        res.status(upstream.statusCode || 502).send("Upstream stream failed");
        resolve();
        return;
      }

      const contentType = upstream.headers["content-type"] || "application/octet-stream";
      if (looksLikeHls(targetUrl, contentType)) {
        const chunks = [];
        upstream.on("data", (chunk) => chunks.push(chunk));
        upstream.on("end", () => {
          const playlist = Buffer.concat(chunks).toString("utf8");
          res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
          res.setHeader("Cache-Control", "no-store");
          res.send(rewriteHlsPlaylist(playlist, targetUrl, slug));
          resolve();
        });
        upstream.on("error", reject);
        return;
      }

      if (res.socket) {
        res.socket.setNoDelay(true);
        res.socket.setKeepAlive(true, 30000);
      }
      res.status(upstream.statusCode || 200);
      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Accel-Buffering", "no");
      for (const header of ["accept-ranges", "content-range", "content-length"]) {
        const value = upstream.headers[header];
        if (value) res.setHeader(header, value);
      }

      pipeline(upstream, res).then(resolve).catch((error) => {
        if (req.destroyed || res.destroyed) resolve();
        else reject(error);
      });
    });

    upstreamReq.setTimeout(15000, () => upstreamReq.destroy(new Error("Upstream stream timed out")));
    upstreamReq.on("error", reject);
    req.on("close", () => upstreamReq.destroy());
    upstreamReq.end();
  });
}

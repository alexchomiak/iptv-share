import { config } from "./config.js";

export function platformSourceUrl(value, allowedHosts = config.platformMediaHosts) {
  try {
    const parsed = new URL(String(value || ""));
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return "";
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
    const allowed = allowedHosts.some((entry) => {
      const domain = String(entry || "").trim().toLowerCase().replace(/^\.+|\.$/g, "");
      return domain && (hostname === domain || hostname.endsWith(`.${domain}`));
    });
    return allowed ? parsed.toString() : "";
  } catch {
    return "";
  }
}

export function addPlatformMediaSource(payload, sourceUrl) {
  if (!payload?.stream_available) return payload;
  const mediaUrl = platformSourceUrl(sourceUrl);
  if (!mediaUrl) return payload;
  payload.media_kind = "platform";
  payload.media_url = mediaUrl;
  return payload;
}

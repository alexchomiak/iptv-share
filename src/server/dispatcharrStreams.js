import { config } from "./config.js";

let cached = { until: 0, names: new Map(), error: "" };
let inFlight = null;

export async function fetchDispatcharrStreamNames({ baseUrl, username, password, fetchImpl = fetch }) {
  if (!baseUrl || !username || !password) return new Map();
  const origin = new URL(baseUrl).origin;
  const tokenResponse = await fetchImpl(`${origin}/api/accounts/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
    signal: AbortSignal.timeout(10000),
  });
  if (!tokenResponse.ok) throw new Error(`Dispatcharr login returned ${tokenResponse.status}`);
  const tokenBody = await tokenResponse.json();
  const access = tokenBody.access || tokenBody.access_token;
  if (!access) throw new Error("Dispatcharr login did not return an access token");

  const names = new Map();
  // Dispatcharr searches channel names server-side. Our target channels are
  // named NFL | 01...16, so this avoids fetching the entire channel library.
  let next = new URL("/api/channels/channels/?include_streams=true&search=NFL&page_size=100", origin).toString();
  for (let page = 0; next && page < 50; page += 1) {
    const url = new URL(next, origin);
    if (url.origin !== origin) throw new Error("Dispatcharr returned a cross-origin pagination URL");
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${access}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Dispatcharr channels returned ${response.status}`);
    const body = await response.json();
    const channels = Array.isArray(body) ? body : (body.results || []);
    for (const channel of channels) {
      const titles = (channel.streams || [])
        .filter((stream) => stream && typeof stream === "object")
        .map((stream) => String(stream.name || "").trim())
        .filter((name) => name.toUpperCase().includes("NFL"));
      if (!titles.length) continue;
      if (channel.tvg_id != null && String(channel.tvg_id).trim()) names.set(String(channel.tvg_id).trim(), titles);
      if (channel.channel_number != null) names.set(String(channel.channel_number), titles);
    }
    next = Array.isArray(body) ? null : body.next || null;
  }
  if (next) throw new Error("Dispatcharr channels pagination exceeded 50 pages");
  return names;
}

export async function cachedDispatcharrStreamNames() {
  const current = Date.now();
  if (cached.until > current) {
    if (cached.error) throw new Error(cached.error);
    return cached.names;
  }
  if (inFlight) return inFlight;
  let baseUrl = config.dispatcharrBaseUrl;
  if (!baseUrl) {
    try { baseUrl = new URL(config.m3uUrl).origin; } catch { return new Map(); }
  }
  if (!config.dispatcharrUsername || !config.dispatcharrPassword) return new Map();
  inFlight = fetchDispatcharrStreamNames({
    baseUrl,
    username: config.dispatcharrUsername,
    password: config.dispatcharrPassword,
  }).then((names) => {
    cached = { names, error: "", until: Date.now() + 5 * 60 * 1000 };
    return names;
  }).catch((error) => {
    cached = { names: new Map(), error: error.message, until: Date.now() + 5 * 60 * 1000 };
    throw error;
  }).finally(() => { inFlight = null; });
  return inFlight;
}

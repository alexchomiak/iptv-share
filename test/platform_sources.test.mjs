import test from "node:test";
import assert from "node:assert/strict";
import { addPlatformMediaSource, platformSourceUrl } from "../src/server/platformSources.js";

test("recognizes allowed platform hosts and subdomains", () => {
  assert.equal(platformSourceUrl("https://twitch.tv/example", ["twitch.tv"]), "https://twitch.tv/example");
  assert.equal(platformSourceUrl("https://m.twitch.tv/example", ["twitch.tv"]), "https://m.twitch.tv/example");
});

test("rejects lookalike, non-http, credential-bearing, and ordinary media URLs", () => {
  assert.equal(platformSourceUrl("https://twitch.tv.evil.test/example", ["twitch.tv"]), "");
  assert.equal(platformSourceUrl("file:///etc/passwd", ["twitch.tv"]), "");
  assert.equal(platformSourceUrl("https://user:secret@twitch.tv/example", ["twitch.tv"]), "");
  assert.equal(platformSourceUrl("https://cdn.example/live.m3u8", ["twitch.tv"]), "");
});

test("adds the raw platform page only to a currently streamable payload", () => {
  const available = { stream_available: true, stream_url: "/api/public/stream/demo" };
  addPlatformMediaSource(available, "https://twitch.tv/example");
  assert.equal(available.media_kind, "platform");
  assert.equal(available.media_url, "https://twitch.tv/example");
  assert.equal(available.stream_url, "/api/public/stream/demo");

  const unavailable = { stream_available: false };
  addPlatformMediaSource(unavailable, "https://twitch.tv/example");
  assert.equal("media_url" in unavailable, false);
});

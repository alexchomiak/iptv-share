import test from "node:test";
import assert from "node:assert/strict";
import { browserPlaybackUrl, nativeHlsPlaybackUrl } from "../src/client/src/lib/playbackUrls.js";

test("browser playback URL is stable across freshly minted viewer credentials", () => {
  const first = "https://streams.example.test/api/public/stream/sunday?event=41&viewer=first&vsig=one&hls=1";
  const second = "https://streams.example.test/api/public/stream/sunday?event=41&viewer=second&vsig=two&hls=1";

  assert.equal(browserPlaybackUrl(first), "/api/public/stream/sunday?event=41&hls=1");
  assert.equal(browserPlaybackUrl(second), browserPlaybackUrl(first));
});

test("browser playback URL changes when the linked static event changes", () => {
  const first = browserPlaybackUrl("/api/public/stream/sunday?event=41&viewer=first&vsig=one");
  const replacement = browserPlaybackUrl("/api/public/stream/sunday?event=42&viewer=second&vsig=two");

  assert.notEqual(replacement, first);
  assert.equal(replacement, "/api/public/stream/sunday?event=42");
});

test("browser playback URL preserves non-credential query parameters", () => {
  assert.equal(
    browserPlaybackUrl("/api/public/stream/demo?hls=1&event=7&quality=source&viewer=x&vsig=y"),
    "/api/public/stream/demo?hls=1&event=7&quality=source",
  );
});

test("native HLS compatibility rendition keeps event and viewer identity", () => {
  assert.equal(
    nativeHlsPlaybackUrl("/api/public/stream/game?event=12&viewer=abc&hls=1", "https://example.test"),
    "/api/public/stream/game?event=12&viewer=abc&hls=1&compat=1",
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import { publicStreamUrls, registerSignedViewer } from "../src/server/publicPlayback.js";
import { safeCompare, signViewerAccess } from "../src/server/crypto.js";

const request = {
  protocol: "http",
  get(name) {
    return name === "host" ? "localhost:8080" : "";
  },
};

test("public playback URLs are absolute and carry valid scoped viewer access", () => {
  const result = publicStreamUrls(
    request,
    { kind: "temporary", shareId: 7, slug: "demo", eventId: 42, useHls: true },
    { viewerToken: "a".repeat(48), publicBaseUrl: "" },
  );
  const stream = new URL(result.streamUrl);
  const hls = new URL(result.hlsUrl);
  assert.equal(stream.origin, "http://localhost:8080");
  assert.equal(stream.pathname, "/api/public/stream/demo");
  assert.equal(stream.searchParams.get("event"), "42");
  assert.equal(stream.searchParams.get("viewer"), "a".repeat(48));
  assert.equal(hls.searchParams.get("hls"), "1");
  assert.equal(hls.searchParams.get("viewer"), stream.searchParams.get("viewer"));
  assert.equal(
    safeCompare(stream.searchParams.get("vsig"), signViewerAccess("temporary", 7, stream.searchParams.get("viewer"))),
    true,
  );
});

test("configured public base URL is authoritative", () => {
  const result = publicStreamUrls(
    request,
    { kind: "static", shareId: 9, slug: "game", eventId: 12 },
    { viewerToken: "b".repeat(48), publicBaseUrl: "https://streams.example.test/" },
  );
  const stream = new URL(result.streamUrl);
  assert.equal(stream.origin, "https://streams.example.test");
  assert.equal(stream.searchParams.get("event"), "12");
  assert.equal(stream.searchParams.get("hls"), null);
});

test("valid signed playback access registers a machine viewer once", () => {
  const token = "c".repeat(48);
  const viewers = new Set();
  let registrations = 0;
  const authorize = (signature) => registerSignedViewer({
    kind: "temporary",
    shareId: 11,
    token,
    signature,
    findViewer: (value) => viewers.has(value),
    registerViewer: (value) => {
      registrations += 1;
      viewers.add(value);
    },
  });
  assert.equal(authorize(signViewerAccess("temporary", 11, token)), true);
  assert.equal(authorize(signViewerAccess("temporary", 11, token)), true);
  assert.equal(registrations, 1);
});

test("tampered playback access cannot register a viewer", () => {
  let registrations = 0;
  const authorized = registerSignedViewer({
    kind: "temporary",
    shareId: 11,
    token: "d".repeat(48),
    signature: signViewerAccess("temporary", 12, "d".repeat(48)),
    findViewer: () => false,
    registerViewer: () => {
      registrations += 1;
    },
  });
  assert.equal(authorized, false);
  assert.equal(registrations, 0);
});

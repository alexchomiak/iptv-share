import test from "node:test";
import assert from "node:assert/strict";
import { shouldEndOpenSportsStream } from "../src/server/sportsStreamCutoff.js";

test("keeps an established sports stream open through ambiguous and failed refreshes", () => {
  assert.equal(shouldEndOpenSportsStream({ streamable: false, usesSportsClock: false, source: "epg-sports-state" }), false);
  assert.equal(shouldEndOpenSportsStream({ streamable: false, usesSportsClock: false, source: "epg-sports-error" }), false);
});

test("keeps a live or final-grace sports stream open", () => {
  assert.equal(shouldEndOpenSportsStream({ streamable: true, usesSportsClock: true, source: "sports-live" }), false);
  assert.equal(shouldEndOpenSportsStream({ streamable: true, usesSportsClock: true, source: "sports-final" }), false);
});

test("ends an established stream only after an authoritative final passes grace", () => {
  assert.equal(shouldEndOpenSportsStream({ streamable: false, usesSportsClock: true, source: "sports-final" }), true);
  assert.equal(shouldEndOpenSportsStream({ streamable: false, usesSportsClock: true, source: "sports-final-cache" }), true);
});

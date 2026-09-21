import test from "node:test";
import assert from "node:assert/strict";
import { shouldEndOpenSportsStream, streamCutoffWindow } from "../src/server/sportsStreamCutoff.js";

test("linked sports events keep the sports cutoff after an ambiguous initial lookup", () => {
  const event = { id: 17, espn_event_id: "401000001", ends_at: 1000 };
  const cutoff = streamCutoffWindow({ event, streamable: true, usesSportsClock: false, source: "epg-sports-error" });
  assert.equal(cutoff.open_ended_cutoff, true);
  assert.equal(cutoff.id, 17);
});

test("ordinary EPG events retain their scheduled cutoff", () => {
  const event = { id: 18, ends_at: 1000 };
  assert.deepEqual(streamCutoffWindow({ event, streamable: true, usesSportsClock: false, source: "epg" }), event);
});

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

import test from "node:test";
import assert from "node:assert/strict";
import { staticHlsSegmentIsStreamable } from "../src/server/staticHlsAccess.js";

test("active sports HLS session survives an inconclusive snapshot without an ESPN request", () => {
  const game = { espn_event_id: "game-1" };
  assert.equal(staticHlsSegmentIsStreamable(game, { streamable: false, source: "epg-sports-cache" }, true), true);
  assert.equal(staticHlsSegmentIsStreamable(game, { streamable: false, source: "epg-sports-cache" }, false), false);
  assert.equal(staticHlsSegmentIsStreamable(game, { streamable: false, source: "sports-final-cache" }, true), false);
  assert.equal(staticHlsSegmentIsStreamable({}, { streamable: false, source: "epg" }, true), false);
});

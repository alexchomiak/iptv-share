import test from "node:test";
import assert from "node:assert/strict";
import { appendUniqueChatMessage, newestSportsSummary } from "../src/client/src/lib/liveState.js";

test("an older sports poll cannot replace a newer realtime update", () => {
  const realtime = { fetchedAt: 200, status: "live", realtime: true };
  const olderPoll = { fetchedAt: 170, status: "live", realtime: false };
  assert.equal(newestSportsSummary(realtime, olderPoll), realtime);
});

test("a newer sports update replaces the current summary", () => {
  const current = { fetchedAt: 200 };
  const incoming = { fetchedAt: 205 };
  assert.equal(newestSportsSummary(current, incoming), incoming);
});

test("chat renders each authoritative server message once", () => {
  const message = { id: 42, username: "viewer", message: "hello" };
  const once = appendUniqueChatMessage([], message);
  assert.deepEqual(appendUniqueChatMessage(once, { ...message }), once);
});

import test from "node:test";
import assert from "node:assert/strict";
import { fetchDispatcharrStreamNames } from "../src/server/dispatcharrStreams.js";

test("reads ordered provider stream names from Dispatcharr channel details", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), options });
    if (String(url).endsWith("/api/accounts/token/")) {
      return { ok: true, json: async () => ({ access: "test-access" }) };
    }
    return { ok: true, json: async () => ({
      results: [{ tvg_id: "1001", channel_number: 1001, streams: [
        { name: "NFL 02 - Bears @ Panthers" }, { name: "Backup Bears @ Panthers" },
        { name: "nfl backup: Bears @ Panthers" },
      ] }], next: null,
    }) };
  };
  const names = await fetchDispatcharrStreamNames({
    baseUrl: "http://dispatcharr.test:9191", username: "user", password: "pass", fetchImpl,
  });
  assert.deepEqual(names.get("1001"), ["NFL 02 - Bears @ Panthers", "nfl backup: Bears @ Panthers"]);
  assert.match(requests[1].url, /[?&]search=NFL(?:&|$)/);
  assert.equal(requests[1].options.headers.Authorization, "Bearer test-access");
  assert.equal(JSON.parse(requests[0].options.body).username, "user");
});

test("rejects pagination outside the configured Dispatcharr origin", async () => {
  const fetchImpl = async (url) => String(url).endsWith("/api/accounts/token/")
    ? { ok: true, json: async () => ({ access: "token" }) }
    : { ok: true, json: async () => ({ results: [], next: "https://other.test/channels" }) };
  await assert.rejects(() => fetchDispatcharrStreamNames({
    baseUrl: "http://dispatcharr.test:9191", username: "user", password: "pass", fetchImpl,
  }), /cross-origin/);
});

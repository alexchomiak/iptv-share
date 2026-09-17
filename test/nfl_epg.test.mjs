import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { XMLParser } from "fast-xml-parser";
import { gunzipSync } from "node:zlib";

// Run the mapper with isolated source/ESPN/DB boundaries and a fixed Sunday.
const source = fs.readFileSync(new URL("../src/server/nflEpg.js", import.meta.url), "utf8")
  .replace(/^import .*;\n/gm, "")
  .replace(/^export /gm, "");
const sunday = Date.parse("2026-09-13T14:00:00Z");
const kickoff = Date.parse("2026-09-13T17:00:00Z") / 1000;
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [sunday])); }
  static now() { return sunday; }
}
function fixture({ localTitle = "NFL | 08", eventDate = "2026-09-13T17:00:00Z", available = true } = {}) {
  let searches = 0;
  const label = "NFL | 08 - 1pm Bears at Panthers";
  const xml = `<tv><channel id="slot08"><display-name>Chicago Bears @ Carolina Panthers</display-name><display-name>${label}</display-name></channel>${["040000", "060000", "080000"].map(time => `<programme channel="slot08" start="20260913${time} +0000"><title>Coming Up: Chicago Bears @ Carolina Panthers</title></programme>`).join("")}</tv>`;
  const context = vm.createContext({
    Date: FixedDate, Intl, Buffer, AbortSignal, XMLParser, gunzipSync,
    config: { nflMapperTimezone: "America/New_York", nflMapperDurationSeconds: 21600, nflMapperSourceUrl: "https://fixture.test/guide.xml", nflMapperSourceCacheSeconds: 86400 },
    db: { prepare: () => ({ all: () => [{ id: 1, tvg_id: "slot08", name: localTitle, source_title: localTitle }] }) },
    fetch: async () => ({ ok: true, arrayBuffer: async () => Buffer.from(xml) }),
    searchEspnGames: async () => {
      searches += 1;
      if (!available) throw new Error("ESPN unavailable");
      return { games: [{ id: "verified-game", name: "Chicago Bears at Carolina Panthers", date: eventDate, away: { name: "Chicago Bears", abbreviation: "CHI" }, home: { name: "Carolina Panthers", abbreviation: "CAR" } }] };
    },
    getEspnGameSummary: async () => ({ summary: {}, cache: "hit" }),
  });
  vm.runInContext(source, context);
  return { context, searches: () => searches };
}

test("bare local slot uses verified source matchup with ESPN kickoff, deduplicating repeated XMLTV rows", async () => {
  const { context, searches } = fixture();
  const [mapping] = await context.generatedNflMappings();
  const games = mapping.programs.filter(p => p.title === "Chicago Bears at Carolina Panthers");
  assert.equal(games.length, 1);
  assert.equal(games[0].startAt, kickoff);
  assert.equal(searches(), 1);
  assert.equal(mapping.programs.find(p => p.source === "generated-pregame").startAt, kickoff - 3600);
});

test("source assignment still publishes when optional ESPN enrichment is unavailable", async () => {
  const { context } = fixture({ available: false });
  const [mapping] = await context.generatedNflMappings();
  const game = mapping.programs.find(p => p.title === "Chicago Bears at Carolina Panthers");
  assert.ok(game);
  assert.equal(game.espnEventId, undefined);
});

test("stale source matchup stays on the ESPN date instead of moving to this Sunday", async () => {
  const { context } = fixture({ eventDate: "2026-09-06T17:00:00Z" });
  const [mapping] = await context.generatedNflMappings();
  assert.equal(mapping.programs.some(p => p.title.includes("Bears")), false);
});

test("a named local matchup still takes precedence over a conflicting source slot", async () => {
  const { context } = fixture({ localTitle: "NFL | 08 - 1pm Jets at Titans" });
  const [mapping] = await context.generatedNflMappings();
  assert.equal(mapping.programs.some(p => p.title === "New York Jets at Tennessee Titans"), true);
  assert.equal(mapping.programs.some(p => p.title.includes("Bears")), false);
});

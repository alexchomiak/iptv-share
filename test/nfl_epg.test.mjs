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
function fixture({ localTitle = "NFL | 08", eventDate = "2026-09-13T17:00:00Z", available = true, sourceLabel = "NFL | 08 - 1pm Bears at Panthers", programmeTitle = "Coming Up: Chicago Bears @ Carolina Panthers", streamTitles = [], nowMs = sunday,
  programmeStarts = ['20260913040000', '20260913060000', '20260913080000'],
  espnGame = { name: "Chicago Bears at Carolina Panthers", away: { name: "Chicago Bears", abbreviation: "CHI" }, home: { name: "Carolina Panthers", abbreviation: "CAR" } },
  respectSearchWindow = false,
} = {}) {
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [nowMs])); }
    static now() { return nowMs; }
  }
  let searches = 0;
  const searchWindows = [];
  const label = sourceLabel;
  const xml = `<tv><channel id="slot08"><display-name>Chicago Bears @ Carolina Panthers</display-name><display-name>${label}</display-name></channel>${programmeStarts.map(start => `<programme channel="slot08" start="${start} +0000"><title>${programmeTitle}</title></programme>`).join("")}</tv>`;
  const context = vm.createContext({
    Date: FixedDate, Intl, Buffer, AbortSignal, XMLParser, gunzipSync,
    config: { nflMapperTimezone: "America/New_York", nflMapperDurationSeconds: 21600, nflMapperSourceUrl: "https://fixture.test/guide.xml", nflMapperSourceCacheSeconds: 86400 },
    db: { prepare: () => ({ all: () => [{ id: 1, tvg_id: "slot08", name: localTitle, source_title: localTitle }] }) },
    fetch: async () => ({ ok: true, arrayBuffer: async () => Buffer.from(xml) }),
    searchEspnGames: async ({ start, end }) => {
      searches += 1;
      searchWindows.push({ start, end });
      if (!available) throw new Error("ESPN unavailable");
      const game = { id: "verified-game", ...espnGame, date: eventDate };
      const time = Date.parse(eventDate) / 1000;
      return { games: respectSearchWindow && !(start <= time && time <= end) ? [] : [game] };
    },
    getEspnGameSummary: async () => ({ summary: {}, cache: "hit" }),
    cachedDispatcharrStreamNames: async () => new Map([["slot08", streamTitles]]),
  });
  vm.runInContext(source, context);
  return { context, searches: () => searches, searchWindows };
}

test("bare local slot uses verified source matchup with ESPN kickoff, deduplicating repeated XMLTV rows", async () => {
  const { context, searches } = fixture();
  const [mapping] = await context.generatedNflMappings();
  const games = mapping.programs.filter(p => p.title === "Bears at Panthers");
  assert.equal(games.length, 1);
  assert.equal(games[0].startAt, kickoff);
  assert.equal(searches(), 1);
  assert.equal(mapping.programs.find(p => p.source === "generated-pregame").startAt, kickoff - 3600);
  assert.equal(mapping.programs.find(p => p.source === "generated-pregame").title, "Pregame: Bears at Panthers");
  assert.equal(mapping.programs.find(p => p.source === "generated-postgame").title, "Postgame: Bears at Panthers");
  const xml = await context.generatedNflXmltv();
  assert.match(xml, /<title>Bears at Panthers<\/title>/);
  assert.match(xml, /<title>Pregame: Bears at Panthers<\/title>/);
  assert.match(xml, /<title>Postgame: Bears at Panthers<\/title>/);
});

test("source assignment still publishes when optional ESPN enrichment is unavailable", async () => {
  const { context } = fixture({ available: false });
  const [mapping] = await context.generatedNflMappings();
  const game = mapping.programs.find(p => p.title === "Bears at Panthers");
  assert.ok(game);
  assert.equal(game.espnEventId, undefined);
});

test("bare source slot can use matchup in XMLTV program title and verified ESPN kickoff", async () => {
  const { context } = fixture({ sourceLabel: "NFL | 08" });
  const [mapping] = await context.generatedNflMappings();
  const games = mapping.programs.filter(p => p.title === "Bears at Panthers");
  assert.equal(games.length, 1);
  assert.equal(games[0].startAt, kickoff);
});

test("title-only source does not invent a kickoff when ESPN is unavailable", async () => {
  const { context } = fixture({ sourceLabel: "NFL | 08", available: false });
  const [mapping] = await context.generatedNflMappings();
  assert.equal(mapping.programs.some(p => p.title === "Bears at Panthers"), false);
});

test("Dispatcharr stream title restores a bare slot when source EPG has no assignment", async () => {
  const { context } = fixture({ sourceLabel: "NFL | 08", programmeTitle: "No Event", streamTitles: ["NFL 08 - Bears @ Panthers HD"] });
  const [mapping] = await context.generatedNflMappings();
  const game = mapping.programs.find(p => p.title === "Bears at Panthers");
  assert.equal(game?.startAt, kickoff);
  assert.equal(game?.source, "dispatcharr-stream");
});

test("Dispatcharr title without a matching ESPN event does not invent a game", async () => {
  const { context } = fixture({ sourceLabel: "NFL | 08", programmeTitle: "No Event", streamTitles: ["NFL 08 - Bears @ Panthers HD"], available: false });
  const [mapping] = await context.generatedNflMappings();
  assert.equal(mapping.programs.some(p => p.title === "Bears at Panthers"), false);
});

test("ESPN matchup requires the correct away and home teams", () => {
  const { context } = fixture();
  const chiefsDolphins = {
    name: "Kansas City Chiefs at Miami Dolphins",
    away: { name: "Kansas City Chiefs", abbreviation: "KC" },
    home: { name: "Miami Dolphins", abbreviation: "MIA" },
  };
  assert.equal(context.matchupMatches("Philadelphia Eagles at Chicago Bears", chiefsDolphins), false);
  assert.equal(context.matchupMatches("Kansas City Chiefs at Miami Dolphins", chiefsDolphins), true);
  assert.equal(context.matchupMatches("Miami Dolphins at Kansas City Chiefs", chiefsDolphins), false);
});

test("missing slot mappings are reported as unavailable, not No Game Today", async () => {
  const { context } = fixture({ sourceLabel: "NFL | 08", programmeTitle: "No Event" });
  const [mapping] = await context.generatedNflMappings();
  assert.equal(mapping.programs[0].title, "Schedule Unavailable");
});

test("Sunday game remains mapped after early source XMLTV rows age past twelve hours", async () => {
  const { context } = fixture({ nowMs: Date.parse("2026-09-14T03:00:00Z") });
  const [mapping] = await context.generatedNflMappings();
  assert.ok(mapping.programs.some(p => p.title === "Bears at Panthers"));
});

test("old Sunday source rows do not roll into the following Sunday", async () => {
  const { context } = fixture({ nowMs: Date.parse("2026-09-14T05:00:00Z") });
  const [mapping] = await context.generatedNflMappings();
  assert.equal(mapping.programs.some(p => p.title === "Bears at Panthers"), false);
});

test("stale source matchup stays on the ESPN date instead of moving to this Sunday", async () => {
  const { context } = fixture({ eventDate: "2026-09-06T17:00:00Z" });
  const [mapping] = await context.generatedNflMappings();
  assert.equal(mapping.programs.some(p => p.title.includes("Bears")), false);
});

test("a named local matchup still takes precedence over a conflicting source slot", async () => {
  const { context } = fixture({ localTitle: "NFL | 08 - 1pm Jets at Titans" });
  const [mapping] = await context.generatedNflMappings();
  assert.equal(mapping.programs.some(p => p.title === "Jets at Titans"), true);
  assert.equal(mapping.programs.some(p => p.title.includes("Bears")), false);
});

test("short titles handle every NFL team, abbreviations, and pregame/postgame prefixes", () => {
  const { context } = fixture();
  const teams = [
    ['Arizona Cardinals', 'ARI', 'Cardinals'],
    ['Atlanta Falcons', 'ATL', 'Falcons'],
    ['Baltimore Ravens', 'BAL', 'Ravens'],
    ['Buffalo Bills', 'BUF', 'Bills'],
    ['Carolina Panthers', 'CAR', 'Panthers'],
    ['Chicago Bears', 'CHI', 'Bears'],
    ['Cincinnati Bengals', 'CIN', 'Bengals'],
    ['Cleveland Browns', 'CLE', 'Browns'],
    ['Dallas Cowboys', 'DAL', 'Cowboys'],
    ['Denver Broncos', 'DEN', 'Broncos'],
    ['Detroit Lions', 'DET', 'Lions'],
    ['Green Bay Packers', 'GB', 'Packers'],
    ['Houston Texans', 'HOU', 'Texans'],
    ['Indianapolis Colts', 'IND', 'Colts'],
    ['Jacksonville Jaguars', 'JAX', 'Jaguars'],
    ['Kansas City Chiefs', 'KC', 'Chiefs'],
    ['Las Vegas Raiders', 'LV', 'Raiders'],
    ['Los Angeles Chargers', 'LAC', 'Chargers'],
    ['Los Angeles Rams', 'LAR', 'Rams'],
    ['Miami Dolphins', 'MIA', 'Dolphins'],
    ['Minnesota Vikings', 'MIN', 'Vikings'],
    ['New England Patriots', 'NE', 'Patriots'],
    ['New Orleans Saints', 'NO', 'Saints'],
    ['New York Giants', 'NYG', 'Giants'],
    ['New York Jets', 'NYJ', 'Jets'],
    ['Philadelphia Eagles', 'PHI', 'Eagles'],
    ['Pittsburgh Steelers', 'PIT', 'Steelers'],
    ['San Francisco 49ers', 'SF', '49ers'],
    ['Seattle Seahawks', 'SEA', 'Seahawks'],
    ['Tampa Bay Buccaneers', 'TB', 'Buccaneers'],
    ['Tennessee Titans', 'TEN', 'Titans'],
    ['Washington Commanders', 'WAS', 'Commanders'],
  ];
  for (const [away, awayAbbreviation, awayNickname] of teams) {
    for (const [home, homeAbbreviation, homeNickname] of teams) {
      const expected = `${awayNickname} at ${homeNickname}`;
      for (const prefix of ['', 'Pregame: ', 'Postgame: ']) {
        assert.equal(context.shortProgrammeTitle(`${prefix}${away} at ${home}`), `${prefix}${expected}`);
        assert.equal(context.shortProgrammeTitle(`${prefix}${awayAbbreviation} @ ${homeAbbreviation}`), `${prefix}${expected}`);
        assert.equal(context.shortProgrammeTitle(`${prefix}${awayNickname} vs. ${homeNickname}`), `${prefix}${expected}`);
      }
    }
  }
  assert.equal(context.shortProgrammeTitle('Bucs at 49ers'), 'Buccaneers at 49ers');
  for (const title of ['No Event', 'No Game Today', 'Schedule Unavailable', 'Unknown Team at Chicago Bears']) {
    assert.equal(context.shortProgrammeTitle(title), title);
  }
});

const texansJaguars = {
  name: 'Houston Texans at Jacksonville Jaguars',
  away: { name: 'Houston Texans', abbreviation: 'HOU' },
  home: { name: 'Jacksonville Jaguars', abbreviation: 'JAX' },
};
const londonFixture = {
  nowMs: Date.parse('2026-10-15T12:00:00Z'),
  sourceLabel: 'NFL | 08 - 9:30am Texans at Jaguars',
  programmeTitle: 'NFL | 08 - 9:30am Texans at Jaguars',
  programmeStarts: ['20261015000000', '20261015020000', '20261016000000', '20261021000000', '20261022000000'],
  espnGame: texansJaguars,
  eventDate: '2026-10-18T13:30:00Z',
  respectSearchWindow: true,
};

test('Thursday London-game labels resolve once to Sunday rather than each repeated XMLTV day', async () => {
  const { context, searches, searchWindows } = fixture(londonFixture);
  const [mapping] = await context.generatedNflMappings();
  const games = mapping.programs.filter(p => p.title === 'Texans at Jaguars');
  assert.equal(games.length, 1);
  const actualKickoff = Date.parse(londonFixture.eventDate) / 1000;
  assert.equal(games[0].startAt, actualKickoff);
  assert.equal(searches(), 1);
  assert.ok(searchWindows[0].start <= actualKickoff && actualKickoff <= searchWindows[0].end);
  assert.equal(mapping.programs.find(p => p.title === 'Pregame: Texans at Jaguars').startAt, actualKickoff - 3600);
  assert.equal(mapping.programs.find(p => p.title === 'Postgame: Texans at Jaguars').startAt, actualKickoff + 21600);
  const xml = await context.generatedNflXmltv();
  const programmes = new XMLParser({ ignoreAttributes: false }).parse(xml).tv.programme;
  assert.equal(programmes.filter(p => p.title === 'Texans at Jaguars').length, 1);
  assert.equal(programmes.find(p => p.title === 'Texans at Jaguars')['@_start'], '20261018133000 +0000');
});

test('morning time-only label falls back to one Sunday assignment if ESPN is unavailable', async () => {
  const { context } = fixture({ ...londonFixture, available: false });
  const [mapping] = await context.generatedNflMappings();
  const games = mapping.programs.filter(p => p.title === 'Texans at Jaguars');
  assert.equal(games.length, 1);
  assert.equal(games[0].startAt, Date.parse(londonFixture.eventDate) / 1000);
});

test('local M3U time-only labels also search the coming week instead of a one-day window', async () => {
  const { context, searchWindows } = fixture({ ...londonFixture, localTitle: 'NFL | 08 - 9:30am Texans at Jaguars' });
  const [mapping] = await context.generatedNflMappings();
  assert.equal(mapping.programs.filter(p => p.title === 'Texans at Jaguars').length, 1);
  const kickoff = Date.parse(londonFixture.eventDate) / 1000;
  assert.ok(searchWindows.every(window => window.start <= kickoff && kickoff <= window.end));
});

test('an explicit weekday stays authoritative when optional enrichment is unavailable', async () => {
  const { context } = fixture({ ...londonFixture, sourceLabel: 'NFL | 08 - Thu 9:30am Texans at Jaguars', available: false });
  const [mapping] = await context.generatedNflMappings();
  const games = mapping.programs.filter(p => p.title === 'Texans at Jaguars');
  assert.equal(games.length, 1);
  assert.equal(games[0].startAt, Date.parse('2026-10-15T13:30:00Z') / 1000);
});

test('ESPN can correct an inferred daytime label to a Thursday game', async () => {
  const { context } = fixture({ ...londonFixture, sourceLabel: 'NFL | 08 - 12:30pm Texans at Jaguars', eventDate: '2026-10-15T16:30:00Z' });
  const [mapping] = await context.generatedNflMappings();
  const games = mapping.programs.filter(p => p.title === 'Texans at Jaguars');
  assert.equal(games.length, 1);
  assert.equal(games[0].startAt, Date.parse('2026-10-15T16:30:00Z') / 1000);
});

import crypto from "node:crypto";
import { config } from "./config.js";
import { db } from "./db.js";

const LEAGUES = {
  nfl: { sport: "football", league: "nfl", label: "NFL" },
  mlb: { sport: "baseball", league: "mlb", label: "MLB" },
  nba: { sport: "basketball", league: "nba", label: "NBA" },
  ncaafb: { sport: "football", league: "college-football", label: "College Football" },
  ncaamb: { sport: "basketball", league: "mens-college-basketball", label: "Men's College Basketball" },
};

function now() {
  return Math.floor(Date.now() / 1000);
}

function cacheKey(url) {
  return crypto.createHash("sha256").update(url).digest("hex");
}

function dayStart(ts) {
  const date = new Date(ts * 1000);
  return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 1000);
}

function pruneEspnCache() {
  db.prepare("DELETE FROM espn_cache WHERE expires_at < ?").run(now() - 86400);
  db.prepare("DELETE FROM espn_request_log WHERE requested_at < ?").run(now() - 86400 * 7);
}

function requestCountToday() {
  return db.prepare("SELECT COUNT(*) AS total FROM espn_request_log WHERE requested_at >= ?").get(dayStart(now())).total;
}

async function fetchJsonCached(url, ttlSeconds) {
  pruneEspnCache();
  const key = cacheKey(url);
  const cached = db.prepare("SELECT * FROM espn_cache WHERE cache_key = ?").get(key);
  if (cached && cached.expires_at > now()) {
    return { payload: JSON.parse(cached.payload), cache: "hit", fetchedAt: cached.fetched_at };
  }
  if (requestCountToday() >= config.espnMaxRequestsPerDay) {
    if (cached) return { payload: JSON.parse(cached.payload), cache: "stale", fetchedAt: cached.fetched_at };
    throw new Error("Local ESPN daily request limit reached");
  }
  const response = await fetch(url);
  if (!response.ok) {
    if (cached) return { payload: JSON.parse(cached.payload), cache: "stale", fetchedAt: cached.fetched_at };
    throw new Error(`ESPN returned ${response.status}`);
  }
  const payload = await response.json();
  db.prepare(
    `
    INSERT INTO espn_cache(cache_key, url, payload, fetched_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET
      payload = excluded.payload,
      fetched_at = excluded.fetched_at,
      expires_at = excluded.expires_at
  `,
  ).run(key, url, JSON.stringify(payload), now(), now() + ttlSeconds);
  db.prepare("INSERT INTO espn_request_log(cache_key, requested_at) VALUES (?, ?)").run(key, now());
  return { payload, cache: "miss", fetchedAt: now() };
}

function compactTeam(competitor) {
  const team = competitor?.team || {};
  return {
    id: team.id || "",
    name: team.displayName || team.shortDisplayName || team.name || "",
    abbreviation: team.abbreviation || "",
    logo: team.logo || team.logos?.[0]?.href || "",
    homeAway: competitor?.homeAway || "",
  };
}

function normalizeEvent(event, leagueKey) {
  const competition = event.competitions?.[0] || {};
  const competitors = competition.competitors || [];
  const home = competitors.find((item) => item.homeAway === "home");
  const away = competitors.find((item) => item.homeAway === "away");
  return {
    provider: "espn",
    id: event.id,
    league: leagueKey,
    leagueLabel: LEAGUES[leagueKey]?.label || leagueKey.toUpperCase(),
    name: event.name || event.shortName || "",
    shortName: event.shortName || event.name || "",
    date: event.date,
    status: event.status?.type?.description || "",
    state: event.status?.type?.state || "",
    venue: competition.venue?.fullName || "",
    home: compactTeam(home),
    away: compactTeam(away),
    summaryUrl: `https://site.api.espn.com/apis/site/v2/sports/${LEAGUES[leagueKey].sport}/${LEAGUES[leagueKey].league}/summary?event=${event.id}`,
  };
}

function compactScoreboard(header = {}) {
  const competition = header.competitions?.[0] || {};
  return (competition.competitors || []).map((competitor) => ({
    id: competitor.id,
    homeAway: competitor.homeAway,
    score: competitor.score,
    winner: Boolean(competitor.winner),
    team: compactTeam(competitor),
    linescores: competitor.linescores || [],
    statistics: competitor.statistics || [],
    records: competitor.records || [],
  }));
}

function compactBoxscore(boxscore = {}) {
  const teams = (boxscore.teams || []).map((entry) => ({
    team: {
      id: entry.team?.id,
      name: entry.team?.displayName || entry.team?.shortDisplayName || entry.team?.name,
      abbreviation: entry.team?.abbreviation,
      logo: entry.team?.logo,
    },
    statistics: (entry.statistics || []).map((stat) => ({
      name: stat.name,
      label: stat.label || stat.displayName || stat.shortDisplayName,
      displayValue: stat.displayValue,
      stats: (stat.stats || []).map((item) => ({
        name: item.name,
        label: item.label || item.displayName || item.shortDisplayName || item.abbreviation,
        abbreviation: item.abbreviation,
        value: item.value,
        displayValue: item.displayValue,
      })),
    })),
  }));
  const players = (boxscore.players || []).map((entry) => ({
    team: {
      id: entry.team?.id,
      name: entry.team?.displayName || entry.team?.shortDisplayName || entry.team?.name,
      abbreviation: entry.team?.abbreviation,
      logo: entry.team?.logo,
    },
    statistics: (entry.statistics || []).map((group) => ({
      name: group.name || inferStatGroupName(group.labels || []),
      labels: group.labels || [],
      athletes: (group.athletes || []).slice(0, 8).map((athlete) => ({
        name: athlete.athlete?.displayName || athlete.athlete?.shortName || "",
        stats: athlete.stats || [],
      })),
    })),
  }));
  return { teams, players };
}

function inferStatGroupName(labels = []) {
  const normalized = labels.map((label) => String(label).toLowerCase());
  if (normalized.includes("h-ab") || (normalized.includes("ab") && normalized.includes("rbi"))) return "Hitting";
  if (normalized.includes("ip") && normalized.includes("era")) return "Pitching";
  return "Stats";
}

export function normalizeGameSummary(payload = {}, leagueKey = "nfl") {
  const selected = LEAGUES[leagueKey] || LEAGUES.nfl;
  const header = payload.header || {};
  const competition = header.competitions?.[0] || {};
  const competitors = compactScoreboard(header);
  const fallbackName = competitors.length >= 2
    ? `${competitors.find((item) => item.homeAway === "away")?.team?.abbreviation || competitors[0].team?.abbreviation || ""} @ ${competitors.find((item) => item.homeAway === "home")?.team?.abbreviation || competitors[1].team?.abbreviation || ""}`.trim()
    : "";
  return {
    id: header.id,
    league: leagueKey,
    leagueLabel: selected.label,
    sport: selected.sport,
    name: header.name || header.shortName || fallbackName,
    shortName: header.shortName || header.name || fallbackName,
    date: header.competitions?.[0]?.date || header.date || "",
    status: competition.status?.type?.description || header.competitions?.[0]?.status?.type?.description || "",
    state: competition.status?.type?.state || "",
    period: competition.status?.period || null,
    clock: competition.status?.displayClock || "",
    competitors,
    boxscore: compactBoxscore(payload.boxscore),
  };
}

function ymd(date) {
  const value = new Date(date);
  const pad = (part) => String(part).padStart(2, "0");
  return `${value.getUTCFullYear()}${pad(value.getUTCMonth() + 1)}${pad(value.getUTCDate())}`;
}

export function espnLeagues() {
  return Object.entries(LEAGUES).map(([key, value]) => ({ key, ...value }));
}

export function espnLiveRefreshSeconds(league = "nfl") {
  return config.espnLiveCacheSecondsByLeague?.[league] || config.espnLiveCacheSeconds;
}

export async function searchEspnGames({ league = "nfl", q = "", start, end, ttlSeconds = config.espnSearchCacheSeconds }) {
  const selected = LEAGUES[league] || LEAGUES.nfl;
  const startDate = start ? new Date(Number(start) * 1000) : new Date();
  const endDate = end ? new Date(Number(end) * 1000) : new Date(startDate.getTime() + 21 * 24 * 60 * 60 * 1000);
  const url = new URL(`https://site.api.espn.com/apis/site/v2/sports/${selected.sport}/${selected.league}/scoreboard`);
  url.searchParams.set("dates", `${ymd(startDate)}-${ymd(endDate)}`);
  url.searchParams.set("limit", "200");
  const { payload, cache, fetchedAt } = await fetchJsonCached(url.toString(), ttlSeconds);
  const needle = String(q || "").trim().toLowerCase();
  const games = (payload.events || [])
    .map((event) => normalizeEvent(event, league))
    .filter((event) => {
      if (!needle) return true;
      return `${event.name} ${event.shortName} ${event.home.name} ${event.home.abbreviation} ${event.away.name} ${event.away.abbreviation}`
        .toLowerCase()
        .includes(needle);
    })
    .slice(0, 50);
  return { games, cache, fetchedAt, requestsToday: requestCountToday() };
}

export async function getEspnGameSummary({ league = "nfl", eventId }) {
  const selected = LEAGUES[league] || LEAGUES.nfl;
  const url = new URL(`https://site.api.espn.com/apis/site/v2/sports/${selected.sport}/${selected.league}/summary`);
  url.searchParams.set("event", eventId);
  const result = await fetchJsonCached(url.toString(), espnLiveRefreshSeconds(league));
  return { ...result, summary: normalizeGameSummary(result.payload, league) };
}

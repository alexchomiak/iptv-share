import crypto from "node:crypto";
import zlib from "node:zlib";
import { WebSocket } from "ws";
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

function parseNestedJsonPayload(payload) {
  if (typeof payload === "string" && /^[\[{]/.test(payload.trim())) {
    try {
      return JSON.parse(payload);
    } catch {
      return payload;
    }
  }
  return payload;
}

export async function fetchJsonCached(url, ttlSeconds) {
  pruneEspnCache();
  const key = cacheKey(url);
  const cached = db.prepare("SELECT * FROM espn_cache WHERE cache_key = ?").get(key);
  if (cached && cached.expires_at > now()) {
    return { payload: parseNestedJsonPayload(JSON.parse(cached.payload)), cache: "hit", fetchedAt: cached.fetched_at };
  }
  if (requestCountToday() >= config.espnMaxRequestsPerDay) {
    if (cached) return { payload: parseNestedJsonPayload(JSON.parse(cached.payload)), cache: "stale", fetchedAt: cached.fetched_at };
    throw new Error("Local ESPN daily request limit reached");
  }
  const response = await fetch(url, {
    headers: {
      Accept: "application/json,text/plain,*/*",
      "User-Agent": "Mozilla/5.0 ShareTV/1.0",
    },
  });
  if (!response.ok) {
    if (cached) return { payload: parseNestedJsonPayload(JSON.parse(cached.payload)), cache: "stale", fetchedAt: cached.fetched_at };
    throw new Error(`ESPN returned ${response.status}`);
  }
  const payload = parseNestedJsonPayload(await response.json());
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
    name: team.displayName || team.shortDisplayName || competitor?.displayName || team.name || competitor?.name || "",
    abbreviation: team.abbreviation || "",
    logo: team.logo || team.logos?.[0]?.href || "",
    homeAway: competitor?.homeAway || "",
  };
}

function normalizeEvent(event, leagueKey) {
  const competition = firstItem(event.competitions);
  const competitors = asList(competition.competitors);
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
  const competition = firstItem(header.competitions);
  return asList(competition.competitors).map((competitor) => ({
    id: competitor.id,
    homeAway: competitor.homeAway,
    score: competitor.score,
    winner: Boolean(competitor.winner),
    team: compactTeam(competitor),
    linescores: compactLinescores(competitor.linescores),
    statistics: competitor.statistics || [],
    records: competitor.records || [],
    record: recordSummary(competitor),
  }));
}

function recordSummary(competitor = {}) {
  if (typeof competitor.record === "string") return competitor.record;
  if (Array.isArray(competitor.records)) {
    return competitor.records.find((record) => record.type === "total")?.summary || competitor.records[0]?.summary || "";
  }
  if (Array.isArray(competitor.record)) {
    return competitor.record.find((record) => record.type === "total")?.summary || competitor.record[0]?.summary || "";
  }
  return competitor.record?.summary || "";
}

function compactLinescores(linescores = []) {
  return asList(linescores).map((line) => ({
    period: line.period,
    value: line.value ?? line.displayValue ?? line.score ?? "",
    displayValue: line.displayValue ?? line.value ?? line.score ?? "",
  }));
}

function compactBoxscore(boxscore = {}) {
  const teams = asList(boxscore.teams).map((entry) => ({
    team: {
      id: entry.team?.id,
      name: entry.team?.displayName || entry.team?.shortDisplayName || entry.team?.name,
      abbreviation: entry.team?.abbreviation,
      logo: entry.team?.logo,
    },
    statistics: asList(entry.statistics).map((stat) => ({
      name: stat.name,
      label: stat.label || stat.displayName || stat.shortDisplayName,
      displayValue: stat.displayValue,
      stats: asList(stat.stats).map((item) => ({
        name: item.name,
        label: item.label || item.displayName || item.shortDisplayName || item.abbreviation,
        abbreviation: item.abbreviation,
        value: item.value,
        displayValue: item.displayValue,
      })),
    })),
  }));
  const players = asList(boxscore.players).map((entry) => ({
    team: {
      id: entry.team?.id,
      name: entry.team?.displayName || entry.team?.shortDisplayName || entry.team?.name,
      abbreviation: entry.team?.abbreviation,
      logo: entry.team?.logo,
    },
    statistics: asList(entry.statistics).map((group) => ({
      name: group.displayName || group.name || inferStatGroupName(group.labels || []),
      shortName: group.shortDisplayName || group.abbreviation || group.name || "",
      labels: group.labels || [],
      descriptions: group.descriptions || [],
      keys: group.keys || [],
      athletes: asList(group.athletes).map((athlete) => ({
        id: athlete.athlete?.id || "",
        name: athlete.athlete?.displayName || athlete.athlete?.shortName || "",
        shortName: athlete.athlete?.shortName || athlete.athlete?.displayName || "",
        jersey: athlete.athlete?.jersey || "",
        position: athlete.athlete?.position?.abbreviation || athlete.athlete?.position?.displayName || "",
        headshot: normalizeImageUrl(athlete.athlete?.headshot),
        starter: Boolean(athlete.starter),
        didNotPlay: Boolean(athlete.didNotPlay),
        reason: athlete.reason || "",
        stats: athlete.stats || [],
      })),
    })),
  }));
  return { teams, players };
}

function normalizeImageUrl(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  return value.href || value.url || "";
}

function asList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "object") return Object.values(value).filter(Boolean);
  return [];
}

function firstItem(value) {
  return asList(value)[0] || {};
}

function compactAthlete(athlete = {}, role = "") {
  return {
    id: athlete.id || "",
    name: athlete.displayName || athlete.name || athlete.shortName || "",
    shortName: athlete.shortName || athlete.displayName || athlete.name || "",
    jersey: athlete.jersey || "",
    position: athlete.position?.abbreviation || athlete.position?.displayName || athlete.position || "",
    headshot: normalizeImageUrl(athlete.headshot),
    role,
  };
}

function buildAthleteLookup(payload = {}) {
  const athletes = new Map();
  const remember = (athlete) => {
    if (!athlete?.id) return;
    athletes.set(String(athlete.id), compactAthlete(athlete));
  };

  for (const team of asList(payload.boxscore?.players)) {
    for (const group of asList(team.statistics)) {
      for (const entry of asList(group.athletes)) remember(entry.athlete);
    }
  }
  for (const team of asList(payload.rosters)) {
    for (const entry of asList(team.roster || team.athletes)) remember(entry.athlete || entry);
  }
  return athletes;
}

function enrichAthleteReference(reference = {}, athletesById = new Map(), fallbackRole = "") {
  const source = reference.athlete || reference.player || reference;
  const id = source?.id || reference.playerId || "";
  const role = reference.type || reference.role || fallbackRole;
  const compact = athletesById.get(String(id)) || compactAthlete(source, role);
  if (!compact.id && !compact.name) return null;
  return { ...compact, role: role || compact.role || "" };
}

function compactPlayAthletes(play = {}, athletesById = new Map()) {
  const seen = new Set();
  const entries = [];
  const add = (reference, role = "") => {
    const athlete = enrichAthleteReference(reference, athletesById, role);
    if (!athlete) return;
    const key = `${athlete.id || athlete.name}:${athlete.role || role}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push(athlete);
  };

  for (const participant of asList(play.participants)) add(participant);
  for (const athlete of asList(play.athletesInvolved)) add(athlete);
  add(play.batter, "batter");
  add(play.pitcher, "pitcher");
  add(play.athlete);
  return entries.slice(0, 4);
}

function compactSituation(situation = {}, plays = [], athletesById = new Map()) {
  if (!situation || typeof situation !== "object") return null;
  if (!Object.keys(situation).length) return null;
  const lastPlaySource = situation.lastPlay?.text
    ? situation.lastPlay
    : plays.find((play) => String(play.id) === String(situation.lastPlay?.id)) || situation.lastPlay;
  return {
    balls: situation.balls,
    strikes: situation.strikes,
    outs: situation.outs,
    onFirst: Boolean(situation.onFirst),
    onSecond: Boolean(situation.onSecond),
    onThird: Boolean(situation.onThird),
    outsText: situation.outsText || "",
    baseRunnersText: situation.baseRunnersText || "",
    lastPlay: lastPlaySource ? compactPlay(lastPlaySource, athletesById) : null,
    dueUp: asList(situation.dueUp).map((entry) => ({
      playerId: entry.playerId || entry.athlete?.id || "",
      batOrder: entry.batOrder,
      name: entry.athlete?.displayName || entry.athlete?.shortName || "",
      shortName: entry.athlete?.shortName || entry.athlete?.displayName || "",
      jersey: entry.athlete?.jersey || "",
      headshot: normalizeImageUrl(entry.athlete?.headshot),
    })),
  };
}

function compactPlay(play = {}, athletesById = new Map()) {
  return {
    id: play.id || "",
    sequenceNumber: play.sequenceNumber || "",
    text: play.text || play.shortText || "",
    shortText: play.shortText || play.text || "",
    type: play.type?.text || play.type?.abbreviation || play.type?.type || "",
    scoringPlay: Boolean(play.scoringPlay),
    scoreValue: play.scoreValue ?? 0,
    awayScore: play.awayScore,
    homeScore: play.homeScore,
    period: {
      type: play.period?.type || "",
      number: play.period?.number ?? play.period,
      displayValue: play.period?.displayValue || "",
    },
    teamId: play.team?.id || "",
    wallclock: play.wallclock || "",
    outs: play.outs,
    pitchCount: play.pitchCount || play.resultCount || null,
    athletes: compactPlayAthletes(play, athletesById),
  };
}

function compactGameInfo(payload = {}, competition = {}) {
  const gameInfo = payload.gameInfo || {};
  const venue = gameInfo.venue || competition.venue || {};
  return {
    venue: {
      id: venue.id || "",
      name: venue.fullName || venue.shortName || "",
      city: venue.address?.city || "",
      state: venue.address?.state || "",
      image: venue.images?.[0]?.href || "",
    },
    weather: gameInfo.weather
      ? {
          temperature: gameInfo.weather.temperature,
          condition: gameInfo.weather.conditionId || gameInfo.weather.displayValue || "",
          precipitation: gameInfo.weather.precipitation,
          wind: gameInfo.weather.gust,
        }
      : null,
    officials: (gameInfo.officials || []).map((official) => ({
      name: official.displayName || "",
      position: official.position?.displayName || official.position?.name || "",
    })),
  };
}

function compactBroadcasts(payload = {}, competition = {}) {
  const broadcasts = payload.broadcasts || competition.broadcasts || [];
  return asList(broadcasts).map((broadcast) => ({
    name: broadcast.name || broadcast.station || broadcast.media?.shortName || broadcast.media?.name || "",
    shortName: broadcast.shortName || broadcast.station || broadcast.media?.shortName || "",
    type: broadcast.type?.shortName || broadcast.type?.longName || broadcast.type || "",
    market: broadcast.market?.type || "",
    isNational: Boolean(broadcast.isNational),
  }));
}

function compactVideos(payload = {}) {
  return asList(payload.videos || payload.article?.video)
    .map((video) => ({
      id: video.id || "",
      title: video.headline || video.title || video.description || "",
      description: video.description || "",
      thumbnail: video.thumbnail || video.images?.[0]?.url || video.images?.[0]?.href || "",
      duration: video.duration || "",
      url: video.links?.web?.href || video.link?.href || "",
    }))
    .filter((video) => video.title || video.thumbnail || video.url)
    .slice(0, 12);
}

function compactOdds(payload = {}) {
  const odds = Array.isArray(payload.pickcenter) ? payload.pickcenter[0] : Array.isArray(payload.odds) ? payload.odds[0] : payload.odds;
  if (!odds) return null;
  return enrichOddsProbabilities({
    provider: odds.provider?.name || odds.header?.text || "",
    details: odds.details || "",
    spread: odds.spread ?? null,
    overUnder: odds.overUnder ?? null,
    moneyline: compactOddsMarket(odds.moneyline),
    pointSpread: compactOddsMarket(odds.pointSpread),
    total: compactOddsMarket(odds.total),
    away: compactOddsSide(odds.away || odds.awayTeamOdds),
    home: compactOddsSide(odds.home || odds.homeTeamOdds),
  });
}

function compactOddsMarket(market = {}) {
  if (!market || typeof market !== "object") return null;
  return {
    displayName: market.displayName || "",
    shortDisplayName: market.shortDisplayName || "",
    away: compactOddsSide(market.away || market.awayTeamOdds),
    home: compactOddsSide(market.home || market.homeTeamOdds),
    over: compactOddsSide(market.over),
    under: compactOddsSide(market.under),
  };
}

function compactOddsSide(side = {}) {
  if (!side || typeof side !== "object") return null;
  return {
    odds: side.odds ?? side.moneyLine ?? side.spreadOdds ?? null,
    value: side.value ?? side.line ?? side.spread ?? null,
    open: compactOddsPoint(side.open),
    close: compactOddsPoint(side.close),
    live: compactOddsPoint(side.live),
    current: compactOddsPoint(side.current),
  };
}

function compactOddsPoint(point = {}) {
  if (!point || typeof point !== "object") return null;
  return {
    odds: point.odds ?? point.moneyLine ?? point.spreadOdds ?? null,
    value: point.value ?? point.line ?? point.spread ?? null,
  };
}

function americanOddsToProbability(value) {
  if (value === null || value === undefined || value === "") return null;
  const odds = Number(String(value).replace(/[^\d+-]/g, ""));
  if (!Number.isFinite(odds) || odds === 0) return null;
  if (odds > 0) return Number(((100 / (odds + 100)) * 100).toFixed(1));
  return Number(((-odds / (-odds + 100)) * 100).toFixed(1));
}

function liveOddsValue(side = {}) {
  return side?.current?.odds ?? side?.live?.odds ?? side?.close?.odds ?? side?.open?.odds ?? side?.odds ?? null;
}

function enrichOddsProbabilities(odds = {}) {
  if (!odds || typeof odds !== "object") return odds;
  const awayOdds = liveOddsValue(odds.moneyline?.away || odds.away);
  const homeOdds = liveOddsValue(odds.moneyline?.home || odds.home);
  const awayRaw = americanOddsToProbability(awayOdds);
  const homeRaw = americanOddsToProbability(homeOdds);
  if (awayRaw === null && homeRaw === null) return odds;
  const total = Number(awayRaw || 0) + Number(homeRaw || 0);
  return {
    ...odds,
    impliedWinProbability: {
      away: total ? Number(((Number(awayRaw || 0) / total) * 100).toFixed(1)) : awayRaw,
      home: total ? Number(((Number(homeRaw || 0) / total) * 100).toFixed(1)) : homeRaw,
      awayOdds,
      homeOdds,
    },
  };
}

function probabilityPercent(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Number((numeric <= 1 ? numeric * 100 : numeric).toFixed(1));
}

function compactWinProbability(payload = {}, competitors = []) {
  const rawSeries = payload.winProbability || payload.winprobability || payload.winProbabilities || payload.probabilities || [];
  const playsWithProbability = asList(payload.plays).filter((play) =>
    ["homeWinPercentage", "awayWinPercentage", "homeWinProbability", "awayWinProbability", "probability"].some((key) => play[key] !== undefined),
  );
  const source = asList(rawSeries).length ? asList(rawSeries) : playsWithProbability;
  const series = source
    .map((entry, index) => {
      const home = probabilityPercent(entry.homeWinPercentage ?? entry.homeWinProbability ?? entry.homeProbability ?? entry.probability?.home);
      const away = probabilityPercent(entry.awayWinPercentage ?? entry.awayWinProbability ?? entry.awayProbability ?? entry.probability?.away);
      const tie = probabilityPercent(entry.tiePercentage ?? entry.tieProbability ?? entry.probability?.tie);
      const period = entry.period?.number ?? entry.period ?? entry.play?.period?.number ?? null;
      return {
        index,
        id: entry.id || entry.playId || entry.play?.id || "",
        home,
        away: away ?? (home !== null ? Number((100 - home).toFixed(1)) : null),
        tie,
        period,
        clock: entry.clock?.displayValue || entry.displayClock || entry.clock || "",
        wallclock: entry.wallclock || entry.timestamp || entry.modified || "",
      };
    })
    .filter((entry) => entry.home !== null || entry.away !== null);
  const homeEntry = competitors.find((entry) => entry.homeAway === "home") || competitors[1];
  const awayEntry = competitors.find((entry) => entry.homeAway === "away") || competitors[0];
  return {
    homeTeamId: homeEntry?.team?.id || "",
    awayTeamId: awayEntry?.team?.id || "",
    current: series.at(-1) || null,
    series: series.slice(-240),
  };
}

function compactScoringSummary(payload = {}, athletesById = new Map()) {
  const scoring = payload.scoringPlays || payload.scrSumm || [];
  const scoringList = asList(scoring);
  if (scoringList.length) {
    return scoringList.map((play) => compactPlay(play, athletesById)).filter((play) => play.text);
  }
  return asList(payload.plays).filter((play) => play.scoringPlay).map((play) => compactPlay(play, athletesById));
}

function compactRecentPlays(payload = {}, athletesById = new Map()) {
  return asList(payload.plays)
    .filter((play) => play.text && play.summaryType !== "P")
    .map((play) => compactPlay(play, athletesById))
    .slice(-20)
    .reverse();
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
  const competition = firstItem(header.competitions);
  const status = competition.status || {};
  const statusType = status.type || {};
  const competitors = compactScoreboard(header);
  const athletesById = buildAthleteLookup(payload);
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
    date: competition.date || header.date || "",
    status: statusType.description || "",
    statusDetail: statusType.detail || statusType.statusPrimary || "",
    shortStatusDetail: statusType.shortDetail || statusType.statusPrimary || "",
    state: statusType.state || "",
    completed: Boolean(statusType.completed),
    period: status.period || null,
    periodPrefix: status.periodPrefix || "",
    displayPeriod: status.displayPeriod || "",
    clock: status.displayClock || "",
    source: payload.__source || "summary",
    situation: compactSituation(payload.situation, payload.plays || [], athletesById),
    competitors,
    boxscore: compactBoxscore(payload.boxscore),
    scoringSummary: compactScoringSummary(payload, athletesById),
    recentPlays: compactRecentPlays(payload, athletesById),
    gameInfo: compactGameInfo(payload, competition),
    broadcasts: compactBroadcasts(payload, competition),
    videos: compactVideos(payload),
    odds: compactOdds(payload),
    winProbability: compactWinProbability(payload, competitors),
  };
}

function gamePackagePayload(payload = {}) {
  if (payload.header || payload.boxscore || payload.plays) return payload;
  return payload.gamepackageJSON || payload.gamePackage || payload.content?.gamepackageJSON || payload.page?.content?.gamepackageJSON || null;
}

function gameSummaryIsUseful(summary) {
  return Boolean(summary?.id && summary?.competitors?.length >= 2);
}

function latestPlayTimestampSeconds(summary) {
  const timestamps = [
    summary?.situation?.lastPlay?.wallclock,
    ...(summary?.recentPlays || []).map((play) => play.wallclock),
  ];
  return timestamps
    .map((value) => {
      const parsed = Date.parse(value || "");
      return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
    })
    .filter(Boolean)
    .sort((a, b) => b - a)[0] || null;
}

function gamePackageLooksStale(summary) {
  if (!summary || summary.sport !== "baseball") return false;
  if (summary.state === "pre" && Date.parse(summary.date) && Date.now() > Date.parse(summary.date) + 5 * 60 * 1000) return true;
  if (summary.state === "in" && !summary.recentPlays?.length && !summary.situation?.lastPlay) return true;
  const latestPlayAt = latestPlayTimestampSeconds(summary);
  if (summary.state === "in" && latestPlayAt && now() - latestPlayAt > Math.max(180, espnSummaryRefreshSeconds(summary.league))) return true;
  return false;
}

function summarizeShape(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 3) return Array.isArray(value) ? `array(${value.length})` : typeof value;
  if (Array.isArray(value)) return value.length ? [summarizeShape(value[0], depth + 1)] : [];
  return Object.fromEntries(Object.keys(value).slice(0, 80).map((key) => [key, summarizeShape(value[key], depth + 1)]));
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

export function espnSummaryRefreshSeconds(league = "nfl") {
  return Math.max(30, config.espnSummaryCacheSecondsByLeague?.[league] || config.espnLiveCacheSecondsByLeague?.[league] || config.espnLiveCacheSeconds);
}

export function espnFastcastRefreshSeconds(league = "mlb") {
  return Math.max(2, config.espnFastcastCacheSecondsByLeague?.[league] || 5);
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

async function getEspnSummaryFallback({ league = "nfl", eventId }) {
  const selected = LEAGUES[league] || LEAGUES.nfl;
  const url = new URL(`https://site.api.espn.com/apis/site/v2/sports/${selected.sport}/${selected.league}/summary`);
  url.searchParams.set("event", eventId);
  const result = await fetchJsonCached(url.toString(), espnSummaryRefreshSeconds(league));
  return { ...result, url: url.toString(), summary: normalizeGameSummary({ ...result.payload, __source: "summary" }, league) };
}

export async function getEspnRawGamePackage({ league = "mlb", eventId }) {
  const selected = LEAGUES[league] || LEAGUES.nfl;
  const url = new URL(`https://cdn.espn.com/core/${selected.league}/game`);
  url.searchParams.set("xhr", "1");
  url.searchParams.set("gameId", eventId);
  const result = await fetchJsonCached(url.toString(), espnSummaryRefreshSeconds(league));
  const gamepackage = gamePackagePayload(result.payload);
  return {
    ...result,
    url: url.toString(),
    shape: summarizeShape(result.payload),
    gamepackageShape: summarizeShape(gamepackage),
    payload: result.payload,
  };
}

export async function getEspnGameSummary({ league = "nfl", eventId }) {
  let packageError = null;
  try {
    const result = await getEspnRawGamePackage({ league, eventId });
    const gamepackage = gamePackagePayload(result.payload);
    const summary = normalizeGameSummary({ ...gamepackage, __source: "game-package" }, league);
    if (gameSummaryIsUseful(summary) && !gamePackageLooksStale(summary)) {
      return { ...result, summary };
    }
    packageError = new Error("ESPN game package is stale or missing live fields");
  } catch (error) {
    packageError = error;
  }
  const fallback = await getEspnSummaryFallback({ league, eventId });
  return {
    ...fallback,
    summary: {
      ...fallback.summary,
      source: "summary-fallback",
      fallbackReason: packageError?.message || "ESPN game package unavailable",
    },
  };
}

const fastcastFeeds = new Map();
let fastcastHostCache = null;
let fastcastHostExpiresAt = 0;
let fastcastPruneTimer = null;
const fastcastHostUrl = "https://fastcast.semfs.engsvc.go.com/public/websockethost";

function fastcastKey(league, eventId) {
  return `${league}:${eventId}`;
}

function fastcastTopic(league, eventId) {
  const selected = LEAGUES[league];
  if (!selected) return "";
  return `gp-${selected.sport}-${selected.league}-${eventId}`;
}

function fastcastEventTopic(league) {
  const selected = LEAGUES[league];
  if (!selected) return "";
  return `event-${selected.sport}-${selected.league}`;
}

function invalidateFastcastHost() {
  fastcastHostCache = null;
  fastcastHostExpiresAt = 0;
  db.prepare("DELETE FROM espn_cache WHERE cache_key = ?").run(cacheKey(fastcastHostUrl));
}

async function discoverFastcastHost({ force = false } = {}) {
  if (force) invalidateFastcastHost();
  if (fastcastHostCache && fastcastHostExpiresAt > now()) return fastcastHostCache;
  const result = await fetchJsonCached(fastcastHostUrl, 300);
  fastcastHostCache = result.payload;
  fastcastHostExpiresAt = now() + 300;
  return fastcastHostCache;
}

function scheduleFastcastReconnect(feed, delayMs = 5000) {
  if (!feed.watchers.size || feed.reconnectTimer) return;
  feed.reconnectTimer = setTimeout(() => {
    feed.reconnectTimer = null;
    connectFastcastFeed(feed);
  }, delayMs);
}

async function fetchFastcastCheckpoint(feed, checkpointUrl, { force = false } = {}) {
  if (!checkpointUrl) return;
  if (feed.inFlightCheckpoint) {
    if (feed.inFlightCheckpoint !== checkpointUrl) feed.pendingCheckpointUrl = checkpointUrl;
    return;
  }
  const refreshSeconds = espnFastcastRefreshSeconds(feed.league);
  const secondsUntilNextFetch = feed.lastFetchedAt
    ? refreshSeconds - (now() - Number(feed.lastFetchedAt))
    : 0;
  if (!force && secondsUntilNextFetch > 0) {
    feed.pendingCheckpointUrl = checkpointUrl;
    if (!feed.pendingCheckpointTimer) {
      feed.pendingCheckpointTimer = setTimeout(() => {
        feed.pendingCheckpointTimer = null;
        const pendingUrl = feed.pendingCheckpointUrl;
        feed.pendingCheckpointUrl = "";
        fetchFastcastCheckpoint(feed, pendingUrl, { force: true });
      }, Math.max(1000, secondsUntilNextFetch * 1000 + 250));
    }
    return;
  }
  if (feed.pendingCheckpointUrl === checkpointUrl) feed.pendingCheckpointUrl = "";
  feed.inFlightCheckpoint = checkpointUrl;
  try {
    const result = await fetchJsonCached(checkpointUrl, refreshSeconds);
    const payload = gamePackagePayload(result.payload);
    if (!payload) throw new Error("Fastcast checkpoint did not contain a game package payload");
    const summary = normalizeGameSummary({ ...payload, __source: "fastcast" }, feed.league);
    if (!gameSummaryIsUseful(summary)) throw new Error("Fastcast checkpoint did not contain a usable game summary");
    feed.lastSummary = summary;
    feed.lastPayload = structuredClone(payload);
    feed.lastFetchedAt = result.fetchedAt;
    feed.lastCheckpointUrl = checkpointUrl;
    feed.lastError = "";
    for (const watcher of feed.watchers.values()) {
      try {
        watcher.onUpdate?.({ summary, fetchedAt: result.fetchedAt, cache: result.cache, source: "fastcast", checkpointUrl });
      } catch {
        // Keep one bad watcher from killing updates for the rest of the room.
      }
    }
  } catch (error) {
    feed.lastError = error.message;
  } finally {
    feed.inFlightCheckpoint = "";
    if (feed.pendingCheckpointUrl && !feed.pendingCheckpointTimer) {
      fetchFastcastCheckpoint(feed, feed.pendingCheckpointUrl);
    }
  }
}

function decodeFastcastPatchPayload(value) {
  if (!value || typeof value !== "string") return { ts: 0, patches: [], compressed: false, error: "" };
  let message;
  try {
    message = JSON.parse(value);
  } catch {
    return { ts: 0, patches: [], compressed: false, error: "Fastcast patch wrapper was not JSON" };
  }
  let patches = message.pl;
  if (message["~c"] && typeof patches === "string") {
    try {
      patches = JSON.parse(zlib.inflateSync(Buffer.from(patches, "base64")).toString("utf8"));
    } catch {
      return { ts: Number(message.ts || 0), patches: [], compressed: true, error: "Fastcast compressed patch payload did not decode" };
    }
  }
  return {
    ts: Number(message.ts || 0),
    patches: Array.isArray(patches) ? patches : [],
    compressed: Boolean(message["~c"]),
    error: "",
  };
}

function decodeFastcastPath(path = "", fallbackEventId = "") {
  const parts = String(path).split("/").filter(Boolean);
  const [entityPath = "", ...fieldParts] = parts;
  if (!entityPath.includes("~")) {
    return { eventId: fallbackEventId, fields: parts };
  }
  const eventId = entityPath.split("~").find((part) => part.startsWith("e:"))?.slice(2) || fallbackEventId;
  return { eventId, fields: fieldParts };
}

function applyNestedPatch(target, fields, value, op = "replace") {
  if (!target || !fields.length) return false;
  let cursor = target;
  for (const field of fields.slice(0, -1)) {
    if (Array.isArray(cursor)) {
      const index = field === "-" ? cursor.length : Number(field);
      if (!Number.isInteger(index) || index < 0) return false;
      if (!cursor[index] || typeof cursor[index] !== "object") cursor[index] = {};
      cursor = cursor[index];
    } else {
      if (!cursor[field] || typeof cursor[field] !== "object") cursor[field] = {};
      cursor = cursor[field];
    }
  }
  const last = fields.at(-1);
  if (Array.isArray(cursor)) {
    if (last === "-") {
      cursor.push(value);
      return true;
    }
    const index = Number(last);
    if (!Number.isInteger(index) || index < 0) return false;
    if (op === "remove") {
      if (index >= cursor.length) return false;
      cursor.splice(index, 1);
      return true;
    }
    if (JSON.stringify(cursor[index]) === JSON.stringify(value)) return false;
    cursor[index] = value;
    return true;
  }
  if (op === "remove") {
    if (!(last in cursor)) return false;
    delete cursor[last];
    return true;
  }
  if (JSON.stringify(cursor[last]) === JSON.stringify(value)) return false;
  cursor[last] = value;
  return true;
}

function patchBatchIsOlder(feed, batch) {
  const ts = Number(batch?.ts || 0);
  const mid = Number(batch?.mid || 0);
  if (ts && feed.lastAppliedPatchTs && ts < feed.lastAppliedPatchTs) return true;
  if (ts && feed.lastAppliedPatchTs && ts === feed.lastAppliedPatchTs && mid && feed.lastAppliedPatchMid && mid <= feed.lastAppliedPatchMid) return true;
  return false;
}

function rememberPatchDebug(feed, batch, appliedPaths = []) {
  feed.lastPatchTs = Number(batch?.ts || 0) || feed.lastPatchTs || null;
  feed.lastPatchMid = Number(batch?.mid || 0) || feed.lastPatchMid || null;
  feed.lastPatchCount = batch?.patches?.length || 0;
  feed.lastTargetPatchCount = batch?.targetPatchCount || 0;
  feed.lastIgnoredPatchCount = Math.max(0, feed.lastPatchCount - feed.lastTargetPatchCount);
  feed.lastPatchCompressed = Boolean(batch?.compressed);
  feed.lastPatchError = batch?.error || "";
  if (appliedPaths.length) {
    feed.lastAppliedPatchTs = Number(batch?.ts || 0) || feed.lastAppliedPatchTs || null;
    feed.lastAppliedPatchMid = Number(batch?.mid || 0) || feed.lastAppliedPatchMid || null;
    feed.lastAppliedPatchAt = now();
    feed.lastAppliedPatchPaths = appliedPaths.slice(-25);
  }
}

function applyFastcastEventPatches(feed, batch = {}) {
  const patches = batch.patches || [];
  if (!feed.lastPayload || !patches.length) {
    rememberPatchDebug(feed, batch);
    return false;
  }
  if (patchBatchIsOlder(feed, batch)) {
    rememberPatchDebug(feed, { ...batch, error: "Ignored older Fastcast patch batch" });
    return false;
  }
  let changed = false;
  const nextPayload = structuredClone(feed.lastPayload);
  const appliedPaths = [];
  let targetPatchCount = 0;
  for (const patch of patches) {
    if (!["add", "replace", "remove"].includes(patch.op)) continue;
    const { eventId, fields } = decodeFastcastPath(patch.path, batch.scope === "game" ? feed.eventId : "");
    if (String(eventId) !== String(feed.eventId) || !fields.length) continue;
    targetPatchCount += 1;
    const applied = applyNestedPatch(nextPayload, fields, patch.value, patch.op);
    if (!applied) continue;
    appliedPaths.push(patch.path);
    changed = true;
  }
  rememberPatchDebug(feed, { ...batch, targetPatchCount }, appliedPaths);
  if (!changed) return false;
  const summary = normalizeGameSummary({ ...nextPayload, __source: "fastcast-event" }, feed.league);
  if (!gameSummaryIsUseful(summary)) {
    feed.lastPatchError = "Patched Fastcast payload did not normalize into a usable game summary";
    return false;
  }
  feed.lastPayload = nextPayload;
  feed.lastSummary = summary;
  feed.lastFetchedAt = Math.max(now(), Math.floor((Number(batch.ts || 0) || 0) / 1000));
  for (const watcher of feed.watchers.values()) {
    try {
      watcher.onUpdate?.({ summary, fetchedAt: feed.lastFetchedAt, cache: "fastcast-event", source: "fastcast-event" });
    } catch {
      // Keep one bad watcher from killing updates for the rest of the room.
    }
  }
  return true;
}

function queueFastcastPatchBatch(feed, batch = {}) {
  if (batch.error || !batch.patches?.length) {
    rememberPatchDebug(feed, batch);
    return false;
  }
  feed.pendingPatchBatches.push(batch);
  if (feed.pendingPatchTimer) return true;
  feed.pendingPatchTimer = setTimeout(() => {
    feed.pendingPatchTimer = null;
    try {
      const batches = feed.pendingPatchBatches
        .splice(0)
        .sort((a, b) => (Number(a.ts || 0) - Number(b.ts || 0)) || (Number(a.mid || 0) - Number(b.mid || 0)));
      for (const pendingBatch of batches) applyFastcastEventPatches(feed, pendingBatch);
    } catch (error) {
      feed.lastPatchError = `Fastcast patch flush failed: ${error.message}`;
      feed.pendingPatchBatches = [];
    }
  }, 750);
  return true;
}

function connectFastcastFeed(feed) {
  if (feed.ws && [WebSocket.CONNECTING, WebSocket.OPEN].includes(feed.ws.readyState)) return;
  if (feed.reconnectTimer) {
    clearTimeout(feed.reconnectTimer);
    feed.reconnectTimer = null;
  }
  feed.status = "connecting";
  feed.lastError = "";
  discoverFastcastHost()
    .then((host) => {
      const address = host.ip || host.host;
      const securePort = host.securePort || 9573;
      const token = host.token;
      if (!address || !token) throw new Error("Fastcast host discovery returned an incomplete response");
      const ws = new WebSocket(`wss://${address}:${securePort}/FastcastService/pubsub/profiles/12000?TrafficManager-Token=${token}`);
      feed.ws = ws;
      ws.on("open", () => {
        feed.status = "open";
        feed.lastFrameAt = now();
        ws.send(JSON.stringify({ op: "C" }));
      });
      ws.on("message", (raw) => {
        feed.lastFrameAt = now();
        let message;
        try {
          message = JSON.parse(raw.toString());
        } catch {
          return;
        }
        feed.lastMessage = message;
        if (message.op === "C" && message.sid) {
          feed.sid = message.sid;
          ws.send(JSON.stringify({ op: "S", sid: message.sid, tc: feed.topic }));
          if (feed.eventTopic) ws.send(JSON.stringify({ op: "S", sid: message.sid, tc: feed.eventTopic }));
          return;
        }
        if (message.op === "S") {
          feed.status = "subscribed";
          return;
        }
        if (message.tc === feed.topic && ["P", "R"].includes(message.op)) {
          feed.lastGamePatchMid = message.mid;
          queueFastcastPatchBatch(feed, { ...decodeFastcastPatchPayload(message.pl), mid: Number(message.mid || 0), op: message.op, scope: "game" });
          return;
        }
        if (message.tc === feed.eventTopic && ["P", "R"].includes(message.op)) {
          feed.lastEventMid = message.mid;
          queueFastcastPatchBatch(feed, { ...decodeFastcastPatchPayload(message.pl), mid: Number(message.mid || 0), op: message.op, scope: "league" });
          return;
        }
        if (message.tc === feed.topic && message.op === "H" && message.pl && message.mid !== feed.lastMid) {
          feed.lastMid = message.mid;
          fetchFastcastCheckpoint(feed, message.pl);
        }
      });
      ws.on("close", () => {
        feed.status = "closed";
        feed.ws = null;
        scheduleFastcastReconnect(feed, feed.lastError.includes("Unexpected server response") ? 1500 : 5000);
      });
      ws.on("error", (error) => {
        feed.lastError = error.message;
        if (error.message.includes("Unexpected server response")) {
          invalidateFastcastHost();
        }
      });
    })
    .catch((error) => {
      feed.status = "error";
      feed.lastError = error.message;
      scheduleFastcastReconnect(feed, 15000);
    });
}

function pruneFastcastWatchers() {
  const current = now();
  for (const [key, feed] of fastcastFeeds.entries()) {
    for (const [watcherId, watcher] of feed.watchers.entries()) {
      if (watcher.expiresAt <= current) feed.watchers.delete(watcherId);
    }
    if (!feed.watchers.size) {
      if (feed.reconnectTimer) clearTimeout(feed.reconnectTimer);
      if (feed.pendingCheckpointTimer) clearTimeout(feed.pendingCheckpointTimer);
      if (feed.pendingPatchTimer) clearTimeout(feed.pendingPatchTimer);
      if (feed.ws) feed.ws.close();
      fastcastFeeds.delete(key);
    } else if (feed.lastFrameAt && current - feed.lastFrameAt > 90 && feed.ws) {
      feed.lastError = "Fastcast socket went stale";
      feed.ws.close();
    }
  }
  if (!fastcastFeeds.size && fastcastPruneTimer) {
    clearInterval(fastcastPruneTimer);
    fastcastPruneTimer = null;
  }
}

export function watchEspnFastcastGame({ league = "mlb", eventId, watcherId, ttlSeconds = 180, onUpdate }) {
  const selected = LEAGUES[league];
  const topic = fastcastTopic(league, eventId);
  if (!selected || !topic || !eventId) return null;
  const key = fastcastKey(league, eventId);
  let feed = fastcastFeeds.get(key);
  if (!feed) {
    feed = {
      league,
      eventId,
      topic,
      eventTopic: fastcastEventTopic(league),
      status: "new",
      sid: "",
      ws: null,
      watchers: new Map(),
      lastMid: null,
      lastEventMid: null,
      lastGamePatchMid: null,
      lastMessage: null,
      lastSummary: null,
      lastPayload: null,
      lastFetchedAt: null,
      lastCheckpointUrl: "",
      lastFrameAt: null,
      lastError: "",
      inFlightCheckpoint: "",
      pendingCheckpointUrl: "",
      pendingCheckpointTimer: null,
      pendingPatchBatches: [],
      pendingPatchTimer: null,
      reconnectTimer: null,
      lastPatchTs: null,
      lastPatchMid: null,
      lastPatchCount: 0,
      lastTargetPatchCount: 0,
      lastIgnoredPatchCount: 0,
      lastPatchCompressed: false,
      lastPatchError: "",
      lastAppliedPatchTs: null,
      lastAppliedPatchMid: null,
      lastAppliedPatchAt: null,
      lastAppliedPatchPaths: [],
    };
    fastcastFeeds.set(key, feed);
  }
  feed.watchers.set(String(watcherId || key), {
    expiresAt: now() + Math.max(60, Number(ttlSeconds || 180)),
    onUpdate,
  });
  connectFastcastFeed(feed);
  if (!fastcastPruneTimer) fastcastPruneTimer = setInterval(pruneFastcastWatchers, 30000);
  return {
    summary: feed.lastSummary,
    fetchedAt: feed.lastFetchedAt,
    status: feed.status,
    lastError: feed.lastError,
  };
}

export function espnFastcastDebug() {
  return [...fastcastFeeds.values()].map((feed) => ({
    league: feed.league,
    eventId: feed.eventId,
    topic: feed.topic,
    eventTopic: feed.eventTopic,
    status: feed.status,
    watcherCount: feed.watchers.size,
    watchers: [...feed.watchers.keys()],
    lastMid: feed.lastMid,
    lastEventMid: feed.lastEventMid,
    lastGamePatchMid: feed.lastGamePatchMid,
    lastFetchedAt: feed.lastFetchedAt,
    lastFrameAt: feed.lastFrameAt,
    lastCheckpointUrl: feed.lastCheckpointUrl,
    pendingCheckpointUrl: feed.pendingCheckpointUrl,
    pendingPatchBatchCount: feed.pendingPatchBatches?.length || 0,
    lastError: feed.lastError,
    lastPatchTs: feed.lastPatchTs,
    lastPatchMid: feed.lastPatchMid,
    lastPatchCount: feed.lastPatchCount,
    lastTargetPatchCount: feed.lastTargetPatchCount,
    lastIgnoredPatchCount: feed.lastIgnoredPatchCount,
    lastPatchCompressed: feed.lastPatchCompressed,
    lastPatchError: feed.lastPatchError,
    lastAppliedPatchTs: feed.lastAppliedPatchTs,
    lastAppliedPatchMid: feed.lastAppliedPatchMid,
    lastAppliedPatchAt: feed.lastAppliedPatchAt,
    lastAppliedPatchPaths: feed.lastAppliedPatchPaths || [],
    lastPayloadShape: summarizeShape(feed.lastPayload),
    lastSummary: feed.lastSummary
      ? {
          id: feed.lastSummary.id,
          name: feed.lastSummary.name,
          state: feed.lastSummary.state,
          status: feed.lastSummary.status,
          statusDetail: feed.lastSummary.statusDetail,
          period: feed.lastSummary.period,
          clock: feed.lastSummary.clock,
        }
      : null,
  }));
}

import { config } from "./config.js";
import { db } from "./db.js";
import { getEspnGameSummary, searchEspnGames } from "./espn.js";
import { XMLParser } from "fast-xml-parser";
import { gunzipSync } from "node:zlib";

const DAY_ALIASES = {
  sun: 0,
  sunday: 0,
  snf: 0,
  mon: 1,
  monday: 1,
  mnf: 1,
  tue: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  tnf: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

let sourceCache = {
  fetchedAt: 0,
  programs: [],
  error: "",
};
const enrichmentCache = new Map();

const GENERATED_DAYS = 14;
const PREGAME_SECONDS = 60 * 60;
const POSTGAME_SECONDS = 60 * 60;
const ESPN_ENRICHMENT_CACHE_SECONDS = 24 * 60 * 60;
const ESPN_ENRICHMENT_CACHE_VERSION = 2;
const NFL_TEAMS = [
  ["Arizona Cardinals", "ari", "cardinals"],
  ["Atlanta Falcons", "atl", "falcons"],
  ["Baltimore Ravens", "bal", "ravens"],
  ["Buffalo Bills", "buf", "bills"],
  ["Carolina Panthers", "car", "panthers"],
  ["Chicago Bears", "chi", "bears"],
  ["Cincinnati Bengals", "cin", "bengals"],
  ["Cleveland Browns", "cle", "browns"],
  ["Dallas Cowboys", "dal", "cowboys"],
  ["Denver Broncos", "den", "broncos"],
  ["Detroit Lions", "det", "lions"],
  ["Green Bay Packers", "gb", "packers"],
  ["Houston Texans", "hou", "texans"],
  ["Indianapolis Colts", "ind", "colts"],
  ["Jacksonville Jaguars", "jax", "jaguars"],
  ["Kansas City Chiefs", "kc", "chiefs"],
  ["Las Vegas Raiders", "lv", "raiders"],
  ["Los Angeles Chargers", "lac", "chargers"],
  ["Los Angeles Rams", "lar", "rams"],
  ["Miami Dolphins", "mia", "dolphins"],
  ["Minnesota Vikings", "min", "vikings"],
  ["New England Patriots", "ne", "patriots"],
  ["New Orleans Saints", "no", "saints"],
  ["New York Giants", "nyg", "giants"],
  ["New York Jets", "nyj", "jets"],
  ["Philadelphia Eagles", "phi", "eagles"],
  ["Pittsburgh Steelers", "pit", "steelers"],
  ["San Francisco 49ers", "sf", "49ers"],
  ["Seattle Seahawks", "sea", "seahawks"],
  ["Tampa Bay Buccaneers", "tb", "buccaneers", "bucs"],
  ["Tennessee Titans", "ten", "titans"],
  ["Washington Commanders", "was", "commanders"],
].map(([display, ...aliases]) => ({
  display,
  aliases: [display, ...aliases].map(normalizeTeamToken),
}));

function escapeXml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function timezoneParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hour12: false,
  }).formatToParts(date);
  const map = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => {
    if (part.type === "weekday") return [part.type, DAY_ALIASES[part.value.toLowerCase()]];
    return [part.type, Number(part.value)];
  }));
  if (map.hour === 24) map.hour = 0;
  return map;
}

function timezoneOffsetMs(date, timeZone) {
  const parts = timezoneParts(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - date.getTime();
}

function zonedDateTimeToEpoch(parts, timeZone) {
  let utc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute || 0, 0);
  for (let index = 0; index < 3; index += 1) {
    utc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute || 0, 0) - timezoneOffsetMs(new Date(utc), timeZone);
  }
  return Math.floor(utc / 1000);
}

function addDaysToZonedDate(parts, days) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12, 0, 0));
  return timezoneParts(date, "UTC");
}

function localDayParts(date, daysAhead = 0) {
  const parts = timezoneParts(date, config.nflMapperTimezone);
  return addDaysToZonedDate(parts, daysAhead);
}

function localDayStart(parts) {
  return zonedDateTimeToEpoch({ ...parts, hour: 0, minute: 0 }, config.nflMapperTimezone);
}

function localDayKey(epoch) {
  const parts = timezoneParts(new Date(epoch * 1000), config.nflMapperTimezone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function formatMapperDateTime(epoch) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: config.nflMapperTimezone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(epoch * 1000));
}

function parseKickoffTime(value = "") {
  const match = String(value).match(/^(\d{1,2})(?::(\d{2}))?\s*([ap]m)$/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  const meridiem = match[3].toLowerCase();
  if (meridiem === "pm" && hour !== 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  return { hour, minute };
}

function inferKickoffEpoch({ dayToken, timeToken, nowDate = new Date(), timeZone = config.nflMapperTimezone }) {
  const kickoff = parseKickoffTime(timeToken);
  if (!kickoff) return null;
  const nowParts = timezoneParts(nowDate, timeZone);
  const today = nowParts.weekday ?? new Date(zonedDateTimeToEpoch({ ...nowParts, hour: 12, minute: 0 }, timeZone) * 1000).getUTCDay();
  const explicitDay = dayToken ? DAY_ALIASES[String(dayToken).toLowerCase()] : null;
  const preferredDay = explicitDay ?? (kickoff.hour >= 12 && kickoff.hour < 19 ? 0 : today);
  const daysAhead = (preferredDay - today + 7) % 7;
  const candidateDate = addDaysToZonedDate(nowParts, daysAhead);
  let epoch = zonedDateTimeToEpoch({ ...candidateDate, hour: kickoff.hour, minute: kickoff.minute }, timeZone);
  const duration = config.nflMapperDurationSeconds;
  const current = Math.floor(nowDate.getTime() / 1000);
  if (explicitDay == null && epoch + duration < current) {
    const nextDate = addDaysToZonedDate(nowParts, daysAhead + 7);
    epoch = zonedDateTimeToEpoch({ ...nextDate, hour: kickoff.hour, minute: kickoff.minute }, timeZone);
  }
  return epoch;
}

function xmltvStamp(epoch) {
  const date = new Date(epoch * 1000);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())} +0000`;
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function xmlText(value) {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "object" && typeof value["#text"] === "string") return value["#text"].trim();
  return "";
}

function parseXmltvTime(value) {
  const match = String(value || "").match(/^(\d{14})(?:\s*([+-]\d{4}))?/);
  if (!match) return 0;
  const stamp = match[1];
  const offset = match[2] || "+0000";
  const utc = Date.UTC(
    Number(stamp.slice(0, 4)),
    Number(stamp.slice(4, 6)) - 1,
    Number(stamp.slice(6, 8)),
    Number(stamp.slice(8, 10)),
    Number(stamp.slice(10, 12)),
    Number(stamp.slice(12, 14)),
  );
  const sign = offset[0] === "+" ? 1 : -1;
  const offsetMs = sign * ((Number(offset.slice(1, 3)) * 60 + Number(offset.slice(3, 5))) * 60000);
  return Math.floor((utc - offsetMs) / 1000);
}

function extractNflSlot(value = "") {
  const text = String(value || "");
  const match = text.match(/\bNFL\s*(?:\||-|:)?\s*(4k|\d{1,2})\b/i);
  if (!match) return "";
  const slot = match[1].toLowerCase();
  return slot === "4k" ? "4k" : String(Number(slot)).padStart(2, "0");
}

function stripNflPrefix(value = "") {
  return String(value || "")
    .replace(/^\s*NFL\s*(?:\||-|:)?\s*(?:4k|\d{1,2})\s*(?:-|:)?\s*/i, "")
    .replace(/^\s*(?:TNF|SNF|MNF)\s+/i, "")
    .replace(/^\s*(?:Sun(?:day)?|Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:r|rs|rsday|sday)?|Fri(?:day)?|Sat(?:urday)?)\s+/i, "")
    .replace(/^\s*\d{1,2}(?::\d{2})?\s*[ap]m\s+/i, "")
    .trim();
}

function isNoiseProgram(title = "") {
  return /^(?:no\s+event|no\s+events|off\s+air|to\s+be\s+announced|tba)\b/i.test(String(title || "").trim());
}

function isEmptySlotTitle(title = "") {
  return !String(title || "").replace(/[\s|:-]/g, "");
}

function normalizeTeamToken(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/&amp;/g, "&")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function teamAliasesFor(value = "") {
  const token = normalizeTeamToken(value);
  if (!token) return [];
  return NFL_TEAMS.find((team) => team.aliases.includes(token))?.aliases || [token];
}

function fullTeamName(value = "") {
  const token = normalizeTeamToken(value);
  return NFL_TEAMS.find((team) => team.aliases.includes(token))?.display || String(value || "").trim();
}

function splitMatchup(title = "") {
  const normalized = String(title || "").replace(/\s+vs\.?\s+/i, " at ");
  const parts = normalized.split(/\s+@\s+|\s+at\s+/i).map((part) => part.trim()).filter(Boolean);
  return parts.length >= 2 ? { away: parts[0], home: parts.slice(1).join(" at ") } : null;
}

function displayMatchup(title = "") {
  const matchup = splitMatchup(title);
  if (!matchup) return String(title || "").trim();
  return `${fullTeamName(matchup.away)} at ${fullTeamName(matchup.home)}`;
}

function aliasesOverlap(left = "", right = "") {
  const leftAliases = new Set(teamAliasesFor(left));
  return teamAliasesFor(right).some((alias) => leftAliases.has(alias));
}

function sameMatchup(leftTitle = "", rightTitle = "") {
  const left = splitMatchup(leftTitle);
  const right = splitMatchup(rightTitle);
  if (!left || !right) return false;
  return aliasesOverlap(left.away, right.away) && aliasesOverlap(left.home, right.home);
}

function matchupMatches(programTitle, event) {
  const matchup = splitMatchup(programTitle);
  if (!matchup || !event) return false;
  const haystack = normalizeTeamToken([
    event.name,
    event.shortName,
    event.away?.name,
    event.away?.abbreviation,
    event.home?.name,
    event.home?.abbreviation,
  ].join(" "));
  const awayAliases = teamAliasesFor(matchup.away);
  const homeAliases = teamAliasesFor(matchup.home);
  return awayAliases.some((alias) => haystack.includes(alias)) && homeAliases.some((alias) => haystack.includes(alias));
}

function recordFor(competitor = {}) {
  return competitor.record || competitor.records?.find((item) => item.type === "total")?.summary || competitor.records?.[0]?.summary || "";
}

function teamLabel(competitor = {}) {
  return [competitor.team?.name || competitor.name, recordFor(competitor) ? `(${recordFor(competitor)})` : ""].filter(Boolean).join(" ");
}

function injuryStatus(injury = {}) {
  return [injury.status, injury.detail || injury.type || injury.returnDate].filter(Boolean).join(" - ");
}

function groupedInjuryLines(injuries = []) {
  const sections = [];
  for (const entry of injuries) {
    const team = entry.team?.name || entry.team?.abbreviation;
    const lines = [];
    for (const injury of entry.injuries || []) {
      const player = injury.athlete?.shortName || injury.athlete?.name;
      const status = injuryStatus(injury);
      if (player && status) lines.push(`- ${player} - ${status}`);
    }
    if (team && lines.length) sections.push(`${team} Injuries:\n${lines.join("\n")}`);
  }
  return sections;
}

function formatPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "";
  return `${Number(numeric.toFixed(1)).toString()}%`;
}

function conciseOdds(odds = {}, away = {}, home = {}) {
  if (!odds || typeof odds !== "object") return "";
  const probability = odds.impliedWinProbability;
  const awayName = away.team?.name || away.name;
  const homeName = home.team?.name || home.name;
  if (
    probability &&
    (probability.away !== null || probability.home !== null) &&
    (probability.away !== undefined || probability.home !== undefined) &&
    awayName &&
    homeName
  ) {
    return [
      probability.away !== null && probability.away !== undefined ? `${awayName}: ${formatPercent(probability.away)}` : "",
      probability.home !== null && probability.home !== undefined ? `${homeName}: ${formatPercent(probability.home)}` : "",
    ].filter(Boolean).join(". ");
  }
  const parts = [];
  if (odds.details) parts.push(odds.details);
  if (odds.overUnder) parts.push(`O/U ${odds.overUnder}`);
  return parts.slice(0, 2).join(", ");
}

function conciseStoryline(summary, event) {
  const competitors = summary?.competitors || [];
  const away = competitors.find((entry) => entry.homeAway === "away") || competitors[0] || event?.away;
  const home = competitors.find((entry) => entry.homeAway === "home") || competitors[1] || event?.home;
  const matchup = [teamLabel(away), teamLabel(home)].filter(Boolean).join(" at ");
  const venue = summary?.gameInfo?.venue?.name || event?.venue || "";
  const broadcasts = (summary?.broadcasts || []).map((item) => item.name || item.shortName).filter(Boolean).slice(0, 2).join(", ");
  const injuries = groupedInjuryLines(summary?.injuries || []);
  const odds = conciseOdds(summary?.odds, away, home);
  return [
    matchup ? `${matchup}.` : "",
    venue ? `From ${venue}.` : "",
    broadcasts ? `TV: ${broadcasts}.` : "",
    odds ? `Odds: ${odds}.` : "",
    ...injuries,
  ].filter(Boolean).join("\n\n");
}

function espnEventStart(event = {}) {
  const parsed = Date.parse(event.date || "");
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

export function parseNflM3uTitle(sourceTitle = "", nowDate = new Date()) {
  const title = String(sourceTitle || "").trim();
  if (!/\bNFL\b/i.test(title)) return null;
  const afterDash = title.includes("-") ? title.split("-").slice(1).join("-").trim() : title;
  const match = afterDash.match(/^(?:(TNF|SNF|MNF|Sun(?:day)?|Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:r|rs|rsday|sday)?|Fri(?:day)?|Sat(?:urday)?)\s+)?(\d{1,2}(?::\d{2})?\s*[ap]m)\s+(.+)$/i);
  if (!match) return null;
  const startAt = inferKickoffEpoch({ dayToken: match[1], timeToken: match[2], nowDate });
  if (!startAt) return null;
  const matchup = match[3].trim();
  const displayTitle = displayMatchup(matchup);
  return {
    title: displayTitle,
    subtitle: "NFL Football",
    description: `${displayTitle}. Kickoff window starts ${formatMapperDateTime(startAt)}.`,
    category: "Sports",
    startAt,
    endAt: startAt + config.nflMapperDurationSeconds,
  };
}

function localNflChannels() {
  return db
    .prepare(
      `
      SELECT id, tvg_id, name, logo, group_name, source_title
      FROM channels
      WHERE source_title LIKE '%NFL%'
         OR name LIKE '%NFL%'
         OR group_name LIKE '%NFL%'
      ORDER BY channel_sort IS NULL, channel_sort, name COLLATE NOCASE
    `,
    )
    .all();
}

async function fetchSourceText() {
  if (!config.nflMapperSourceUrl) return "";
  const response = await fetch(config.nflMapperSourceUrl, { headers: { "User-Agent": "ShareTV NFL EPG mapper/0.1" } });
  if (!response.ok) throw new Error(`NFL mapper source failed: ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const inflated = config.nflMapperSourceUrl.endsWith(".gz") || (buffer[0] === 0x1f && buffer[1] === 0x8b)
    ? gunzipSync(buffer)
    : buffer;
  return inflated.toString("utf8");
}

function normalizeGanjaProgram(program, channelName, slot) {
  const title = xmlText(asArray(program.title)[0]) || "NFL Football";
  if (isNoiseProgram(title)) return null;
  const startAt = parseXmltvTime(program["@_start"]);
  if (!startAt) return null;
  const description = xmlText(asArray(program.desc)[0]);
  const cleanTitle = stripNflPrefix(title) || title;
  if (isEmptySlotTitle(cleanTitle)) return null;
  const displayTitle = displayMatchup(cleanTitle);
  const subtitle = xmlText(asArray(program["sub-title"])[0]) || "NFL Football";
  const icon = asArray(program.icon)[0]?.["@_src"] || "";
  return {
    source: "ganja",
    slot,
    channelName,
    title: displayTitle,
    subtitle,
    description: description && !isNoiseProgram(description) ? description : `${displayTitle}. Kickoff window starts ${formatMapperDateTime(startAt)}.`,
    category: xmlText(asArray(program.category)[0]) || "Sports",
    icon,
    startAt,
    endAt: startAt + config.nflMapperDurationSeconds,
  };
}

async function enrichGameProgram(program) {
  if (!program?.title || program.source?.startsWith("generated-")) return program;
  const cacheKey = `${ESPN_ENRICHMENT_CACHE_VERSION}:${program.startAt}:${program.title}`;
  const cached = enrichmentCache.get(cacheKey);
  const current = Math.floor(Date.now() / 1000);
  if (cached && cached.expiresAt > current) return { ...program, ...cached.patch };

  try {
    const searchStart = program.startAt - 7 * 24 * 60 * 60;
    const searchEnd = program.startAt + 7 * 24 * 60 * 60;
    const { games } = await searchEspnGames({
      league: "nfl",
      q: program.title,
      start: searchStart,
      end: searchEnd,
      ttlSeconds: ESPN_ENRICHMENT_CACHE_SECONDS,
    });
    const event = games.find((game) => matchupMatches(program.title, game));
    if (!event?.id) throw new Error("No matching ESPN event");
    const result = await getEspnGameSummary({ league: "nfl", eventId: event.id });
    const summary = result.summary || {};
    const startAt = espnEventStart(event) || espnEventStart(summary) || program.startAt;
    const description = conciseStoryline(summary, event) || program.description;
    const patch = {
      title: event.name || event.shortName || program.title,
      description,
      icon: program.icon || event.away?.logo || event.home?.logo || "",
      startAt,
      endAt: startAt + config.nflMapperDurationSeconds,
      espnEventId: event.id,
      espnName: event.name,
      espnCache: result.cache,
      scheduleSource: "espn",
    };
    enrichmentCache.set(cacheKey, { expiresAt: current + ESPN_ENRICHMENT_CACHE_SECONDS, patch });
    return { ...program, ...patch };
  } catch (error) {
    enrichmentCache.set(cacheKey, {
      expiresAt: current + ESPN_ENRICHMENT_CACHE_SECONDS,
      patch: {
        enrichmentError: error.message,
      },
    });
    return program;
  }
}

async function ganjaPrograms() {
  const current = Math.floor(Date.now() / 1000);
  if (sourceCache.fetchedAt && sourceCache.fetchedAt + config.nflMapperSourceCacheSeconds > current) return sourceCache;
  try {
    const text = await fetchSourceText();
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      textNodeName: "#text",
      processEntities: false,
    });
    const xml = parser.parse(text);
    const tv = xml.tv || {};
    const channelNames = new Map();
    for (const channel of asArray(tv.channel)) {
      const id = channel["@_id"];
      const names = asArray(channel["display-name"]).map(xmlText).filter(Boolean);
      if (id) channelNames.set(id, names[0] || id);
    }
    const programs = asArray(tv.programme)
      .map((program) => {
        const channelKey = program["@_channel"] || "";
        const channelName = channelNames.get(channelKey) || channelKey;
        const slot = extractNflSlot(channelName) || extractNflSlot(channelKey) || extractNflSlot(xmlText(asArray(program.title)[0]));
        if (!slot) return null;
        return normalizeGanjaProgram(program, channelName, slot);
      })
      .filter(Boolean)
      .filter((program) => program.endAt >= current - 12 * 60 * 60 && program.startAt <= current + 14 * 24 * 60 * 60)
      .sort((a, b) => a.startAt - b.startAt);
    sourceCache = { fetchedAt: current, programs, error: "" };
  } catch (error) {
    sourceCache = { ...sourceCache, fetchedAt: current, error: error.message };
  }
  return sourceCache;
}

function fallbackProgramForChannel(row, nowDate) {
  return parseNflM3uTitle(row.source_title || row.name, nowDate);
}

function makeGuideProgram({ title, subtitle = "NFL Football", description, startAt, endAt, slot, source, channelName, icon = "" }) {
  return {
    title,
    subtitle,
    description,
    category: "Sports",
    startAt,
    endAt,
    slot,
    source,
    channelName,
    icon,
  };
}

function mergeGamePrograms(sourcePrograms, fallbackPrograms = []) {
  const byStartAndTitle = new Map();
  for (const program of [...sourcePrograms, ...fallbackPrograms].filter(Boolean)) {
    const key = `${program.startAt}:${program.title}`;
    if (!byStartAndTitle.has(key)) byStartAndTitle.set(key, program);
  }
  return [...byStartAndTitle.values()].sort((a, b) => a.startAt - b.startAt);
}

function alignSourceProgramsToLocalSchedule(sourcePrograms, fallback) {
  if (!fallback) return sourcePrograms;
  const aligned = sourcePrograms.flatMap((program) => {
    if (!sameMatchup(program.title, fallback.title)) return [];
    return {
      ...program,
      title: fallback.title,
      startAt: fallback.startAt,
      endAt: fallback.endAt,
      description: program.description && program.description !== program.title ? program.description : fallback.description,
      scheduleSource: "m3u-title",
    };
  });
  const hasMatchedSource = aligned.some((program) => sameMatchup(program.title, fallback.title));
  return hasMatchedSource ? aligned : [...aligned, fallback];
}

function nextGameDescription(games, dayEnd) {
  const nextGame = games.find((game) => game.startAt >= dayEnd);
  if (!nextGame) return "No game today. No upcoming game found for this channel yet.";
  return `No game today. Next game: ${nextGame.title} on ${formatMapperDateTime(nextGame.startAt)}.`;
}

function addFiller(programs, { startAt, endAt, slot, channelName }) {
  if (endAt <= startAt) return;
  programs.push(makeGuideProgram({
    title: "No Event",
    subtitle: "NFL Sunday Ticket",
    description: "No NFL event scheduled on this channel right now.",
    startAt,
    endAt,
    slot,
    source: "generated-filler",
    channelName,
  }));
}

function expandedDailyPrograms(games, { slot, channelName, nowDate }) {
  const programs = [];
  const gamesByDay = new Map();
  for (const game of games) {
    const key = localDayKey(game.startAt);
    if (!gamesByDay.has(key)) gamesByDay.set(key, []);
    gamesByDay.get(key).push(game);
  }

  for (let dayIndex = 0; dayIndex < GENERATED_DAYS; dayIndex += 1) {
    const parts = localDayParts(nowDate, dayIndex);
    const dayStart = localDayStart(parts);
    const dayEnd = localDayStart(addDaysToZonedDate(parts, 1));
    const dayGames = (gamesByDay.get(localDayKey(dayStart)) || []).sort((a, b) => a.startAt - b.startAt);

    if (!dayGames.length) {
      programs.push(makeGuideProgram({
        title: "No Game Today",
        subtitle: "NFL Sunday Ticket",
        description: nextGameDescription(games, dayEnd),
        startAt: dayStart,
        endAt: dayEnd,
        slot,
        source: "generated-empty-day",
        channelName,
      }));
      continue;
    }

    let cursor = dayStart;
    for (const game of dayGames) {
      const pregameStart = Math.max(dayStart, game.startAt - PREGAME_SECONDS);
      const gameStart = Math.max(dayStart, game.startAt);
      const gameEnd = Math.min(dayEnd, game.endAt);
      const postgameEnd = Math.min(dayEnd, gameEnd + POSTGAME_SECONDS);
      addFiller(programs, { startAt: cursor, endAt: pregameStart, slot, channelName });
      if (gameStart > pregameStart) {
        programs.push(makeGuideProgram({
          ...game,
          title: `Pregame: ${game.title}`,
          subtitle: "NFL Pregame",
          description: [`Pregame coverage for ${game.title}.`, game.description].filter(Boolean).join(" "),
          startAt: pregameStart,
          endAt: gameStart,
          source: "generated-pregame",
        }));
      }
      programs.push(makeGuideProgram({
        ...game,
        title: game.title,
        subtitle: game.subtitle || "NFL Football",
        description: game.description || game.title,
        startAt: gameStart,
        endAt: gameEnd,
      }));
      if (postgameEnd > gameEnd) {
        programs.push(makeGuideProgram({
          ...game,
          title: `Postgame: ${game.title}`,
          subtitle: "NFL Postgame",
          description: [`Postgame coverage for ${game.title}.`, game.description].filter(Boolean).join(" "),
          startAt: gameEnd,
          endAt: postgameEnd,
          source: "generated-postgame",
        }));
      }
      cursor = postgameEnd;
    }
    addFiller(programs, { startAt: cursor, endAt: dayEnd, slot, channelName });
  }

  return programs.filter((program) => program.endAt > program.startAt);
}

export async function generatedNflMappings() {
  const rows = localNflChannels();
  const nowDate = new Date();
  const source = await ganjaPrograms();
  return Promise.all(rows.map(async (row) => {
    const channelId = row.tvg_id || `sharetv-channel-${row.id}`;
    const slot = extractNflSlot(row.source_title) || extractNflSlot(row.name) || extractNflSlot(row.tvg_id);
    const sourcePrograms = slot ? source.programs.filter((program) => program.slot === slot) : [];
    const fallback = fallbackProgramForChannel(row, nowDate);
    const scheduledPrograms = fallback
      ? alignSourceProgramsToLocalSchedule(sourcePrograms, { ...fallback, source: "m3u-title", slot })
      : sourcePrograms.flatMap((program) => {
          // A bare local slot can still have a matchup in the source feed.
          // Its XMLTV rows repeat through the day, so infer kickoff from the
          // source label and require ESPN confirmation before publishing it.
          const sourceSchedule = parseNflM3uTitle(program.channelName, nowDate);
          if (!sourceSchedule || !sameMatchup(program.title, sourceSchedule.title)) return [];
          return { ...program, ...sourceSchedule, slot, source: "ganja" };
        });
    const enrichedGames = await Promise.all(
      mergeGamePrograms(scheduledPrograms)
        .map((program) => enrichGameProgram(program)),
    );
    const games = fallback ? enrichedGames : enrichedGames.filter((program) => program.espnEventId);
    const programs = slot ? expandedDailyPrograms(games, { slot, channelName: row.name, nowDate }) : [];
    return {
      channel: {
        id: row.id,
        channelId,
        tvgId: row.tvg_id || "",
        name: row.name,
        logo: row.logo || "",
        groupName: row.group_name || "",
        sourceTitle: row.source_title || "",
        slot,
      },
      programs,
      program: programs[0] || null,
      parsed: programs.length > 0,
      sourceError: source.error,
    };
  }));
}

export async function generatedNflXmltv() {
  const mappings = (await generatedNflMappings()).filter((mapping) => mapping.parsed);
  const channels = [];
  const programmes = [];
  for (const mapping of mappings) {
    const row = mapping.channel;
    const channelId = row.channelId;
    channels.push({ ...row, channelId });
    for (const parsed of mapping.programs) programmes.push({ ...parsed, channelId });
  }

  const channelXml = channels.map((channel) => [
    `  <channel id="${escapeXml(channel.channelId)}">`,
    `    <display-name>${escapeXml(channel.name)}</display-name>`,
    channel.logo ? `    <icon src="${escapeXml(channel.logo)}" />` : "",
    "  </channel>",
  ].filter(Boolean).join("\n"));
  const programmeXml = programmes.map((program) => [
    `  <programme channel="${escapeXml(program.channelId)}" start="${xmltvStamp(program.startAt)}" stop="${xmltvStamp(program.endAt)}">`,
    `    <title>${escapeXml(program.title)}</title>`,
    `    <sub-title>${escapeXml(program.subtitle)}</sub-title>`,
    `    <desc>${escapeXml(program.description)}</desc>`,
    `    <category>${escapeXml(program.category)}</category>`,
    program.icon ? `    <icon src="${escapeXml(program.icon)}" />` : "",
    "  </programme>",
  ].filter(Boolean).join("\n"));

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<tv generator-info-name="ShareTV NFL M3U Mapper">',
    ...channelXml,
    ...programmeXml,
    "</tv>",
    "",
  ].join("\n");
}

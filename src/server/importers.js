import fs from "node:fs/promises";
import { XMLParser } from "fast-xml-parser";
import { config } from "./config.js";
import { db } from "./db.js";

const attrPattern = /([\w-]+)="([^"]*)"/g;

function now() {
  return Math.floor(Date.now() / 1000);
}

function firstAttr(attrs, keys) {
  for (const key of keys) {
    const value = attrs[key];
    if (value && String(value).trim()) return String(value).trim();
  }
  return "";
}

function parseChannelSort(channelNumber, playlistIndex) {
  const match = String(channelNumber || "").match(/\d+(?:\.\d+)?/);
  if (!match) return 100000000 + playlistIndex;
  return Math.round(Number(match[0]) * 1000);
}

async function readUrlOrFile(source) {
  if (source.startsWith("http://") || source.startsWith("https://")) {
    const response = await fetch(source, { headers: { "User-Agent": "iptv-share/0.2" } });
    if (!response.ok) throw new Error(`Could not fetch ${source}: ${response.status}`);
    return response.text();
  }
  return fs.readFile(source, "utf8");
}

export function parseM3u(text) {
  const channels = [];
  let current = null;
  let playlistIndex = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#EXTINF")) {
      const attrs = {};
      for (const match of line.matchAll(attrPattern)) attrs[match[1]] = match[2];
      const name = line.includes(",") ? line.split(",").pop().trim() : attrs["tvg-name"] || "Channel";
      const channelNumber = firstAttr(attrs, ["tvg-chno", "tvg-ch", "tvg-number", "tvg-no", "channel-number", "ch-number"]);
      current = {
        tvgId: attrs["tvg-id"] || attrs["channel-id"] || name,
        name: attrs["tvg-name"] || name,
        logo: attrs["tvg-logo"] || "",
        groupName: attrs["group-title"] || "Other",
        channelNumber,
        channelSort: parseChannelSort(channelNumber, playlistIndex),
      };
    } else if (current && !line.startsWith("#")) {
      channels.push({ ...current, streamUrl: line });
      playlistIndex += 1;
      current = null;
    }
  }
  return channels;
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

export function parseXmltvTime(value) {
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

export async function refreshSources() {
  try {
    const refreshMarker = Date.now();
    const refreshedAt = now();
    const [m3uText, epgText] = await Promise.all([readUrlOrFile(config.m3uUrl), readUrlOrFile(config.epgUrl)]);
    const channels = parseM3u(m3uText);
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      textNodeName: "#text",
      processEntities: false,
    });
    const xml = parser.parse(epgText);
    const tv = xml.tv || {};
    const xmlChannels = asArray(tv.channel);
    const programs = asArray(tv.programme);

    const tx = db.transaction(() => {
      const channelByKey = new Map();
      const channelByName = new Map();
      const insertChannel = db.prepare(`
        INSERT INTO channels(tvg_id, name, logo, group_name, channel_number, channel_sort, stream_url, updated_at)
        VALUES (@tvgId, @name, @logo, @groupName, @channelNumber, @channelSort, @streamUrl, @updatedAt)
        ON CONFLICT(tvg_id) DO UPDATE SET
          name = excluded.name,
          logo = excluded.logo,
          group_name = excluded.group_name,
          channel_number = excluded.channel_number,
          channel_sort = excluded.channel_sort,
          stream_url = excluded.stream_url,
          updated_at = excluded.updated_at
      `);
      for (const channel of channels) {
        insertChannel.run({ ...channel, updatedAt: refreshMarker });
      }

      db.prepare("DELETE FROM channels WHERE updated_at != ?").run(refreshMarker);

      for (const row of db.prepare("SELECT id, tvg_id, name FROM channels").all()) {
        if (row.tvg_id) channelByKey.set(row.tvg_id, row.id);
        channelByName.set(row.name.toLowerCase(), row.id);
      }

      const xmltvNames = new Map();
      for (const channel of xmlChannels) {
        const id = channel["@_id"];
        const display = xmlText(asArray(channel["display-name"])[0]);
        if (id && display) xmltvNames.set(id, display);
      }

      const upsertProgram = db.prepare(`
        INSERT INTO epg_programs(channel_key, channel_id, title, subtitle, description, category, icon, start_at, end_at, updated_at)
        VALUES (@channelKey, @channelId, @title, @subtitle, @description, @category, @icon, @startAt, @endAt, @updatedAt)
        ON CONFLICT(channel_key, start_at, end_at, title) DO UPDATE SET
          channel_id = excluded.channel_id,
          subtitle = excluded.subtitle,
          description = excluded.description,
          category = excluded.category,
          icon = excluded.icon,
          updated_at = excluded.updated_at
      `);
      for (const program of programs) {
        const channelKey = program["@_channel"];
        const title = xmlText(asArray(program.title)[0]) || "Untitled";
        const startAt = parseXmltvTime(program["@_start"]);
        const endAt = parseXmltvTime(program["@_stop"]);
        if (!channelKey || !startAt || !endAt) continue;
        const xmlName = xmltvNames.get(channelKey);
        const channelId = channelByKey.get(channelKey) || (xmlName ? channelByName.get(xmlName.toLowerCase()) : null);
        if (!channelId) continue;
        const icon = asArray(program.icon)[0]?.["@_src"] || "";
        upsertProgram.run({
          channelKey,
          channelId,
          title,
          subtitle: xmlText(asArray(program["sub-title"])[0]),
          description: xmlText(asArray(program.desc)[0]),
          category: xmlText(asArray(program.category)[0]),
          icon,
          startAt,
          endAt,
          updatedAt: refreshMarker,
        });
      }

      db.prepare("DELETE FROM epg_programs WHERE updated_at != ?").run(refreshMarker);
      db.prepare("UPDATE refresh_state SET last_refresh_at = ?, last_error = NULL WHERE id = 1").run(refreshedAt);
    });
    tx();
  } catch (error) {
    db.prepare("UPDATE refresh_state SET last_error = ? WHERE id = 1").run(error.message);
    throw error;
  }
}

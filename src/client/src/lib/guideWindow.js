export const GUIDE_ROW_HEIGHT = 72;
export const GUIDE_HEADER_HEIGHT = 48;
export const GUIDE_HOUR_WIDTH = 300;
export const GUIDE_CANVAS_HOURS = 96;
export const GUIDE_BLOCK_SECONDS = 6 * 3600;
export const GUIDE_CHANNEL_BATCH = 32;
export const GUIDE_CACHE_LIMIT = 64;

export function guideViewport({ left, top, width, height, start, channelWidth, count }) {
  const first = Math.max(0, Math.floor((top - GUIDE_HEADER_HEIGHT) / GUIDE_ROW_HEIGHT) - 3);
  const last = Math.min(count, Math.ceil((top + height - GUIDE_HEADER_HEIGHT) / GUIDE_ROW_HEIGHT) + 3);
  return {
    first, last,
    start: Math.floor(start + left * 3600 / GUIDE_HOUR_WIDTH),
    end: Math.ceil(start + (left + Math.max(1, width - channelWidth)) * 3600 / GUIDE_HOUR_WIDTH),
  };
}

export function guideCanvasPosition(time) {
  const start = Math.floor(time / 3600) * 3600 - GUIDE_CANVAS_HOURS / 2 * 3600;
  return { start, left: (time - start) * GUIDE_HOUR_WIDTH / 3600 };
}

export function guideRequests(channels, viewport) {
  if (!viewport?.channelIds.length) return [];
  const indices = new Map(channels.map((channel, index) => [channel.id, index]));
  const batches = new Set(viewport.channelIds.filter(id => indices.has(id)).map(id => Math.floor(indices.get(id) / GUIDE_CHANNEL_BATCH)));
  const start = Math.floor((viewport.start - 3600) / GUIDE_BLOCK_SECONDS) * GUIDE_BLOCK_SECONDS;
  const end = viewport.end + 3600;
  const requests = [];
  for (const batch of batches) {
    const ids = channels.slice(batch * GUIDE_CHANNEL_BATCH, (batch + 1) * GUIDE_CHANNEL_BATCH).map(channel => channel.id);
    for (let time = start; time < end; time += GUIDE_BLOCK_SECONDS) {
      requests.push({ key: `${ids.join(',')}:${time}`, ids, start: time, end: time + GUIDE_BLOCK_SECONDS });
    }
  }
  return requests;
}

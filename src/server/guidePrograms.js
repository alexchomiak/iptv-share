export function loadGuidePrograms(db, start, end, channelIds) {
  let ids = null;
  if (channelIds !== undefined) {
    if (typeof channelIds !== 'string' || !/^\d+(,\d+)*$/.test(channelIds)) throw new Error('Invalid channelIds');
    ids = [...new Set(channelIds.split(',').map(Number))];
    if (ids.length > 64 || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('Invalid channelIds');
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 24 * 3600) throw new Error('Invalid guide window');
  }
  return db.prepare(`SELECT epg_programs.*, channels.name AS channel_name
    FROM epg_programs LEFT JOIN channels ON channels.id = epg_programs.channel_id
    WHERE end_at > ? AND start_at < ?
      ${ids ? `AND epg_programs.channel_id IN (${ids.map(() => '?').join(',')})` : ''}
    ORDER BY start_at`).all(start, end, ...(ids || []));
}

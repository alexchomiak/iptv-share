export function buildScheduleEvents({ programs, channel, start, end, title = '', espn = null, league = '' }) {
  if (programs.length) return programs.map(program => ({ programId: program.id, espn }));
  if (!channel?.id) throw new Error('Choose a channel or programme first.');
  if (espn) {
    const kickoff = Math.floor(Date.parse(espn.date || '') / 1000);
    if (!Number.isFinite(kickoff)) throw new Error('The selected ESPN game has no valid kickoff time.');
    const hours = ['nba', 'ncaamb'].includes(league) ? 3 : 4;
    return [{ channelId: channel.id, title: espn.name || espn.shortName || title.trim() || channel.name,
      description: espn.shortName ? `Linked ESPN game: ${espn.shortName}` : '',
      startsAt: kickoff, endsAt: kickoff + hours * 3600, espn }];
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new Error('End time must be after start time.');
  return [{ channelId: channel.id, title: title.trim() || channel.name, startsAt: start, endsAt: end, espn: null }];
}

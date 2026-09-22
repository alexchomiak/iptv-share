export function findActiveShareProgram(db, shareId, graceSeconds, currentTime) {
  return db
    .prepare(
      `
      SELECT
        epg_programs.*,
        epg_programs.start_at AS starts_at,
        epg_programs.end_at AS ends_at,
        channels.stream_url
      FROM share_link_items
      JOIN epg_programs ON epg_programs.id = share_link_items.program_id
      JOIN channels ON channels.id = epg_programs.channel_id
      WHERE share_link_items.share_id = ?
        AND epg_programs.start_at - ? <= ?
        AND ? <= epg_programs.end_at + ?
      ORDER BY
        CASE WHEN epg_programs.start_at <= ? AND ? < epg_programs.end_at THEN 0 ELSE 1 END,
        epg_programs.start_at DESC
      LIMIT 1
    `,
    )
    .get(shareId, graceSeconds, currentTime, currentTime, graceSeconds, currentTime, currentTime);
}

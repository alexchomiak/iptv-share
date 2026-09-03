import { useState } from "react";
import { eventEnd, eventStart, formatDateTime } from "../../lib/time.js";
import SportsPanel from "./SportsPanel.jsx";

function orderedCompetitors(summary) {
  return [...(summary?.competitors || [])].sort((a, b) => {
    if (a.homeAway === b.homeAway) return 0;
    return a.homeAway === "away" ? -1 : 1;
  });
}

function teamRecord(entry) {
  return entry?.record || entry?.records?.find((item) => item.type === "total")?.summary || entry?.records?.[0]?.summary || "";
}

function ArchiveTeam({ entry, align = "left" }) {
  if (!entry) return <div className={`archiveTeam ${align}`} />;
  return (
    <div className={`archiveTeam ${align}`}>
      {entry.team?.logo && <img src={entry.team.logo} alt="" />}
      <span>
        <strong>{entry.team?.name || entry.team?.abbreviation || "Team"}</strong>
        {teamRecord(entry) && <small>{teamRecord(entry)}</small>}
      </span>
      <b>{entry.score ?? "-"}</b>
    </div>
  );
}

function PastGames({ games = [], admin = false, onDeleteGame }) {
  const [openGameId, setOpenGameId] = useState(null);
  if (!games.length) return null;

  return (
    <section className="pastGames">
      <div className="pastGamesHeader">
        <h2>Past Games</h2>
        <p>{games.length} archived</p>
      </div>
      {games.map((game) => {
        const open = openGameId === game.id;
        const summary = game.final_summary;
        const competitors = orderedCompetitors(summary);
        const away = competitors.find((entry) => entry.homeAway === "away") || competitors[0];
        const home = competitors.find((entry) => entry.homeAway === "home") || competitors[1];
        const title = summary?.shortName || game.espn_short_name || game.title;
        const status = summary?.statusDetail || summary?.status || "Final";
        return (
          <article key={game.id} className="pastGameCard">
            <div className="pastGameCardTop">
              <button type="button" onClick={() => setOpenGameId(open ? null : game.id)}>
                {away || home ? (
                  <div className="archiveScoreRow">
                    <ArchiveTeam entry={away} />
                    <div className="archiveGameMeta">
                      <strong>{status}</strong>
                      <small>{formatDateTime.format(new Date(eventStart(game) * 1000))}</small>
                    </div>
                    <ArchiveTeam entry={home} align="right" />
                  </div>
                ) : (
                  <div className="archiveFallbackRow">
                    {game.icon_url && <img src={game.icon_url} alt="" />}
                    <span>
                      <strong>{title}</strong>
                      <small>{formatDateTime.format(new Date(eventStart(game) * 1000))} - {formatDateTime.format(new Date(eventEnd(game) * 1000))}</small>
                    </span>
                  </div>
                )}
                <div className="archiveSummaryRow">
                  <span>
                    <strong>{title}</strong>
                    {game.description && <small>{game.description}</small>}
                  </span>
                  <b>{open ? "Hide Box Score" : "View Box Score"}</b>
                </div>
              </button>
              {admin && (
                <button type="button" className="danger archiveDeleteButton" onClick={() => onDeleteGame?.(game.id)}>
                  Remove Archive
                </button>
              )}
            </div>
            {open && (
              summary
                ? <SportsPanel summary={{ ...summary, refreshSeconds: 0, fetchedAt: game.espn_final_fetched_at }} hideScorecard />
                : <p className="emptyState">No final box score was captured for this game.</p>
            )}
          </article>
        );
      })}
    </section>
  );
}

export default PastGames;

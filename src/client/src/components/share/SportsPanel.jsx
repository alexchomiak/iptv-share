import React, { useEffect, useState } from "react";

const playTimestampFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  month: "2-digit",
  day: "2-digit",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

function SportsPanel({ summary, message, hideScorecard = false }) {
  if (message && !summary) return <section className="sportsPanel"><p>{message}</p></section>;
  if (summary?.sport === "baseball" || summary?.league === "mlb") return <BaseballPanel summary={summary} hideScorecard={hideScorecard} />;
  return <FootballPanel summary={summary} hideScorecard={hideScorecard} />;
}

function useRelativeTimeTick() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);
}

function FootballPanel({ summary, hideScorecard = false }) {
  const playerGroups = summary?.boxscore?.players || [];
  const competitors = [...(summary?.competitors || [])].sort((a, b) => {
    if (a.homeAway === b.homeAway) return 0;
    return a.homeAway === "away" ? -1 : 1;
  });
  const away = competitors.find((entry) => entry.homeAway === "away") || competitors[0];
  const home = competitors.find((entry) => entry.homeAway === "home") || competitors[1];
  const periodLabels = getPeriodLabels(summary, competitors);

  return (
    <section className="sportsPanel">
      {!hideScorecard && (
        <div className="footballScorecard">
          <ScoreTeamSide entry={away} side="away" compact />
          <b className="footballCenterScore">{away?.score ?? "-"}</b>
          <FootballLineScore summary={summary} away={away} home={home} periodLabels={periodLabels} />
          <b className="footballCenterScore">{home?.score ?? "-"}</b>
          <ScoreTeamSide entry={home} side="home" compact />
        </div>
      )}
      <RefreshNote seconds={summary.refreshSeconds} fetchedAt={summary.fetchedAt} spoilerDelaySeconds={summary.spoilerDelaySeconds} />
      <WinProbabilityPanel summary={summary} away={away} home={home} />
      {playerGroups.length > 0 && (
        <div className="footballBoxscore">
          {[away, home].filter(Boolean).map((entry) => {
            const teamStats = playerGroups.find((team) => String(team.team?.id) === String(entry.team?.id))
              || playerGroups.find((team) => team.team?.abbreviation === entry.team?.abbreviation);
            return <FootballTeamBox key={entry.id || entry.team?.abbreviation} competitor={entry} teamStats={teamStats} />;
          })}
        </div>
      )}
    </section>
  );
}

function FootballLineScore({ summary, away, home, periodLabels }) {
  return (
    <div className="gameCenter">
      <span>{gameStatusText(summary)}</span>
      <div className="lineScoreTable" style={{ gridTemplateColumns: `34px repeat(${periodLabels.length}, 26px)` }}>
        <div />
        {periodLabels.map((period) => <b key={period}>{period}</b>)}
        {[away, home].filter(Boolean).map((entry) => (
          <React.Fragment key={entry.id || entry.team?.abbreviation}>
            <strong>{entry.team?.abbreviation || entry.team?.name}</strong>
            {periodLabels.map((_period, index) => (
              <span key={index}>{entry.linescores?.[index]?.value ?? entry.linescores?.[index]?.displayValue ?? "-"}</span>
            ))}
          </React.Fragment>
        ))}
      </div>
      {summary.clock && <small>{summary.clock}</small>}
    </div>
  );
}

function BaseballPanel({ summary, hideScorecard = false }) {
  const playerGroups = summary?.boxscore?.players || [];
  const competitors = [...(summary?.competitors || [])].sort((a, b) => {
    if (a.homeAway === b.homeAway) return 0;
    return a.homeAway === "away" ? -1 : 1;
  });
  const away = competitors.find((entry) => entry.homeAway === "away") || competitors[0];
  const home = competitors.find((entry) => entry.homeAway === "home") || competitors[1];
  const teamTotals = summary?.boxscore?.teams || [];
  const maxInnings = Math.max(9, ...competitors.map((entry) => entry.linescores?.length || 0), Number(summary?.period || 0));
  const inningLabels = Array.from({ length: maxInnings }, (_item, index) => String(index + 1));
  const displaySituation = baseballDisplaySituation(summary);

  return (
    <section className="sportsPanel baseballPanel">
      {!hideScorecard && (
        <div className="baseballScorecard">
          <ScoreTeamSide entry={away} side="away" />
          <div className="baseballGameCenter">
            <span>{gameStatusText(summary)}</span>
            {displaySituation && !isFinalSummary(summary) && (
              <small>{baseballSituationText(displaySituation)}</small>
            )}
            {summary.clock && <small>{summary.clock}</small>}
          </div>
          <ScoreTeamSide entry={home} side="home" />
        </div>
      )}
      <div className="baseballLineScore">
        <div
          className="lineScoreTable baseballLines"
          style={{ gridTemplateColumns: `54px repeat(${inningLabels.length}, minmax(28px, 1fr)) repeat(3, 34px)` }}
        >
          <div />
          {inningLabels.map((inning) => <b key={inning}>{inning}</b>)}
          <b>R</b>
          <b>H</b>
          <b>E</b>
          {[away, home].filter(Boolean).map((entry) => (
            <React.Fragment key={entry.id || entry.team?.abbreviation}>
              <strong>{entry.team?.abbreviation || entry.team?.name}</strong>
              {inningLabels.map((_inning, index) => (
                <span key={index}>{baseballLineScoreValue(entry, index, summary)}</span>
              ))}
              <b>{entry.score ?? "-"}</b>
              <b>{getBaseballTotal(teamTotals, entry, "hits")}</b>
              <b>{getBaseballTotal(teamTotals, entry, "errors")}</b>
            </React.Fragment>
          ))}
        </div>
      </div>
      <RefreshNote seconds={summary.refreshSeconds} fetchedAt={summary.fetchedAt} spoilerDelaySeconds={summary.spoilerDelaySeconds} />
      {playerGroups.length > 0 && (
        <div className="baseballBoxscore">
          {[away, home].filter(Boolean).map((entry) => {
            const teamStats = playerGroups.find((team) => String(team.team?.id) === String(entry.team?.id))
              || playerGroups.find((team) => team.team?.abbreviation === entry.team?.abbreviation);
            const totals = teamTotals.find((item) => String(item.team?.id) === String(entry.team?.id))
              || teamTotals.find((item) => item.team?.abbreviation === entry.team?.abbreviation);
            return <BaseballTeamBox key={entry.id || entry.team?.abbreviation} competitor={entry} teamStats={teamStats} teamTotals={totals} />;
          })}
        </div>
      )}
      <BaseballExtras summary={summary} away={away} home={home} />
    </section>
  );
}

function BaseballExtras({ summary, away, home }) {
  const scoring = summary?.scoringSummary || [];
  const plays = summary?.recentPlays || [];
  const broadcasts = summary?.broadcasts || [];
  const videos = summary?.videos || [];
  const gameInfo = summary?.gameInfo || {};
  const hasInfo = gameInfo.venue?.name || gameInfo.weather || broadcasts.length > 0;
  const hasWinProbability = Boolean((summary?.winProbability?.series || []).length || summary?.odds?.impliedWinProbability);
  const hasAside = hasWinProbability || hasInfo || videos.length > 0;
  if (!scoring.length && !plays.length && !hasAside) return null;
  return (
    <div className={hasAside ? "baseballExtras" : "baseballExtras single"}>
      <div className="baseballExtrasMain">
        {plays.length > 0 && (
          <section className="sportsSubpanel">
            <div className="sportsSubpanelHeader">
              <h3>Recent Plays</h3>
            </div>
            <div className="recentPlaysList">
              {plays.map((play) => <PlayRow key={play.id || `${play.wallclock}-${play.text}`} play={play} away={away} home={home} />)}
            </div>
          </section>
        )}
        {scoring.length > 0 && (
          <section className="sportsSubpanel">
            <div className="sportsSubpanelHeader">
              <h3>Scoring Summary</h3>
            </div>
            <div className="scoringSummaryList">
              {scoring.map((play) => <PlayRow key={play.id || `${play.period?.number}-${play.text}`} play={play} away={away} home={home} />)}
            </div>
          </section>
        )}
      </div>
      {hasAside && (
        <aside className="baseballExtrasAside">
          {hasWinProbability && <WinProbabilityPanel summary={summary} away={away} home={home} />}
          {hasInfo && (
            <section className="sportsSubpanel gameInfoPanel">
              <div className="sportsSubpanelHeader">
                <h3>Game Info</h3>
              </div>
              <div className="gameInfoGrid">
                {gameInfo.venue?.name && (
                  <div>
                    {gameInfo.venue.image && <img src={gameInfo.venue.image} alt="" />}
                    <b>{gameInfo.venue.name}</b>
                    <span>{[gameInfo.venue.city, gameInfo.venue.state].filter(Boolean).join(", ")}</span>
                  </div>
                )}
                {gameInfo.weather && (
                  <div>
                    <b>Weather</b>
                    <span>{[gameInfo.weather.temperature ? `${gameInfo.weather.temperature}°` : "", gameInfo.weather.condition].filter(Boolean).join(" · ")}</span>
                  </div>
                )}
                {broadcasts.length > 0 && (
                  <div>
                    <b>Broadcasts</b>
                    <span>{broadcasts.map((broadcast) => broadcast.shortName || broadcast.name).filter(Boolean).join(", ")}</span>
                  </div>
                )}
              </div>
            </section>
          )}
          {videos.length > 0 && (
            <section className="sportsSubpanel sportsVideosPanel">
              <div className="sportsSubpanelHeader">
                <h3>Highlights</h3>
              </div>
              <div className="sportsVideoGrid">
                {videos.map((video) => (
                  <a key={video.id || video.url || video.title} href={video.url || undefined} target="_blank" rel="noreferrer">
                    {video.thumbnail && <img src={video.thumbnail} alt="" />}
                    <b>{video.title}</b>
                    {video.duration && <span>{video.duration}</span>}
                  </a>
                ))}
              </div>
            </section>
          )}
        </aside>
      )}
    </div>
  );
}

function WinProbabilityPanel({ summary, away, home }) {
  const series = summary?.winProbability?.series || [];
  const implied = summary?.odds?.impliedWinProbability;
  if (!series.length && !implied) return null;
  const current = series.at(-1) || implied;
  const homeValue = percentValue(current?.home);
  const awayValue = percentValue(current?.away);
  const leader = homeValue >= awayValue ? home : away;
  const leaderValue = Math.max(homeValue, awayValue);
  const homePoints = series.length ? chartPoints(series.map((point) => percentValue(point.home))) : "";
  const awayPoints = series.length ? chartPoints(series.map((point) => percentValue(point.away))) : "";
  const periodLabels = probabilityPeriodLabels(summary, series);
  return (
    <section className="sportsSubpanel winProbabilityPanel">
      <div className="winProbabilityHeader">
        <div>
          <h3>Win Probability</h3>
          <span>{series.length ? "ESPN live probability" : "Implied from live moneyline odds"}</span>
        </div>
        <div className="winProbabilityLeader">
          {leader?.team?.logo && <img src={leader.team.logo} alt="" />}
          <b>{Number.isFinite(leaderValue) ? `${Math.round(leaderValue)}%` : "-"}</b>
        </div>
      </div>
      <div className="winProbabilityTeams">
        <span>{away?.team?.logo && <img src={away.team.logo} alt="" />} {away?.team?.abbreviation || away?.team?.name || "Away"} <b>{Number.isFinite(awayValue) ? `${awayValue.toFixed(1)}%` : "-"}</b></span>
        <span>{home?.team?.logo && <img src={home.team.logo} alt="" />} {home?.team?.abbreviation || home?.team?.name || "Home"} <b>{Number.isFinite(homeValue) ? `${homeValue.toFixed(1)}%` : "-"}</b></span>
      </div>
      {series.length > 1 && (
        <div className="winProbabilityChart">
          <svg viewBox="0 0 320 130" role="img" aria-label="Win probability chart">
            <defs>
              <linearGradient id={`wp-fill-${summary.id || "game"}`} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor="rgba(96, 165, 250, 0.34)" />
                <stop offset="1" stopColor="rgba(49, 196, 141, 0.08)" />
              </linearGradient>
            </defs>
            {[25, 50, 75].map((line) => <line key={line} x1="0" x2="320" y1={130 - line * 1.3} y2={130 - line * 1.3} className="wpGrid" />)}
            <line x1="0" x2="320" y1="65" y2="65" className="wpMidline" />
            <polyline points={`0,130 ${homePoints} 320,130`} className="wpArea" fill={`url(#wp-fill-${summary.id || "game"})`} />
            <polyline points={homePoints} className="wpLine home" />
            <polyline points={awayPoints} className="wpLine away" />
          </svg>
          {periodLabels.length > 0 && (
            <div className="winProbabilityPeriods">
              {periodLabels.map((label) => <span key={label}>{label}</span>)}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function percentValue(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(100, numeric));
}

function chartPoints(values) {
  const width = 320;
  const height = 130;
  const last = Math.max(1, values.length - 1);
  return values.map((value, index) => {
    const x = (index / last) * width;
    const y = height - percentValue(value) * (height / 100);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}

function probabilityPeriodLabels(summary, series) {
  const periods = [...new Set(series.map((point) => Number(point.period)).filter(Number.isFinite))];
  if (!periods.length) return [];
  if (summary?.sport === "baseball" || summary?.league === "mlb") return periods.map((period) => ordinal(period));
  return periods.map((period) => {
    if (period <= 4) return `${period}Q`;
    return period === 5 ? "OT" : `${period - 4}OT`;
  });
}

function ordinal(value) {
  const suffix = value % 10 === 1 && value % 100 !== 11 ? "st" : value % 10 === 2 && value % 100 !== 12 ? "nd" : value % 10 === 3 && value % 100 !== 13 ? "rd" : "th";
  return `${value}${suffix}`;
}

function PlayRow({ play, away, home }) {
  const awayLabel = away?.team?.abbreviation || "Away";
  const homeLabel = home?.team?.abbreviation || "Home";
  const period = [play.period?.type, play.period?.displayValue || play.period?.number].filter(Boolean).join(" ");
  const athletes = (play.athletes || []).filter((athlete) => athlete.name || athlete.headshot).slice(0, 3);
  return (
    <article className={play.scoringPlay ? "playRow scoring" : "playRow"}>
      <div>
        <header className="playRowHeader">
          <b>{period || play.type || "Play"}</b>
          {play.wallclock && <time>{formatPlayTimestamp(play.wallclock)}</time>}
        </header>
        {athletes.length > 0 && (
          <div className="playAthletes" aria-label="Players involved">
            {athletes.map((athlete) => (
              <span key={`${play.id}-${athlete.id || athlete.name}-${athlete.role || ""}`}>
                {athlete.headshot && <img src={athlete.headshot} alt="" loading="lazy" />}
                <small>{athlete.shortName || athlete.name}</small>
              </span>
            ))}
          </div>
        )}
        <span>{play.text}</span>
      </div>
      <strong>{play.awayScore ?? "-"}-{play.homeScore ?? "-"}</strong>
      <small>{awayLabel} @ {homeLabel}</small>
    </article>
  );
}

function formatPlayTimestamp(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "";
  return `${playTimestampFormat.format(new Date(timestamp)).replace(",", "")} CST`;
}

function RefreshNote({ seconds, fetchedAt, spoilerDelaySeconds = 0 }) {
  useRelativeTimeTick();
  const hasSpoilerDelay = Number(spoilerDelaySeconds) > 0;
  if (!seconds) {
    return <small className="sportsRefreshNote">{fetchedAt ? "Final stats captured." : "Final stats snapshot."}</small>;
  }
  if (hasSpoilerDelay) {
    const visibleAt = Number(fetchedAt || 0) + Number(spoilerDelaySeconds || 0);
    return (
      <small className="sportsRefreshNote">
        Spoiler-safe stats refresh every {formatRefreshInterval(seconds)}{fetchedAt ? ` · last updated ${formatUpdatedAgo(visibleAt)}` : ""}{fetchedAt ? "." : ""}
      </small>
    );
  }
  const mode = fetchedAt && seconds ? "Stats update" : "Stats refresh";
  return (
    <small className="sportsRefreshNote">
      {mode} every {formatRefreshInterval(seconds)}{delayText}{fetchedAt ? ` · last updated ${formatUpdatedAgo(fetchedAt)}` : ""}{fetchedAt ? "." : ""}
    </small>
  );
}

function formatRefreshInterval(seconds) {
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

function formatUpdatedAgo(value) {
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - Number(value || 0));
  if (diff < 5) return "just now";
  if (diff < 60) return `${diff} sec ago`;
  const minutes = Math.floor(diff / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hr ago`;
}

function gameStatusText(summary) {
  if (!summary) return "Game";
  if (summary.sport === "baseball" || summary.league === "mlb") {
    const livePeriod = baseballLivePeriodText(summary);
    if (livePeriod) return livePeriod;
  }
  if (summary.statusDetail && !/^scheduled/i.test(summary.statusDetail)) return summary.statusDetail;
  if (summary.shortStatusDetail && !/^scheduled/i.test(summary.shortStatusDetail)) return summary.shortStatusDetail;
  return summary.status || "Game";
}

function baseballLivePeriodText(summary) {
  if (isFinalSummary(summary)) return summary.statusDetail || summary.status || "Final";
  const statusText = summary.statusDetail || summary.shortStatusDetail || summary.status || "";
  if (isBaseballPeriodText(statusText)) return statusText;
  const lastPlayPeriod = summary.situation?.lastPlay?.period || summary.recentPlays?.[0]?.period || {};
  const periodType = lastPlayPeriod.type || summary.periodPrefix || "";
  const periodDisplay = lastPlayPeriod.displayValue || summary.displayPeriod || (summary.period ? `${summary.period}` : "");
  if (!periodType || !periodDisplay) return "";
  if (!isBaseballPeriodType(periodType)) return "";
  return `${periodType} ${periodDisplay}`;
}

function baseballDisplaySituation(summary) {
  const periodText = baseballLivePeriodText(summary);
  if (!/^top|^bottom/i.test(periodText)) return null;
  const situation = summary?.situation || {};
  const situationPeriod = situation.lastPlay?.period?.number;
  if (Number.isFinite(Number(situationPeriod)) && Number.isFinite(Number(summary?.period)) && Number(situationPeriod) < Number(summary.period)) {
    return null;
  }
  const latestPlay = summary?.recentPlays?.[0] || {};
  const hasSituation = ["outs", "balls", "strikes"].some((key) => Number.isFinite(Number(situation[key])));
  if (hasSituation) return situation;
  const pitchCount = latestPlay.pitchCount || {};
  return {
    outs: latestPlay.outs,
    balls: pitchCount.balls,
    strikes: pitchCount.strikes,
  };
}

function isBaseballPeriodText(value = "") {
  const normalized = String(value).trim().toLowerCase();
  return /^(top|bottom|middle|mid|end)\s+(\d+|[1-9]\d*(st|nd|rd|th))/.test(normalized);
}

function isBaseballPeriodType(value = "") {
  return ["top", "bottom", "middle", "mid", "end"].includes(String(value).toLowerCase());
}

function baseballSituationText(situation) {
  const parts = [];
  if (Number.isFinite(Number(situation.outs))) parts.push(`${situation.outs} out${Number(situation.outs) === 1 ? "" : "s"}`);
  if (Number.isFinite(Number(situation.balls)) && Number.isFinite(Number(situation.strikes))) {
    parts.push(`${situation.balls}-${situation.strikes}`);
  }
  return parts.join(" · ");
}

function baseballLineScoreValue(entry, index, summary) {
  const actual = entry.linescores?.[index]?.value ?? entry.linescores?.[index]?.displayValue;
  if (actual !== undefined && actual !== null && actual !== "") return actual;
  const period = Number(summary?.period || 0);
  const inning = index + 1;
  const periodText = baseballLivePeriodText(summary);
  if (!period || inning > period) return "-";
  if (inning < period) return "0";
  if (/^(middle|mid|end)/i.test(periodText)) return "0";
  if (/^top/i.test(periodText) && entry.homeAway === "away") return "0";
  if (/^bottom/i.test(periodText)) return "0";
  return "-";
}

function isFinalSummary(summary) {
  return summary?.completed || summary?.state === "post" || /final/i.test(summary?.status || "");
}

function getBaseballTotal(teamTotals, entry, name) {
  const team = teamTotals.find((item) => String(item.team?.id) === String(entry.team?.id))
    || teamTotals.find((item) => item.team?.abbreviation === entry.team?.abbreviation);
  const statistic = (team?.statistics || [])
    .flatMap((group) => group.stats || [])
    .find((stat) => stat.name === name || stat.abbreviation?.toLowerCase() === name);
  return statistic?.displayValue ?? statistic?.value ?? "-";
}

function getPeriodLabels(summary, competitors) {
  const regulationPeriods = summary?.league === "ncaamb" ? 2 : 4;
  const lineScoreCount = Math.max(...(competitors || []).map((entry) => entry.linescores?.length || 0), Number(summary?.period || 0), regulationPeriods);
  return Array.from({ length: lineScoreCount }, (_item, index) => {
    const period = index + 1;
    if (summary?.league === "ncaamb" && period <= regulationPeriods) return `${period}H`;
    if (period <= regulationPeriods) return String(period);
    const overtime = period - regulationPeriods;
    return overtime === 1 ? "OT" : `${overtime}OT`;
  });
}

function ScoreTeamSide({ entry, side, compact = false }) {
  if (!entry) return <div />;
  const record = entry.record || entry.records?.find((item) => item.type === "total")?.summary || entry.records?.[0]?.summary || "";
  return (
    <div className={`scoreTeamSide ${side} ${compact ? "compact" : ""}`}>
      {entry.team?.logo && <img src={entry.team.logo} alt="" />}
      <div>
        <strong>{entry.team?.name || entry.team?.abbreviation}</strong>
        {record && <span>{record}</span>}
      </div>
      {!compact && <b>{entry.score ?? "-"}</b>}
    </div>
  );
}

function FootballTeamBox({ competitor, teamStats }) {
  const teamName = competitor.team?.name || competitor.team?.abbreviation || "Team";
  const groups = normalizeStatGroups(teamStats?.statistics || []);
  return (
    <article className="footballTeamBox">
      {groups.map((group) => (
        <div className="statTableWrap" key={group.name}>
          <h3>
            {competitor.team?.logo && <img src={competitor.team.logo} alt="" />}
            {teamName} {group.name}
          </h3>
          <div className="statTable" style={{ gridTemplateColumns: `minmax(150px, 1.5fr) repeat(${group.labels.length}, minmax(46px, 1fr))` }}>
            <strong>{group.rowHeading}</strong>
            {group.labels.map((label) => <b key={label}>{label}</b>)}
            {group.athletes.map((athlete) => (
              <React.Fragment key={`${group.name}-${athlete.id || athlete.name}`}>
                <AthleteName athlete={athlete} />
                {group.labels.map((_label, index) => <span key={index}>{athlete.stats[index] ?? "-"}</span>)}
              </React.Fragment>
            ))}
          </div>
        </div>
      ))}
    </article>
  );
}

function BaseballTeamBox({ competitor, teamStats, teamTotals }) {
  const teamName = competitor.team?.name || competitor.team?.abbreviation || "Team";
  const groups = normalizeStatGroups(teamStats?.statistics || []);
  const hitting = groups.find((group) => ["batting", "hitting"].includes(group.name?.toLowerCase()));
  const pitching = groups.find((group) => group.name?.toLowerCase() === "pitching");
  const remaining = groups.filter((group) => group !== hitting && group !== pitching);

  return (
    <article className="baseballTeamBox">
      {[hitting, pitching, ...remaining].filter(Boolean).map((group) => {
        const totalRow = buildTeamTotalRow(group, teamTotals);
        const rows = totalRow ? [...group.athletes, totalRow] : group.athletes;
        return (
          <div className="statTableWrap" key={group.name}>
            <h3>
              {competitor.team?.logo && <img src={competitor.team.logo} alt="" />}
              {teamName} {group.name === "batting" ? "Hitting" : group.name}
            </h3>
            <div className="statTable baseballStatTable" style={{ gridTemplateColumns: `minmax(150px, 1.5fr) repeat(${group.labels.length}, minmax(38px, 1fr))` }}>
              <strong>{group.rowHeading}</strong>
              {group.labels.map((label) => <b key={label}>{label}</b>)}
              {rows.map((athlete) => (
                <React.Fragment key={`${group.name}-${athlete.id || athlete.name}`}>
                  <AthleteName athlete={athlete} />
                  {group.labels.map((_label, index) => <span key={index}>{athlete.stats[index] ?? "-"}</span>)}
                </React.Fragment>
              ))}
            </div>
          </div>
        );
      })}
    </article>
  );
}

function buildTeamTotalRow(group, teamTotals) {
  const stats = teamTotals?.statistics?.find((item) => item.name?.toLowerCase() === rawGroupName(group.name))?.stats;
  if (!stats?.length || !group.keys?.length) return null;
  const statMap = new Map(stats.map((stat) => [String(stat.name), stat]));
  const values = group.keys.map((key) => displayTeamStat(statMap, key));
  if (values.every((value) => value === "-")) return null;
  return {
    id: `team-${group.name}`,
    name: "TEAM",
    stats: values,
  };
}

function rawGroupName(name) {
  const lower = String(name || "").toLowerCase();
  if (lower === "hitting") return "batting";
  return lower;
}

function displayTeamStat(statMap, key) {
  const normalized = String(key || "");
  if (normalized === "hits-atBats") {
    const hits = statMap.get("hits")?.displayValue ?? statMap.get("hits")?.value;
    const atBats = statMap.get("atBats")?.displayValue ?? statMap.get("atBats")?.value;
    return hits != null && atBats != null ? `${hits}-${atBats}` : "-";
  }
  if (normalized === "pitches-strikes") {
    const pitches = statMap.get("pitches")?.displayValue ?? statMap.get("pitches")?.value;
    const strikes = statMap.get("strikes")?.displayValue ?? statMap.get("strikes")?.value;
    return pitches != null && strikes != null ? `${pitches}-${strikes}` : "-";
  }
  const exact = statMap.get(normalized);
  const fallback = statMap.get(normalized.split(".").at(-1));
  const stat = exact || fallback;
  return stat?.displayValue ?? stat?.value ?? "-";
}

function normalizeStatGroups(groups) {
  return groups
    .filter((group) => group?.labels?.length || group?.athletes?.length)
    .map((group) => ({
      ...group,
      name: normalizeGroupName(group.name),
      labels: group.labels || [],
      athletes: group.athletes || [],
      rowHeading: rowHeadingForGroup(group.name),
    }));
}

function normalizeGroupName(name) {
  if (!name) return "Stats";
  const lower = String(name).toLowerCase();
  if (lower === "batting") return "Hitting";
  return String(name).replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function rowHeadingForGroup(name) {
  const lower = String(name || "").toLowerCase();
  if (lower === "pitching") return "Pitchers";
  if (lower === "batting" || lower === "hitting") return "Hitters";
  return "Players";
}

function AthleteName({ athlete }) {
  const details = [athlete.position, athlete.jersey ? `#${athlete.jersey}` : "", athlete.didNotPlay ? athlete.reason || "DNP" : ""].filter(Boolean);
  return (
    <strong className={athlete.didNotPlay ? "athleteName didNotPlay" : "athleteName"}>
      <span>{athlete.name}</span>
      {details.length > 0 && <small>{details.join(" ")}</small>}
    </strong>
  );
}

function describeVideoError(video, label) {
  const error = video.error;
  if (!error) return `${label} playback failed.`;
  const names = {
    1: "MEDIA_ERR_ABORTED",
    2: "MEDIA_ERR_NETWORK",
    3: "MEDIA_ERR_DECODE",
    4: "MEDIA_ERR_SRC_NOT_SUPPORTED",
  };
  return `${label} playback failed: ${names[error.code] || "MEDIA_ERR_UNKNOWN"} (${error.code})${error.message ? ` / ${error.message}` : ""}`;
}

function attachHlsJs(video, source, setMessage) {
  const hls = new Hls({
    lowLatencyMode: false,
    maxBufferLength: 60,
    maxMaxBufferLength: 120,
    liveSyncDurationCount: 6,
  });
  hls.on(Hls.Events.ERROR, (_event, data) => {
    if (data.fatal) setMessage(`HLS playback failed: ${data.details || data.type}`);
  });
  hls.loadSource(source);
  hls.attachMedia(video);
  return () => hls.destroy();
}

function attachNativeVideo(video, source) {
  video.src = source;
  video.load();
  return () => {};
}

function attachMpegTs(video, source, setMessage) {
  const player = mpegts.createPlayer(
    {
      type: "mse",
      isLive: true,
      url: source,
      cors: false,
      withCredentials: true,
    },
    {
      enableWorker: false,
      enableStashBuffer: true,
      stashInitialSize: 4 * 1024 * 1024,
      lazyLoad: false,
      deferLoadAfterSourceOpen: true,
      liveBufferLatencyChasing: false,
      liveBufferLatencyMaxLatency: 20,
      liveBufferLatencyMinRemain: 8,
      autoCleanupSourceBuffer: true,
      autoCleanupMaxBackwardDuration: 300,
      autoCleanupMinBackwardDuration: 120,
    },
  );
  player.on(mpegts.Events.ERROR, (type, detail, info) => {
    const isRecoverableMseNoise =
      detail === mpegts.ErrorDetails?.MEDIA_MSE_ERROR &&
      video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
    if (!isRecoverableMseNoise) {
      const cleanInfo = typeof info === "string" ? info : info?.msg || info?.message || "";
      setMessage(`MPEG-TS playback failed: ${[type, detail, cleanInfo].filter(Boolean).join(" / ") || "stream error"}`);
    }
  });
  player.attachMediaElement(video);
  player.load();
  return () => {
    player.unload();
    player.detachMediaElement();
    player.destroy();
  };
}

export default SportsPanel;

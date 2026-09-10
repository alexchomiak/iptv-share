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
  const teamTotals = summary?.boxscore?.teams || [];
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
      <FootballDrivePanel summary={summary} away={away} home={home} />
      <WinProbabilityPanel summary={summary} away={away} home={home} />
      <FootballSnapshotGrid summary={summary} away={away} home={home} teamTotals={teamTotals} />
      {playerGroups.length > 0 && (
        <div className="footballBoxscore">
          {[away, home].filter(Boolean).map((entry) => {
            const teamStats = playerGroups.find((team) => String(team.team?.id) === String(entry.team?.id))
              || playerGroups.find((team) => team.team?.abbreviation === entry.team?.abbreviation);
            return <FootballTeamBox key={entry.id || entry.team?.abbreviation} competitor={entry} teamStats={teamStats} />;
          })}
        </div>
      )}
      <FootballExtras summary={summary} away={away} home={home} />
    </section>
  );
}

function FootballDrivePanel({ summary, away, home }) {
  const drives = footballDriveList(summary);
  const fallbackPlay = summary?.recentPlays?.[0];
  const isCompleted = isFinalSummary(summary);
  const [selectedDriveKey, setSelectedDriveKey] = useState("");
  const [selectedPlayKey, setSelectedPlayKey] = useState("");
  const activeDriveKey = selectedDriveKey && drives.some((entry) => entry.key === selectedDriveKey)
    ? selectedDriveKey
    : drives[0]?.key || "";
  const selectedDriveEntry = drives.find((entry) => entry.key === activeDriveKey) || null;
  const selectedDrive = selectedDriveEntry?.drive || null;
  const drivePlays = selectedDrive?.plays || [];
  const drivePlaysNewestFirst = [...drivePlays].reverse();
  const activePlayKey = selectedPlayKey && drivePlays.some((play) => footballPlayKey(play) === selectedPlayKey)
    ? selectedPlayKey
    : footballPlayKey(drivePlays.at(-1) || fallbackPlay);
  const selectedPlay = drivePlays.find((play) => footballPlayKey(play) === activePlayKey) || drivePlays.at(-1) || fallbackPlay;
  const computedFieldModel = buildFootballReplayField(selectedDrive, selectedPlay, away, home);
  const fieldModel = selectedDriveEntry?.isCurrent
    ? computedFieldModel || summary?.footballField
    : computedFieldModel;
  const spot = fieldModel?.ball || selectedPlay?.end || selectedDrive?.end || selectedDrive?.start || selectedPlay?.start;
  const playAthletes = drivePlayAthletes(selectedPlay);
  const displayTeam = fieldModel?.possessionTeam || selectedDrive?.team || selectedPlay?.team;
  const isLiveDrive = Boolean(selectedDriveEntry?.isCurrent && !isCompleted);
  const title = isLiveDrive ? "Current Drive" : isCompleted && activeDriveKey === drives[0]?.key ? "Final Drive" : "Drive Replay";
  const driveResult = selectedDrive?.result || selectedDrive?.shortResult || "";
  const groupedDrives = groupFootballDrives(drives);
  const liveDriveKey = !isCompleted && drives[0]?.isCurrent ? drives[0].key : "";
  const currentLatestPlayKey = liveDriveKey ? footballPlayKey(drives[0]?.drive?.plays?.at(-1) || fallbackPlay) : "";
  const showLiveButton = Boolean(liveDriveKey && (activeDriveKey !== liveDriveKey || selectedPlayKey));
  const returnToLiveDrive = () => {
    if (liveDriveKey) setSelectedDriveKey(liveDriveKey);
    setSelectedPlayKey("");
  };
  const selectDrive = (entry) => {
    setSelectedDriveKey(entry.key);
    setSelectedPlayKey(entry.isCurrent ? "" : footballPlayKey(entry.drive?.plays?.at(-1)));
  };
  const selectDrivePlay = (play) => {
    const key = footballPlayKey(play);
    if (isLiveDrive && key && key === currentLatestPlayKey) {
      returnToLiveDrive();
      return;
    }
    setSelectedPlayKey(key);
  };

  useEffect(() => {
    if (!activeDriveKey) return;
    if (activeDriveKey !== selectedDriveKey) setSelectedDriveKey(activeDriveKey);
  }, [activeDriveKey, selectedDriveKey]);

  useEffect(() => {
    if (!selectedPlayKey) return;
    if (!drivePlays.some((play) => footballPlayKey(play) === selectedPlayKey)) setSelectedPlayKey("");
  }, [activeDriveKey, drivePlays.length, selectedPlayKey]);

  if (!selectedDrive && !spot && !selectedPlay && !summary?.footballField) return null;

  return (
    <section className="sportsSubpanel footballDrivePanel">
      <div className="sportsSubpanelHeader">
        <div>
          <h3>{title}</h3>
          <span>{selectedDrive?.description || driveResult || "Drive in progress"}</span>
        </div>
        <div className="driveHeaderActions">
          {showLiveButton && (
            <button
              type="button"
              onClick={returnToLiveDrive}
            >
              Live Drive
            </button>
          )}
          {displayTeam?.logo && <img src={displayTeam.logo} alt="" />}
        </div>
      </div>
      <div className="footballDriveGrid">
        <div className="footballDriveMain">
          <FootballField summary={summary} model={fieldModel} play={selectedPlay} away={away} home={home} />
          {selectedPlay?.text && (
            <div className="driveLastPlay">
              <div>
                <strong>{selectedPlay.shortDescription || selectedPlay.type || "Selected Play"}</strong>
                <small>{[spot?.downDistanceText || spot?.shortDownDistanceText, spot?.possessionText, selectedPlay.clock].filter(Boolean).join(" · ")}</small>
              </div>
              <span>{selectedPlay.text}</span>
              {playAthletes.length > 0 && (
                <div className="drivePlayers">
                  {playAthletes.map((athlete) => (
                    <span key={`${selectedPlay.id}-${athlete.id || athlete.name}-${athlete.role || ""}`}>
                      {athlete.headshot && <img src={athlete.headshot} alt="" loading="lazy" />}
                      <b>{athlete.shortName || athlete.name}</b>
                      {athlete.role && <small>{formatPlayerRole(athlete.role)}</small>}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        {drives.length > 0 && (
          <aside className="footballDriveRail">
            <div className="driveRailHeader">
              <h4>Drives</h4>
              <span>{drives.length}</span>
            </div>
            <div className="driveRailList">
              {groupedDrives.map((group) => (
                <div className="driveRailGroup" key={group.label}>
                  <h5>{group.label}</h5>
                  {group.entries.map((entry) => (
                    <button
                      key={entry.key}
                      className={entry.key === activeDriveKey ? "active" : ""}
                      type="button"
                      onClick={() => selectDrive(entry)}
                    >
                      {entry.drive?.team?.logo && <img src={entry.drive.team.logo} alt="" />}
                      <span>
                        <b>{entry.isCurrent ? "Current Drive" : entry.drive?.result || "Drive"}</b>
                        <small>{footballDriveMeta(entry.drive)}</small>
                      </span>
                      <strong>{footballDriveScore(entry.drive)}</strong>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </aside>
        )}
      </div>
      {drivePlays.length > 0 && (
        <div className="drivePlayFeed">
          <div className="driveRailHeader">
            <h4>Drive Plays</h4>
            <span>{drivePlays.length}</span>
          </div>
          {drivePlaysNewestFirst.map((play, index) => (
            <article
              key={footballPlayKey(play) || index}
              className={footballPlayKey(play) === activePlayKey ? "active" : ""}
              role="button"
              tabIndex={0}
              onClick={() => selectDrivePlay(play)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  selectDrivePlay(play);
                }
              }}
            >
              <div>
                <header className="playRowHeader">
                  <b>{play.shortDescription || play.type || `Play ${drivePlays.length - index}`}</b>
                  {play.wallclock && <time>{formatPlayTimestamp(play.wallclock)}</time>}
                </header>
                <span>{[play.clock, play.start?.downDistanceText || play.start?.shortDownDistanceText, play.start?.possessionText].filter(Boolean).join(" · ")}</span>
                <p>{play.text}</p>
              </div>
              <strong>{play.awayScore ?? "-"}-{play.homeScore ?? "-"}</strong>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function FootballField({ summary, model: fieldModel, play, away, home }) {
  const model = fieldModel || summary?.footballField || {};
  const ball = model.ball || null;
  const possessionTeam = model.possessionTeam || play?.team || ball?.team || null;
  const possession = possessionTeam?.abbreviation || "";
  const possessionLogo = possessionTeam?.logo || "";
  const current = finiteNumber(ball?.percent);
  const firstDown = finiteNumber(model.firstDown?.percent);
  const driveStart = finiteNumber(model.driveStart?.percent);
  const start = finiteNumber(model.lastPlay?.startPercent);
  const end = finiteNumber(model.lastPlay?.endPercent);
  const kind = model.lastPlay?.kind || "";
  const hasPath = Boolean(model.lastPlay?.showRoute) && Number.isFinite(start) && Number.isFinite(end);
  const visualMarker = Number.isFinite(current) ? fieldMarkerPercent(current) : null;
  const path = hasPath ? footballPlayPath(start, end, kind) : "";
  const drivePath = Number.isFinite(driveStart) && Number.isFinite(current) && Math.abs(driveStart - current) > 0.5
    ? `M ${driveStart.toFixed(1)} 45 L ${current.toFixed(1)} 45`
    : "";
  const playSpotText = ball?.possessionText || ball?.downDistanceText || "";
  return (
    <div className="footballField" aria-label="Current drive field position">
      <span className="footballFieldEndzone">
        {away?.team?.logo ? <img src={away.team.logo} alt={away?.team?.abbreviation || "Away"} /> : away?.team?.abbreviation || "AWAY"}
      </span>
      <div className="footballFieldSurface">
        <svg viewBox="0 0 100 48" preserveAspectRatio="none" aria-hidden="true">
          {drivePath && <path d={drivePath} className="footballDriveStartPath" />}
          {drivePath && <circle cx={driveStart} cy="45" r="1.2" className="footballDriveStartDot" />}
          {drivePath && <circle cx={current} cy="45" r="1.5" className="footballDriveCurrentDot" />}
          {Number.isFinite(firstDown) && <line x1={firstDown} x2={firstDown} y1="4" y2="44" className="footballFirstDownLine" />}
          {hasPath && <path d={path} className={`footballFieldPath ${kind}`} />}
          {hasPath && <circle cx={start} cy={footballPathY(kind)} r="1.2" className="footballFieldDot start" />}
          {hasPath && <circle cx={end} cy={footballPathY(kind)} r="1.6" className="footballFieldDot end" />}
        </svg>
        {[10, 20, 30, 40, 50, 40, 30, 20, 10].map((yard, index) => <i key={`${yard}-${index}`}>{yard}</i>)}
        {visualMarker !== null && (
          <b className={possessionLogo ? "footballFieldMarker logoOnly" : "footballFieldMarker"} style={{ left: `${visualMarker}%` }}>
            {possessionLogo && <img src={possessionLogo} alt="" />}
            {!possessionLogo && <span>{possession || playSpotText || "Ball"}</span>}
          </b>
        )}
      </div>
      <span className="footballFieldEndzone">
        {home?.team?.logo ? <img src={home.team.logo} alt={home?.team?.abbreviation || "Home"} /> : home?.team?.abbreviation || "HOME"}
      </span>
    </div>
  );
}

function footballPlayPath(start, end, kind) {
  const y = footballPathY(kind);
  if (kind === "pass") {
    const mid = (start + end) / 2;
    const lift = Math.max(16, Math.min(28, Math.abs(end - start) * 0.72));
    return `M ${start.toFixed(1)} ${y} Q ${mid.toFixed(1)} ${(y - lift).toFixed(1)} ${end.toFixed(1)} ${y}`;
  }
  return `M ${start.toFixed(1)} ${y} L ${end.toFixed(1)} ${y}`;
}

function footballPathY(kind) {
  return kind === "pass" ? 36 : 34;
}


function fieldMarkerPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(2.8, Math.min(97.2, numeric));
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return NaN;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : NaN;
}

function footballDriveList(summary) {
  const isCompleted = isFinalSummary(summary);
  const rawCurrent = summary?.drives?.current;
  const current = isCompleted ? null : rawCurrent;
  const currentId = String(current?.id || "");
  const previous = [...(summary?.drives?.previous || [])].filter((drive, index) => {
    if (currentId && String(drive?.id || "") === currentId) return false;
    return !current || index !== 0 || footballDriveMeta(drive) !== footballDriveMeta(current);
  });
  if (isCompleted && footballDriveHasContent(rawCurrent) && !previous.some((drive) => footballDriveSameDrive(drive, rawCurrent))) {
    previous.unshift(rawCurrent);
  }
  return [
    ...(current ? [{ drive: current, isCurrent: true }] : []),
    ...previous.map((drive) => ({ drive, isCurrent: false })),
  ].filter((entry) => entry.drive).map((entry, index) => ({
    ...entry,
    key: `${entry.isCurrent ? "current" : "drive"}-${entry.drive.id || index}-${entry.drive.team?.id || entry.drive.team?.abbreviation || ""}`,
  }));
}

function footballDriveHasContent(drive = {}) {
  return Boolean(drive?.id || drive?.plays?.length || drive?.start || drive?.end || drive?.result || drive?.shortResult);
}

function footballDriveSameDrive(left = {}, right = {}) {
  if (!left || !right) return false;
  if (left.id && right.id) return String(left.id) === String(right.id);
  return footballDriveMeta(left) === footballDriveMeta(right)
    && footballDriveScore(left) === footballDriveScore(right)
    && (left.result || left.shortResult || "") === (right.result || right.shortResult || "");
}

function groupFootballDrives(drives = []) {
  const groups = [];
  for (const entry of drives) {
    const label = entry.isCurrent ? "Live" : footballDrivePeriodLabel(entry.drive);
    let group = groups.find((item) => item.label === label);
    if (!group) {
      group = { label, entries: [] };
      groups.push(group);
    }
    group.entries.push(entry);
  }
  return groups;
}

function footballDrivePeriodLabel(drive = {}) {
  const period = drive.plays?.[0]?.period || drive.plays?.at(-1)?.period || {};
  const number = Number(period.number);
  if (period.displayValue) return period.displayValue;
  if (Number.isFinite(number)) return number <= 4 ? `${ordinal(number)} Quarter` : number === 5 ? "Overtime" : `${ordinal(number - 4)} Overtime`;
  return "Earlier Drives";
}

function footballPlayKey(play) {
  if (!play) return "";
  return String(play.id || play.sequenceNumber || `${play.clock || ""}-${play.text || play.shortText || ""}`);
}

function footballDriveMeta(drive = {}) {
  return [
    drive.offensivePlays ? `${drive.offensivePlays} plays` : "",
    drive.yards != null ? `${drive.yards} yards` : "",
    drive.timeElapsed,
  ].filter(Boolean).join(", ") || "Drive details";
}

function footballDriveScore(drive = {}) {
  const lastPlay = drive.plays?.at(-1);
  if (lastPlay?.awayScore != null || lastPlay?.homeScore != null) return `${lastPlay.awayScore ?? 0}-${lastPlay.homeScore ?? 0}`;
  return "";
}

function buildFootballReplayField(drive = {}, play = {}, away, home) {
  const possessionTeam = drive?.team || play?.team || null;
  const ballSpot = play?.end || drive?.end || play?.start || drive?.start || null;
  const driveStartSpot = drive?.plays?.[0]?.start || drive?.start;
  const fieldFlip = footballFieldShouldFlip(driveStartSpot, ballSpot, away, home, possessionTeam);
  const driveStartPercent = footballFieldPercent(driveStartSpot, away, home, possessionTeam, fieldFlip);
  const ballPercent = footballFieldPercent(ballSpot, away, home, possessionTeam, fieldFlip);
  const startPercent = footballFieldPercent(play?.start, away, home, possessionTeam, fieldFlip);
  const endPercent = footballFieldPercent(play?.end, away, home, possessionTeam, fieldFlip);
  const direction = footballDriveDirection({
    possessionTeam,
    away,
    home,
    ballPercent,
    driveStartPercent,
    startPercent,
    endPercent,
  });
  const firstDownPercent = footballFirstDownPercent(play?.start || ballSpot, possessionTeam, away, home, direction, fieldFlip);
  const kind = footballPlayKind(play);
  return {
    possessionTeam,
    direction,
    fieldFlip,
    ball: ballSpot && Number.isFinite(ballPercent) ? { ...ballSpot, percent: ballPercent } : null,
    driveStart: Number.isFinite(driveStartPercent) ? { percent: driveStartPercent } : null,
    firstDown: Number.isFinite(firstDownPercent) ? { percent: firstDownPercent } : null,
    lastPlay: play
      ? {
          id: play.id || "",
          kind,
          startPercent,
          endPercent,
          showRoute: Boolean(kind) && Number.isFinite(startPercent) && Number.isFinite(endPercent) && Math.abs(startPercent - endPercent) > 0.5,
        }
      : null,
  };
}

function footballFieldPercent(spot, away, home, possessionTeam, flip = false) {
  const percent = footballFieldBasePercent(spot, away, home, possessionTeam);
  if (!Number.isFinite(percent)) return percent;
  return flip ? clampFieldPercent(100 - percent) : percent;
}

function footballFieldBasePercent(spot, away, home, possessionTeam) {
  if (!spot) return null;
  const parsed = parseFootballSpotText(spot.possessionText || spot.downDistanceText);
  if (parsed?.yardLine === 50 && !parsed.team) return 50;
  if (parsed?.team) {
    const side = footballPossessionSide(parsed.team, away, home);
    if (side === "away") return clampFieldPercent(parsed.yardLine);
    if (side === "home") return clampFieldPercent(100 - parsed.yardLine);
  }
  const yardsToEndzone = Number(spot.yardsToEndzone);
  const side = footballPossessionSide(possessionTeam || spot.team, away, home);
  if (!Number.isFinite(yardsToEndzone) || !side) return null;
  return clampFieldPercent(side === "away" ? 100 - yardsToEndzone : yardsToEndzone);
}

function footballFieldShouldFlip(startSpot, currentSpot, away, home, possessionTeam) {
  const startYardsToEndzone = Number(startSpot?.yardsToEndzone);
  const currentYardsToEndzone = Number(currentSpot?.yardsToEndzone);
  const startPercent = footballFieldBasePercent(startSpot, away, home, possessionTeam);
  const currentPercent = footballFieldBasePercent(currentSpot, away, home, possessionTeam);
  if (
    !Number.isFinite(startYardsToEndzone) ||
    !Number.isFinite(currentYardsToEndzone) ||
    !Number.isFinite(startPercent) ||
    !Number.isFinite(currentPercent)
  ) {
    return false;
  }
  const yardsDelta = currentYardsToEndzone - startYardsToEndzone;
  const percentDelta = currentPercent - startPercent;
  if (Math.abs(yardsDelta) <= 0.5 || Math.abs(percentDelta) <= 0.5) return false;
  return Math.sign(yardsDelta) !== Math.sign(percentDelta);
}

function footballFirstDownPercent(spot, possessionTeam, away, home, direction = "", flip = false) {
  const ball = footballFieldPercent(spot, away, home, possessionTeam, flip);
  if (!Number.isFinite(ball)) return null;
  const driveDirection = direction || (footballPossessionSide(possessionTeam || spot?.team, away, home) === "home" ? "left" : "right");
  if (!driveDirection) return null;
  if (/&\s*goal\b/i.test(`${spot?.shortDownDistanceText || ""} ${spot?.downDistanceText || ""}`)) return driveDirection === "left" ? 0 : 100;
  const parsed = parseFootballDownDistance(spot?.shortDownDistanceText || spot?.downDistanceText);
  const distance = Number(spot?.distance ?? parsed.distance);
  if (!Number.isFinite(distance) || distance <= 0) return null;
  return clampFieldPercent(driveDirection === "left" ? ball - distance : ball + distance);
}

function footballDriveDirection({ possessionTeam, away, home, ballPercent, driveStartPercent, startPercent, endPercent } = {}) {
  if (Number.isFinite(driveStartPercent) && Number.isFinite(ballPercent) && Math.abs(ballPercent - driveStartPercent) > 0.5) {
    return ballPercent > driveStartPercent ? "right" : "left";
  }
  if (Number.isFinite(startPercent) && Number.isFinite(endPercent) && Math.abs(endPercent - startPercent) > 0.5) {
    return endPercent > startPercent ? "right" : "left";
  }
  return footballPossessionSide(possessionTeam, away, home) === "home" ? "left" : "right";
}

function footballPossessionSide(team, away, home) {
  const id = String(team?.id || "");
  const abbreviation = String(team?.abbreviation || "");
  if (id && String(away?.team?.id || "") === id) return "away";
  if (id && String(home?.team?.id || "") === id) return "home";
  if (abbreviation && String(away?.team?.abbreviation || "") === abbreviation) return "away";
  if (abbreviation && String(home?.team?.abbreviation || "") === abbreviation) return "home";
  return "";
}

function parseFootballSpotText(value = "") {
  const text = String(value || "").trim();
  const atMatch = text.match(/\bat\s+([A-Z]{2,4})\s+(\d{1,2})\b/i);
  const plainMatch = text.match(/^([A-Z]{2,4})\s+(\d{1,2})$/i);
  const midfieldMatch = text.match(/\bat\s+(50)\b/i) || text.match(/^(50)$/);
  const match = atMatch || plainMatch;
  if (match) return { text: `${match[1].toUpperCase()} ${Number(match[2])}`, team: { abbreviation: match[1].toUpperCase() }, yardLine: Number(match[2]) };
  if (midfieldMatch) return { text: "50", team: null, yardLine: 50 };
  return null;
}

function parseFootballDownDistance(value = "") {
  const text = String(value || "").trim();
  const downMatch = text.match(/\b(1st|2nd|3rd|4th)\b/i);
  const distanceMatch = text.match(/&\s*(\d{1,2}|goal)\b/i);
  const downMap = { "1st": 1, "2nd": 2, "3rd": 3, "4th": 4 };
  const distanceText = distanceMatch?.[1] || "";
  return {
    down: downMap[downMatch?.[1]?.toLowerCase()] || null,
    distance: /^goal$/i.test(distanceText) ? null : Number(distanceText) || null,
  };
}

function footballPlayKind(play = {}) {
  const text = [play?.type, play?.shortDescription, play?.shortText, play?.text].filter(Boolean).join(" ").toLowerCase();
  if (/timeout|end quarter|two-minute warning/.test(text)) return "";
  if (/pass|reception|intercept/.test(text)) return "pass";
  if (/punt|kick|field goal/.test(text)) return "kick";
  if (/rush|run|sack|scramble/.test(text)) return "run";
  return "";
}

function clampFieldPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(0, Math.min(100, numeric));
}

function drivePlayAthletes(play) {
  const seen = new Set();
  return (play?.athletes || []).filter((athlete) => {
    const key = athlete.id || athlete.name || athlete.shortName;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return athlete.name || athlete.shortName || athlete.headshot;
  }).slice(0, 4);
}

function formatPlayerRole(value = "") {
  const labels = {
    passer: "Passer",
    receiver: "Receiver",
    rusher: "Rusher",
    tackler: "Tackle",
    sacker: "Sack",
    interceptor: "Interception",
    kicker: "Kicker",
    punter: "Punter",
  };
  return labels[value] || String(value).replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function FootballSnapshotGrid({ summary, away, home, teamTotals }) {
  const hasLeaders = (summary?.leaders || []).some((entry) => entry.leaders?.length);
  const hasTeamStats = teamTotals.length >= 2;
  if (!hasLeaders && !hasTeamStats) return null;
  return (
    <div className={`footballSnapshotGrid ${hasLeaders && hasTeamStats ? "" : "single"}`}>
      {hasLeaders && <FootballLeaders leaders={summary.leaders} away={away} home={home} />}
      {hasTeamStats && <FootballTeamStats teams={teamTotals} away={away} home={home} />}
    </div>
  );
}

function FootballLeaders({ leaders, away, home }) {
  const categories = ["passingYards", "rushingYards", "receivingYards", "sacks", "totalTackles"];
  const byTeam = new Map((leaders || []).map((entry) => [String(entry.team?.id || entry.team?.abbreviation), entry]));
  const leaderFor = (team, categoryName) => {
    const entry = byTeam.get(String(team?.team?.id)) || byTeam.get(String(team?.team?.abbreviation));
    return entry?.leaders?.find((category) => category.name === categoryName || category.label?.replace(/\s/g, "").toLowerCase() === categoryName.toLowerCase())?.leaders?.[0] || null;
  };
  return (
    <section className="sportsSubpanel footballLeadersPanel">
      <div className="sportsSubpanelHeader">
        <h3>Game Leaders</h3>
      </div>
      <div className="leaderRows">
        {categories.map((category) => {
          const awayLeader = leaderFor(away, category);
          const homeLeader = leaderFor(home, category);
          const label = leaderLabel(category, awayLeader, homeLeader);
          if (!awayLeader && !homeLeader) return null;
          return (
            <div className="leaderRow" key={category}>
              <LeaderSide leader={awayLeader} />
              <b>{label}</b>
              <LeaderSide leader={homeLeader} right />
            </div>
          );
        })}
      </div>
    </section>
  );
}

function LeaderSide({ leader, right = false }) {
  const athlete = leader?.athlete;
  if (!leader || !athlete) return <span className={`leaderSide ${right ? "right" : ""} mutedLeader`}>None</span>;
  return (
    <span className={`leaderSide ${right ? "right" : ""}`}>
      {athlete.headshot && <img src={athlete.headshot} alt="" />}
      <strong>{leader.mainStat?.value ?? leader.value ?? "-"}</strong>
      <small>{athlete.shortName || athlete.name} {athlete.position || ""}</small>
    </span>
  );
}

function leaderLabel(category, awayLeader, homeLeader) {
  return {
    passingYards: "Passing",
    rushingYards: "Rushing",
    receivingYards: "Receiving",
    sacks: "Sacks",
    totalTackles: "Tackles",
  }[category] || awayLeader?.mainStat?.label || homeLeader?.mainStat?.label || category;
}

function FootballTeamStats({ teams, away, home }) {
  const awayStats = teamStatMap(teams, away);
  const homeStats = teamStatMap(teams, home);
  const rows = [
    ["totalYards", "Total Yards"],
    ["turnovers", "Turnovers"],
    ["firstDowns", "1st Downs"],
    ["thirdDownEff", "3rd Down"],
    ["fourthDownEff", "4th Down"],
    ["redZoneAttempts", "Red Zone"],
    ["possessionTime", "Possession"],
  ];
  return (
    <section className="sportsSubpanel footballTeamStatsPanel">
      <div className="sportsSubpanelHeader">
        <h3>Team Stats</h3>
      </div>
      <div className="teamCompareHeader">
        <span>
          {away?.team?.logo && <img src={away.team.logo} alt="" />}
          <b>{away?.team?.abbreviation || away?.team?.name || "Away"}</b>
        </span>
        <span>
          <b>{home?.team?.abbreviation || home?.team?.name || "Home"}</b>
          {home?.team?.logo && <img src={home.team.logo} alt="" />}
        </span>
      </div>
      <div className="teamCompareRows">
        {rows.map(([key, label]) => <TeamCompareRow key={key} statKey={key} label={label} away={awayStats.get(key)} home={homeStats.get(key)} />)}
      </div>
    </section>
  );
}

function teamStatMap(teams, competitor) {
  const team = teams.find((entry) => String(entry.team?.id) === String(competitor?.team?.id))
    || teams.find((entry) => entry.team?.abbreviation === competitor?.team?.abbreviation);
  return new Map((team?.statistics || []).flatMap((group) => group.stats?.length ? group.stats : [group]).map((stat) => [stat.name, stat.displayValue ?? stat.value ?? "-"]));
}

function TeamCompareRow({ label, away, home, statKey }) {
  const awayValue = statCompareValue(away, statKey);
  const homeValue = statCompareValue(home, statKey);
  const total = Number(awayValue || 0) + Number(homeValue || 0);
  const awayShare = total > 0 ? (Number(awayValue || 0) / total) * 100 : 50;
  const homeShare = total > 0 ? (Number(homeValue || 0) / total) * 100 : 50;
  return (
    <div className="teamCompareRow">
      <div className="teamCompareValues">
        <strong>{away ?? "-"}</strong>
        <span>{label}</span>
        <strong>{home ?? "-"}</strong>
      </div>
      <div className="teamCompareTrack" aria-hidden="true">
        <i className="away" style={{ width: `${awayShare}%` }} />
        <i className="home" style={{ width: `${homeShare}%` }} />
      </div>
    </div>
  );
}

function statCompareValue(value, key = "") {
  if (value === null || value === undefined || value === "") return 0;
  const text = String(value);
  const timeMatch = text.match(/^(\d+):(\d{2})$/);
  if (timeMatch) return Number(timeMatch[1]) * 60 + Number(timeMatch[2]);
  const parts = text.match(/^(\d+)\s*[-/]\s*(\d+)$/);
  if (parts) {
    if (key === "penalties") return Number(parts[2]);
    const attempts = Number(parts[2]);
    return attempts > 0 ? Number(parts[1]) / attempts : Number(parts[1]);
  }
  const numeric = Number(text.replace(/[^\d.-]/g, ""));
  return Number.isFinite(numeric) ? Math.max(0, numeric) : 0;
}

function FootballLineScore({ summary, away, home, periodLabels }) {
  const drive = summary?.drives?.current;
  const field = summary?.footballField || {};
  const spot = field.ball || null;
  const possession = field.possessionTeam || drive?.team || summary?.recentPlays?.[0]?.team;
  const driveLabel = spot?.shortDownDistanceText || spot?.downDistanceText || drive?.description || "";
  const fieldLabel = spot?.possessionText || "";
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
      {(driveLabel || fieldLabel) && (
        <div className="scoreboardDriveChip">
          {possession?.logo && <img src={possession.logo} alt="" />}
          <b>{driveLabel}</b>
          {fieldLabel && <span>{fieldLabel}</span>}
        </div>
      )}
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

function FootballExtras({ summary, away, home }) {
  const scoring = summary?.scoringSummary || [];
  const plays = summary?.recentPlays || [];
  const injuries = summary?.injuries || [];
  const broadcasts = summary?.broadcasts || [];
  const gameInfo = summary?.gameInfo || {};
  const hasInfo = gameInfo.venue?.name || gameInfo.weather || broadcasts.length > 0;
  const hasInjuries = injuries.some((entry) => entry.injuries?.length);
  if (!scoring.length && !plays.length && !hasInfo && !hasInjuries) return null;
  return (
    <div className="footballExtras">
      <div className="footballExtrasMain">
        {plays.length > 0 && (
          <section className="sportsSubpanel">
            <div className="sportsSubpanelHeader">
              <h3>Recent Plays</h3>
            </div>
            <div className="recentPlaysList compact">
              {plays.map((play) => <PlayRow key={play.id || `${play.wallclock}-${play.text}`} play={play} away={away} home={home} />)}
            </div>
          </section>
        )}
        {scoring.length > 0 && (
          <section className="sportsSubpanel">
            <div className="sportsSubpanelHeader">
              <h3>Scoring Plays</h3>
            </div>
            <div className="scoringSummaryList">
              {scoring.map((play) => <PlayRow key={play.id || `${play.period?.number}-${play.text}`} play={play} away={away} home={home} />)}
            </div>
          </section>
        )}
      </div>
      {hasInfo && (
        <aside className="footballExtrasAside">
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
          {hasInjuries && <FootballInjuries injuries={injuries} />}
        </aside>
      )}
      {!hasInfo && hasInjuries && (
        <aside className="footballExtrasAside">
          <FootballInjuries injuries={injuries} />
        </aside>
      )}
    </div>
  );
}

function FootballInjuries({ injuries }) {
  return (
    <section className="sportsSubpanel injuryPanel">
      <div className="sportsSubpanelHeader">
        <h3>Injury Report</h3>
      </div>
      <div className="injuryTeams">
        {injuries.map((entry) => (
          <div className="injuryTeam" key={entry.team?.id || entry.team?.abbreviation}>
            <h4>
              {entry.team?.logo && <img src={entry.team.logo} alt="" />}
              {entry.team?.name || entry.team?.abbreviation || "Team"}
            </h4>
            {entry.injuries.slice(0, 8).map((injury) => (
              <div className="injuryRow" key={`${entry.team?.id}-${injury.athlete?.id || injury.athlete?.name}-${injury.status}`}>
                {injury.athlete?.headshot && <img src={injury.athlete.headshot} alt="" />}
                <div>
                  <b>{injury.athlete?.shortName || injury.athlete?.name || "Player"}</b>
                  <span>{[injury.athlete?.position, injury.type].filter(Boolean).join(" · ")}</span>
                </div>
                <strong>{injury.detail || injury.status}</strong>
              </div>
            ))}
          </div>
        ))}
      </div>
    </section>
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
  const period = playPeriodLabel(play);
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

function playPeriodLabel(play) {
  const type = play.period?.type || "";
  const display = play.period?.displayValue || "";
  const number = Number(play.period?.number);
  if (type || display) return [type, display || play.period?.number].filter(Boolean).join(" ");
  if (Number.isFinite(number)) return number <= 4 ? `${ordinal(number)} Quarter` : number === 5 ? "Overtime" : `${ordinal(number - 4)} Overtime`;
  return "";
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
      {mode} every {formatRefreshInterval(seconds)}{fetchedAt ? ` · last updated ${formatUpdatedAgo(fetchedAt)}` : ""}{fetchedAt ? "." : ""}
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

import { useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api.js";
import { navigate } from "../../lib/navigation.js";
import { eventEnd, eventStart, formatDateTime, fromLocalInput, toLocalInput } from "../../lib/time.js";
import EventPeek from "./EventPeek.jsx";
import GuideGrid from "./GuideGrid.jsx";

function AppGuide() {
  const initialStart = useMemo(() => toLocalInput(new Date(Date.now() - 30 * 60 * 1000)), []);
  const initialEnd = useMemo(() => toLocalInput(new Date(Date.now() + 8 * 60 * 60 * 1000)), []);
  const [channels, setChannels] = useState([]);
  const [programs, setPrograms] = useState([]);
  const [searchResults, setSearchResults] = useState([]);
  const [searchResultsOpen, setSearchResultsOpen] = useState(false);
  const [status, setStatus] = useState("Loading guide...");
  const [search, setSearch] = useState("");
  const [group, setGroup] = useState("");
  const [rangeStart, setRangeStart] = useState(initialStart);
  const [rangeEnd, setRangeEnd] = useState(initialEnd);
  const [selectedChannelId, setSelectedChannelId] = useState(null);
  const [selectedProgramIds, setSelectedProgramIds] = useState(new Set());
  const [shareForm, setShareForm] = useState({ slug: "", title: "", password: "", maxViewers: "" });
  const [staticShares, setStaticShares] = useState([]);
  const [schedulePickerOpen, setSchedulePickerOpen] = useState(false);
  const [shareResult, setShareResult] = useState("");
  const [activeProgram, setActiveProgram] = useState(null);
  const [scheduleProgram, setScheduleProgram] = useState(null);
  const [espnLeague, setEspnLeague] = useState("nfl");
  const [espnQuery, setEspnQuery] = useState("");
  const [espnGames, setEspnGames] = useState([]);
  const [selectedEspn, setSelectedEspn] = useState(null);
  const [espnCache, setEspnCache] = useState(null);
  const [espnSearching, setEspnSearching] = useState(false);

  async function loadData() {
    const [channelsResponse, epgResponse, stateResponse] = await Promise.all([
      api("/api/channels"),
      api(`/api/epg?start=${fromLocalInput(rangeStart)}&end=${fromLocalInput(rangeEnd)}`),
      api("/api/state"),
    ]);
    if (!channelsResponse.ok) return;
    const channelsPayload = await channelsResponse.json();
    const epgPayload = await epgResponse.json();
    const statePayload = await stateResponse.json();
    setChannels(channelsPayload.channels);
    setPrograms(epgPayload.programs);
    setStatus(`${statePayload.channels} channels, ${statePayload.programs} guide items`);
  }

  useEffect(() => {
    loadData();
  }, [rangeStart, rangeEnd]);

  useEffect(() => {
    loadStaticShares();
  }, []);

  useEffect(() => {
    const needle = search.trim();
    if (needle.length < 2) {
      setSearchResults([]);
      setSearchResultsOpen(false);
      return undefined;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await api(`/api/search?q=${encodeURIComponent(needle)}`, { signal: controller.signal });
        if (!response.ok) return;
        const payload = await response.json();
        setSearchResults(payload.results);
      } catch (error) {
        if (error.name !== "AbortError") setSearchResults([]);
      }
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [search]);

  const groups = useMemo(() => Array.from(new Set(channels.map((channel) => channel.group_name || "Other"))).sort(), [channels]);

  const visibleChannels = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const matchingProgramChannels = new Set(
      programs
        .filter((program) => `${program.title} ${program.description || ""}`.toLowerCase().includes(needle))
        .map((program) => program.channel_id),
    );
    return channels.filter((channel) => {
      if (group && channel.group_name !== group) return false;
      if (!needle) return true;
      return channel.name.toLowerCase().includes(needle) || matchingProgramChannels.has(channel.id);
    });
  }, [channels, group, programs, search]);

  function toggleProgram(program) {
    const removingProgram = selectedProgramIds.has(program.id);
    setSelectedProgramIds((current) => {
      const selectedPrograms = Array.from(current).map((id) => programs.find((item) => item.id === id)).filter(Boolean);
      const next = selectedPrograms.some((item) => item.channel_id !== program.channel_id) ? new Set() : new Set(current);
      if (next.has(program.id)) next.delete(program.id);
      else next.add(program.id);
      return next;
    });
    setSelectedChannelId(program.channel_id);
    setActiveProgram(program);
    setScheduleProgram(removingProgram ? null : program);
  }

  async function refresh() {
    setStatus("Refreshing sources...");
    await api("/api/refresh", { method: "POST" });
    await loadData();
  }

  async function logout() {
    await fetch("/api/logout", { method: "POST" });
    navigate("/login");
  }

  async function createShare() {
    const response = await api("/api/shares", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...shareForm,
        programIds: Array.from(selectedProgramIds),
        channelId: selectedChannelId,
        startsAt: fromLocalInput(rangeStart),
        endsAt: fromLocalInput(rangeEnd),
        mode: selectedProgramIds.size ? "programs" : "range",
      }),
    });
    const payload = await response.json();
    if (!response.ok) {
      setShareResult(payload.error || "Could not create share.");
      return;
    }
    const url = payload.url.startsWith("/") ? `${window.location.origin}${payload.url}` : payload.url;
    setShareResult(url);
  }

  async function loadStaticShares() {
    const response = await api("/api/shares");
    if (!response.ok) return;
    const payload = await response.json();
    const schedules = (payload.shares || []).filter((share) => share.kind === "static");
    setStaticShares(schedules);
  }

  async function addToStaticSchedule(targetShare) {
    if (!targetShare?.id || selectedPrograms.length === 0) {
      setShareResult("Select one or more EPG events and a static share first.");
      return;
    }
    for (const program of selectedPrograms) {
      const response = await api(`/api/static-shares/${targetShare.id}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ programId: program.id, espn: selectedEspn }),
      });
      if (!response.ok) {
        const payload = await response.json();
        setShareResult(payload.error || "Could not add event to schedule.");
        return;
      }
    }
    setShareResult("Added selected event(s) to the static schedule.");
    setSchedulePickerOpen(false);
    navigate(`/admin/s/${targetShare.admin_ref || `static-${targetShare.id}`}`);
  }

  async function searchEspnGames() {
    setEspnSearching(true);
    setEspnCache(null);
    try {
      const start = selectedPrograms[0] ? eventStart(selectedPrograms[0]) - 7 * 24 * 60 * 60 : Math.floor(Date.now() / 1000);
      const end = selectedPrograms.at(-1) ? eventEnd(selectedPrograms.at(-1)) + 21 * 24 * 60 * 60 : start + 28 * 24 * 60 * 60;
      const response = await api(
        `/api/sports/espn/search?league=${encodeURIComponent(espnLeague)}&q=${encodeURIComponent(espnQuery)}&start=${start}&end=${end}`,
      );
      const payload = await response.json();
      if (!response.ok) {
        setShareResult(payload.error || "Could not search ESPN games.");
        return;
      }
      setEspnGames(payload.games || []);
      setEspnCache({ state: payload.cache, requestsToday: payload.requestsToday });
      if ((payload.games || []).length === 0) setShareResult("No ESPN games found for that search.");
    } finally {
      setEspnSearching(false);
    }
  }

  function shiftWindow(hours) {
    const delta = hours * 60 * 60 * 1000;
    setRangeStart(toLocalInput(new Date(new Date(rangeStart).getTime() + delta)));
    setRangeEnd(toLocalInput(new Date(new Date(rangeEnd).getTime() + delta)));
  }

  function jumpToNow() {
    const duration = new Date(rangeEnd).getTime() - new Date(rangeStart).getTime();
    const start = new Date(Date.now() - 30 * 60 * 1000);
    setRangeStart(toLocalInput(start));
    setRangeEnd(toLocalInput(new Date(start.getTime() + duration)));
  }

  function setWindowHours(hours) {
    const start = new Date(rangeStart);
    setRangeEnd(toLocalInput(new Date(start.getTime() + hours * 60 * 60 * 1000)));
  }

  function openSearchResult(program) {
    const start = new Date(program.start_at * 1000 - 30 * 60 * 1000);
    const end = new Date(program.end_at * 1000 + 90 * 60 * 1000);
    setRangeStart(toLocalInput(start));
    setRangeEnd(toLocalInput(end));
    setSelectedChannelId(program.channel_id);
    setSelectedProgramIds(new Set([program.id]));
    setActiveProgram(program);
    setScheduleProgram(program);
    setSearchResults([]);
    setSearchResultsOpen(false);
  }

  const selectedPrograms = Array.from(selectedProgramIds)
    .map((id) => programs.find((program) => program.id === id) || (scheduleProgram?.id === id ? scheduleProgram : null))
    .filter(Boolean)
    .sort((a, b) => eventStart(a) - eventStart(b));

  const selectedSummary = selectedPrograms.length
    ? `${selectedPrograms.length} selected: ${formatDateTime.format(new Date(eventStart(selectedPrograms[0]) * 1000))} - ${formatDateTime.format(new Date(eventEnd(selectedPrograms.at(-1)) * 1000))}`
    : selectedChannelId
      ? `${channels.find((channel) => channel.id === selectedChannelId)?.name || "Channel"}: ${formatDateTime.format(new Date(rangeStart))} - ${formatDateTime.format(new Date(rangeEnd))}`
      : "Select one or more shows, or choose a channel and time window.";

  return (
    <main className="appShell">
      <header className="guidePageHeader">
        <div className="guideHeaderTop">
          <div className="guideTitleBlock">
            <h1>IPTV Share</h1>
            <p>{status}</p>
          </div>
          <div className="toolbar">
            <button type="button" onClick={() => navigate("/admin")}>Shares</button>
            <button type="button" onClick={refresh}>Refresh</button>
            <button type="button" onClick={logout}>Log out</button>
          </div>
        </div>

        <section className="guideCommandBar">
          <div
            className="searchBox"
            onFocus={() => setSearchResultsOpen(true)}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) setSearchResultsOpen(false);
            }}
          >
            <label>
              Search
              <input
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setSearchResultsOpen(true);
                }}
                type="search"
                placeholder="Channel or show"
              />
            </label>
            {searchResultsOpen && searchResults.length > 0 && (
              <div className="searchResults">
                {searchResults.map((program) => (
                  <button key={program.id} type="button" onClick={() => openSearchResult(program)}>
                    {(program.icon_url || program.channel_logo) && <img src={program.icon_url || program.channel_logo} alt="" />}
                    <span>
                      <strong>{program.title}</strong>
                      <small>{program.channel_name} · {formatDateTime.format(new Date(program.start_at * 1000))} - {formatDateTime.format(new Date(program.end_at * 1000))}</small>
                      {program.category && <em>{program.category}</em>}
                      {program.description && <p>{program.description}</p>}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <label>
            Group
            <select value={group} onChange={(event) => setGroup(event.target.value)}>
              <option value="">All groups</option>
              {groups.map((item) => <option key={item}>{item}</option>)}
            </select>
          </label>
          <label>
            Start
            <input value={rangeStart} onChange={(event) => setRangeStart(event.target.value)} type="datetime-local" />
          </label>
          <label>
            End
            <input value={rangeEnd} onChange={(event) => setRangeEnd(event.target.value)} type="datetime-local" />
          </label>
          <div className="timeControls">
            <button type="button" onClick={() => shiftWindow(-6)}>Back 6h</button>
            <button type="button" onClick={jumpToNow}>Now</button>
            <button type="button" onClick={() => shiftWindow(6)}>Next 6h</button>
            <button type="button" onClick={() => setWindowHours(12)}>Show 12h</button>
            <button type="button" onClick={() => shiftWindow(24)}>Next 24h</button>
            <button type="button" onClick={() => shiftWindow(48)}>Next 48h</button>
          </div>
        </section>
      </header>

      <GuideGrid
        channels={visibleChannels}
        programs={programs}
        start={fromLocalInput(rangeStart)}
        end={fromLocalInput(rangeEnd)}
        selectedChannelId={selectedChannelId}
        selectedProgramIds={selectedProgramIds}
        onChannelSelect={(channelId) => {
          setSelectedChannelId(channelId);
          setSelectedProgramIds(new Set());
          setScheduleProgram(null);
        }}
        onProgramToggle={toggleProgram}
        onProgramInspect={setActiveProgram}
      />

      {activeProgram && <EventPeek program={activeProgram} onClose={() => setActiveProgram(null)} />}

      <aside className="selectionPanel">
        <div className="selectionPanelTop">
          <div className="selectionSummary">
            <span>Create Share</span>
            <h2>{selectedPrograms.length ? `${selectedPrograms.length} event${selectedPrograms.length === 1 ? "" : "s"} selected` : selectedChannelId ? "Time window selected" : "Nothing selected"}</h2>
            <p>{selectedSummary}</p>
          </div>
          <div className="selectionActions">
            <button type="button" onClick={() => {
              setSelectedProgramIds(new Set());
              setSelectedChannelId(null);
              setScheduleProgram(null);
              setShareResult("");
            }}>Clear</button>
            <button type="button" disabled={!selectedProgramIds.size} onClick={async () => {
              await loadStaticShares();
              setEspnQuery(selectedPrograms[0]?.title || "");
              setEspnGames([]);
              setSelectedEspn(null);
              setEspnCache(null);
              setSchedulePickerOpen(true);
            }}>Add to Schedule</button>
            <button type="button" className="primary" onClick={createShare}>Create Link</button>
          </div>
        </div>
        <div className="panelFields">
          <label>
            Link
            <input value={shareForm.slug} onChange={(event) => setShareForm({ ...shareForm, slug: event.target.value })} placeholder="optional-name" />
          </label>
          <label>
            Title
            <input value={shareForm.title} onChange={(event) => setShareForm({ ...shareForm, title: event.target.value })} placeholder="Optional display title" />
          </label>
          <label>
            Share password
            <input value={shareForm.password} onChange={(event) => setShareForm({ ...shareForm, password: event.target.value })} type="password" placeholder="Optional" />
          </label>
          <label>
            Max viewers
            <input value={shareForm.maxViewers} onChange={(event) => setShareForm({ ...shareForm, maxViewers: event.target.value })} type="number" min="0" placeholder="Unlimited" />
          </label>
        </div>
        <p className="shareResult">{shareResult && (shareResult.startsWith("http") ? <a href={shareResult} target="_blank" rel="noreferrer">{shareResult}</a> : shareResult)}</p>
      </aside>

      {schedulePickerOpen && (
        <section className="schedulePickerOverlay" role="dialog" aria-modal="true" aria-label="Add selected events to schedule">
          <div className="schedulePickerModal">
            <div className="schedulePickerHeader">
              <div>
                <h2>Add to Schedule</h2>
                <p>{selectedSummary}</p>
              </div>
              <button type="button" onClick={() => setSchedulePickerOpen(false)}>Close</button>
            </div>
            <section className="schedulePickerSports">
              <div className="selectedEventCard">
                <span>Selected EPG Event{selectedPrograms.length === 1 ? "" : "s"}</span>
                <strong>{selectedPrograms.map((program) => program.title).join(", ")}</strong>
                <p>
                  {selectedPrograms[0]?.channel_name || "Channel"} · {selectedPrograms.length} event{selectedPrograms.length === 1 ? "" : "s"} selected
                </p>
              </div>
              <div className="sportsSearch">
                <select value={espnLeague} onChange={(event) => setEspnLeague(event.target.value)}>
                  <option value="nfl">NFL</option>
                  <option value="mlb">MLB</option>
                  <option value="nba">NBA</option>
                  <option value="ncaafb">College Football</option>
                  <option value="ncaamb">Men's College Basketball</option>
                </select>
                <input value={espnQuery} onChange={(event) => setEspnQuery(event.target.value)} placeholder="Search ESPN games, e.g. Bears" />
                <button type="button" onClick={searchEspnGames} disabled={espnSearching}>{espnSearching ? "Searching..." : "Search ESPN"}</button>
                <button type="button" onClick={() => setSelectedEspn(null)} disabled={!selectedEspn}>Clear ESPN</button>
              </div>
              {selectedEspn && <p className="shareResult">Will link ESPN game: {selectedEspn.shortName || selectedEspn.name}</p>}
              {espnCache && <p className="cacheNote">ESPN cache: {espnCache.state} · {espnCache.requestsToday} outbound requests today</p>}
              {espnGames.length > 0 && (
                <div className="espnResults">
                  {espnGames.map((game) => (
                    <button key={game.id} type="button" className={selectedEspn?.id === game.id ? "active" : ""} onClick={() => setSelectedEspn(game)}>
                      <strong>{game.shortName || game.name}</strong>
                      <span>{formatDateTime.format(new Date(game.date))} · {game.status || game.leagueLabel}</span>
                    </button>
                  ))}
                </div>
              )}
            </section>
            <div className="schedulePickerList">
              {staticShares.length === 0 && <p className="emptyState">No static shares yet.</p>}
              {staticShares.map((share) => (
                <button key={share.admin_ref || share.id} type="button" onClick={() => addToStaticSchedule(share)}>
                  <strong>{share.title || share.slug}</strong>
                  <span>{share.event_count} scheduled · {share.next_event_at ? `Next ${formatDateTime.format(new Date(share.next_event_at * 1000))}` : "No upcoming events"}</span>
                  <small>/s/{share.slug}</small>
                </button>
              ))}
            </div>
          </div>
        </section>
      )}
    </main>
  );
}

export default AppGuide;

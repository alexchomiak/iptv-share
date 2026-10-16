import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api.js";
import { navigate } from "../../lib/navigation.js";
import { eventEnd, eventStart, formatDateTime, fromLocalInput, toLocalInput } from "../../lib/time.js";
import EventPeek from "./EventPeek.jsx";
import GuideGrid from "./GuideGrid.jsx";
import Modal from "./Modal.jsx";
import { buildScheduleEvents } from "../../lib/shareSchedule.js";
import useGuidePrograms from "./useGuidePrograms.js";

function AppGuide() {
  const initialStart = useMemo(() => toLocalInput(new Date(Date.now() - 30 * 60 * 1000)), []);
  const initialEnd = useMemo(() => toLocalInput(new Date(Date.now() + 8 * 60 * 60 * 1000)), []);
  const [channels, setChannels] = useState([]);
  const [viewport, setViewport] = useState(null);
  const [guideGeneration, setGuideGeneration] = useState(0);
  const [jumpRequest, setJumpRequest] = useState(null);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const { programs, loading: guideLoading, error: guideError } = useGuidePrograms(channels, viewport, guideGeneration);
  const [searchResults, setSearchResults] = useState([]);
  const [searchResultsOpen, setSearchResultsOpen] = useState(false);
  const [status, setStatus] = useState("Loading guide...");
  const [search, setSearch] = useState("");
  const [rangeStart, setRangeStart] = useState(initialStart);
  const [rangeEnd, setRangeEnd] = useState(initialEnd);
  const [selectedChannelId, setSelectedChannelId] = useState(null);
  const [selection, setSelection] = useState(new Map());
  const selectedProgramIds = useMemo(() => new Set(selection.keys()), [selection]);
  const [shareForm, setShareForm] = useState({ slug: "", title: "", password: "", maxViewers: "" });
  const [staticShares, setStaticShares] = useState([]);
  const [shareDestination, setShareDestination] = useState("link");
  const [targetScheduleId, setTargetScheduleId] = useState("");
  const [scheduleResult, setScheduleResult] = useState(null);
  const [scheduleLoadError, setScheduleLoadError] = useState("");
  const postedScheduleItems = useRef(new Set());
  const [shareResult, setShareResult] = useState("");
  const [activeProgram, setActiveProgram] = useState(null);
  const [espnLeague, setEspnLeague] = useState("nfl");
  const [espnQuery, setEspnQuery] = useState("");
  const [espnGames, setEspnGames] = useState([]);
  const [selectedEspn, setSelectedEspn] = useState(null);
  const [espnCache, setEspnCache] = useState(null);
  const [espnSearching, setEspnSearching] = useState(false);

  async function loadData() {
    try {
      const [channelsResponse, stateResponse] = await Promise.all([api("/api/channels"), api("/api/state")]);
      if (!channelsResponse.ok || !stateResponse.ok) throw new Error("Could not load the guide.");
      const channelsPayload = await channelsResponse.json();
      const statePayload = await stateResponse.json();
      setChannels(channelsPayload.channels);
      setStatus(`${statePayload.channels} channels · ${statePayload.programs.toLocaleString()} guide items`);
    } catch (error) { setStatus(error.message); }
  }

  useEffect(() => { loadData(); }, []);

  useEffect(() => {
    loadStaticShares();
  }, []);

  useEffect(() => {
    const needle = search.trim();
    setSearchResults([]);
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

  const visibleChannels = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return channels;
    const matchingProgramChannels = new Set([
      ...programs.filter(program => `${program.title} ${program.description || ""}`.toLowerCase().includes(needle)).map(program => program.channel_id),
      ...searchResults.map(program => program.channel_id),
    ]);
    return channels.filter(channel => `${channel.name} ${channel.group_name || ""}`.toLowerCase().includes(needle) || matchingProgramChannels.has(channel.id));
  }, [channels, programs, search, searchResults]);

  function toggleProgram(program) {
    setSelection(current => {
      const next = [...current.values()].some(item => item.channel_id !== program.channel_id) ? new Map() : new Map(current);
      if (next.has(program.id)) next.delete(program.id);
      else next.set(program.id, program);
      return next;
    });
    setSelectedChannelId(program.channel_id);
    setSelectedEspn(null);
    setScheduleResult(null);
    setShareResult("");
  }

  async function refresh() {
    setStatus("Refreshing sources...");
    await api("/api/refresh", { method: "POST" });
    await loadData();
    setGuideGeneration(current => current + 1);
  }

  async function logout() {
    await fetch("/api/logout", { method: "POST" });
    navigate("/login");
  }

  async function createShare() {
    if (creating) return;
    if (!selectedChannelId) { setShareResult("Choose a channel or programme first."); return; }
    if (!selectedProgramIds.size && !(fromLocalInput(rangeStart) < fromLocalInput(rangeEnd))) {
      setShareResult("End time must be after start time."); return;
    }
    setCreating(true);
    setShareResult("");
    try {
      const response = await api("/api/shares", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...shareForm, programIds: Array.from(selectedProgramIds), channelId: selectedChannelId,
          startsAt: fromLocalInput(rangeStart), endsAt: fromLocalInput(rangeEnd), mode: selectedProgramIds.size ? "programs" : "range" }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not create share.");
      setShareResult(payload.url.startsWith("/") ? `${window.location.origin}${payload.url}` : payload.url);
    } catch (error) { setShareResult(error.message || "Could not create share."); }
    finally { setCreating(false); }
  }

  async function loadStaticShares() {
    setScheduleLoadError("");
    try {
      const response = await api("/api/shares");
      if (!response.ok) throw new Error("Could not load static schedules.");
      const payload = await response.json();
      setStaticShares((payload.shares || []).filter(share => share.kind === "static"));
    } catch (error) { setScheduleLoadError(error.message); }
  }

  async function addToStaticSchedule() {
    if (creating || scheduleResult) return;
    const targetShare = staticShares.find(share => String(share.id) === targetScheduleId);
    if (!targetShare) { setShareResult("Choose a static schedule."); return; }
    let events;
    try {
      events = buildScheduleEvents({ programs: selectedPrograms,
        channel: channels.find(channel => channel.id === selectedChannelId),
        start: fromLocalInput(rangeStart), end: fromLocalInput(rangeEnd), title: shareForm.title, espn: selectedEspn, league: espnLeague });
    } catch (error) { setShareResult(error.message); return; }
    setCreating(true);
    setShareResult("");
    try {
      for (const event of events) {
        const key = `${targetShare.id}:${JSON.stringify(event)}`;
        if (postedScheduleItems.current.has(key)) continue;
        const response = await api(`/api/static-shares/${targetShare.id}/events`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(event),
        });
        if (!response.ok) {
          const payload = await response.json();
          throw new Error(payload.error || "Could not add event to schedule.");
        }
        postedScheduleItems.current.add(key);
      }
      setScheduleResult(targetShare);
      setShareResult(`Added ${events.length} event${events.length === 1 ? "" : "s"} to ${targetShare.title || targetShare.slug}.`);
      loadStaticShares();
    } catch (error) { setShareResult(error.message || "Could not add event to schedule. You can retry without repeating confirmed additions."); }
    finally { setCreating(false); }
  }

  function changeDestination(value) {
    setShareDestination(value);
    setShareResult("");
    setScheduleResult(null);
    if (value === "schedule") {
      loadStaticShares();
      if (!espnQuery) setEspnQuery(selectedPrograms[0]?.title || "");
    }
  }

  async function searchEspnGames() {
    setEspnSearching(true);
    setEspnCache(null);
    try {
      const start = selectedPrograms[0] ? eventStart(selectedPrograms[0]) - 7 * 24 * 60 * 60 : fromLocalInput(rangeStart) - 7 * 24 * 60 * 60;
      const end = selectedPrograms.at(-1) ? eventEnd(selectedPrograms.at(-1)) + 21 * 24 * 60 * 60 : fromLocalInput(rangeEnd) + 21 * 24 * 60 * 60;
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
    } catch (error) { setShareResult(error.message || "Could not search ESPN games."); }
    finally { setEspnSearching(false); }
  }

  function openSearchResult(program) {
    setSearch("");
    setSelectedChannelId(program.channel_id);
    setSelection(new Map([[program.id, program]]));
    setActiveProgram(program);
    setSelectedEspn(null);
    setScheduleResult(null);
    setShareResult("");
    setJumpRequest({ time: program.start_at, channelId: program.channel_id, nonce: Date.now() });
    setSearchResultsOpen(false);
  }

  const selectedPrograms = [...selection.values()].sort((a, b) => eventStart(a) - eventStart(b));

  function selectChannel(channelId) {
    setSelectedChannelId(channelId);
    setSelection(new Map());
    setActiveProgram(null);
    setSelectedEspn(null);
    setScheduleResult(null);
    setShareResult("");
  }

  function changeShareStart(event) { setRangeStart(event.currentTarget.value); setScheduleResult(null); setShareResult(""); }
  function changeShareEnd(event) { setRangeEnd(event.currentTarget.value); setScheduleResult(null); setShareResult(""); }

  const selectedSummary = selectedPrograms.length
    ? `${selectedPrograms.length} selected: ${formatDateTime.format(new Date(eventStart(selectedPrograms[0]) * 1000))} - ${formatDateTime.format(new Date(eventEnd(selectedPrograms.at(-1)) * 1000))}`
    : selectedChannelId && shareDestination === "schedule" && selectedEspn
      ? `${channels.find(channel => channel.id === selectedChannelId)?.name || "Channel"}: ${selectedEspn.name || selectedEspn.shortName} · ${formatDateTime.format(new Date(selectedEspn.date))}`
    : selectedChannelId
      ? `${channels.find((channel) => channel.id === selectedChannelId)?.name || "Channel"}: ${Number.isFinite(fromLocalInput(rangeStart)) ? formatDateTime.format(new Date(rangeStart)) : "Choose start"} - ${Number.isFinite(fromLocalInput(rangeEnd)) ? formatDateTime.format(new Date(rangeEnd)) : "Choose end"}`
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
                placeholder="Search channels, groups or programmes…"
                aria-label="Search channels, groups or programmes"
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
        </section>
      </header>

      <GuideGrid
        channels={visibleChannels}
        programs={programs}
        selectedChannelId={selectedChannelId}
        selectedProgramIds={selectedProgramIds}
        onViewportChange={setViewport}
        loading={guideLoading}
        error={guideError}
        onRetry={() => setGuideGeneration(current => current + 1)}
        jumpRequest={jumpRequest}
        onChannelSelect={selectChannel}
        onProgramToggle={toggleProgram}
        onProgramInspect={setActiveProgram}
      />

      {activeProgram && <EventPeek program={activeProgram} onClose={() => setActiveProgram(null)} />}

      <button type="button" className="primary floatingCreateShare" onClick={() => { setActiveProgram(null); setCreateModalOpen(true); }}>
        <span aria-hidden="true">＋</span> Create Share
        {(selectedPrograms.length > 0 || selectedChannelId) && <small>{selectedPrograms.length ? `${selectedPrograms.length} selected` : "Channel selected"}</small>}
      </button>

      {createModalOpen && <Modal title="Create Share" onClose={() => setCreateModalOpen(false)}>
        <form className="createShareForm" onSubmit={event => { event.preventDefault(); if (shareDestination === "schedule") addToStaticSchedule(); else createShare(); }}>
          <fieldset className="shareDestination" disabled={creating}>
            <legend>Share destination</legend>
            <label><input type="radio" name="share-destination" checked={shareDestination === "link"} onChange={() => changeDestination("link")} /><span><strong>New share link</strong><small>Create a standalone link</small></span></label>
            <label><input type="radio" name="share-destination" checked={shareDestination === "schedule"} onChange={() => changeDestination("schedule")} /><span><strong>Static schedule</strong><small>Add to an existing share</small></span></label>
          </fieldset>
          <div className="selectionSummary">
            <span>{selectedPrograms.length ? "Programme share" : "Channel share"}</span>
            <p>{selectedSummary}</p>
          </div>
          {selectedPrograms.length > 0 ? <div className="selectedProgrammeList">
            {selectedPrograms.map(program => <article key={program.id}><strong>{program.title}</strong><small>{formatDateTime.format(new Date(eventStart(program) * 1000))} – {formatDateTime.format(new Date(eventEnd(program) * 1000))}</small></article>)}
            <button type="button" disabled={creating} onClick={() => { setSelection(new Map()); setSelectedEspn(null); setScheduleResult(null); setShareResult(""); }}>Use a channel time window instead</button>
          </div> : <>
            <label>Channel<select required disabled={creating} value={selectedChannelId || ""} onChange={event => selectChannel(Number(event.target.value) || null)}>
              <option value="">Choose a channel</option>{channels.map(channel => <option key={channel.id} value={channel.id}>{channel.name}</option>)}
            </select></label>
            {!(shareDestination === "schedule" && selectedEspn) && <div className="shareTimeFields">
              <label>Starts<input type="datetime-local" required disabled={creating} value={rangeStart} onInput={changeShareStart} onChange={changeShareStart} /></label>
              <label>Ends<input type="datetime-local" required disabled={creating} min={rangeStart} value={rangeEnd} onInput={changeShareEnd} onChange={changeShareEnd} /></label>
            </div>}
          </>}
          {(shareDestination === "link" || (!selectedPrograms.length && !selectedEspn)) && <label>Title<input value={shareForm.title} onChange={event => setShareForm({ ...shareForm, title: event.target.value })} placeholder={shareDestination === "schedule" ? "Defaults to channel name" : "Optional display title"} /></label>}
          {shareDestination === "link" && <label>Link name<input value={shareForm.slug} onChange={event => setShareForm({ ...shareForm, slug: event.target.value })} placeholder="Optional · a unique link is generated otherwise" /></label>}
          {shareDestination === "schedule" && <section className="inlineScheduleFields" aria-label="Static schedule options">
            <label>Static schedule<select required disabled={creating} value={targetScheduleId} onChange={event => {
              setTargetScheduleId(event.target.value); setScheduleResult(null); setShareResult("");
            }}><option value="">Choose a schedule</option>{staticShares.map(share => <option key={share.id} value={share.id}>{share.title || share.slug}</option>)}</select></label>
            {scheduleLoadError && <p role="alert">{scheduleLoadError} <button type="button" onClick={loadStaticShares}>Retry</button></p>}
            {!scheduleLoadError && !staticShares.length && <p className="fieldHint">No static schedules yet. <a href="/admin">Create one in Shares</a>, then add events here.</p>}
            <details className="shareAdvanced sportsLinkOptions"><summary>Link ESPN game (optional){selectedEspn ? " · linked" : ""}</summary>
              <div className="shareAdvancedFields">
                <p className="fieldHint">{selectedPrograms.length ? "Link sports coverage to the selected programme(s)." : "An ESPN game supplies its kickoff time and live sports window. Otherwise, use your channel time window above."}</p>
                <div className="inlineSportsSearch">
                  <label>League<select value={espnLeague} disabled={espnSearching || creating} onChange={event => { setEspnLeague(event.target.value); setSelectedEspn(null); setEspnGames([]); setEspnCache(null); setScheduleResult(null); }}>
                    <option value="nfl">NFL</option><option value="mlb">MLB</option><option value="nba">NBA</option><option value="ncaafb">College Football</option><option value="ncaamb">Men’s College Basketball</option>
                  </select></label>
                  <label>ESPN search<input value={espnQuery} onChange={event => setEspnQuery(event.target.value)} placeholder="Team or matchup" /></label>
                  <button type="button" disabled={espnSearching || creating} onClick={searchEspnGames}>{espnSearching ? "Searching…" : "Search ESPN"}</button>
                </div>
                {selectedEspn && <div className="linkedSportsGame"><strong>{selectedEspn.name || selectedEspn.shortName}</strong><small>{formatDateTime.format(new Date(selectedEspn.date))}</small>
                  <button type="button" disabled={creating} onClick={() => { setSelectedEspn(null); setScheduleResult(null); setShareResult(""); }}>Remove ESPN link</button></div>}
                {espnCache && <p className="fieldHint">{espnGames.length} game{espnGames.length === 1 ? "" : "s"} found</p>}
                {espnGames.length > 0 && <div className="espnResults">{espnGames.map(game => <button key={game.id} type="button" disabled={creating} aria-pressed={selectedEspn?.id === game.id} className={selectedEspn?.id === game.id ? "active" : ""}
                  onClick={() => { setSelectedEspn(game); setScheduleResult(null); setShareResult(""); }}><strong>{game.shortName || game.name}</strong><span>{formatDateTime.format(new Date(game.date))} · {game.status || game.leagueLabel}</span></button>)}</div>}
              </div>
            </details>
          </section>}
          <details className="shareAdvanced"><summary>Advanced settings</summary>
            <div className="shareAdvancedFields">
              {shareDestination === "link" ? <>
              <label>Share password<input type="password" value={shareForm.password} onChange={event => setShareForm({ ...shareForm, password: event.target.value })} placeholder="Optional" autoComplete="new-password" /></label>
              <label>Max viewers<input type="number" min="1" value={shareForm.maxViewers} onChange={event => setShareForm({ ...shareForm, maxViewers: event.target.value })} placeholder="Unlimited" /></label>
              </> : <p className="fieldHint">Events inherit the static share’s password, viewer limit, Discord webhook and spoiler delay.
                {targetScheduleId && <> <a href={`/admin/s/${staticShares.find(share => String(share.id) === targetScheduleId)?.admin_ref || `static-${targetScheduleId}`}`}>Manage schedule settings</a></>}
              </p>}
            </div>
          </details>
          {shareResult && <div className="shareModalResult" role="status">{shareResult.startsWith("http") ? <>
            <strong>Share link ready</strong><a href={shareResult} target="_blank" rel="noreferrer">{shareResult}</a>
            <button type="button" onClick={async () => { try { await navigator.clipboard.writeText(shareResult); } catch { /* The visible link remains selectable. */ } }}>Copy link</button>
          </> : <>{shareResult}{scheduleResult && <a href={`/admin/s/${scheduleResult.admin_ref || `static-${scheduleResult.id}`}`}>Open schedule</a>}</>}</div>}
          <footer className="createShareActions">
            <button type="button" disabled={creating} onClick={() => { selectChannel(null); }}>Clear</button>
            <button type="button" disabled={creating} onClick={() => setCreateModalOpen(false)}>Close</button>
            <button type="submit" className="primary" disabled={creating || !selectedChannelId || (shareDestination === "schedule" && (!targetScheduleId || Boolean(scheduleResult)))}>
              {creating ? (shareDestination === "schedule" ? "Adding…" : "Creating…") : shareDestination === "schedule" ? (scheduleResult ? "Added to Schedule" : "Add to Schedule") : "Create Link"}
            </button>
          </footer>
        </form>
      </Modal>}

    </main>
  );
}

export default AppGuide;

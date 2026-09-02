import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import Hls from "hls.js";
import mpegts from "mpegts.js";
import "./styles.css";

const formatTime = new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" });
const formatDateTime = new Intl.DateTimeFormat([], { dateStyle: "medium", timeStyle: "short" });

function toLocalInput(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromLocalInput(value) {
  return Math.floor(new Date(value).getTime() / 1000);
}

function eventStart(event) {
  return Number(event.start_at ?? event.starts_at ?? 0);
}

function eventEnd(event) {
  return Number(event.end_at ?? event.ends_at ?? 0);
}

async function api(path, options) {
  const response = await fetch(path, options);
  if (response.status === 401 && !path.startsWith("/api/public")) {
    window.history.replaceState(null, "", "/login");
    window.dispatchEvent(new Event("locationchange"));
  }
  return response;
}

function useLocationPath() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const update = () => setPath(window.location.pathname);
    window.addEventListener("popstate", update);
    window.addEventListener("locationchange", update);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener("locationchange", update);
    };
  }, []);
  return path;
}

function navigate(path) {
  window.history.pushState(null, "", path);
  window.dispatchEvent(new Event("locationchange"));
}

function Login() {
  const [message, setMessage] = useState("");

  async function submit(event) {
    event.preventDefault();
    const payload = Object.fromEntries(new FormData(event.currentTarget));
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (response.ok) navigate("/");
    else setMessage("Invalid username or password.");
  }

  return (
    <main className="loginPage">
      <form className="loginCard" onSubmit={submit}>
        <h1>IPTV Share</h1>
        <label>
          Username
          <input name="username" autoComplete="username" required />
        </label>
        <label>
          Password
          <input name="password" type="password" autoComplete="current-password" required />
        </label>
        <button type="submit">Log in</button>
        <p>{message}</p>
      </form>
    </main>
  );
}

function AppGuide() {
  const initialStart = useMemo(() => toLocalInput(new Date(Date.now() - 30 * 60 * 1000)), []);
  const initialEnd = useMemo(() => toLocalInput(new Date(Date.now() + 8 * 60 * 60 * 1000)), []);
  const [channels, setChannels] = useState([]);
  const [programs, setPrograms] = useState([]);
  const [searchResults, setSearchResults] = useState([]);
  const [status, setStatus] = useState("Loading guide...");
  const [search, setSearch] = useState("");
  const [group, setGroup] = useState("");
  const [rangeStart, setRangeStart] = useState(initialStart);
  const [rangeEnd, setRangeEnd] = useState(initialEnd);
  const [selectedChannelId, setSelectedChannelId] = useState(null);
  const [selectedProgramIds, setSelectedProgramIds] = useState(new Set());
  const [shareForm, setShareForm] = useState({ slug: "", title: "", password: "" });
  const [shareResult, setShareResult] = useState("");
  const [sharesOpen, setSharesOpen] = useState(false);
  const [shares, setShares] = useState([]);
  const [activeProgram, setActiveProgram] = useState(null);
  const [scheduleProgram, setScheduleProgram] = useState(null);

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
    const needle = search.trim();
    if (needle.length < 2) {
      setSearchResults([]);
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
    if (sharesOpen) loadShares();
  }

  async function loadShares() {
    const response = await api("/api/shares");
    if (!response.ok) return;
    const payload = await response.json();
    setShares(payload.shares);
  }

  async function deleteShare(id) {
    await api(`/api/shares/${id}`, { method: "DELETE" });
    await loadShares();
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
    <main className={`appShell ${sharesOpen ? "sharesVisible" : ""}`}>
      <header className="topbar">
        <div>
          <h1>IPTV Share</h1>
          <p>{status}</p>
        </div>
        <div className="toolbar">
          <button type="button" onClick={() => {
            const next = !sharesOpen;
            setSharesOpen(next);
            if (next) loadShares();
          }}>Shares</button>
          <button type="button" onClick={refresh}>Refresh</button>
          <button type="button" onClick={logout}>Log out</button>
        </div>
      </header>

      <section className="controls">
        <div className="searchBox">
          <label>
            Search
            <input value={search} onChange={(event) => setSearch(event.target.value)} type="search" placeholder="Channel or show" />
          </label>
          {searchResults.length > 0 && (
            <div className="searchResults">
              {searchResults.map((program) => (
                <button key={program.id} type="button" onClick={() => openSearchResult(program)}>
                  {program.channel_logo && <img src={program.channel_logo} alt="" />}
                  <span>
                    <strong>{program.title}</strong>
                    <small>{program.channel_name} · {formatDateTime.format(new Date(program.start_at * 1000))}</small>
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

      {sharesOpen && (
        <ShareAdmin
          shares={shares}
          selectedProgram={scheduleProgram}
          onRefresh={loadShares}
          onDelete={deleteShare}
          onClose={() => setSharesOpen(false)}
        />
      )}

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
        <div>
          <h2>Create Share</h2>
          <p>{selectedSummary}</p>
        </div>
        <div className="panelFields">
          <label>
            Link name
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
        </div>
        <div className="toolbar">
          <button type="button" onClick={() => {
            setSelectedProgramIds(new Set());
            setSelectedChannelId(null);
            setScheduleProgram(null);
            setShareResult("");
          }}>Clear</button>
          <button type="button" className="primary" onClick={createShare}>Create Link</button>
        </div>
        <p className="shareResult">{shareResult && (shareResult.startsWith("http") ? <a href={shareResult} target="_blank" rel="noreferrer">{shareResult}</a> : shareResult)}</p>
      </aside>
    </main>
  );
}

function EventPeek({ program, onClose }) {
  return (
    <section className="eventPeek">
      {(program.icon_url || program.icon) && <img src={program.icon_url || program.icon} alt="" />}
      <div>
        <strong>{program.title}</strong>
        <span>{program.channel_name} · {formatDateTime.format(new Date(program.start_at * 1000))} - {formatTime.format(new Date(program.end_at * 1000))}</span>
        {program.category && <small>{program.category}</small>}
        <p>{program.description || "No description in the EPG."}</p>
      </div>
      <button type="button" onClick={onClose}>Close</button>
    </section>
  );
}

function ShareAdmin({ shares, selectedProgram, onRefresh, onClose }) {
  const [staticForm, setStaticForm] = useState({ slug: "", title: "", description: "", icon: "", password: "" });
  const [settingsForm, setSettingsForm] = useState({ title: "", description: "", icon: "", password: "", clearPassword: false });
  const [message, setMessage] = useState("");
  const [editing, setEditing] = useState(null);
  const [espnQuery, setEspnQuery] = useState("");
  const [espnLeague, setEspnLeague] = useState("nfl");
  const [espnGames, setEspnGames] = useState([]);
  const [selectedEspn, setSelectedEspn] = useState(null);
  const [espnCache, setEspnCache] = useState(null);

  async function createStaticShare() {
    const response = await api("/api/static-shares", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(staticForm),
    });
    const payload = await response.json();
    if (!response.ok) {
      setMessage(payload.error || "Could not create static share.");
      return;
    }
    setStaticForm({ slug: "", title: "", description: "", icon: "", password: "" });
    setMessage(`Created ${payload.url}`);
    await onRefresh();
  }

  async function openStaticShare(share) {
    const response = await api(`/api/static-shares/${share.id}`);
    const payload = await response.json();
    if (response.ok) {
      setEditing(payload.share);
      setSettingsForm({
        title: payload.share.title || "",
        description: payload.share.description || "",
        icon: payload.share.icon || "",
        password: "",
        clearPassword: false,
      });
    }
  }

  async function saveStaticShareSettings() {
    if (!editing) return;
    const response = await api(`/api/static-shares/${editing.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settingsForm),
    });
    const payload = await response.json();
    if (!response.ok) {
      setMessage(payload.error || "Could not save share settings.");
      return;
    }
    setEditing(payload.share);
    setSettingsForm({
      title: payload.share.title || "",
      description: payload.share.description || "",
      icon: payload.share.icon || "",
      password: "",
      clearPassword: false,
    });
    setMessage("Saved share settings.");
    await onRefresh();
  }

  async function deleteAnyShare(share) {
    await api(share.kind === "static" ? `/api/static-shares/${share.id}` : `/api/shares/${share.id}`, { method: "DELETE" });
    if (editing?.id === share.id && share.kind === "static") setEditing(null);
    await onRefresh();
  }

  async function searchEspn() {
    const nowDate = Math.floor(Date.now() / 1000);
    const response = await api(
      `/api/sports/espn/search?league=${encodeURIComponent(espnLeague)}&q=${encodeURIComponent(espnQuery)}&start=${nowDate}&end=${nowDate + 60 * 24 * 60 * 60}`,
    );
    const payload = await response.json();
    if (!response.ok) {
      setMessage(payload.error || "ESPN search failed.");
      return;
    }
    setEspnGames(payload.games);
    setEspnCache({
      state: payload.cache,
      fetchedAt: payload.fetchedAt,
      requestsToday: payload.requestsToday,
    });
  }

  async function addSelectedProgram() {
    if (!editing || !selectedProgram) return;
    const response = await api(`/api/static-shares/${editing.id}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ programId: selectedProgram.id, espn: selectedEspn }),
    });
    const payload = await response.json();
    if (!response.ok) {
      setMessage(payload.error || "Could not add event.");
      return;
    }
    await openStaticShare(editing);
    setSelectedEspn(null);
    setMessage("Added event to schedule.");
  }

  async function removeScheduledEvent(eventId) {
    await api(`/api/static-shares/${editing.id}/events/${eventId}`, { method: "DELETE" });
    await openStaticShare(editing);
  }

  return (
    <section className="shareAdmin">
      <div className="shareAdminHeader">
        <div>
          <h2>Share Manager</h2>
          <p>Manage permanent schedules, one-off links, and ESPN game matching.</p>
        </div>
        <div className="toolbar">
          <button type="button" onClick={onRefresh}>Reload</button>
          <button type="button" onClick={onClose}>Close</button>
        </div>
      </div>

      <div className="shareManagerBody">
        <aside className="shareManagerList">
          <form className="staticShareCreator" onSubmit={(event) => {
            event.preventDefault();
            createStaticShare();
          }}>
            <h3>New Static Share</h3>
            <input value={staticForm.slug} onChange={(event) => setStaticForm({ ...staticForm, slug: event.target.value })} placeholder="da-bears" />
            <input value={staticForm.title} onChange={(event) => setStaticForm({ ...staticForm, title: event.target.value })} placeholder="Bears Watch Schedule" />
            <input value={staticForm.description} onChange={(event) => setStaticForm({ ...staticForm, description: event.target.value })} placeholder="Optional description" />
            <input value={staticForm.icon} onChange={(event) => setStaticForm({ ...staticForm, icon: event.target.value })} placeholder="Optional icon image URL" />
            <input value={staticForm.password} onChange={(event) => setStaticForm({ ...staticForm, password: event.target.value })} type="password" placeholder="Optional stream password" />
            <button type="submit" className="primary">Create Static Share</button>
          </form>

          <div className="shareTable">
            {shares.length === 0 && <p className="emptyState">No share links yet.</p>}
            {shares.map((share) => {
              const url = share.url.startsWith("/") ? `${window.location.origin}${share.url}` : share.url;
              const active = editing?.id === share.id && share.kind === "static";
              return (
                <article key={`${share.kind}-${share.id}`} className={`shareRow ${active ? "active" : ""}`}>
                  <button type="button" className="shareOpenButton" onClick={() => share.kind === "static" && openStaticShare(share)} disabled={share.kind !== "static"}>
                    <strong>{share.title || share.slug}</strong>
                    <span>
                      {share.kind === "static"
                        ? `${share.event_count} scheduled · ${share.next_event_at ? `Next ${formatDateTime.format(new Date(share.next_event_at * 1000))}` : "No upcoming events"}`
                        : `${share.channel_name} · ${formatDateTime.format(new Date(share.starts_at * 1000))}`}
                    </span>
                    <small>{share.kind === "static" ? "Static schedule" : "Temporary"} · {share.opened_count} opens · {share.has_password ? "Password" : "Public"}</small>
                  </button>
                  <a href={url} target="_blank" rel="noreferrer">{url}</a>
                  <div className="shareActions">
                    {share.kind === "static" && <button type="button" onClick={() => openStaticShare(share)}>Manage</button>}
                    <button type="button" className="danger" onClick={() => deleteAnyShare(share)}>Delete</button>
                  </div>
                </article>
              );
            })}
          </div>
        </aside>

        <section className="scheduleEditor">
          {!editing && (
            <div className="emptySchedule">
              <h3>Select a static share</h3>
              <p>Choose a static share on the left, then select an EPG event in the guide to add it to that schedule.</p>
            </div>
          )}
          {editing && (
            <>
              <div className="scheduleTitle">
                <div>
                  <h3>{editing.title}</h3>
                  <p>{editing.description || "Static schedule share"}</p>
                </div>
                <a href={editing.url} target="_blank" rel="noreferrer">Open public page</a>
              </div>

              <form className="shareSettingsForm" onSubmit={(event) => {
                event.preventDefault();
                saveStaticShareSettings();
              }}>
                <label>
                  Title
                  <input value={settingsForm.title} onChange={(event) => setSettingsForm({ ...settingsForm, title: event.target.value })} />
                </label>
                <label>
                  Description
                  <input value={settingsForm.description} onChange={(event) => setSettingsForm({ ...settingsForm, description: event.target.value })} />
                </label>
                <label>
                  Icon URL
                  <input value={settingsForm.icon} onChange={(event) => setSettingsForm({ ...settingsForm, icon: event.target.value })} placeholder="https://..." />
                </label>
                <label>
                  New password
                  <input value={settingsForm.password} onChange={(event) => setSettingsForm({ ...settingsForm, password: event.target.value, clearPassword: false })} type="password" placeholder={editing.has_password ? "Leave blank to keep current" : "Optional"} />
                </label>
                <label className="checkboxLabel">
                  <input checked={settingsForm.clearPassword} onChange={(event) => setSettingsForm({ ...settingsForm, clearPassword: event.target.checked, password: "" })} type="checkbox" disabled={!editing.has_password} />
                  Remove password
                </label>
                <button type="submit" className="primary">Save Settings</button>
              </form>

              <div className="selectedEventCard">
                <span>Selected EPG Event</span>
                <strong>{selectedProgram?.title || "Nothing selected"}</strong>
                <p>{selectedProgram ? `${selectedProgram.channel_name} · ${formatDateTime.format(new Date(eventStart(selectedProgram) * 1000))}` : "Click an event in the guide first."}</p>
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
                <button type="button" onClick={searchEspn}>Search ESPN</button>
                <button type="button" className="primary" disabled={!selectedProgram} onClick={addSelectedProgram}>
                  Add to Schedule
                </button>
              </div>

              {selectedEspn && <p className="shareResult">Linked ESPN game: {selectedEspn.shortName || selectedEspn.name}</p>}
              {espnCache && <p className="cacheNote">ESPN cache: {espnCache.state} · {espnCache.requestsToday} outbound requests today</p>}
              {espnGames.length > 0 && (
                <div className="espnResults">
                  {espnGames.map((game) => (
                    <button key={game.id} type="button" className={selectedEspn?.id === game.id ? "active" : ""} onClick={() => setSelectedEspn(game)}>
                      <strong>{game.shortName || game.name}</strong>
                      <span>{formatDateTime.format(new Date(game.date))} · {game.status}</span>
                    </button>
                  ))}
                </div>
              )}

              <div className="scheduleList">
                {editing.events.length === 0 && <p className="emptyState">No scheduled events yet.</p>}
                {editing.events.map((item) => (
                  <article key={item.id}>
                    {(item.icon_url || item.icon) && <img src={item.icon_url || item.icon} alt="" />}
                    <div>
                      <strong>{item.title}</strong>
                      <span>{item.channel_name} · {formatDateTime.format(new Date(item.starts_at * 1000))}</span>
                      {item.espn && <small>ESPN: {item.espn.shortName || item.espn.name}</small>}
                    </div>
                    <button type="button" className="danger" onClick={() => removeScheduledEvent(item.id)}>Remove</button>
                  </article>
                ))}
              </div>
            </>
          )}
          {message && <p className="shareResult">{message}</p>}
        </section>
      </div>
    </section>
  );
}

function GuideGrid({ channels, programs, start, end, selectedChannelId, selectedProgramIds, onChannelSelect, onProgramToggle, onProgramInspect }) {
  const span = Math.max(1, end - start);
  const hours = Math.max(1, span / 3600);
  const channelWidth = 255;
  const timelineWidth = Math.max(1600, Math.ceil(hours * 280));
  const currentTs = Math.floor(Date.now() / 1000);
  const nowPercent = currentTs >= start && currentTs <= end ? ((currentTs - start) / span) * 100 : null;
  const marks = [];
  for (let ts = Math.ceil(start / 3600) * 3600; ts <= end; ts += 3600) marks.push(ts);

  return (
    <section className="workspace">
      <div className="guideScroller">
        <div className="guideHeader" style={{ width: `${channelWidth + timelineWidth}px` }}>
          <div className="channelHeader">Channels</div>
          <div className="timeAxis" style={{ width: `${timelineWidth}px` }}>
          {marks.map((mark) => (
            <span key={mark} style={{ left: `${((mark - start) / span) * 100}%` }}>{formatTime.format(new Date(mark * 1000))}</span>
          ))}
          {nowPercent !== null && <i className="nowMarker axisMarker" style={{ left: `${nowPercent}%` }} />}
          </div>
        </div>
        <div className="guideGrid" style={{ width: `${channelWidth + timelineWidth}px` }}>
          {channels.map((channel) => (
            <div key={channel.id} className="guideRow">
              <button className={`channelCell ${selectedChannelId === channel.id ? "active" : ""}`} type="button" onClick={() => onChannelSelect(channel.id)}>
                {channel.logo ? <img src={channel.logo} alt="" /> : <span className="logoFallback">{channel.name.slice(0, 2)}</span>}
                <span>{channel.name}</span>
              </button>
              <div className="programLane" style={{ width: `${timelineWidth}px` }}>
                {nowPercent !== null && <i className="nowMarker" style={{ left: `${nowPercent}%` }} />}
                {programs.filter((program) => program.channel_id === channel.id).map((program) => {
                  const left = Math.max(0, ((program.start_at - start) / span) * 100);
                  const width = Math.max(3, ((Math.min(program.end_at, end) - Math.max(program.start_at, start)) / span) * 100);
                  return (
                    <button
                      key={program.id}
                      type="button"
                      className={`event ${selectedProgramIds.has(program.id) ? "selected" : ""}`}
                      style={{ left: `${left}%`, width: `${width}%` }}
                      onClick={() => onProgramToggle(program)}
                      onMouseEnter={() => onProgramInspect(program)}
                      onFocus={() => onProgramInspect(program)}
                    >
                      <strong>{program.title}</strong>
                      <span>{formatTime.format(new Date(program.start_at * 1000))}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function SharePage({ slug }) {
  const [share, setShare] = useState(null);
  const [message, setMessage] = useState("");
  const [sportsSummary, setSportsSummary] = useState(null);
  const [sportsMessage, setSportsMessage] = useState("");
  const [clockNow, setClockNow] = useState(() => Date.now());

  async function loadShare() {
    const response = await fetch(`/api/public/share/${encodeURIComponent(slug)}`);
    const payload = await response.json();
    if (!response.ok) {
      setMessage("Share not found.");
      return;
    }
    setShare(payload.share);
  }

  useEffect(() => {
    fetch(`/api/public/share/${encodeURIComponent(slug)}/open`, { method: "POST" });
    loadShare();
  }, [slug]);

  useEffect(() => {
    const timer = setInterval(() => setClockNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!share || share.locked || share.kind !== "static" || !share.active_event_id) {
      setSportsSummary(null);
      return undefined;
    }
    const active = (share.events || []).find((event) => event.id === share.active_event_id);
    if (!active?.espn?.id) {
      setSportsSummary(null);
      return undefined;
    }
    let cancelled = false;
    async function loadSportsSummary() {
      const response = await fetch(`/api/public/share/${encodeURIComponent(slug)}/sports-summary?event=${active.id}`);
      const payload = await response.json();
      if (cancelled) return;
      if (response.ok) {
        setSportsSummary({ ...payload.summary, refreshSeconds: payload.refreshSeconds, fetchedAt: payload.fetchedAt });
        setSportsMessage("");
      } else {
        setSportsMessage(payload.error || "Live sports data unavailable.");
      }
    }
    loadSportsSummary();
    const timer = setInterval(loadSportsSummary, 60000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [share, slug]);

  async function unlock(event) {
    event.preventDefault();
    const password = new FormData(event.currentTarget).get("password");
    const response = await fetch(`/api/public/share/${encodeURIComponent(slug)}/unlock`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (response.ok) loadShare();
    else setMessage("Incorrect password.");
  }

  if (!share) {
    return <main className="shareShell"><h1>{message || "Loading..."}</h1></main>;
  }

  const hasWindow = Number(share.starts_at) && Number(share.ends_at);
  const starts = hasWindow ? new Date(share.starts_at * 1000) : null;
  const ends = hasWindow ? new Date(share.ends_at * 1000) : null;
  const state = !hasWindow ? "Schedule" : share.server_now < share.starts_at ? "Starts" : share.server_now <= share.ends_at ? "Live now" : "Ended";
  const schedule = share.events || share.programs || [];
  const sortedSchedule = [...schedule].sort((a, b) => eventStart(a) - eventStart(b));
  const nowSeconds = Math.floor(clockNow / 1000);
  const liveEvent = sortedSchedule.find((program) => eventStart(program) <= nowSeconds && nowSeconds <= eventEnd(program));
  const nextEvent = sortedSchedule.find((program) => eventStart(program) > nowSeconds);
  const countdownSeconds = nextEvent ? Math.max(0, eventStart(nextEvent) - nowSeconds) : 0;
  const isStaticShare = share.kind === "static";

  return (
    <main className={`shareShell ${isStaticShare ? "staticShareShell" : ""}`}>
      <section className={`shareHero ${isStaticShare ? "staticHero" : ""}`}>
        {isStaticShare && share.icon_url && <img className="staticShareIcon" src={share.icon_url} alt="" />}
        <div>
          <h1>{share.title || "Shared IPTV Window"}</h1>
          <p>{isStaticShare ? share.description || "Static schedule" : share.channel_name}</p>
        </div>
        {!isStaticShare && <time>{hasWindow ? `${state}: ${formatDateTime.format(starts)} - ${formatDateTime.format(ends)}` : state}</time>}
      </section>
      {isStaticShare && (!share.stream_url || share.locked) && (
        <StaticCountdown nextEvent={nextEvent} liveEvent={liveEvent} seconds={countdownSeconds} />
      )}
      {share.locked && (
        <section className="passwordGate">
          <form onSubmit={unlock}>
            <h2>Password Required</h2>
            <input name="password" type="password" placeholder="Share password" required />
            <button type="submit" className="primary">Unlock Stream</button>
            <p>{message}</p>
          </form>
        </section>
      )}
      {!share.locked && share.stream_url && <Player src={share.stream_url} kind={share.stream_kind} />}
      {!share.locked && !share.stream_url && !isStaticShare && <p className="notLive">This share is not currently in its stream window.</p>}
      {!share.locked && (sportsSummary || sportsMessage) && <SportsPanel summary={sportsSummary} message={sportsMessage} />}
      <section className="programList">
        {sortedSchedule.map((program) => {
          const media = program.icon_url || program.icon;
          const isLive = share.active_event_id === program.id;
          const startsAt = eventStart(program);
          const endsAt = eventEnd(program);
          return (
            <article key={program.id} className={`programRow ${media ? "" : "noMedia"} ${isLive ? "live" : ""}`}>
              {media && <img src={media} alt="" />}
              <div>
                <strong>{program.title}</strong>
                <span>{formatDateTime.format(new Date(startsAt * 1000))} - {formatDateTime.format(new Date(endsAt * 1000))}</span>
                {program.espn && (
                  <div className="sportsLinked">
                    {program.espn.away?.logo && <img src={program.espn.away.logo} alt="" />}
                    <small>ESPN: {program.espn.shortName || program.espn.name}</small>
                    {program.espn.home?.logo && <img src={program.espn.home.logo} alt="" />}
                  </div>
                )}
                <p>{program.description}</p>
              </div>
            </article>
          );
        })}
      </section>
    </main>
  );
}

function StaticCountdown({ nextEvent, liveEvent, seconds }) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  const heroEvent = nextEvent || liveEvent;
  const media = heroEvent?.icon_url || heroEvent?.icon;

  return (
    <section className={`staticCountdown ${media ? "hasMedia" : ""}`}>
      {media && <img src={media} alt="" />}
      <div className="countdownContent">
        <span>{nextEvent ? "Next Up" : liveEvent ? "Live Now" : "Schedule"}</span>
        <h2>{heroEvent?.title || "No events scheduled"}</h2>
        {nextEvent && (
          <>
            <div className="countdownDigits" aria-label={`Starts in ${seconds} seconds`}>
              <CountdownUnit label="Days" value={days} />
              <CountdownUnit label="Hours" value={hours} />
              <CountdownUnit label="Minutes" value={minutes} />
              <CountdownUnit label="Seconds" value={remainingSeconds} />
            </div>
            <p>{formatDateTime.format(new Date(eventStart(nextEvent) * 1000))}</p>
          </>
        )}
        {liveEvent && !nextEvent && <p className="liveNowText">The scheduled stream is live.</p>}
        {!heroEvent && <p>Add events to this static share from the admin panel.</p>}
      </div>
    </section>
  );
}

function CountdownUnit({ label, value }) {
  const display = String(value).padStart(2, "0");
  return (
    <div className="countdownUnit">
      <strong key={display}>{display}</strong>
      <span>{label}</span>
    </div>
  );
}

function SportsPanel({ summary, message }) {
  if (message && !summary) return <section className="sportsPanel"><p>{message}</p></section>;
  if (summary?.sport === "baseball" || summary?.league === "mlb") return <BaseballPanel summary={summary} />;
  return <FootballPanel summary={summary} />;
}

function FootballPanel({ summary }) {
  const playerGroups = summary?.boxscore?.players || [];
  const competitors = [...(summary?.competitors || [])].sort((a, b) => {
    if (a.homeAway === b.homeAway) return 0;
    return a.homeAway === "away" ? -1 : 1;
  });
  const away = competitors.find((entry) => entry.homeAway === "away") || competitors[0];
  const home = competitors.find((entry) => entry.homeAway === "home") || competitors[1];
  const periodLabels = ["1", "2", "3", "4"];

  return (
    <section className="sportsPanel">
      <div className="footballScorecard">
        <ScoreTeamSide entry={away} side="away" />
        <div className="gameCenter">
          <span>{summary.status || "Game"}</span>
          <div className="lineScoreTable" style={{ gridTemplateColumns: `34px repeat(${periodLabels.length + 1}, 26px)` }}>
            <div />
            {periodLabels.map((period) => <b key={period}>{period}</b>)}
            <b>T</b>
            {[away, home].filter(Boolean).map((entry) => (
              <React.Fragment key={entry.id || entry.team?.abbreviation}>
                <strong>{entry.team?.abbreviation || entry.team?.name}</strong>
                {periodLabels.map((_period, index) => (
                  <span key={index}>{entry.linescores?.[index]?.value ?? entry.linescores?.[index]?.displayValue ?? "-"}</span>
                ))}
                <b>{entry.score ?? "-"}</b>
              </React.Fragment>
            ))}
          </div>
          {summary.clock && <small>{summary.clock}</small>}
        </div>
        <ScoreTeamSide entry={home} side="home" />
      </div>
      <RefreshNote seconds={summary.refreshSeconds} />
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

function BaseballPanel({ summary }) {
  const playerGroups = summary?.boxscore?.players || [];
  const competitors = [...(summary?.competitors || [])].sort((a, b) => {
    if (a.homeAway === b.homeAway) return 0;
    return a.homeAway === "away" ? -1 : 1;
  });
  const away = competitors.find((entry) => entry.homeAway === "away") || competitors[0];
  const home = competitors.find((entry) => entry.homeAway === "home") || competitors[1];
  const teamTotals = summary?.boxscore?.teams || [];
  const maxInnings = Math.max(9, ...competitors.map((entry) => entry.linescores?.length || 0));
  const inningLabels = Array.from({ length: maxInnings }, (_item, index) => String(index + 1));

  return (
    <section className="sportsPanel baseballPanel">
      <div className="baseballScorecard">
        <ScoreTeamSide entry={away} side="away" />
        <div className="baseballGameCenter">
          <span>{summary.status || "Game"}</span>
          {summary.clock && <small>{summary.clock}</small>}
        </div>
        <ScoreTeamSide entry={home} side="home" />
      </div>
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
                <span key={index}>{entry.linescores?.[index]?.value ?? entry.linescores?.[index]?.displayValue ?? "-"}</span>
              ))}
              <b>{entry.score ?? "-"}</b>
              <b>{getBaseballTotal(teamTotals, entry, "hits")}</b>
              <b>{getBaseballTotal(teamTotals, entry, "errors")}</b>
            </React.Fragment>
          ))}
        </div>
      </div>
      <RefreshNote seconds={summary.refreshSeconds} />
      {playerGroups.length > 0 && (
        <div className="baseballBoxscore">
          {[away, home].filter(Boolean).map((entry) => {
            const teamStats = playerGroups.find((team) => String(team.team?.id) === String(entry.team?.id))
              || playerGroups.find((team) => team.team?.abbreviation === entry.team?.abbreviation);
            return <BaseballTeamBox key={entry.id || entry.team?.abbreviation} competitor={entry} teamStats={teamStats} />;
          })}
        </div>
      )}
    </section>
  );
}

function RefreshNote({ seconds }) {
  return <small className="sportsRefreshNote">Stats refresh every {formatRefreshInterval(seconds || 60)}.</small>;
}

function formatRefreshInterval(seconds) {
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

function getBaseballTotal(teamTotals, entry, name) {
  const team = teamTotals.find((item) => String(item.team?.id) === String(entry.team?.id))
    || teamTotals.find((item) => item.team?.abbreviation === entry.team?.abbreviation);
  const statistic = (team?.statistics || [])
    .flatMap((group) => group.stats || [])
    .find((stat) => stat.name === name || stat.abbreviation?.toLowerCase() === name);
  return statistic?.displayValue ?? statistic?.value ?? "-";
}

function ScoreTeamSide({ entry, side }) {
  if (!entry) return <div />;
  const record = entry.records?.find((item) => item.type === "total")?.summary || entry.records?.[0]?.summary || "";
  return (
    <div className={`scoreTeamSide ${side}`}>
      {entry.team?.logo && <img src={entry.team.logo} alt="" />}
      <div>
        <strong>{entry.team?.name || entry.team?.abbreviation}</strong>
        {record && <span>{record} {side === "away" ? "Away" : "Home"}</span>}
      </div>
      <b>{entry.score ?? "-"}</b>
    </div>
  );
}

function FootballTeamBox({ competitor, teamStats }) {
  const teamName = competitor.team?.name || competitor.team?.abbreviation || "Team";
  return (
    <article className="footballTeamBox">
      {(teamStats?.statistics || []).map((group) => (
        <div className="statTableWrap" key={group.name}>
          <h3>
            {competitor.team?.logo && <img src={competitor.team.logo} alt="" />}
            {teamName} {group.name}
          </h3>
          <div className="statTable" style={{ gridTemplateColumns: `minmax(150px, 1.5fr) repeat(${group.labels.length}, minmax(46px, 1fr))` }}>
            <strong />
            {group.labels.map((label) => <b key={label}>{label}</b>)}
            {group.athletes.map((athlete) => (
              <React.Fragment key={`${group.name}-${athlete.name}`}>
                <strong>{athlete.name}</strong>
                {group.labels.map((_label, index) => <span key={index}>{athlete.stats[index] ?? "-"}</span>)}
              </React.Fragment>
            ))}
          </div>
        </div>
      ))}
    </article>
  );
}

function BaseballTeamBox({ competitor, teamStats }) {
  const teamName = competitor.team?.name || competitor.team?.abbreviation || "Team";
  const groups = teamStats?.statistics || [];
  const hitting = groups.find((group) => group.name?.toLowerCase() === "batting") || groups.find((group) => group.name?.toLowerCase() === "hitting");
  const pitching = groups.find((group) => group.name?.toLowerCase() === "pitching");
  const remaining = groups.filter((group) => group !== hitting && group !== pitching);

  return (
    <article className="baseballTeamBox">
      {[hitting, pitching, ...remaining].filter(Boolean).map((group) => (
        <div className="statTableWrap" key={group.name}>
          <h3>
            {competitor.team?.logo && <img src={competitor.team.logo} alt="" />}
            {teamName} {group.name === "batting" ? "Hitting" : group.name}
          </h3>
          <div className="statTable baseballStatTable" style={{ gridTemplateColumns: `minmax(150px, 1.5fr) repeat(${group.labels.length}, minmax(38px, 1fr))` }}>
            <strong>{group.name === "pitching" ? "Pitchers" : "Hitters"}</strong>
            {group.labels.map((label) => <b key={label}>{label}</b>)}
            {group.athletes.map((athlete) => (
              <React.Fragment key={`${group.name}-${athlete.name}`}>
                <strong>{athlete.name}</strong>
                {group.labels.map((_label, index) => <span key={index}>{athlete.stats[index] ?? "-"}</span>)}
              </React.Fragment>
            ))}
          </div>
        </div>
      ))}
    </article>
  );
}

function Player({ src, kind }) {
  const videoRef = React.useRef(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    video.muted = false;
    video.defaultMuted = false;
    video.volume = 1;
    video.removeAttribute("muted");
    setMessage("");

    const clearRecoveredError = () => {
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && !video.paused) setMessage("");
    };
    video.addEventListener("playing", clearRecoveredError);
    video.addEventListener("canplay", clearRecoveredError);

    let cleanup = () => {};
    if (kind === "hls" && Hls.isSupported()) {
      const hls = new Hls({
        lowLatencyMode: false,
        maxBufferLength: 60,
        maxMaxBufferLength: 120,
        liveSyncDurationCount: 6,
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) setMessage(`HLS playback failed: ${data.details || data.type}`);
      });
      hls.loadSource(src);
      hls.attachMedia(video);
      cleanup = () => {
        hls.destroy();
      };
    } else if (kind === "mpegts" && mpegts.getFeatureList().mseLivePlayback) {
      const player = mpegts.createPlayer(
        {
          type: "mse",
          isLive: true,
          url: src,
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
      cleanup = () => {
        player.unload();
        player.detachMediaElement();
        player.destroy();
      };
    } else {
      if (kind === "mpegts") setMessage("This browser does not support MPEG-TS playback through Media Source Extensions.");
      video.src = src;
    }

    return () => {
      video.removeEventListener("playing", clearRecoveredError);
      video.removeEventListener("canplay", clearRecoveredError);
      cleanup();
    };
  }, [src, kind]);

  return (
    <section className="playerArea">
      <video ref={videoRef} controls playsInline preload="auto" />
      {message && <p className="playerMessage">{message}</p>}
    </section>
  );
}

function Root() {
  const path = useLocationPath();
  if (path === "/login") return <Login />;
  if (path.startsWith("/s/")) return <SharePage slug={decodeURIComponent(path.split("/").pop())} />;
  return <AppGuide />;
}

createRoot(document.getElementById("root")).render(<Root />);

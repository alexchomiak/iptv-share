import { useState } from "react";
import { api } from "../../lib/api.js";
import { eventStart, formatDateTime } from "../../lib/time.js";

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

export default ShareAdmin;

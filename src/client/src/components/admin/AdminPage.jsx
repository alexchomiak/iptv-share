import { useEffect, useState } from "react";
import { api } from "../../lib/api.js";
import { navigate } from "../../lib/navigation.js";
import { formatDateTime } from "../../lib/time.js";

const emptyStaticForm = { slug: "", title: "", description: "", icon: "", password: "", maxViewers: "" };

function fullUrl(url) {
  return url?.startsWith("/") ? `${window.location.origin}${url}` : url;
}

function shareTimeSummary(share) {
  if (share.kind === "static") {
    if (!share.next_event_at) return "No upcoming events";
    return `Next ${formatDateTime.format(new Date(share.next_event_at * 1000))}`;
  }
  return `${share.channel_name || "Channel"} · ${formatDateTime.format(new Date(share.starts_at * 1000))}`;
}

function AdminPage() {
  const [shares, setShares] = useState([]);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(emptyStaticForm);

  async function loadShares() {
    setLoading(true);
    const response = await api("/api/shares");
    if (response.ok) {
      const payload = await response.json();
      setShares(payload.shares || []);
    }
    setLoading(false);
  }

  useEffect(() => {
    loadShares();
  }, []);

  async function createStaticShare(event) {
    event.preventDefault();
    const response = await api("/api/static-shares", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    const payload = await response.json();
    if (!response.ok) {
      setMessage(payload.error || "Could not create static share.");
      return;
    }
    setForm(emptyStaticForm);
    setMessage(`Created ${payload.url}`);
    await loadShares();
  }

  async function deleteShare(share) {
    await api(share.kind === "static" ? `/api/static-shares/${share.id}` : `/api/shares/${share.id}`, { method: "DELETE" });
    await loadShares();
  }

  async function logout() {
    await fetch("/api/logout", { method: "POST" });
    navigate("/login");
  }

  return (
    <main className="adminShell">
      <header className="adminHeader">
        <div>
          <h1>Share Admin</h1>
          <p>{shares.length} share links</p>
        </div>
        <div className="toolbar">
          <button type="button" onClick={() => navigate("/")}>Guide</button>
          <button type="button" onClick={loadShares}>Refresh</button>
          <button type="button" onClick={logout}>Log out</button>
        </div>
      </header>

      <section className="adminGrid">
        <form className="adminCard staticShareCreator" onSubmit={createStaticShare}>
          <div>
            <h2>New Static Share</h2>
            <p>Permanent schedule links for recurring watch pages.</p>
          </div>
          <input value={form.slug} onChange={(event) => setForm({ ...form, slug: event.target.value })} placeholder="da-bears" />
          <input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="Display title" />
          <input value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} placeholder="Description" />
          <input value={form.icon} onChange={(event) => setForm({ ...form, icon: event.target.value })} placeholder="Icon image URL" />
          <input value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} type="password" placeholder="Optional password" />
          <input value={form.maxViewers} onChange={(event) => setForm({ ...form, maxViewers: event.target.value })} type="number" min="0" placeholder="Max viewers, blank for unlimited" />
          <button type="submit" className="primary">Create Static Share</button>
          {message && <p className="shareResult">{message}</p>}
        </form>

        <section className="adminCard adminShareList">
          <div className="adminSectionTitle">
            <div>
              <h2>Shares</h2>
              <p>{loading ? "Loading..." : "Open a share admin page to manage viewers, settings, and schedules."}</p>
            </div>
          </div>
          {shares.length === 0 && !loading && <p className="emptyState">No share links yet.</p>}
          {shares.map((share) => (
            <article key={`${share.kind}-${share.id}`} className="adminShareRow">
              <div className="adminShareMeta">
                <strong>{share.title || share.slug}</strong>
                <span>{share.kind === "static" ? `${share.event_count} scheduled` : "Temporary"} · {shareTimeSummary(share)}</span>
                <small>{share.opened_count} opens · {share.has_password ? "Password protected" : "No password"} · {share.max_viewers || "Unlimited"} viewers</small>
                <a href={fullUrl(share.url)} target="_blank" rel="noreferrer">{fullUrl(share.url)}</a>
              </div>
              <div className="adminShareActions">
                <button type="button" onClick={() => navigate(`/admin/s/${share.admin_ref || `${share.kind}-${share.id}`}`)}>Admin Page</button>
                <button type="button" className="danger" onClick={() => deleteShare(share)}>Delete</button>
              </div>
            </article>
          ))}
        </section>
      </section>
    </main>
  );
}

export default AdminPage;

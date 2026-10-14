import { useEffect, useState } from "react";
import { api } from "../../lib/api.js";
import { formatDateTime } from "../../lib/time.js";

export default function IntegrationKeys() {
  const [keys, setKeys] = useState([]);
  const [name, setName] = useState("");
  const [secret, setSecret] = useState(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const response = await api("/api/admin/integration-keys");
      if (!response.ok) throw new Error("Could not load API keys.");
      setKeys((await response.json()).keys);
    } catch (error) { setMessage(error.message); }
  }
  useEffect(() => { load(); }, []);

  async function create(event) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    setSecret(null);
    try {
      const response = await api("/api/admin/integration-keys", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not create API key.");
      setSecret({ id: payload.key.id, value: payload.secret });
      setName("");
      await load();
    } catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }

  async function revoke(id) {
    setBusy(true);
    setMessage("");
    try {
      const response = await api(`/api/admin/integration-keys/${id}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Could not revoke API key.");
      if (secret?.id === id) setSecret(null);
      await load();
    } catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }

  return (
    <section className="adminCard integrationKeys">
      <div>
        <h2>Discord API Keys</h2>
        <p>Read-only access to share programme previews. Passwords and share expiry still apply.</p>
      </div>
      <form onSubmit={create} className="integrationKeyForm">
        <label htmlFor="integration-key-name">Key name</label>
        <input id="integration-key-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={100} required placeholder="Discord bot" />
        <button type="submit" className="primary" disabled={busy || !name.trim()}>Generate API Key</button>
      </form>
      {secret && <div className="integrationKeySecret">
        <p>Copy this secret now. It will not be shown again. Set it as SHARETV_API_KEY in your bot.</p>
        <code>{secret.value}</code>
        <button type="button" onClick={async () => {
          try { await navigator.clipboard.writeText(secret.value); setMessage("API key copied."); }
          catch { setMessage("Select and copy the secret above."); }
        }}>Copy</button>
        <button type="button" onClick={() => setSecret(null)}>Dismiss secret</button>
      </div>}
      {message && <p role="status">{message}</p>}
      {!keys.length && <p>No API keys created.</p>}
      {keys.map((key) => <article key={key.id} className="adminShareRow">
        <div className="adminShareMeta">
          <strong>{key.name}</strong>
          <small>Created {formatDateTime.format(new Date(key.created_at * 1000))} · {key.revoked_at === null ? "Active" : "Revoked"}</small>
          <small>{key.scope}</small>
        </div>
        {key.revoked_at === null && <button type="button" className="danger" disabled={busy} onClick={() => revoke(key.id)}>Revoke</button>}
      </article>)}
    </section>
  );
}

import { useState } from "react";
import { navigate } from "../lib/navigation.js";

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

export default Login;

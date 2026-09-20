import { useState } from "react";
import { useNavigate } from "react-router-dom";

const JSON_HEADERS = { "Content-Type": "application/json" };

export function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ email, password }),
        credentials: "include",
      });
      if (!res.ok) {
        setError(res.status === 401 ? "Invalid email or password." : `Could not sign in (HTTP ${res.status}).`);
        return;
      }
      navigate("/");
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1>Sign in</h1>
      <form onSubmit={submit}>
        <label>
          Email{" "}
          <input
            type="email"
            value={email}
            autoFocus
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label>
          Password{" "}
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <button type="submit" disabled={busy || email.length === 0 || password.length === 0}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
      {error && <div role="alert">{error}</div>}
    </div>
  );
}

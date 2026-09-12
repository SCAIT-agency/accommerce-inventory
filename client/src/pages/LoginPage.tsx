import { useState } from "react";
import { useNavigate } from "react-router-dom";

interface Identity {
  id: number;
  email: string;
  role: "editor" | "viewer";
}

const JSON_HEADERS = { "Content-Type": "application/json" };

export function LoginPage() {
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [identities, setIdentities] = useState<Identity[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/auth/password", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ password }),
        credentials: "include",
      });
      if (!res.ok) {
        setError(res.status === 401 ? "Wrong password." : `Could not verify password (HTTP ${res.status}).`);
        return;
      }
      const usersRes = await fetch("/api/auth/users", { credentials: "include" });
      if (!usersRes.ok) {
        setError(`Password accepted, but loading identities failed (HTTP ${usersRes.status}).`);
        return;
      }
      const rows: Identity[] = await usersRes.json();
      if (rows.length === 0) {
        setError("No users exist yet. Run scripts/seed-first-user.ts against this database (see RAILWAY.md).");
        return;
      }
      setIdentities(rows);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  async function selectUser(userId: number) {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/auth/select-user", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ userId }),
        credentials: "include",
      });
      if (!res.ok) {
        // The password cookie is short-lived; an expired one lands here.
        setError(
          res.status === 401
            ? "Your password check expired. Please enter the password again."
            : `Could not sign in as that user (HTTP ${res.status}).`,
        );
        if (res.status === 401) setIdentities(null);
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
      {identities === null ? (
        <form onSubmit={submitPassword}>
          <label>
            Password{" "}
            <input
              type="password"
              value={password}
              autoFocus
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <button type="submit" disabled={busy || password.length === 0}>
            {busy ? "Checking…" : "Continue"}
          </button>
        </form>
      ) : (
        <div>
          <p>Who are you?</p>
          <ul>
            {identities.map((identity) => (
              <li key={identity.id}>
                <button disabled={busy} onClick={() => selectUser(identity.id)}>
                  {identity.email} ({identity.role})
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {error && <div role="alert">{error}</div>}
    </div>
  );
}

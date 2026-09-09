/**
 * AuthScreen — the human-facing authentication surface (login + signup).
 *
 * Replaces the previous API-token prompt. Sessions are signed HttpOnly
 * cookies issued by the server; the client never sees, stores, or sends
 * any token itself (credentials: "include" on every api.ts request).
 *
 * Signup collects Email / Password / Confirm password with client-side
 * feedback; server-side validation remains authoritative. After success
 * the session cookie is already set, so the app renders immediately —
 * no second login step.
 */
import { useState } from "react";
import { ApiError, login, signup } from "./api";

const MIN_PASSWORD_LENGTH = 8;

type Mode = "login" | "signup";

export function AuthScreen({
  onAuthenticated,
  offlineNotice,
}: {
  onAuthenticated: () => void;
  offlineNotice?: string | null;
}) {
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(offlineNotice ?? null);

  const switchMode = (next: Mode) => {
    setMode(next);
    setError(null);
    setPassword("");
    setConfirm("");
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setError("Enter a valid email address.");
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (mode === "signup" && password !== confirm) {
      setError("Passwords do not match.");
      return;
    }

    setBusy(true);
    try {
      if (mode === "signup") await signup(trimmedEmail, password);
      else await login(trimmedEmail, password);
      onAuthenticated(); // session cookie is set — re-render the app
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError("Could not reach the Probe server. Please try again.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card auth-gate-card">
      <h2>{mode === "login" ? "Sign in to Probe" : "Create your Probe account"}</h2>
      <p className="auth-gate-note">
        {mode === "login"
          ? "Sign in with your Probe account to run and view investigations."
          : "Create an account to run evidence-driven investigations. Your investigations are private to your account."}
      </p>

      <form onSubmit={handleSubmit} className="auth-token-form">
        <div className="form-group">
          <label htmlFor="auth-email">Email</label>
          <input
            id="auth-email"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
            required
          />
        </div>

        <div className="form-group">
          <label htmlFor="auth-password">Password</label>
          <input
            id="auth-password"
            type="password"
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            placeholder={mode === "signup" ? `At least ${MIN_PASSWORD_LENGTH} characters` : "Password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={MIN_PASSWORD_LENGTH}
          />
        </div>

        {mode === "signup" && (
          <div className="form-group">
            <label htmlFor="auth-confirm">Confirm password</label>
            <input
              id="auth-confirm"
              type="password"
              autoComplete="new-password"
              placeholder="Repeat your password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
            />
          </div>
        )}

        {error && (
          <p className="auth-token-error" role="alert">
            {error}
          </p>
        )}

        <div className="auth-token-actions">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
          </button>
        </div>
      </form>

      <p className="auth-switch">
        {mode === "login" ? (
          <>
            Don&rsquo;t have an account?{" "}
            <button type="button" className="auth-link" onClick={() => switchMode("signup")}>
              Create account
            </button>
          </>
        ) : (
          <>
            Already have an account?{" "}
            <button type="button" className="auth-link" onClick={() => switchMode("login")}>
              Sign in
            </button>
          </>
        )}
      </p>
    </div>
  );
}

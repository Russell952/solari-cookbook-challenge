/**
 * AuthGate — production authentication surface for the API bearer token.
 *
 * The backend requires `Authorization: Bearer <token>` on every /api route.
 * The token itself is a caller identity configured per deployment
 * (PROBE_API_TOKEN server-side); the client obtains it through the existing
 * api.ts mechanisms — VITE_PROBE_API_TOKEN baked at build time, or the
 * `probe_token` localStorage key entered here.
 *
 * Behavior:
 *  - No token configured → probe the API once. A 401 means this deployment
 *    requires authentication and the token form is shown; a 200 means the
 *    deployment allows anonymous/local access and the app renders as before.
 *  - Token configured → it is verified against the API before the app loads,
 *    so auth failures surface here instead of as silent empty screens.
 *  - Network failures never reject a token (the backend may be waking up);
 *    they show a retry state instead.
 *
 * The token is stored only in the browser's localStorage under `probe_token`
 * and is sent only to the configured API base. No other state, no cookies.
 */
import { useCallback, useEffect, useState } from "react";
import { ApiError, listInvestigations, probeTokenSet, setProbeToken } from "./api";

type GateState =
  | { kind: "checking" }
  | { kind: "authed" }
  | { kind: "needs-token"; notice?: string }
  | { kind: "offline"; detail: string };

/**
 * Verify the currently configured token (or none) against the API.
 * Exported for tests — the gate's whole decision procedure is this mapping.
 */
export async function probeAuthState(): Promise<"ok" | "unauthorized" | "unreachable"> {
  try {
    await listInvestigations();
    return "ok";
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return "unauthorized";
    return "unreachable";
  }
}

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<GateState>({ kind: "checking" });

  const run = useCallback(async () => {
    setState({ kind: "checking" });
    const result = await probeAuthState();
    if (result === "ok") setState({ kind: "authed" });
    else if (result === "unauthorized")
      setState({ kind: "needs-token" });
    else
      setState({ kind: "offline", detail: "The Probe server could not be reached. It may still be starting — try again." });
  }, []);

  useEffect(() => {
    void run();
  }, [run]);

  if (state.kind === "authed") return <>{children}</>;

  if (state.kind === "checking") {
    return (
      <div className="card auth-gate-card">
        <div className="loading">Connecting to Probe…</div>
      </div>
    );
  }

  if (state.kind === "offline") {
    return (
      <div className="card auth-gate-card">
        <h2>Server unavailable</h2>
        <p className="auth-gate-note">{state.detail}</p>
        <button className="btn btn-primary" onClick={() => void run()}>
          Retry connection
        </button>
      </div>
    );
  }

  return (
    <div className="card auth-gate-card">
      <h2>Authentication required</h2>
      <p className="auth-gate-note">
        This Probe deployment requires an API token. Enter the token configured
        for this deployment (the server&rsquo;s <code>PROBE_API_TOKEN</code>) to continue.
        It is stored only in this browser and sent only to the Probe API.
      </p>
      <TokenForm
        notice={state.notice}
        onVerified={() => setState({ kind: "authed" })}
      />
    </div>
  );
}

/**
 * Token entry form. Saves through the existing api.ts token mechanism and
 * verifies the credential against the real API before reporting success.
 * Also rendered in a modal from the app header for changing the token later.
 */
export function TokenForm({
  notice,
  onVerified,
  onCancel,
}: {
  notice?: string;
  onVerified: () => void;
  onCancel?: () => void;
}) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(notice ?? null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = token.trim();
    if (!trimmed) {
      setError("Enter the API token for this deployment.");
      return;
    }
    setError(null);
    setBusy(true);
    // Persist first (the api layer reads it from localStorage), then verify.
    setProbeToken(trimmed);
    const result = await probeAuthState();
    setBusy(false);
    if (result === "ok") {
      onVerified();
      return;
    }
    if (result === "unauthorized") {
      setError("Token rejected by the server. Check the token and try again.");
      return;
    }
    // Unreachable: keep the token stored (it may be valid) and let the
    // offline/retry state handle connectivity — do not claim rejection.
    setError("Could not reach the Probe server to verify the token. Please retry.");
  };

  return (
    <form onSubmit={handleSubmit} className="auth-token-form">
      <div className="form-group">
        <label htmlFor="probe-api-token">API token</label>
        <input
          id="probe-api-token"
          type="password"
          autoComplete="off"
          placeholder="Probe API token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          autoFocus
        />
      </div>
      {error && (
        <p className="auth-token-error" role="alert">
          {error}
        </p>
      )}
      <div className="auth-token-actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? "Verifying…" : "Continue"}
        </button>
        {onCancel && (
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

/**
 * Header control + modal for managing the stored token after the gate has
 * opened. Clearing the token returns to the gate on the next page load.
 */
export function TokenManagerButton() {
  const [open, setOpen] = useState(false);
  const [cleared, setCleared] = useState(false);

  return (
    <>
      <button
        className="btn btn-secondary conn-token-btn"
        onClick={() => setOpen(true)}
        title="Probe API token for this browser"
      >
        API token
      </button>
      {open && (
        <div
          className="auth-modal-overlay"
          onClick={() => setOpen(false)}
          role="dialog"
          aria-label="API token"
        >
          <div className="card auth-modal" onClick={(e) => e.stopPropagation()}>
            <div className="card-header">
              <h2>API token</h2>
              <button className="btn btn-secondary" style={{ padding: "0.25rem 0.6rem" }} onClick={() => setOpen(false)}>
                Close
              </button>
            </div>
            {cleared ? (
              <p style={{ fontSize: "0.85rem", color: "var(--text-secondary)" }}>
                Stored token cleared — reload the page to sign in again.
              </p>
            ) : (
              <>
                <p className="auth-gate-note">
                  Replace the API token stored in this browser. The token is
                  verified against the Probe API before it is accepted.
                </p>
                <TokenForm
                  onVerified={() => {
                    setOpen(false);
                    // Force data layers to re-run with the new token.
                    window.location.reload();
                  }}
                  onCancel={() => setOpen(false)}
                />
                <button
                  className="btn btn-secondary"
                  style={{ marginTop: "0.5rem" }}
                  onClick={() => {
                    setProbeToken("");
                    setCleared(true);
                  }}
                >
                  Clear stored token
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

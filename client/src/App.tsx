import { useState, useEffect, useCallback } from "react";
import { NewInvestigation } from "./NewInvestigation";
import { InvestigationView } from "./InvestigationView";
import { AuthScreen, authStateFromProbe, authStateFromError, type AuthState } from "./AuthGate";
import { getSessionUser, logout, healthUrl, listInvestigations, type Investigation, type SessionUser, phaseLabel } from "./api";
import { SearchIcon } from "./icons";

type Route =
  | { page: "home" }
  | { page: "investigation"; id: string };

function parseRoute(): Route {
  const hash = window.location.hash.slice(1);
  if (hash.startsWith("/investigation/")) {
    return { page: "investigation", id: hash.split("/")[2] || "" };
  }
  return { page: "home" };
}

export function App() {
  const [route, setRoute] = useState<Route>(parseRoute);
  const [health, setHealth] = useState<{ status: string } | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  // Three render states + initial checking; every /me outcome leaves checking.
  const [auth, setAuth] = useState<AuthState>({ kind: "checking" });

  useEffect(() => {
    const handler = () => setRoute(parseRoute());
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);

  // Health check — unauthenticated by design (header connectivity indicator).
  useEffect(() => {
    fetch(healthUrl)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => setHealth(d))
      .catch((e) => setHealthError(e instanceof Error ? e.message : "offline"));
  }, []);

  // Session check — the HttpOnly cookie is attached automatically by the
  // browser; no token material is ever read or stored by the frontend.
  // 200 means authenticated; 401 means unauthenticated (AuthScreen);
  // network failure / 5xx mean server-error (retryable). Nothing maps to checking.
  const refreshUser = useCallback(async () => {
    setAuth({ kind: "checking" });
    try {
      setAuth(authStateFromProbe(await getSessionUser()));
    } catch (err) {
      setAuth(authStateFromError(err));
    }
  }, []);

  useEffect(() => {
    void refreshUser();
  }, [refreshUser]);

  const navigate = (path: string) => {
    window.location.hash = path;
  };

  const handleSignOut = async () => {
    try {
      await logout();
    } finally {
      setAuth({ kind: "unauthenticated" });
    }
  };

  return (
    <div className="app">
      <header className="header">
        <h1
          style={{ cursor: "pointer" }}
          onClick={() => navigate("/")}
        >
          <SearchIcon aria-hidden="true" /> Probe{" "}
          <span>Evidence-Driven Software Investigation</span>
        </h1>
        <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
          {healthError && (
            <span className="conn-badge conn-offline">
              <span className="conn-dot conn-dot-danger" aria-hidden="true" />
              Server offline
            </span>
          )}
          {health && (
            <span className="conn-badge conn-online">
              <span className="conn-dot conn-dot-ok" aria-hidden="true" />
              Connected
            </span>
          )}
          {auth.kind === "authenticated" && (
            <>
              <span className="conn-user-email" title={auth.user.email}>{auth.user.email}</span>
              <button className="btn btn-secondary conn-token-btn" onClick={() => void handleSignOut()}>
                Sign out
              </button>
            </>
          )}
        </div>
      </header>
      <main className="main">
        {auth.kind === "checking" ? (
          <div className="card auth-gate-card">
            <div className="loading">Checking your session…</div>
          </div>
        ) : auth.kind === "unauthenticated" ? (
          <AuthScreen onAuthenticated={() => void refreshUser()} offlineNotice={healthError} />
        ) : auth.kind === "server-error" ? (
          <div className="card auth-gate-card" role="alert">
            <h2>Probe server unavailable</h2>
            <p className="auth-gate-note">{auth.message}</p>
            <div className="auth-token-actions">
              <button className="btn btn-primary" onClick={() => void refreshUser()}>
                Retry
              </button>
            </div>
          </div>
        ) : (
          <>
            {route.page === "home" && (
              <HomeView
                onNewInvestigation={() => navigate("/")}
                onSelectInvestigation={(id) => navigate(`/investigation/${id}`)}
              />
            )}
            {route.page === "investigation" && (
              <InvestigationView
                investigationId={route.id}
                onBack={() => navigate("/")}
              />
            )}
          </>
        )}
      </main>
    </div>
  );
}

function HomeView({
  onNewInvestigation,
  onSelectInvestigation,
}: {
  onNewInvestigation: () => void;
  onSelectInvestigation: (id: string) => void;
}) {
  const [investigations, setInvestigations] = useState<Investigation[]>([]);
  const [showNew, setShowNew] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    listInvestigations()
      .then(setInvestigations)
      .catch((e) => setLoadError(e instanceof Error ? e.message : "Failed to load investigations"))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div>
      {/* Investigation list */}
      <div className="card">
        <div className="card-header">
          <h2>Investigations</h2>
          <button
            className="btn btn-primary"
            onClick={() => setShowNew(!showNew)}
          >
            {showNew ? "Cancel" : "+ New Investigation"}
          </button>
        </div>

        {showNew && (
          <NewInvestigation
            onCreated={(id) => {
              setShowNew(false);
              onSelectInvestigation(id);
            }}
          />
        )}

        {!showNew && (
          <>
            {loading && <div className="loading">Loading...</div>}
            {!loading && loadError && (
              <div className="empty-state">
                <p style={{ color: "var(--danger)" }}>{loadError}</p>
              </div>
            )}
            {!loading && !loadError && investigations.length === 0 && (
              <div className="empty-state">
                <p>No investigations yet.</p>
                <button className="btn btn-primary" onClick={() => setShowNew(true)}>
                  Create your first investigation
                </button>
              </div>
            )}
            {!loading && investigations.length > 0 && (
              <div>
                {investigations.map((inv) => (
                  <div
                    key={inv.id}
                    className="experiment-item"
                    style={{ cursor: "pointer" }}
                    onClick={() => onSelectInvestigation(inv.id)}
                  >
                    <div className="exp-header">
                      <span className={`status-${inv.status}`} style={{ fontSize: "0.75rem", fontWeight: 500 }}>
                        {inv.status}
                      </span>
                      <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>
                        {phaseLabel(inv.currentPhase)}
                      </span>
                    </div>
                    <p className="exp-objective">{inv.objective}</p>
                    <div style={{ display: "flex", gap: "1rem", fontSize: "0.75rem", color: "var(--text-muted)", marginTop: "0.25rem" }}>
                      <span>{inv.repositoryUrl}</span>
                      <span>{inv.applicationUrl}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

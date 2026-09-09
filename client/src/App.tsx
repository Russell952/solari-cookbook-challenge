import { useState, useEffect } from "react";
import { NewInvestigation } from "./NewInvestigation";
import { InvestigationView } from "./InvestigationView";
import { AuthGate, TokenManagerButton } from "./AuthGate";
import { healthUrl, listInvestigations, type Investigation, phaseLabel } from "./api";
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

  // Listen for hash changes
  useEffect(() => {
    const handler = () => setRoute(parseRoute());
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);

  // Health check — same base URL as every other API call (api.ts healthUrl)
  useEffect(() => {
    fetch(healthUrl)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => setHealth(d))
      .catch((e) => setHealthError(e instanceof Error ? e.message : "offline"));
  }, []);

  const navigate = (path: string) => {
    window.location.hash = path;
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
          <TokenManagerButton />
        </div>
      </header>
      <main className="main">
        {/* Every API call is authenticated; AuthGate verifies the token before
            data views mount so failures surface as a clear sign-in instead of
            silent empty screens. */}
        <AuthGate>
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
        </AuthGate>
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

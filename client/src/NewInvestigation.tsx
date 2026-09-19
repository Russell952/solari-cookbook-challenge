import { useState } from "react";
import { createInvestigation, startInvestigation, type CreateInvestigationInput } from "./api";

/**
 * Objective length limit — mirrors the server's enforced limit (server
 * config.limits.maxObjectiveLength; the client has no dependency on the
 * server config, so the number is defined here once and used everywhere in
 * this form). The backend independently rejects oversized objectives; this
 * counter keeps users from ever hitting that error.
 */
const MAX_OBJECTIVE_LENGTH = 1000;

interface Props {
  onCreated: (id: string) => void;
}

export function NewInvestigation({ onCreated }: Props) {
  const [form, setForm] = useState<CreateInvestigationInput>({
    repositoryUrl: "",
    applicationUrl: "",
    objective: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Live remaining-character counter: every typed character decrements,
  // every deletion restores. 0 remaining is valid (not an error state).
  const remaining = MAX_OBJECTIVE_LENGTH - form.objective.length;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const inv = await createInvestigation(form);
      await startInvestigation(inv.id);
      onCreated(inv.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create investigation");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <div className="card" style={{ maxWidth: 640 }}>
        <div className="card-header">
          <h2>New Investigation</h2>
        </div>

        <p style={{ fontSize: "0.875rem", color: "var(--text-secondary)", marginBottom: "1.5rem" }}>
          Investigate whether a web application behaves the way its code and documentation claim.
        </p>

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="repo">Repository URL</label>
            <input
              id="repo"
              type="url"
              placeholder="https://github.com/owner/repo"
              value={form.repositoryUrl}
              onChange={(e) => setForm({ ...form, repositoryUrl: e.target.value })}
              required
            />
          </div>

          <div className="form-group">
            <label htmlFor="app">Live Application URL</label>
            <input
              id="app"
              type="url"
              placeholder="https://example.com"
              value={form.applicationUrl}
              onChange={(e) => setForm({ ...form, applicationUrl: e.target.value })}
              required
            />
          </div>

          <div className="form-group">
            <label htmlFor="obj">Investigation Objective</label>
            <textarea
              id="obj"
              placeholder="What should Probe verify? For example: Can a new user sign up, log in, and create a project?"
              value={form.objective}
              // maxLength stops character 1,001 from ever being entered —
              // the limit is visible up front, not discovered on submit.
              maxLength={MAX_OBJECTIVE_LENGTH}
              onChange={(e) => setForm({ ...form, objective: e.target.value })}
              required
              style={{ minHeight: 120 }}
            />
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                marginTop: "0.25rem",
              }}
            >
              <span
                style={{
                  fontSize: "0.75rem",
                  color:
                    remaining === 0
                      ? "var(--warning)"
                      : remaining <= 100
                        ? "var(--text-muted)"
                        : "var(--text-secondary)",
                }}
                aria-live="polite"
              >
                {remaining} characters remaining
              </span>
            </div>
          </div>

          {error && (
            <div style={{ color: "var(--danger)", fontSize: "0.875rem", marginBottom: "1rem" }}>
              {error}
            </div>
          )}

          <button
            type="submit"
            className="btn btn-primary"
            disabled={submitting}
          >
            {submitting ? "Creating..." : "Start Investigation"}
          </button>
        </form>
      </div>
    </div>
  );
}

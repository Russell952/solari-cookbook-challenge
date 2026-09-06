import { useState } from "react";
import { createInvestigation, startInvestigation, type CreateInvestigationInput } from "./api";

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
              onChange={(e) => setForm({ ...form, objective: e.target.value })}
              required
              style={{ minHeight: 120 }}
            />
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

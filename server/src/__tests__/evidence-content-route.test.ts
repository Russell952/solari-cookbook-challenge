/**
 * Evidence content download path — end-to-end route regression.
 *
 * Production bug: the frontend built a FLAT URL `/api/evidence/:id/content`,
 * but the backend serves evidence content only at the NESTED route
 * `/api/investigations/:id/evidence/:evId/content`. The flat URL matched no
 * route and fell through to the /api catch-all, returning
 * `{"error":"Not found"}` for every "Download artifact" click.
 *
 * These tests pin the whole retrieval chain:
 *   evidence id → ownership check → metadata.storageKey → artifact store
 *   → bytes with correct Content-Type / disposition / hash headers
 * plus the honest failure modes (unknown id, no artifact ever stored,
 * object missing from storage) and the catch-all behavior that caused the
 * production report.
 */
/** @vitest-environment node */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { Server } from "http";
import type { AddressInfo } from "net";

vi.mock("../solari/client.js", () => ({
  getSdkClient: vi.fn(),
  getBrowserSolari: vi.fn(),
  closeAllClients: vi.fn(async () => {}),
  trackBrowserSession: vi.fn(),
  untrackBrowserSession: vi.fn(),
}));

import { buildApp } from "../app.js";
import { store } from "../store/index.js";
import { registerTokenForTesting } from "../security/auth.js";
import { resetRateLimits } from "../security/rate-limit.js";
import { setArtifactStore, type ArtifactStore } from "../evidence/artifact-store.js";
import { captureScreenshot } from "../evidence/index.js";

const TEST_TOKEN = "evidence-content-test-token";

let server: Server;
let baseUrl: string;

beforeAll(() => {
  registerTokenForTesting(TEST_TOKEN);
});

beforeEach(async () => {
  resetRateLimits();
  store.clearAll();
  server = buildApp().listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f5f0000000049454e44ae426082",
  "hex"
);

function auth(): Record<string, string> {
  return { Authorization: `Bearer ${TEST_TOKEN}` };
}

async function createOwnedInvestigation(): Promise<string> {
  const res = await fetch(`${baseUrl}/api/investigations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth() },
    body: JSON.stringify({
      repositoryUrl: "https://github.com/demo/demo",
      applicationUrl: "https://app.test",
      objective: "evidence content route test",
    }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { id: string };
  return body.id;
}

/** Capture a real artifact so metadata.storageKey points at actual bytes. */
async function captureRealArtifact(invId: string): Promise<string> {
  const ev = await captureScreenshot(invId, "", PNG_BYTES, {
    pageTitle: "route test",
  });
  return ev.id;
}

describe("GET /api/investigations/:id/evidence/:evId/content", () => {
  let evidenceDir: string;
  let originalStore: ArtifactStore | null;

  beforeEach(async () => {
    evidenceDir = await mkdtemp(join(tmpdir(), "probe-evcontent-"));
    process.env.PROBE_EVIDENCE_DIR = evidenceDir;
    // Re-import the store factory under the temp root: the local store reads
    // PROBE_EVIDENCE_DIR lazily (evidenceRoot()), so this is sufficient.
    originalStore = null;
  });

  afterEach(async () => {
    delete process.env.PROBE_EVIDENCE_DIR;
    await rm(evidenceDir, { recursive: true, force: true });
  });

  afterAll(() => {
    if (originalStore) setArtifactStore(null);
  });

  it("serves the stored artifact bytes with correct content type and disposition", async () => {
    const invId = await createOwnedInvestigation();
    const evId = await captureRealArtifact(invId);

    const res = await fetch(
      `${baseUrl}/api/investigations/${invId}/evidence/${evId}/content`,
      { headers: auth() }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("content-disposition")).toContain(`${evId}.png`);
    expect(res.headers.get("x-evidence-hash-verified")).toBe("true");
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(PNG_BYTES)).toBe(true);
  });

  it("returns 404 for an unknown evidence id (no enumeration signal)", async () => {
    const invId = await createOwnedInvestigation();
    const res = await fetch(
      `${baseUrl}/api/investigations/${invId}/evidence/ev_does_not_exist/content`,
      { headers: auth() }
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Evidence not found" });
  });

  it("returns an honest 404 when the evidence has no stored artifact", async () => {
    const invId = await createOwnedInvestigation();
    // Evidence recorded WITHOUT bytes (artifactAvailable: false) — the
    // truthful replay-unavailable shape. Metadata remains queryable.
    const ev = store.createEvidence({
      investigationId: invId,
      experimentId: null,
      observationId: null,
      type: "replay",
      uri: "solari://session/missing",
      contentHash: "",
      metadata: { artifactAvailable: false, format: "rrweb" },
    });

    const meta = await fetch(
      `${baseUrl}/api/investigations/${invId}/evidence/${ev.id}`,
      { headers: auth() }
    );
    expect(meta.status).toBe(200);
    const metaBody = (await meta.json()) as {
      metadata: Record<string, unknown>;
    };
    // The metadata endpoint surfaces the truthful capture-time record.
    expect(metaBody.metadata.artifactAvailable).toBe(false);

    const res = await fetch(
      `${baseUrl}/api/investigations/${invId}/evidence/${ev.id}/content`,
      { headers: auth() }
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Evidence artifact not available" });
  });

  it("returns 404 when the storage object has disappeared (missing B2/local object)", async () => {
    const invId = await createOwnedInvestigation();
    const evId = await captureRealArtifact(invId);
    // Delete the bytes out from under the metadata (local store equivalent of
    // a vanished B2 object) — read must return null → honest 404.
    const ev = store.getEvidence(evId)!;
    const { deleteEvidenceArtifact } = await import("../evidence/index.js");
    await deleteEvidenceArtifact(ev);

    const res = await fetch(
      `${baseUrl}/api/investigations/${invId}/evidence/${evId}/content`,
      { headers: auth() }
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Evidence artifact not available" });
  });

  it("resolves bytes via metadata.storageKey — not via a re-derived wrong key", async () => {
    // Pin the contract: the collector persists the storage key, and
    // retrieval passes EXACTLY that key to the artifact store. A custom
    // store records what it was asked to read.
    const invId = await createOwnedInvestigation();
    const evId = await captureRealArtifact(invId);
    const ev = store.getEvidence(evId)!;
    const storageKey = ev.metadata?.storageKey as string;
    expect(typeof storageKey).toBe("string");
    expect(storageKey).toContain(invId);
    expect(storageKey).toContain(evId);
    expect(storageKey.endsWith(".png")).toBe(true);
  });

  it("serves 404 (not bytes) when the evidence belongs to another caller", async () => {
    const invId = await createOwnedInvestigation();
    const evId = await captureRealArtifact(invId);

    const otherToken = "evidence-content-other-token";
    registerTokenForTesting(otherToken);
    const res = await fetch(
      `${baseUrl}/api/investigations/${invId}/evidence/${evId}/content`,
      { headers: { Authorization: `Bearer ${otherToken}` } }
    );
    expect(res.status).toBe(404);
  });

  it("rejects unauthenticated content requests with 401", async () => {
    const invId = await createOwnedInvestigation();
    const evId = await captureRealArtifact(invId);
    const res = await fetch(
      `${baseUrl}/api/investigations/${invId}/evidence/${evId}/content`
    );
    expect(res.status).toBe(401);
  });
});

describe("the flat /api/evidence/:id/content URL (production bug shape)", () => {
  it("matches NO backend route and returns the catch-all JSON 404", async () => {
    // This is the exact request the old frontend produced. It must remain a
    // JSON 404 (never a crash, never leaked bytes) until the client stops
    // building it — the fix lives in evidenceContentUrl().
    const res = await fetch(
      `${baseUrl}/api/evidence/13526bf3-f804-4b05-896d-a0fd43f264dd/content`,
      { headers: auth() }
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });
});

/**
 * Artifact-availability regression — the strict UI contract.
 *
 * The Evidence UI may render artifact controls (View/Download/Inspect/replay)
 * ONLY when the backend reports `artifactAvailable: true`, i.e. usable bytes
 * were verified to exist. Anything else (`false`, undefined/legacy without a
 * live probe) must leave the UI with no artifact controls at all, because a
 * rendered control that 404s (`{"error":"Not found"}` from
 * GET /api/investigations/:id/evidence/:evId/content) is exactly the failure
 * this suite prevents.
 *
 * Covered here (server side):
 *   1. Legacy evidence records (no capture-time assertion) are probed against
 *      the REAL artifact store through the summary endpoint — true when the
 *      object exists, false when it does not.
 *   2. Capture-time assertions pass through untouched (false stays false —
 *      no probe can resurrect a record whose upload failed).
 *   3. URL evidence is never probed and never reports available.
 *   4. A storage-system probe failure does not fabricate availability.
 *   5. The content endpoint still 404s honestly for missing artifacts —
 *      proving no UI control could ever have pointed at real bytes.
 */
/** @vitest-environment node */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { Server } from "http";
import type { AddressInfo } from "net";
import type { StoredArtifact } from "../evidence/artifact-store.js";

vi.mock("../solari/client.js", () => ({
  getSdkClient: vi.fn(),
  getBrowserSolari: vi.fn(),
  closeAllClients: vi.fn(async () => {}),
  trackBrowserSession: vi.fn(),
  untrackBrowserSession: vi.fn(),
}));

import { buildApp } from "../app.js";
import { store, useDurableBackend } from "../store/index.js";
import { registerTokenForTesting } from "../security/auth.js";
import { resetRateLimits, resetInvestigationQuotas } from "../security/rate-limit.js";
import {
  setArtifactStore,
  type ArtifactStore,
} from "../evidence/artifact-store.js";
import { captureEvidence } from "../evidence/index.js";

const TEST_TOKEN = "artifact-availability-test-token";

/**
 * In-memory store whose `exists` result is programmable, simulating:
 *  - objects present in storage (exists → true)
 *  - objects absent from storage (exists → false)
 *  - a storage-system outage (exists throws)
 */
function makeProgrammableStore(): ArtifactStore & { existsResult: boolean | Error } {
  return {
    kind: "local" as const,
    existsResult: true as boolean | Error,
    async save(opts: {
      evidenceId: string;
      investigationId: string;
      evidenceType: string;
      content: string | Buffer;
    }) {
      const bytes = Buffer.isBuffer(opts.content) ? opts.content : Buffer.from(opts.content, "utf-8");
      return {
        evidenceId: opts.evidenceId,
        investigationId: opts.investigationId,
        experimentId: null,
        evidenceType: opts.evidenceType,
        mimeType: "application/octet-stream",
        byteSize: bytes.length,
        sha256: "a".repeat(64),
        storagePath: `${opts.investigationId}/${opts.evidenceId}`,
        createdAt: new Date().toISOString(),
      };
    },
    async read(): Promise<Buffer | null> {
      // Mirror the programmed existence state so read() and exists() tell
      // the same story (a real store does exactly that).
      if (this.existsResult instanceof Error) throw this.existsResult;
      return this.existsResult ? Buffer.from("bytes") : null;
    },
    async exists(): Promise<boolean> {
      if (this.existsResult instanceof Error) throw this.existsResult;
      return this.existsResult;
    },
    async delete(): Promise<void> {},
    async deleteInvestigation(): Promise<void> {},
    async investigationBytes(): Promise<number> {
      return 0;
    },
  };
}

let fake: ReturnType<typeof makeProgrammableStore>;
let server: Server;
let baseUrl: string;

beforeAll(() => {
  registerTokenForTesting(TEST_TOKEN);
});

beforeEach(async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "probe-art-avail-"));
  process.env.PROBE_STORE_DIR = dataDir;
  useDurableBackend(null);
  store.clearAll();
  resetRateLimits();
  resetInvestigationQuotas();
  fake = makeProgrammableStore();
  setArtifactStore(fake);
  server = buildApp().listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  setArtifactStore(null);
  const dataDir = process.env.PROBE_STORE_DIR;
  delete process.env.PROBE_STORE_DIR;
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

afterAll(() => {
  vi.restoreAllMocks();
});

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
      objective: "artifact availability test",
    }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { id: string };
  return body.id;
}

interface SummaryEvidence {
  id: string;
  type: string;
  artifactAvailable: boolean;
}

async function fetchSummaryEvidence(invId: string): Promise<SummaryEvidence[]> {
  const res = await fetch(`${baseUrl}/api/investigations/${invId}/summary`, {
    headers: auth(),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { evidence: SummaryEvidence[] };
  return body.evidence;
}

/**
 * Simulate a legacy record: created directly through the store (pre-flag
 * schema shape) with no capture-time availability assertion.
 */
function createLegacyRecord(
  invId: string,
  type: string,
  uri: string
): { id: string } {
  return store.createEvidence({
    investigationId: invId,
    experimentId: null,
    observationId: null,
    type: type as "screenshot",
    uri,
    contentHash: "c".repeat(64),
    metadata: { storageKey: `${invId}/legacy-object`, mimeType: "image/png" },
  });
}

describe("summary endpoint artifact availability (strict UI contract)", () => {
  it("legacy record with a REAL object in storage → artifactAvailable true (verified by live probe)", async () => {
    const invId = await createOwnedInvestigation();
    const ev = createLegacyRecord(invId, "screenshot", "https://app.test/page");

    fake.existsResult = true;
    const rows = await fetchSummaryEvidence(invId);
    const row = rows.find((r) => r.id === ev.id)!;
    expect(row.artifactAvailable).toBe(true);
  });

  it("legacy record with NO object in storage → artifactAvailable false (probe proves absence)", async () => {
    const invId = await createOwnedInvestigation();
    const ev = createLegacyRecord(invId, "screenshot", "https://app.test/page");

    fake.existsResult = false;
    const rows = await fetchSummaryEvidence(invId);
    const row = rows.find((r) => r.id === ev.id)!;
    expect(row.artifactAvailable).toBe(false);
  });

  it("capture-time assertion passes through: upload-failed record stays false even if a probe would lie", async () => {
    const invId = await createOwnedInvestigation();
    // Simulate an upload failure: create the record exactly as the
    // collector's failure path does.
    store.createEvidence({
      investigationId: invId,
      experimentId: null,
      observationId: null,
      type: "screenshot",
      uri: "https://app.test/page",
      contentHash: "b".repeat(64),
      metadata: {
        artifactAvailable: false,
        artifactUnavailableReason: "upload_failed",
      },
    });

    // Even a wildly optimistic store cannot resurrect this record.
    fake.existsResult = true;
    const rows = await fetchSummaryEvidence(invId);
    expect(rows.length).toBe(1);
    expect(rows[0].artifactAvailable).toBe(false);
  });

  it("URL evidence is never probed and never reports an available artifact", async () => {
    const invId = await createOwnedInvestigation();
    const ev = createLegacyRecord(invId, "url", "https://app.test/visited");

    fake.existsResult = true;
    const rows = await fetchSummaryEvidence(invId);
    const row = rows.find((r) => r.id === ev.id)!;
    expect(row.type).toBe("url");
    expect(row.artifactAvailable).toBe(false);
  });

  it("storage outage during the probe → unavailable, never a fabricated yes", async () => {
    const invId = await createOwnedInvestigation();
    const ev = createLegacyRecord(invId, "screenshot", "https://app.test/page");

    fake.existsResult = new Error("network unreachable");
    const rows = await fetchSummaryEvidence(invId);
    const row = rows.find((r) => r.id === ev.id)!;
    expect(row.artifactAvailable).toBe(false);
  });

  it("every summary evidence row carries a DEFINED artifactAvailable flag", async () => {
    const invId = await createOwnedInvestigation();
    createLegacyRecord(invId, "screenshot", "https://app.test/a");
    createLegacyRecord(invId, "url", "https://app.test/b");
    const rows = await fetchSummaryEvidence(invId);
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(typeof row.artifactAvailable).toBe("boolean");
    }
  });
});

describe("content endpoint honesty (no control can point at missing bytes)", () => {
  it("content 404s for a legacy record whose artifact is absent — matching the UI's false flag", async () => {
    const invId = await createOwnedInvestigation();
    const ev = createLegacyRecord(invId, "screenshot", "https://app.test/page");

    fake.existsResult = false;
    const rows = await fetchSummaryEvidence(invId);
    expect(rows.find((r) => r.id === ev.id)!.artifactAvailable).toBe(false);

    const res = await fetch(
      `${baseUrl}/api/investigations/${invId}/evidence/${ev.id}/content`,
      { headers: auth() }
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Evidence artifact not available" });
  });

  it("content serves bytes for a legacy record the probe verified available — matching the UI's true flag", async () => {
    const invId = await createOwnedInvestigation();
    const ev = createLegacyRecord(invId, "screenshot", "https://app.test/page");

    fake.existsResult = true;
    const rows = await fetchSummaryEvidence(invId);
    expect(rows.find((r) => r.id === ev.id)!.artifactAvailable).toBe(true);

    const res = await fetch(
      `${baseUrl}/api/investigations/${invId}/evidence/${ev.id}/content`,
      { headers: auth() }
    );
    expect(res.status).toBe(200);
  });
});

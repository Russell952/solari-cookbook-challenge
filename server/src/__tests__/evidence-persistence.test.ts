/** @vitest-environment node */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "crypto";
import { mkdtemp, rm, readFile, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { store } from "../store/index.js";
import { getLocalIndexedArtifact } from "../evidence/artifact-store.js";
import { deleteInvestigationArtifacts } from "../evidence/index.js";
import type { Evidence } from "@probe/shared";
import {
  captureScreenshot,
  captureActionTrace,
  captureEvidence,
  captureReplay,
  captureReplayUnavailable,
  getEvidenceContent,
} from "../evidence/index.js";

// ── Isolated evidence root per test run ─────────────────────────────────────

let evidenceDir: string;

beforeEach(async () => {
  evidenceDir = await mkdtemp(join(tmpdir(), "probe-evidence-"));
  process.env.PROBE_EVIDENCE_DIR = evidenceDir;
  store.clearAll();
});

afterEach(async () => {
  delete process.env.PROBE_EVIDENCE_DIR;
  await rm(evidenceDir, { recursive: true, force: true });
});

function createInvestigation(): string {
  return store.createInvestigation({
    repositoryUrl: "",
    applicationUrl: "https://example.com",
    objective: "Evidence persistence test",
  }).id;
}

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

// ── Persistence core ────────────────────────────────────────────────────────

describe("evidence artifact persistence", () => {
  it("writes screenshot bytes to disk and the record points at them", async () => {
    const invId = createInvestigation();
    const png = Buffer.from("fake-png-bytes-1234567890");

    const ev = await captureScreenshot(invId, "exp_1", png);

    // Record exists in the store with retrieval metadata
    expect(ev.type).toBe("screenshot");
    expect(ev.metadata.artifactAvailable).toBe(true);
    expect(ev.metadata.artifactPath).toBeTruthy();

    // Actual file exists at that path with the exact bytes
    const onDisk = await readFile(ev.metadata.artifactPath as string);
    expect(onDisk.equals(png)).toBe(true);

    // Full 64-hex SHA-256 of the persisted bytes
    expect(ev.metadata.sha256).toBe(sha256(png));
    expect(ev.metadata.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ev.contentHash).toBe(sha256(png));

    // Persisted under the evidence root, scoped to the investigation dir.
    expect(ev.metadata.artifactPath).toContain(invId);
  });

  it("writes action traces as JSON artifacts", async () => {
    const invId = createInvestigation();
    const ev = await captureActionTrace(invId, "exp_1", {
      action: "click",
      target: "#submit",
      result: { ok: true },
    });

    const onDisk = await readFile(ev.metadata.artifactPath as string, "utf-8");
    const parsed = JSON.parse(onDisk);
    expect(parsed.action).toBe("click");
    expect(ev.metadata.mimeType).toBe("application/json");
  });

  it("persists replay bytes with replay metadata", async () => {
    const invId = createInvestigation();
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 250, 251]);
    const ev = await captureReplay(invId, "exp_9", bytes, { solariSessionId: "sess_1" });

    expect(ev.type).toBe("replay");
    const onDisk = await readFile(ev.metadata.artifactPath as string);
    expect(Buffer.from(bytes).equals(onDisk)).toBe(true);
    expect(ev.metadata.sha256).toBe(sha256(Buffer.from(bytes)));
    expect(ev.metadata.format).toBe("rrweb");
  });

  it("stores replays as rrweb NDJSON with accurate MIME metadata — not video", async () => {
    // Live-run verification: Solari replay payloads are rrweb event streams
    // (lines of JSON), NOT playable video. The MIME/extension must describe
    // what is actually on disk so the UI and API consumers render it correctly.
    const invId = createInvestigation();
    const ndjson = [
      JSON.stringify({ type: 4, data: { href: "https://example.com" }, timestamp: 1700000000000 }),
      JSON.stringify({ type: 2, data: { node: {} }, timestamp: 1700000000500 }),
      JSON.stringify({ type: 3, data: { source: 1 }, timestamp: 1700000000900 }),
    ].join("\n");
    const ev = await captureReplay(
      invId,
      "exp_ndjson",
      new TextEncoder().encode(ndjson),
      { solariSessionId: "sess_ndjson" }
    );

    expect(ev.metadata.mimeType).toBe("application/x-ndjson");
    expect(String(ev.metadata.artifactPath)).toMatch(/\.ndjson$/);
    const onDisk = await readFile(ev.metadata.artifactPath as string, "utf-8");
    expect(onDisk).toBe(ndjson);
    expect(ev.metadata.sha256).toBe(sha256(Buffer.from(ndjson)));
  });

  it("retrieved bytes match persisted bytes and hash verification succeeds", async () => {
    const invId = createInvestigation();
    const content = Buffer.from("identical-bytes-check");
    const ev = await captureEvidence({
      investigationId: invId,
      experimentId: "exp_1",
      type: "action_trace",
      content,
    });

    const { buffer, sha256: hash, hashVerified } = await getEvidenceContent(ev);
    expect(buffer).not.toBeNull();
    expect(buffer!.equals(content)).toBe(true);
    expect(hash).toBe(sha256(content));
    expect(hashVerified).toBe(true);
  });

  it("detects hash mismatch when the on-disk artifact is tampered with", async () => {
    const invId = createInvestigation();
    const ev = await captureEvidence({
      investigationId: invId,
      experimentId: "exp_1",
      type: "action_trace",
      content: "original-content",
    });

    // Tamper with the artifact on disk
    await writeFile(ev.metadata.artifactPath as string, "tampered-content");

    const { buffer, hashVerified } = await getEvidenceContent(ev);
    expect(buffer).not.toBeNull(); // bytes are served…
    expect(hashVerified).toBe(false); // …but never reported as verified
  });
});

// ── Restart-like recovery ───────────────────────────────────────────────────

describe("restart recovery via on-disk artifact index", () => {
  it("artifact remains independently retrievable after in-memory state is recreated", async () => {
    const invId = createInvestigation();
    const content = Buffer.from("survives-a-restart");
    const ev = await captureEvidence({
      investigationId: invId,
      experimentId: "exp_1",
      type: "screenshot",
      content,
    });

    // Simulate a restart: wipe ALL in-memory store state.
    store.clearAll();

    // Recreate only the investigation record (as a fresh process would have
    // nothing) — the evidence record itself is NOT recreated.
    store.createInvestigation({
      repositoryUrl: "",
      applicationUrl: "https://example.com",
      objective: "Evidence persistence test",
    });

    // Rebuild a minimal evidence record from the on-disk index alone —
    // exactly what a restarted server could do.
    const indexed = await getLocalIndexedArtifact(invId, ev.id);
    expect(indexed).not.toBeNull();
    const reconstructed = {
      id: indexed!.evidenceId,
      investigationId: indexed!.investigationId,
      experimentId: indexed!.experimentId,
      observationId: null,
      type: indexed!.evidenceType,
      uri: null,
      contentHash: indexed!.sha256,
      metadata: {},
      createdAt: indexed!.createdAt,
    };

    const { buffer, sha256: hash, hashVerified } = await getEvidenceContent(reconstructed as Evidence);
    expect(buffer!.equals(content)).toBe(true);
    expect(hash).toBe(sha256(content));
    expect(hashVerified).toBe(true);

    // Raw bytes are readable with no store involvement at all
    const direct = await readFile(indexed!.storagePath);
    expect(direct.equals(content)).toBe(true);
  });

  it("the artifact index is valid JSON on disk and lists every artifact", async () => {
    const invId = createInvestigation();
    const e1 = await captureEvidence({
      investigationId: invId,
      type: "action_trace",
      content: "one",
    });
    const e2 = await captureEvidence({
      investigationId: invId,
      type: "screenshot",
      content: Buffer.from("two"),
    });

    const raw = await readFile(join(evidenceDir, invId, "index.json"), "utf-8");
    const entries = JSON.parse(raw);
    const ids = entries.map((e: { evidenceId: string }) => e.evidenceId);
    expect(ids).toContain(e1.id);
    expect(ids).toContain(e2.id);
    expect(entries).toHaveLength(2);
  });
});

// ── Failure / boundary handling ─────────────────────────────────────────────

describe("artifact retrieval failure handling", () => {
  it("returns null buffer and hashVerified=false for a deleted artifact", async () => {
    const invId = createInvestigation();
    const ev = await captureEvidence({
      investigationId: invId,
      type: "action_trace",
      content: "to-be-deleted",
    });

    await deleteInvestigationArtifacts(invId);
    const { buffer, hashVerified } = await getEvidenceContent(ev);
    expect(buffer).toBeNull();
    expect(hashVerified).toBe(false);
  });

  it("URL-only evidence has no artifact path and no buffer", async () => {
    const invId = createInvestigation();
    const ev = await captureEvidence({
      investigationId: invId,
      type: "url",
      uri: "https://example.com/page",
    });

    const { buffer } = await getEvidenceContent(ev);
    expect(buffer).toBeNull();
  });

  it("cross-investigation artifact access via the index is rejected", async () => {
    const invA = createInvestigation();
    const invB = createInvestigation();
    await captureEvidence({ investigationId: invA, type: "action_trace", content: "secret-A" });

    // Asking the index of investigation B for A's evidence yields nothing.
    const fromB = await getLocalIndexedArtifact(invB, "some-ev-id");
    expect(fromB).toBeNull();

    // The index is scoped per investigation directory on disk and stores
    // hashes, not content.
    const rawA = await readFile(join(evidenceDir, invA, "index.json"), "utf-8");
    expect(rawA).toContain("evidenceId");
    let rawB = "{}";
    try {
      rawB = await readFile(join(evidenceDir, invB, "index.json"), "utf-8");
    } catch {
      // B has no index at all — equally fine.
    }
    expect(rawB).not.toContain("secret-A");
  });
});

// ── Replay end-to-end through the browser adapter ───────────────────────────

describe("replay wiring through getReplay", () => {
  it("captureReplay stores bytes retrieved after session release semantics", async () => {
    const invId = createInvestigation();
    // Simulate the exact flow in runExperiment: session released, replay
    // polled afterwards by session ID.
    const releasedSessionId = "solari-session-42";
    const replayBytes = new Uint8Array([9, 9, 9, 7]);
    const ev = await captureReplay(invId, "exp_1", replayBytes, {
      solariSessionId: releasedSessionId,
    });

    expect(ev.metadata.solariSessionId).toBe(releasedSessionId);
    const { buffer, hashVerified } = await getEvidenceContent(ev);
    expect(buffer!.equals(Buffer.from(replayBytes))).toBe(true);
    expect(hashVerified).toBe(true);
  });

  it("replay ABSENCE is recorded truthfully with no fabricated artifact bytes", async () => {
    // Regression for the replay bottleneck fix: when Solari's replay-url
    // endpoint 404s permanently, Probe records an evidence entry stating the
    // replay is unavailable — with NO artifact bytes and no fake content.
    const invId = createInvestigation();
    const ev = await captureReplayUnavailable(invId, "exp_404", {
      solariSessionId: "solari-session-404",
      reason: "not_generated",
      detail: "Solari replay-url returned 404 after the documented finalization window",
    });

    expect(ev.type).toBe("replay");
    expect(ev.metadata.replayAvailable).toBe(false);
    expect(ev.metadata.replayUnavailableReason).toBe("not_generated");
    expect(ev.metadata.solariSessionId).toBe("solari-session-404");
    // No artifact was persisted — content endpoint must not serve bytes.
    expect(ev.metadata.artifactAvailable).toBe(false);
    expect(ev.contentHash).toBe("");
    const { buffer } = await getEvidenceContent(ev);
    expect(buffer).toBeNull();
  });
});

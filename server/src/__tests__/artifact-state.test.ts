/**
 * Artifact-state regression tests.
 *
 * Pins the distinction the recurring "artifact missing" reports blurred:
 *
 *  - GENUINE ABSENCE: the store definitively reports NoSuchKey → the evidence
 *    content API returns 404 "not available" (artifact truly was never stored
 *    — e.g. replay 404 after finalization). This stays ordinary absence.
 *  - STORAGE-SYSTEM FAILURE: network/auth/5xx errors from the store are
 *    rethrown, and the content API returns 503 — the artifact may exist but
 *    cannot be retrieved right now. Never misreported as "missing".
 *  - UPLOAD-FAILURE PROVENANCE: evidence whose capture content failed to
 *    upload carries artifactUnavailableReason="upload_failed" — distinguishable
 *    from evidence that never had an artifact (url / replay-unavailable).
 *  - ORDERING: the metadata record is written only after the artifact-store
 *    write settles (artifact → metadata), so the store never claims bytes
 *    exist before they are safely persisted.
 *  - INTEGRITY: SHA-256 verification of retrieved bytes is unchanged.
 */
/** @vitest-environment node */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createHash } from "crypto";
import { captureEvidence, getEvidenceContent } from "../evidence/collector.js";
import { setArtifactStore, type ArtifactStore, type StoredArtifact } from "../evidence/artifact-store.js";
import { store, useDurableBackend } from "../store/index.js";

/** Fake store with programmable save/read behavior. */
function makeFakeStore(): ArtifactStore & {
  saveError: Error | null;
  readError: Error | null;
  readMissing: boolean;
  saved: Array<{ key: string; bytes: Buffer }>;
} {
  const saved: Array<{ key: string; bytes: Buffer }> = [];
  return {
    kind: "local" as const,
    saveError: null,
    readError: null,
    readMissing: false,
    saved,
    async save(opts: { evidenceId: string; investigationId: string; evidenceType: string; content: string | Buffer }) {
      if (this.saveError) throw this.saveError;
      const bytes = Buffer.isBuffer(opts.content) ? opts.content : Buffer.from(opts.content, "utf-8");
      const key = `${opts.investigationId}/${opts.evidenceId}`;
      this.saved.push({ key, bytes });
      return {
        evidenceId: opts.evidenceId,
        investigationId: opts.investigationId,
        experimentId: null,
        evidenceType: opts.evidenceType,
        mimeType: "application/octet-stream",
        byteSize: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        storagePath: key,
        createdAt: new Date().toISOString(),
      };
    },
    async read(artifact: StoredArtifact): Promise<Buffer | null> {
      if (this.readError) throw this.readError;
      if (this.readMissing) return null;
      // The local retrieval path absolutizes storage keys; match by suffix.
      const hit = this.saved.find((s) => artifact.storagePath === s.key || artifact.storagePath.endsWith(`/${s.key}`));
      return hit ? hit.bytes : null;
    },
    async delete(): Promise<void> {},
    async deleteInvestigation(): Promise<void> {},
    async investigationBytes(): Promise<number> {
      return 0;
    },
  };
}

let dataDir: string;
let fake: ReturnType<typeof makeFakeStore>;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "probe-artifact-state-"));
  process.env.PROBE_STORE_DIR = dataDir;
  useDurableBackend(null);
  store.clearAll();
  fake = makeFakeStore();
  setArtifactStore(fake);
});

afterEach(async () => {
  setArtifactStore(null);
  await rm(dataDir, { recursive: true, force: true });
});

describe("artifact state model", () => {
  it("successful capture → metadata written after artifact, available=true, retrievable", async () => {
    const inv = store.createInvestigation({ repositoryUrl: "", applicationUrl: "https://app.test/", objective: "o" });
    const ev = await captureEvidence({
      investigationId: inv.id,
      type: "screenshot",
      content: Buffer.from("png-bytes"),
    });
    // Artifact was persisted before the metadata record exists.
    expect(fake.saved).toHaveLength(1);
    const stored = store.getEvidence(ev.id);
    expect(stored?.metadata?.artifactAvailable).toBe(true);
    expect(stored?.metadata?.storageKey).toBe(fake.saved[0].key);
    // And the bytes resolve back through the same path.
    const { buffer, hashVerified } = await getEvidenceContent(stored!);
    expect(buffer).not.toBeNull();
    expect(hashVerified).toBe(true);
  });

  it("upload failure → honest metadata with upload_failed reason, never fabricated availability", async () => {
    fake.saveError = new Error("B2 upload failed: 503 slow down");
    const inv = store.createInvestigation({ repositoryUrl: "", applicationUrl: "https://app.test/", objective: "o" });
    const ev = await captureEvidence({
      investigationId: inv.id,
      type: "screenshot",
      content: Buffer.from("lost-bytes"),
    });
    const stored = store.getEvidence(ev.id)!;
    expect(stored.metadata?.artifactAvailable).toBe(false);
    // THE regression: a lost artifact is distinguished from ordinary absence.
    expect(stored.metadata?.artifactUnavailableReason).toBe("upload_failed");
    expect(String(stored.metadata?.artifactUploadError)).toContain("503");
  });

  it("evidence without content (url/replay-unavailable) has no upload-failure provenance", async () => {
    const inv = store.createInvestigation({ repositoryUrl: "", applicationUrl: "https://app.test/", objective: "o" });
    const ev = await captureEvidence({ investigationId: inv.id, type: "url", uri: "https://app.test/" });
    const stored = store.getEvidence(ev.id)!;
    expect(stored.metadata?.artifactAvailable).toBe(false);
    expect(stored.metadata?.artifactUnavailableReason).toBeUndefined();
  });

  it("store read failure (transient storage error) is rethrown — not treated as absence", async () => {
    const inv = store.createInvestigation({ repositoryUrl: "", applicationUrl: "https://app.test/", objective: "o" });
    const ev = await captureEvidence({
      investigationId: inv.id,
      type: "screenshot",
      content: Buffer.from("png-bytes"),
    });
    fake.readError = new Error("socket hang up");
    await expect(getEvidenceContent(store.getEvidence(ev.id)!)).rejects.toThrow("socket hang up");
  });

  it("definitive absence (NoSuchKey path → null) still resolves as missing, hash check skipped", async () => {
    const inv = store.createInvestigation({ repositoryUrl: "", applicationUrl: "https://app.test/", objective: "o" });
    const ev = await captureEvidence({
      investigationId: inv.id,
      type: "screenshot",
      content: Buffer.from("png-bytes"),
    });
    fake.readMissing = true;
    const result = await getEvidenceContent(store.getEvidence(ev.id)!);
    expect(result.buffer).toBeNull();
  });

  it("contentHash of a failed upload still matches the original content (verifiable either way)", async () => {
    fake.saveError = new Error("no network");
    const inv = store.createInvestigation({ repositoryUrl: "", applicationUrl: "https://app.test/", objective: "o" });
    const content = Buffer.from("content-to-hash");
    const ev = await captureEvidence({ investigationId: inv.id, type: "screenshot", content });
    const stored = store.getEvidence(ev.id)!;
    expect(stored.contentHash).toBe((await import("crypto")).createHash("sha256").update(content).digest("hex"));
  });
});

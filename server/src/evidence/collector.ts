/**
 * Evidence collector.
 *
 * Captures evidence from browser/sandbox operations, persists the actual
 * artifact BYTES through the ArtifactStore (local filesystem in dev/tests,
 * Backblaze B2 in production), then records metadata — including the storage
 * key and full SHA-256 of the persisted bytes — in the store (MongoDB in
 * production).
 *
 * Integrity invariant: the contentHash stored on an Evidence is the full
 * SHA-256 of the persisted bytes — the artifact remains retrievable and the
 * hash can always be re-verified against it. Metadata is only written after
 * successful artifact storage (or, when persistence fails, as an explicit
 * `artifactAvailable: false` record so capture degrades instead of crashing
 * an experiment and never presents a false success).
 */
import { createHash, randomUUID } from "crypto";
import { join } from "path";
import { store } from "../store/index.js";
import { profiler } from "../profiler/index.js";
import {
  getArtifactStore,
  extensionFor,
  mimeFor,
  fullSha256,
  evidenceRoot,
  getLocalIndexedArtifact,
  type StoredArtifact,
} from "./artifact-store.js";
import type { EvidenceType, Evidence } from "@probe/shared";

function contentHash(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex").slice(0, 16);
}

export interface CaptureEvidenceOpts {
  investigationId: string;
  experimentId?: string;
  observationId?: string;
  type: EvidenceType;
  uri?: string;
  /** Artifact bytes to persist (optional — URL evidence has none). */
  content?: string | Buffer;
  /** Optional pre-generated evidence id (used to name the artifact). */
  evidenceId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Capture evidence from an experiment action.
 *
 * Artifact bytes are persisted first; the Evidence record then carries the
 * full SHA-256 of the persisted bytes plus the storage key. If artifact
 * storage fails, the metadata record is still created (marked
 * `artifactAvailable: false`) so evidence capture degrades instead of
 * crashing an experiment — but never reports a successful artifact.
 */
export async function captureEvidence(opts: CaptureEvidenceOpts): Promise<Evidence> {
  const evidenceId = opts.evidenceId ?? randomUUID();
  const artifactStore = getArtifactStore();
  const handle = profiler.begin("evidence", "capture", { type: opts.type });
  let artifact: StoredArtifact | null = null;

  if (opts.content !== undefined) {
    try {
      const tSha0 = Date.now();
      artifact = await artifactStore.save({
        evidenceId,
        investigationId: opts.investigationId,
        experimentId: opts.experimentId ?? null,
        evidenceType: opts.type,
        content: opts.content,
      });
      handle.annotate({
        storageMs: Date.now() - tSha0,
        bytes: artifact?.byteSize ?? Buffer.byteLength(opts.content),
      });
    } catch (error) {
      handle.annotate({
        storageMs: 0,
        bytes: opts.content === undefined ? 0 : Buffer.byteLength(opts.content),
        error: error instanceof Error ? error.message.slice(0, 200) : String(error),
      });
      console.error(
        `Evidence artifact persistence failed (${opts.type}, evidence ${evidenceId}):`,
        error instanceof Error ? error.message : error
      );
    }
  }

  const integrityMetadata: Record<string, unknown> = {
    ...opts.metadata,
    // Full 64-char hex digest of the persisted bytes (or of the content when
    // persistence failed — the value remains verifiable either way).
    contentHash: artifact?.sha256 ?? fullSha256Of(opts.content),
    artifactAvailable: artifact !== null,
    artifactStore: artifactStore.kind,
    ...(artifact
      ? {
          mimeType: artifact.mimeType,
          byteSize: artifact.byteSize,
          sha256: artifact.sha256,
          storageKey: artifact.storagePath,
          // Backward-compat alias: artifactPath is the local filesystem path
          // when using LocalArtifactStore; undefined for B2 (object keys are
          // not filesystem paths). New code should prefer storageKey.
          artifactPath: artifactStore.kind === "local" ? artifact.storagePath : undefined,
          artifactCreatedAt: artifact.createdAt,
        }
      : {}),
  };

  handle.end(true);
  return store.createEvidence({
    id: evidenceId,
    investigationId: opts.investigationId,
    experimentId: opts.experimentId ?? null,
    observationId: opts.observationId ?? null,
    type: opts.type,
    uri: opts.uri ?? null,
    contentHash: integrityMetadata.contentHash as string,
    metadata: integrityMetadata,
  });
}

function fullSha256Of(content: string | Buffer | undefined): string {
  if (content === undefined) return "";
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Capture a screenshot as evidence. The PNG bytes are persisted as an
 * actual image file and remain retrievable via the content API.
 */
export async function captureScreenshot(
  investigationId: string,
  experimentId: string,
  screenshotBuffer: Buffer,
  metadata?: Record<string, unknown>
): Promise<Evidence> {
  return captureEvidence({
    investigationId,
    experimentId,
    type: "screenshot",
    content: screenshotBuffer,
    metadata: {
      ...metadata,
      format: "png",
      sizeBytes: screenshotBuffer.length,
    },
  });
}

/**
 * Capture a session replay as evidence.
 *
 * The replay is an rrweb NDJSON event stream (DOM-level recording, not video)
 * downloaded from Solari AFTER the browser session is released, so retrieval
 * does not depend on the session still existing. The bytes are persisted
 * through the ArtifactStore like any other artifact.
 *
 * If the replay has not been uploaded by Solari yet (it uploads
 * asynchronously and can lag the release by seconds) or the download
 * fails, this returns null and the investigation proceeds — replay is
 * best-effort evidence, never a blocker.
 */
export async function captureReplay(
  investigationId: string,
  experimentId: string,
  replayBytes: Uint8Array,
  metadata?: Record<string, unknown>
): Promise<Evidence> {
  const content = Buffer.from(replayBytes);
  return captureEvidence({
    investigationId,
    experimentId,
    type: "replay",
    content,
    metadata: {
      ...metadata,
      format: "rrweb",
      sizeBytes: content.length,
    },
  });
}

/**
 * Record that a session replay is UNAVAILABLE for an experiment.
 *
 * Evidence integrity rule: the record states exactly what happened — replay
 * absence, the reason, and how hard Probe tried — with NO artifact bytes and
 * no fabricated content. `artifactAvailable` is false and `contentHash` is
 * empty, so the record can never be mistaken for a stored replay artifact.
 * Existing evidence (screenshots, action traces, logs) is untouched and
 * finding confirmation still requires actual supporting evidence.
 */
export async function captureReplayUnavailable(
  investigationId: string,
  experimentId: string,
  info: {
    solariSessionId: string;
    reason: "not_generated" | "not_ready" | "download_failed";
    detail: string;
  }
): Promise<Evidence> {
  return captureEvidence({
    investigationId,
    experimentId,
    type: "replay",
    metadata: {
      solariSessionId: info.solariSessionId,
      replayAvailable: false,
      replayUnavailableReason: info.reason,
      replayUnavailableDetail: info.detail.slice(0, 300),
      format: "rrweb",
    },
  });
}

/**
 * Capture a URL visit as evidence. URL evidence has no artifact bytes;
 * the URL itself is the evidence and is stored as the `uri`.
 *
 * `experimentId` is optional: reconnaissance URLs (captured before any
 * experiment exists) are recorded without one so provenance classification
 * can distinguish recon evidence from experiment-generated evidence.
 */
export async function captureUrlEvidence(
  investigationId: string,
  experimentId: string | undefined,
  url: string,
  pageTitle?: string
): Promise<Evidence> {
  return captureEvidence({
    investigationId,
    experimentId,
    type: "url",
    uri: url,
    metadata: { pageTitle: pageTitle ?? null },
  });
}

/**
 * Capture an action trace as evidence, persisted as a JSON artifact.
 */
export async function captureActionTrace(
  investigationId: string,
  experimentId: string,
  trace: Record<string, unknown>
): Promise<Evidence> {
  const content = JSON.stringify(trace, null, 2);
  return captureEvidence({
    investigationId,
    experimentId,
    type: "action_trace",
    content,
    metadata: { ...trace, sizeBytes: content.length },
  });
}

/**
 * Capture repository source evidence, persisted as a JSON artifact.
 */
export async function captureRepositoryEvidence(
  investigationId: string,
  filePath: string,
  content: string,
  metadata?: Record<string, unknown>
): Promise<Evidence> {
  return captureEvidence({
    investigationId,
    type: "repository_source",
    uri: filePath,
    content,
    metadata: {
      ...metadata,
      filePath,
      sizeBytes: content.length,
    },
  });
}

/**
 * Retrieve the persisted bytes for an Evidence item, if the artifact is
 * still available in the artifact store. Verifies the artifact against the
 * stored contentHash when both are present.
 *
 * Restart recovery: the metadata record carries the storageKey, so bytes
 * resolve from MongoDB metadata alone (local index.json remains a fallback
 * for artifacts written by older versions).
 */
export async function getEvidenceContent(
  evidence: Evidence
): Promise<{ buffer: Buffer | null; sha256: string | null; hashVerified: boolean }> {
  const artifactStore = getArtifactStore();

  let storagePath = evidence.metadata?.storageKey as string | undefined;
  if (!storagePath) {
    // Restart-recovery fallback: try the local index sidecar first, then the
    // deterministic key layout.
    const indexed = await getLocalIndexedArtifact(evidence.investigationId, evidence.id);
    if (indexed) {
      storagePath = indexed.storagePath;
    } else {
      const ext = extensionFor(evidence.type);
      storagePath =
        artifactStore.kind === "b2"
          ? `evidence/${evidence.investigationId}/${evidence.id}.${ext}`
          : `${evidence.investigationId}/${evidence.id}.${ext}`;
    }
  }

  const artifact: StoredArtifact = {
    evidenceId: evidence.id,
    investigationId: evidence.investigationId,
    experimentId: evidence.experimentId,
    evidenceType: evidence.type,
    mimeType: (evidence.metadata?.mimeType as string) ?? mimeFor(evidence.type),
    byteSize: (evidence.metadata?.byteSize as number) ?? 0,
    sha256: (evidence.metadata?.sha256 as string) ?? evidence.contentHash ?? "",
    storagePath: artifactStore.kind === "local" ? absoluteLocalPath(storagePath) : storagePath,
    createdAt: (evidence.metadata?.artifactCreatedAt as string) ?? evidence.createdAt,
  };

  const buffer = await artifactStore.read(artifact);
  if (!buffer) return { buffer: null, sha256: artifact.sha256 || null, hashVerified: false };

  // Re-verify the hash against the actual persisted bytes.
  const actual = fullSha256(buffer);
  const expected = artifact.sha256;
  return { buffer, sha256: actual, hashVerified: expected !== "" && actual === expected };
}

/** Local store paths are stored absolute; legacy relative → absolute. */
function absoluteLocalPath(storagePath: string): string {
  const root = evidenceRoot();
  if (storagePath.startsWith("/") || /^[A-Za-z]:/.test(storagePath)) {
    return storagePath; // already absolute
  }
  // Legacy relative layout: "<investigationId>/<evidenceId>.<ext>"
  return join(root, storagePath);
}

/** Delete the persisted artifact for an Evidence item (best effort). */
export async function deleteEvidenceArtifact(evidence: Evidence): Promise<void> {
  const storageKey = evidence.metadata?.storageKey as string | undefined;
  if (!storageKey) return;
  const artifactStore = getArtifactStore();
  await artifactStore.delete({
    evidenceId: evidence.id,
    investigationId: evidence.investigationId,
    experimentId: evidence.experimentId,
    evidenceType: evidence.type,
    mimeType: "application/octet-stream",
    byteSize: 0,
    sha256: "",
    storagePath: artifactStore.kind === "local" ? storageKey : storageKey,
    createdAt: evidence.createdAt,
  });
}

/**
 * Delete every artifact for an investigation. Resolves metadata records
 * first (no bucket-wide listing), then deletes each artifact.
 */
export async function deleteInvestigationArtifacts(investigationId: string): Promise<void> {
  const artifactStore = getArtifactStore();
  const evidence = store.listEvidence(investigationId);
  await Promise.all(evidence.map((ev) => deleteEvidenceArtifact(ev)));
  if (artifactStore.kind === "local") {
    await artifactStore.deleteInvestigation(investigationId);
  }
}

export { contentHash };

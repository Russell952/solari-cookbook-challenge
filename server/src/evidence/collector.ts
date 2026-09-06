/**
 * Evidence collector.
 *
 * Captures evidence from browser/sandbox operations and persists the actual
 * artifact bytes through the EvidenceStore (server/data/evidence/), then
 * records metadata with content hashes in the in-memory store.
 *
 * Integrity invariant: the contentHash stored on an Evidence is the full
 * SHA-256 of the persisted bytes — the artifact remains retrievable and the
 * hash can always be re-verified against it.
 */
import { createHash, randomUUID } from "crypto";
import { store } from "../store/index.js";
import {
  saveArtifact,
  readArtifact,
  deleteArtifact,
  getArtifactFromIndex,
  type EvidenceArtifact,
} from "./store.js";
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
 * The artifact bytes are persisted first; the Evidence record then carries
 * the full SHA-256 of the persisted bytes plus retrieval metadata. If the
 * disk write fails, the metadata record is still created (marked
 * `artifactAvailable: false`) so evidence capture degrades instead of
 * crashing an experiment.
 */
export async function captureEvidence(opts: CaptureEvidenceOpts): Promise<Evidence> {
  const evidenceId = opts.evidenceId ?? randomUUID();
  let artifact: EvidenceArtifact | null = null;

  if (opts.content !== undefined) {
    try {
      artifact = await saveArtifact({
        evidenceId,
        investigationId: opts.investigationId,
        experimentId: opts.experimentId ?? null,
        evidenceType: opts.type,
        content: opts.content,
      });
    } catch (error) {
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
    ...(artifact
      ? {
          mimeType: artifact.mimeType,
          byteSize: artifact.byteSize,
          sha256: artifact.sha256,
          artifactPath: artifact.storagePath,
          artifactCreatedAt: artifact.createdAt,
        }
      : {}),
  };

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
 * downloaded from
 * Solari AFTER the browser session is released, so retrieval does not
 * depend on the session still existing. The bytes are persisted through the
 * EvidenceStore like any other artifact.
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
 * Capture a URL visit as evidence. URL evidence has no artifact bytes;
 * the URL itself is the evidence and is stored as the `uri`.
 */
export async function captureUrlEvidence(
  investigationId: string,
  experimentId: string,
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
 * still available on disk. Verifies the artifact against the stored
 * contentHash when both are present.
 *
 * Restart recovery: if the in-memory Evidence record lacks an artifactPath
 * (e.g. a reconstructed record), the on-disk artifact index can still
 * locate the artifact as long as the filesystem data remains.
 */
export async function getEvidenceContent(
  evidence: Evidence
): Promise<{ buffer: Buffer | null; sha256: string | null; hashVerified: boolean }> {
  let path = evidence.metadata?.artifactPath as string | undefined;
  if (!path) {
    const indexed = await getArtifactFromIndex(evidence.investigationId, evidence.id);
    if (indexed) path = indexed.storagePath;
  }
  if (!path) return { buffer: null, sha256: null, hashVerified: false };

  const artifact: EvidenceArtifact = {
    evidenceId: evidence.id,
    investigationId: evidence.investigationId,
    experimentId: evidence.experimentId,
    evidenceType: evidence.type,
    mimeType: (evidence.metadata?.mimeType as string) ?? "application/octet-stream",
    byteSize: (evidence.metadata?.byteSize as number) ?? 0,
    sha256: (evidence.metadata?.sha256 as string) ?? evidence.contentHash ?? "",
    storagePath: path,
    createdAt: (evidence.metadata?.artifactCreatedAt as string) ?? evidence.createdAt,
  };

  const buffer = await readArtifact(artifact);
  if (!buffer) return { buffer: null, sha256: artifact.sha256 || null, hashVerified: false };

  // Re-verify the hash against the actual persisted bytes.
  const actual = fullSha256Of(buffer);
  const expected = artifact.sha256;
  return { buffer, sha256: actual, hashVerified: expected !== "" && actual === expected };
}

/** Delete the persisted artifact for an Evidence item (best effort). */
export async function deleteEvidenceArtifact(evidence: Evidence): Promise<void> {
  const path = evidence.metadata?.artifactPath as string | undefined;
  if (!path) return;
  await deleteArtifact({
    evidenceId: evidence.id,
    investigationId: evidence.investigationId,
    experimentId: evidence.experimentId,
    evidenceType: evidence.type,
    mimeType: "application/octet-stream",
    byteSize: 0,
    sha256: "",
    storagePath: path,
    createdAt: evidence.createdAt,
  });
}

export { contentHash };

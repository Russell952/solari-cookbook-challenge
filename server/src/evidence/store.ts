/**
 * Filesystem-backed EvidenceStore.
 *
 * Persists the actual artifact bytes for evidence items so that the
 * contentHash recorded on an Evidence is verifiable against retrievable
 * bytes — not just a hash of data that was thrown away.
 *
 * Layout on disk:
 *   server/data/evidence/<investigationId>/<evidenceId>.<ext>
 *
 * This is deliberately the smallest production-sensible store for a
 * challenge/demo environment. It is not a database and not object storage;
 * the in-memory store keeps the metadata, the filesystem keeps the bytes.
 */
import { createHash, randomUUID } from "crypto";
import { mkdir, readFile, writeFile, unlink, rm } from "fs/promises";
import { join } from "path";
import { config } from "../config/index.js";

/**
 * Guard against unlimited disk growth: reject artifacts beyond the per-artifact
 * cap and investigations whose cumulative artifact bytes exceed the cap.
 * The SHA-256 integrity model is unchanged — these caps apply before write.
 */
async function assertWithinStorageCaps(investigationId: string, buffer: Buffer): Promise<void> {
  if (buffer.length > config.maxArtifactBytes) {
    throw new Error(
      `Artifact exceeds maximum size (${buffer.length} > ${config.maxArtifactBytes} bytes)`
    );
  }
  const entries = await readArtifactIndex(investigationId);
  const total = entries.reduce((sum, e) => sum + (e.byteSize || 0), 0);
  if (total + buffer.length > config.maxInvestigationArtifactBytes) {
    throw new Error(
      `Investigation evidence storage cap exceeded (${total + buffer.length} > ${config.maxInvestigationArtifactBytes} bytes)`
    );
  }
}

export interface EvidenceArtifact {
  evidenceId: string;
  investigationId: string;
  experimentId: string | null;
  evidenceType: string;
  /** MIME type of the stored artifact. */
  mimeType: string;
  /** Byte size of the persisted artifact. */
  byteSize: number;
  /** Full 64-character hex SHA-256 of the persisted bytes. */
  sha256: string;
  /** Absolute path of the artifact on disk. */
  storagePath: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
}

/** File extension per evidence type. Screenshots are real image files. */
const EXT_BY_TYPE: Record<string, { ext: string; mime: string }> = {
  screenshot: { ext: "png", mime: "image/png" },
  action_trace: { ext: "json", mime: "application/json" },
  repository_source: { ext: "json", mime: "application/json" },
  // Solari session replays are rrweb NDJSON event streams (DOM-level
  // recordings), NOT video — verified byte-level against live sessions.
  // They are stored as .ndjson with application/x-ndjson so the MIME
  // metadata describes what is actually on disk.
  replay: { ext: "ndjson", mime: "application/x-ndjson" },
  dom_snapshot: { ext: "html", mime: "text/html" },
  console_output: { ext: "txt", mime: "text/plain" },
  expected_result: { ext: "json", mime: "application/json" },
  observed_result: { ext: "json", mime: "application/json" },
};

const DEFAULT_EXT = { ext: "bin", mime: "application/octet-stream" };

/**
 * Root directory for persisted evidence. `server/data/evidence/`.
 * Overridable for tests via PROBE_EVIDENCE_DIR.
 */
export function evidenceRoot(): string {
  return process.env.PROBE_EVIDENCE_DIR ?? join(process.cwd(), "data", "evidence");
}

function fullSha256(data: string | Buffer): string {
  // Full 64-character hexadecimal digest — no truncation.
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Save an artifact for an evidence item. Bytes are written to disk and
 * hashed; the hash always describes the persisted bytes.
 *
 * A per-investigation `index.json` sidecar records the artifact descriptor
 * so artifacts remain independently retrievable after a server restart
 * (the in-memory Evidence metadata store does not survive restarts).
 */
export async function saveArtifact(opts: {
  evidenceId: string;
  investigationId: string;
  experimentId?: string | null;
  evidenceType: string;
  content: string | Buffer;
}): Promise<EvidenceArtifact> {
  if (!opts.evidenceId || !opts.investigationId) {
    throw new Error("EvidenceStore: evidenceId and investigationId are required");
  }

  const buffer = Buffer.isBuffer(opts.content) ? opts.content : Buffer.from(opts.content, "utf-8");
  const { ext, mime } = EXT_BY_TYPE[opts.evidenceType] ?? DEFAULT_EXT;

  await assertWithinStorageCaps(opts.investigationId, buffer);

  const dir = join(evidenceRoot(), opts.investigationId);
  await mkdir(dir, { recursive: true });

  const filePath = join(dir, `${opts.evidenceId}.${ext}`);
  await writeFile(filePath, buffer);

  const artifact: EvidenceArtifact = {
    evidenceId: opts.evidenceId,
    investigationId: opts.investigationId,
    experimentId: opts.experimentId ?? null,
    evidenceType: opts.evidenceType,
    mimeType: mime,
    byteSize: buffer.length,
    sha256: fullSha256(buffer),
    storagePath: filePath,
    createdAt: new Date().toISOString(),
  };

  await upsertArtifactIndex(artifact);
  return artifact;
}

// ── On-disk artifact index (restart recovery) ────────────────────────────

const INDEX_FILENAME = "index.json";

// Serialize index read-modify-write cycles per investigation. Concurrent
// captures for the same investigation must not clobber each other's entries.
const indexWrites = new Map<string, Promise<void>>();

function withSerializedIndexWrite<T>(
  investigationId: string,
  fn: () => Promise<T>
): Promise<T> {
  const prev = indexWrites.get(investigationId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  indexWrites.set(
    investigationId,
    next.then(
      () => undefined,
      () => undefined
    )
  );
  return next;
}

async function readArtifactIndex(investigationId: string): Promise<EvidenceArtifact[]> {
  try {
    const raw = await readFile(join(evidenceRoot(), investigationId, INDEX_FILENAME), "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as EvidenceArtifact[]) : [];
  } catch {
    return [];
  }
}

async function upsertArtifactIndex(artifact: EvidenceArtifact): Promise<void> {
  await withSerializedIndexWrite(artifact.investigationId, async () => {
    const entries = await readArtifactIndex(artifact.investigationId);
    const idx = entries.findIndex((e) => e.evidenceId === artifact.evidenceId);
    if (idx >= 0) entries[idx] = artifact;
    else entries.push(artifact);
    await writeFile(
      join(evidenceRoot(), artifact.investigationId, INDEX_FILENAME),
      JSON.stringify(entries, null, 2)
    );
  });
}

/**
 * Look up an artifact descriptor from the on-disk index.
 *
 * This is the restart-recovery path: it works with no in-memory state at
 * all, as long as `server/data/evidence/<investigationId>/` is intact.
 */
export async function getArtifactFromIndex(
  investigationId: string,
  evidenceId: string
): Promise<EvidenceArtifact | null> {
  const entries = await readArtifactIndex(investigationId);
  return entries.find((e) => e.evidenceId === evidenceId) ?? null;
}

/** Retrieve the persisted bytes for an artifact, or null if it does not exist. */
export async function readArtifact(artifact: EvidenceArtifact): Promise<Buffer | null> {
  try {
    return await readFile(artifact.storagePath);
  } catch {
    return null;
  }
}

/** Delete a single artifact (best effort). */
export async function deleteArtifact(artifact: EvidenceArtifact): Promise<void> {
  try {
    await unlink(artifact.storagePath);
  } catch {
    // Already gone — deletion is best effort by design.
  }
}

/**
 * Delete every artifact for an investigation. Intended for explicit
 * lifecycle cleanup (e.g. store.clearAll in tests); never called
 * automatically by the orchestrator.
 */
export async function deleteInvestigationArtifacts(investigationId: string): Promise<void> {
  try {
    await rm(join(evidenceRoot(), investigationId), { recursive: true, force: true });
  } catch {
    // Best effort.
  }
}

/** Exposed for tests. */
export { readArtifactIndex };

/** Validate a SHA-256 hex digest shape (64 hex chars). */
export function isFullSha256(hash: string | null | undefined): boolean {
  return typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash);
}

/** Re-export for callers that need to mint IDs alongside artifact storage. */
export { randomUUID };

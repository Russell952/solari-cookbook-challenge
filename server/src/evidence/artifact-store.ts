/**
 * Artifact store abstraction — where evidence BYTES live.
 *
 *   LocalArtifactStore  — server/data/evidence/ (dev/tests; matches the old
 *                         filesystem layout and its index.json recovery file)
 *   B2ArtifactStore     — Backblaze B2, S3-compatible private bucket (prod)
 *
 * The evidence DOMAIN model (ownership, investigation/experiment relations,
 * type, hash, metadata) stays in the store/collector; implementations deal
 * only with bytes and storage keys. Object keys are deterministic and safe:
 * `evidence/<investigationId>/<evidenceId>.<ext>` — ids are server-generated
 * (never user input), so no traversal/absolute paths are possible, and the
 * key is authorization-irrelevant (access always goes through the API).
 */
import { createHash } from "crypto";
import { mkdir, readFile, writeFile, unlink, rm } from "fs/promises";
import { join } from "path";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { config, isB2Configured } from "../config/index.js";

/** File extension + MIME per evidence type. Replay is rrweb NDJSON, NOT video/webm. */
export const EXT_BY_TYPE: Record<string, { ext: string; mime: string }> = {
  screenshot: { ext: "png", mime: "image/png" },
  action_trace: { ext: "json", mime: "application/json" },
  repository_source: { ext: "json", mime: "application/json" },
  replay: { ext: "ndjson", mime: "application/x-ndjson" },
  dom_snapshot: { ext: "html", mime: "text/html" },
  console_output: { ext: "txt", mime: "text/plain" },
  expected_result: { ext: "json", mime: "application/json" },
  observed_result: { ext: "json", mime: "application/json" },
};

const DEFAULT_EXT = { ext: "bin", mime: "application/octet-stream" };

export function extensionFor(type: string): string {
  return (EXT_BY_TYPE[type] ?? DEFAULT_EXT).ext;
}

export function mimeFor(type: string): string {
  return (EXT_BY_TYPE[type] ?? DEFAULT_EXT).mime;
}

export function fullSha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Validate a SHA-256 hex digest shape (64 hex chars). */
export function isFullSha256(hash: string | null | undefined): boolean {
  return typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash);
}

export interface StoredArtifact {
  evidenceId: string;
  investigationId: string;
  experimentId: string | null;
  evidenceType: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  /** Storage location: filesystem path (local) or object key (B2). */
  storagePath: string;
  createdAt: string;
}

/**
 * The artifact store contract. Implementations must be safe to call
 * concurrently and must never throw on missing objects during reads
 * (return null instead) — deletes stay best-effort.
 */
export interface ArtifactStore {
  readonly kind: "local" | "b2";
  save(opts: {
    evidenceId: string;
    investigationId: string;
    experimentId?: string | null;
    evidenceType: string;
    content: string | Buffer;
  }): Promise<StoredArtifact>;
  /** Retrieve bytes, or null when the artifact does not exist. */
  read(artifact: StoredArtifact): Promise<Buffer | null>;
  delete(artifact: StoredArtifact): Promise<void>;
  deleteInvestigation(investigationId: string): Promise<void>;
  /** Per-investigation stored bytes (for the storage-cap check). */
  investigationBytes(investigationId: string): Promise<number>;
}

// ── Local filesystem implementation (dev/test) ───────────────────────────

/** Root directory for persisted evidence. Overridable for tests. */
export function evidenceRoot(): string {
  return process.env.PROBE_EVIDENCE_DIR ?? join(process.cwd(), "data", "evidence");
}

export class LocalArtifactStore implements ArtifactStore {
  readonly kind = "local" as const;

  async save(opts: {
    evidenceId: string;
    investigationId: string;
    experimentId?: string | null;
    evidenceType: string;
    content: string | Buffer;
  }): Promise<StoredArtifact> {
    const buffer = Buffer.isBuffer(opts.content) ? opts.content : Buffer.from(opts.content, "utf-8");
    const { ext, mime } = EXT_BY_TYPE[opts.evidenceType] ?? DEFAULT_EXT;
    const dir = join(evidenceRoot(), opts.investigationId);
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, `${opts.evidenceId}.${ext}`);
    await writeFile(filePath, buffer);
    const artifact: StoredArtifact = {
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

  async read(artifact: StoredArtifact): Promise<Buffer | null> {
    try {
      return await readFile(artifact.storagePath);
    } catch {
      return null;
    }
  }

  async delete(artifact: StoredArtifact): Promise<void> {
    try {
      await unlink(artifact.storagePath);
    } catch {
      /* already gone — best effort */
    }
  }

  async deleteInvestigation(investigationId: string): Promise<void> {
    try {
      await rm(join(evidenceRoot(), investigationId), { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }

  async investigationBytes(investigationId: string): Promise<number> {
    const entries = await readArtifactIndex(investigationId);
    return entries.reduce((s, e) => s + (e.byteSize || 0), 0);
  }
}

// ── Local index sidecar (restart recovery for dev/local runs) ────────────
// MongoDB carries the authoritative metadata in production; this sidecar
// keeps the local filesystem store independently recoverable after a
// process restart, matching the historical behavior.

const INDEX_FILENAME = "index.json";
const indexWrites = new Map<string, Promise<void>>();

function withSerializedIndexWrite<T>(investigationId: string, fn: () => Promise<T>): Promise<T> {
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

async function readArtifactIndex(investigationId: string): Promise<StoredArtifact[]> {
  try {
    const raw = await readFile(join(evidenceRoot(), investigationId, INDEX_FILENAME), "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StoredArtifact[]) : [];
  } catch {
    return [];
  }
}

async function upsertArtifactIndex(artifact: StoredArtifact): Promise<void> {
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
 * Look up an artifact descriptor from the local on-disk index — the
 * restart-recovery path when metadata lives only on disk (dev/local).
 */
export async function getLocalIndexedArtifact(
  investigationId: string,
  evidenceId: string
): Promise<StoredArtifact | null> {
  const entries = await readArtifactIndex(investigationId);
  return entries.find((e) => e.evidenceId === evidenceId) ?? null;
}

// ── Backblaze B2 implementation (production) ─────────────────────────────

/**
 * B2 artifact store over the S3-compatible API.
 *
 * - Private bucket only: no public ACLs, no presigned URL generation, no
 *   anonymous reads. Retrieval always flows through the Probe API after an
 *   ownership check.
 * - Credentials come from env (B2_KEY_ID / B2_APPLICATION_KEY) and are never
 *   logged. The client is created once (pooled HTTP) — never per request.
 * - forcePathStyle is required by B2's S3 compatibility.
 */
export class B2ArtifactStore implements ArtifactStore {
  readonly kind = "b2" as const;
  private client: S3Client;

  constructor(
    private readonly bucketName: string,
    endpoint: string,
    region: string,
    keyId: string,
    applicationKey: string
  ) {
    this.client = new S3Client({
      endpoint,
      region,
      credentials: { accessKeyId: keyId, secretAccessKey: applicationKey },
      forcePathStyle: true, // B2 requirement
      maxAttempts: 2, // bounded retry; never an unbounded loop
      requestHandler: { requestTimeout: 60_000 },
    } as ConstructorParameters<typeof S3Client>[0] & Record<string, unknown>);
  }

  /** Deterministic, traversal-proof object key from server-generated ids. */
  objectKey(investigationId: string, evidenceId: string, ext: string): string {
    const safeInv = investigationId.replace(/[^A-Za-z0-9_-]/g, "");
    const safeEv = evidenceId.replace(/[^A-Za-z0-9_-]/g, "");
    if (!safeInv || !safeEv) {
      throw new Error("ArtifactStore: invalid investigation/evidence id for storage key");
    }
    return `evidence/${safeInv}/${safeEv}.${ext}`;
  }

  async save(opts: {
    evidenceId: string;
    investigationId: string;
    experimentId?: string | null;
    evidenceType: string;
    content: string | Buffer;
  }): Promise<StoredArtifact> {
    const buffer = Buffer.isBuffer(opts.content) ? opts.content : Buffer.from(opts.content, "utf-8");
    const { ext, mime } = EXT_BY_TYPE[opts.evidenceType] ?? DEFAULT_EXT;
    const key = this.objectKey(opts.investigationId, opts.evidenceId, ext);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: buffer,
        ContentType: mime,
        // Explicitly private: B2 private buckets ignore this, but stating it
        // documents intent and fails safe if the bucket is ever misconfigured.
        ACL: "private",
      })
    );
    return {
      evidenceId: opts.evidenceId,
      investigationId: opts.investigationId,
      experimentId: opts.experimentId ?? null,
      evidenceType: opts.evidenceType,
      mimeType: mime,
      byteSize: buffer.length,
      sha256: fullSha256(buffer),
      storagePath: key, // object key — persisted in evidence metadata
      createdAt: new Date().toISOString(),
    };
  }

  async read(artifact: StoredArtifact): Promise<Buffer | null> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucketName, Key: artifact.storagePath })
      );
      const bytes = await res.Body?.transformToByteArray();
      return bytes ? Buffer.from(bytes) : null;
    } catch {
      // Missing object (or transient error) → null; the metadata endpoint
      // remains the availability source of truth.
      return null;
    }
  }

  async delete(artifact: StoredArtifact): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucketName, Key: artifact.storagePath })
      );
    } catch {
      /* best effort */
    }
  }

  async deleteInvestigation(investigationId: string): Promise<void> {
    // Keys are enumerated from metadata by the caller (collector); here we
    // only expose the per-object delete. No bucket-wide listing needed:
    // deleteInvestigationArtifacts resolves metadata first.
    void investigationId;
  }

  async investigationBytes(investigationId: string): Promise<number> {
    void investigationId;
    // Cap accounting for B2 is computed by the collector from evidence
    // metadata (byteSize), avoiding a bucket ListObjects call per capture.
    return 0;
  }
}

/** Shared mutable store instance + factory. */
let artifactStore: ArtifactStore | null = null;

export function getArtifactStore(): ArtifactStore {
  if (!artifactStore) {
    artifactStore = isB2Configured()
      ? new B2ArtifactStore(
          config.b2BucketName,
          config.b2Endpoint,
          config.b2Region,
          config.b2KeyId,
          config.b2ApplicationKey
        )
      : new LocalArtifactStore();
  }
  return artifactStore;
}

/** Test hook: inject a store (e.g. an in-memory fake). */
export function setArtifactStore(store: ArtifactStore | null): void {
  artifactStore = store;
}

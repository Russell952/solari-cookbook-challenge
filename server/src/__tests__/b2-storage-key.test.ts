/**
 * B2 artifact store — storage-key contract.
 *
 * Regression guard for the evidence download path: retrieval MUST read the
 * object at the key persisted in evidence metadata (metadata.storageKey),
 * never re-derive a key from the evidence id (or anything else). If the
 * stored key and a re-derived key ever diverge, reads would silently 404
 * against B2 while metadata still claimed the artifact exists.
 */
/** @vitest-environment node */
import { describe, it, expect, vi } from "vitest";
import { B2ArtifactStore } from "../evidence/artifact-store.js";

function storeWithCapturedReads(objects: Map<string, Buffer>) {
  const readKeys: string[] = [];
  const saveKeys: string[] = [];
  const client = {
    send: vi.fn(async (cmd: { constructor: { name: string }; input: { Key?: string; Bucket?: string; Body?: Buffer } }) => {
      const name = cmd.constructor.name;
      if (name === "GetObjectCommand") {
        const key = cmd.input.Key!;
        readKeys.push(key);
        const body = objects.get(key);
        if (!body) {
          // Mirror the S3 error shape for a missing object.
          const err = new Error("NoSuchKey") as Error & { name: string; $metadata?: unknown };
          err.name = "NoSuchKey";
          throw err;
        }
        return { Body: { transformToByteArray: async () => Uint8Array.from(body) } };
      }
      if (name === "PutObjectCommand") {
        const key = cmd.input.Key!;
        saveKeys.push(key);
        objects.set(key, cmd.input.Body!);
        return {};
      }
      if (name === "DeleteObjectCommand") {
        objects.delete(cmd.input.Key!);
        return {};
      }
      return {};
    }),
  };
  const b2 = new B2ArtifactStore("bucket", "https://s3.example", "us-west-004", "k", "s");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (b2 as any).client = client;
  return { b2, readKeys, saveKeys, client };
}

describe("B2ArtifactStore storage-key contract", () => {
  it("save persists the deterministic object key as storagePath", async () => {
    const objects = new Map<string, Buffer>();
    const { b2 } = storeWithCapturedReads(objects);

    const artifact = await b2.save({
      evidenceId: "ev_123",
      investigationId: "inv_abc",
      evidenceType: "screenshot",
      content: Buffer.from("png-bytes"),
    });

    expect(artifact.storagePath).toBe("evidence/inv_abc/ev_123.png");
    expect(artifact.sha256).toHaveLength(64);
    expect(objects.has("evidence/inv_abc/ev_123.png")).toBe(true);
  });

  it("read uses EXACTLY the storagePath it was given — even if it differs from any re-derived key", async () => {
    const objects = new Map<string, Buffer>();
    const { b2, readKeys } = storeWithCapturedReads(objects);
    // Simulate a legacy/migrated object whose key differs from today's
    // deterministic layout — metadata is the source of truth.
    objects.set("legacy/other/key.png", Buffer.from("bytes"));

    const read = await b2.read({
      evidenceId: "ev_999",
      investigationId: "inv_999",
      experimentId: null,
      evidenceType: "screenshot",
      mimeType: "image/png",
      byteSize: 5,
      sha256: "",
      storagePath: "legacy/other/key.png",
      createdAt: new Date().toISOString(),
    });

    expect(readKeys).toEqual(["legacy/other/key.png"]);
    expect(read?.toString()).toBe("bytes");
  });

  it("read returns null (never throws) for a missing B2 object", async () => {
    const objects = new Map<string, Buffer>();
    const { b2 } = storeWithCapturedReads(objects);

    const read = await b2.read({
      evidenceId: "ev_missing",
      investigationId: "inv_x",
      experimentId: null,
      evidenceType: "screenshot",
      mimeType: "image/png",
      byteSize: 0,
      sha256: "",
      storagePath: "evidence/inv_x/ev_missing.png",
      createdAt: new Date().toISOString(),
    });

    expect(read).toBeNull();
  });

  it("objectKey is traversal-proof and id-stable", () => {
    const objects = new Map<string, Buffer>();
    const { b2 } = storeWithCapturedReads(objects);
    expect(b2.objectKey("inv_1", "ev_1", "png")).toBe("evidence/inv_1/ev_1.png");
    expect(b2.objectKey("../../etc", "ev/../x", "png")).toBe("evidence/etc/evx.png");
  });
});

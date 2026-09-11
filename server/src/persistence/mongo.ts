/**
 * MongoDB persistence implementation (production).
 *
 * Role in the architecture: the DURABLE BACKEND. The store facade keeps the
 * synchronous domain API over its in-process cache (hydrated from Mongo at
 * startup, kept warm by write-through upserts). Users are the exception:
 * accounts are always read through the indexed UserRepository below — never
 * cached across processes — so login/signup are single indexed queries.
 *
 * Connection: ONE lazily-created MongoClient per process — never per request.
 * Pooling, bounded server-selection and connect timeouts are configured on
 * the client so a slow/unreachable cluster fails fast and gracefully.
 *
 * Collections (normalized; small related data is embedded, large/binary data
 * is NOT stored here — artifact bytes live in B2):
 *   users           unique index on email (case-normalized at write time)
 *   investigations  { ownerId+createdAt } for dashboard lists, { ownerId+status }
 *   experiments     { investigationId+sequence }
 *   actions         { experimentId+sequence }
 *   observations    { experimentId+timestamp }
 *   evidence        { investigationId+createdAt } (metadata only; storageKey → B2)
 *   hypotheses      { investigationId+createdAt }
 *   findings        { investigationId+createdAt }
 *   reports         { investigationId } (one per investigation)
 */
import { MongoClient, type Db, type Collection, type WithId, type Document, MongoError } from "mongodb";
import type {
  Investigation,
  Experiment,
  Action,
  Observation,
  Evidence,
  Hypothesis,
  Finding,
  Report,
  SolariSession,
} from "@probe/shared";
import type { DurableBackend, StoredUser, UserRepository, HydratedState } from "./types.js";
import { EmailAlreadyExistsError } from "./types.js";

function now(): string {
  return new Date().toISOString();
}

const dupKeyCodes = new Set([11000, 11001]);
function isDuplicateKeyError(err: unknown): boolean {
  const e = err as { code?: number };
  return !!e && typeof e === "object" && dupKeyCodes.has(Number((e as MongoError).code));
}

interface UserDoc {
  _id: string;
  email: string;
  passwordHash: string;
  createdAt: string;
}

export class MongoPersistence implements DurableBackend {
  readonly kind = "mongo" as const;
  private client: MongoClient | null = null;
  private db: Db | null = null;

  constructor(
    private readonly uri: string,
    private readonly dbName: string
  ) {}

  private async connect(): Promise<Db> {
    if (this.db) return this.db;
    // One client per process. Bounded timeouts so an unreachable cluster
    // fails within seconds instead of hanging request handlers.
    this.client = new MongoClient(this.uri, {
      maxPoolSize: 10,
      minPoolSize: 1,
      serverSelectionTimeoutMS: 8_000,
      connectTimeoutMS: 8_000,
      socketTimeoutMS: 30_000,
      retryWrites: true,
      appName: "probe-api",
    });
    await this.client.connect();
    this.db = this.client.db(this.dbName);
    await this.ensureIndexes();
    return this.db;
  }

  private async ensureIndexes(): Promise<void> {
    const db = this.db!;
    // users.email: unique + case-normalized (normalization happens at write;
    // the unique index makes duplicate-email races a handled error).
    await db.collection("users").createIndex({ email: 1 }, { unique: true });
    // investigations: dashboard lists are owner + recency; phase/status filters.
    await db.collection("investigations").createIndex({ ownerId: 1, createdAt: -1 });
    await db.collection("investigations").createIndex({ ownerId: 1, status: 1 });
    // experiments: always listed per investigation in sequence order.
    await db.collection("experiments").createIndex({ investigationId: 1, sequence: 1 });
    // actions: per-experiment listing.
    await db.collection("actions").createIndex({ experimentId: 1, sequence: 1 });
    // observations: per-experiment analysis reads.
    await db.collection("observations").createIndex({ experimentId: 1, timestamp: 1 });
    // evidence: per-investigation listing (metadata only).
    await db.collection("evidence").createIndex({ investigationId: 1, createdAt: 1 });
    await db.collection("hypotheses").createIndex({ investigationId: 1, createdAt: 1 });
    await db.collection("findings").createIndex({ investigationId: 1, createdAt: 1 });
    await db.collection("reports").createIndex({ investigationId: 1 }, { unique: true });
  }

  private async col<T extends Document>(name: string): Promise<Collection<T>> {
    const db = await this.connect();
    return db.collection<T>(name);
  }

  // ── Users (always read through here — never cached cross-process) ──────
  public users: UserRepository = {
    getUserByEmail: async (email) => {
      const col = await this.col<UserDoc>("users");
      const doc = await col.findOne({ email: email.trim().toLowerCase() });
      return doc ? { id: doc._id, email: doc.email, passwordHash: doc.passwordHash, createdAt: doc.createdAt } : null;
    },
    getUserById: async (id) => {
      const col = await this.col<UserDoc>("users");
      const doc = await col.findOne({ _id: id });
      return doc ? { id: doc._id, email: doc.email, passwordHash: doc.passwordHash, createdAt: doc.createdAt } : null;
    },
    createUser: async (email, passwordHash) => {
      const normalized = email.trim().toLowerCase();
      const col = await this.col<UserDoc>("users");
      const user: UserDoc = {
        _id: `usr_${crypto.randomUUID()}`,
        email: normalized,
        passwordHash,
        createdAt: now(),
      };
      try {
        await col.insertOne(user);
      } catch (err) {
        // Duplicate-email race: the unique index is the authority.
        if (isDuplicateKeyError(err)) throw new EmailAlreadyExistsError(normalized);
        throw err;
      }
      return { id: user._id, email: user.email, passwordHash: user.passwordHash, createdAt: user.createdAt };
    },
    preload: async () => {
      /* Mongo lookups are indexed; no preload needed */
    },
  };

  public async init(): Promise<void> {
    await this.connect();
  }

  public async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.db = null;
    }
  }

  // ── Raw document surface (facade write-through + hydration) ───────────

  private async rawCollection(name: string): Promise<Collection<Document>> {
    return (await this.connect()).collection(name);
  }

  public async upsertRaw(collection: string, doc: Record<string, unknown> & { id: string }): Promise<void> {
    const col = await this.rawCollection(collection);
    // id is the natural key everywhere (domain ids like inv_..., not _id).
    await col.replaceOne({ id: doc.id }, doc as unknown as Document, { upsert: true });
  }

  public async upsertReportRaw(doc: Record<string, unknown>): Promise<void> {
    const col = await this.rawCollection("reports");
    await col.replaceOne(
      { investigationId: doc.investigationId },
      doc as unknown as Document,
      { upsert: true }
    );
  }

  public async hydrateAll(): Promise<HydratedState> {
    const db = await this.connect();
    const [investigations, experiments, actions, observations, evidence, hypotheses, findings, reports, sessions] =
      await Promise.all([
        db.collection("investigations").find().toArray(),
        db.collection("experiments").find().sort({ sequence: 1 }).toArray(),
        db.collection("actions").find().sort({ sequence: 1 }).toArray(),
        db.collection("observations").find().toArray(),
        db.collection("evidence").find().toArray(),
        db.collection("hypotheses").find().toArray(),
        db.collection("findings").find().toArray(),
        db.collection("reports").find().toArray(),
        db.collection("solari_sessions").find().toArray(),
      ]);
    // Documents are written from typed domain objects (write-through) and
    // never contain Mongo ObjectId `_id`s (domain ids are natural keys), so
    // the double cast is sound here.
    const asTyped = <T,>(docs: WithId<Document>[]): T[] => docs as unknown as T[];
    return {
      investigations: asTyped<Investigation>(investigations),
      experiments: asTyped<Experiment>(experiments),
      actions: asTyped<Action>(actions),
      observations: asTyped<Observation>(observations),
      evidence: asTyped<Evidence>(evidence),
      hypotheses: asTyped<Hypothesis>(hypotheses),
      findings: asTyped<Finding>(findings),
      reports: asTyped<Report>(reports),
      sessions: asTyped<SolariSession>(sessions),
    };
  }
}

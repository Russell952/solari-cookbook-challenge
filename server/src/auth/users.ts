/**
 * Filesystem user store for email/password accounts.
 *
 * No database: users live as one JSON file per user under
 * `server/data/users/<normalizedEmail>.json` — the same filesystem-persistence
 * convention as the evidence store (`server/data/evidence/`). Writes are
 * atomic (temp file + rename) so a crash cannot corrupt a record.
 *
 * Each record holds only what auth requires:
 *   id, email (normalized), passwordHash, createdAt
 *
 * Passwords are hashed with Node's native scrypt (N=16384, r=8, p=1,
 * 64-byte key) in the standard `scrypt$N$r$p$salt$hash` serialization —
 * no custom cryptography, no plaintext, no extra dependency.
 *
 * Reads are cached in-process after first load; every auth operation
 * re-reads on a cache miss so records created by other processes
 * (or manually) are picked up.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "crypto";
import { promisify } from "util";
import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { join } from "path";

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem?: number }
) => Promise<Buffer>;

/** Root directory for persisted users. `server/data/users/`. Overridable for tests. */
export function usersRoot(): string {
  return process.env.PROBE_USERS_DIR ?? join(process.cwd(), "data", "users");
}

export interface StoredUser {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: string;
}

/** Normalize an email: trim + lowercase, consistently, everywhere. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** RFC-5322-lite validation: one @, non-empty local part, domain with a dot. */
export function isValidEmail(email: string): boolean {
  const normalized = normalizeEmail(email);
  if (normalized.length < 3 || normalized.length > 254) return false;
  const at = normalized.indexOf("@");
  if (at <= 0 || at !== normalized.lastIndexOf("@")) return false;
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  if (!local || local.length > 64) return false;
  // Domain: labels of alnum/hyphen, at least one dot, no leading/trailing hyphen/dot.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) return false;
  return true;
}

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64, SCRYPT_PARAMS);
  return `scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${salt.toString("hex")}$${key.toString("hex")}`;
}

/** Timing-safe password verification; returns false on any malformed hash. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nStr, rStr, pStr, saltHex, hashHex] = parts;
  const N = parseInt(nStr, 10);
  const r = parseInt(rStr, 10);
  const p = parseInt(pStr, 10);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  try {
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(hashHex, "hex");
    const actual = await scrypt(password, salt, expected.length, { N, r, p, maxmem: 64 * 1024 * 1024 });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** Per-email in-process cache (records are immutable except by rewrite here). */
const cache = new Map<string, StoredUser>();
/** id → user cache so request-path getUserById avoids directory scans. */
const cacheById = new Map<string, StoredUser>();

function userFilePath(email: string): string {
  // The normalized email is the filename; encode it so odd-but-valid
  // addresses cannot escape the users directory.
  return join(usersRoot(), `${encodeURIComponent(normalizeEmail(email))}.json`);
}

export async function getUserByEmail(email: string): Promise<StoredUser | null> {
  const normalized = normalizeEmail(email);
  const cached = cache.get(normalized);
  if (cached) return cached;
  try {
    const raw = await readFile(userFilePath(normalized), "utf-8");
    const user = JSON.parse(raw) as StoredUser;
    cache.set(normalized, user);
    cacheById.set(user.id, user);
    return user;
  } catch {
    return null; // not found (or unreadable → treat as absent)
  }
}

export async function getUserById(id: string): Promise<StoredUser | null> {
  const cached = cacheById.get(id);
  if (cached) return cached;
  // The email is the storage key; scan the (small) users directory.
  const { readdir } = await import("fs/promises");
  let files: string[];
  try {
    files = await readdir(usersRoot());
  } catch {
    return null;
  }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = await readFile(join(usersRoot(), file), "utf-8");
      const user = JSON.parse(raw) as StoredUser;
      cache.set(normalizeEmail(user.email), user);
      cacheById.set(user.id, user);
      if (user.id === id) return user;
    } catch {
      continue;
    }
  }
  return null;
}

export class EmailAlreadyExistsError extends Error {
  constructor(email: string) {
    super(`An account with this email already exists`);
    this.name = "EmailAlreadyExistsError";
  }
}

export async function createUser(email: string, password: string): Promise<StoredUser> {
  const normalized = normalizeEmail(email);
  const existing = await getUserByEmail(normalized);
  if (existing) throw new EmailAlreadyExistsError(normalized);

  const user: StoredUser = {
    id: `usr_${randomBytes(16).toString("hex")}`,
    email: normalized,
    passwordHash: await hashPassword(password),
    createdAt: new Date().toISOString(),
  };

  await mkdir(usersRoot(), { recursive: true });
  const finalPath = userFilePath(normalized);
  const tmpPath = `${finalPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmpPath, JSON.stringify(user, null, 2), { encoding: "utf-8" });
  await rename(tmpPath, finalPath); // atomic on POSIX and Windows

  cache.set(normalized, user);
  cacheById.set(user.id, user);
  return user;
}

/** Test helper: point the store at an empty dir and drop the cache. */
export function resetUserStore(): void {
  cache.clear();
  cacheById.clear();
}

/**
 * Synchronous existence check backed by the id cache. Used by the request
 * path (requireAuth is sync); call preloadUsers() at server startup so
 * accounts created before a restart are visible.
 */
export function hasUserByIdSync(id: string): boolean {
  return cacheById.has(id);
}

/** Load all user records into the id cache (called once at server startup). */
export async function preloadUsers(): Promise<void> {
  const { readdir } = await import("fs/promises");
  let files: string[];
  try {
    files = await readdir(usersRoot());
  } catch {
    return; // no users yet
  }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = await readFile(join(usersRoot(), file), "utf-8");
      const user = JSON.parse(raw) as StoredUser;
      if (user.id && user.email) {
        cache.set(normalizeEmail(user.email), user);
        cacheById.set(user.id, user);
      }
    } catch {
      continue; // skip unreadable records
    }
  }
}

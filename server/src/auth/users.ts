/**
 * User account service.
 *
 * Password hashing is UNCHANGED (Node scrypt, N=16384/r=8/p=1, 64-byte key,
 * `scrypt$N$r$p$salt$hash` serialization, timing-safe verification) — only
 * where the record lives changed: the filesystem JSON store was replaced by
 * the persistence layer's UserRepository (in-memory in dev/tests, MongoDB in
 * production). The repository never stores plaintext passwords and enforces
 * a unique, case-normalized email index, so duplicate-email signup races are
 * converted into EmailAlreadyExistsError instead of corrupting data.
 *
 * Login path = ONE indexed user lookup + scrypt verify. No collection scans,
 * no full-collection preload (Mongo lookups are indexed; the old
 * preloadUsers() directory scan no longer exists).
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "crypto";
import { promisify } from "util";
import { store, users as storeUsers, activeDurableBackend, EmailAlreadyExistsError } from "../store/index.js";
import { clearMemoryUsersForTest } from "../persistence/memory.js";
import type { StoredUser } from "../persistence/types.js";

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem?: number }
) => Promise<Buffer>;

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

export async function getUserByEmail(email: string): Promise<StoredUser | null> {
  return storeUsers.getUserByEmail(normalizeEmail(email));
}

export async function getUserById(id: string): Promise<StoredUser | null> {
  return storeUsers.getUserById(id);
}

export async function createUser(email: string, password: string): Promise<StoredUser> {
  const normalized = normalizeEmail(email);
  const passwordHash = await hashPassword(password);
  // The repository enforces the unique email index and translates a
  // duplicate-key race into EmailAlreadyExistsError.
  return storeUsers.createUser(normalized, passwordHash);
}

export { EmailAlreadyExistsError };

/**
 * Session-user existence cache for the request path.
 *
 * requireAuth must reject sessions whose `sub` refers to a user that no
 * longer exists. That check hits the user store; a tiny positive TTL cache
 * keeps the hot path (every authenticated request) at zero extra lookups
 * after the first hit, while a lookup through the indexed repository keeps
 * correctness on cache miss. Negative results are not cached (an account
 * created moments ago must authenticate immediately).
 */
const idCacheTtlMs = 60_000;
const idCache = new Map<string, { userId: string; expiresAt: number }>();

function rememberUser(user: StoredUser): void {
  idCache.set(user.id, { userId: user.id, expiresAt: Date.now() + idCacheTtlMs });
}

export async function sessionUserExists(userId: string): Promise<boolean> {
  const cached = idCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return true;
  const user = await storeUsers.getUserById(userId);
  if (user) rememberUser(user);
  return !!user;
}

/** TTL-cache fast-path for the request hot path (no I/O). */
export function sessionUserExistsCached(userId: string): boolean {
  const cached = idCache.get(userId);
  return !!cached && cached.expiresAt > Date.now();
}

/** Kept for compatibility with the sync-check call sites in tests. */
export function hasUserByIdSync(id: string): boolean {
  const cached = idCache.get(id);
  return !!cached && cached.expiresAt > Date.now();
}

/**
 * Warm the session-user cache for a freshly created/authenticated user
 * so the next authenticated request resolves without a store lookup.
 */
export function warmUserCache(userId: string): void {
  idCache.set(userId, { userId, expiresAt: Date.now() + idCacheTtlMs });
}

/**
 * Clear the existence cache (and the memory user store in dev/test mode).
 * Replaces the old filesystem resetUserStore; used by tests for isolation.
 */
export function resetUserStore(): void {
  idCache.clear();
  if (!activeDurableBackend()) clearMemoryUsersForTest();
}

/** Startup hook: no directory preload needed anymore (indexed lookups). */
export async function preloadUsers(): Promise<void> {
  /* no-op — MongoDB/memory lookups are indexed; nothing to warm */
}

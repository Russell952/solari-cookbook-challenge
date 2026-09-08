/**
 * Solari sandbox adapter.
 *
 * ── SECURITY INVARIANT ──────────────────────────────────────────────────────
 *
 * ALL command execution in this module goes through the Solari SDK's
 * remote sandbox API. Commands execute inside an isolated microVM, NOT
 * on the Probe server host.
 *
 * Probe server → Solari SDK → remote sandbox VM → command
 *
 * This module NEVER calls Node's child_process, exec, spawn, or any
 * other host-side execution API. If you need to add host-side execution,
 * this is the WRONG place — create a separate module and justify it.
 *
 * AI-generated commands reach this module via:
 *   AI → validated PlannedAction → orchestrator → SandboxAdapter (this file)
 *
 * The orchestrator is the authority. This module only executes what
 * the orchestrator passes through.
 *
 * ── LIFECYCLE RULES ─────────────────────────────────────────────────────────
 *
 * - sandbox.kill() destroys the remote VM (idempotent, remote + local cleanup)
 * - sandbox.close() ONLY drops the local control channel (VM keeps running!)
 * - Commands are NOT shell-interpreted by default; use args or runSandboxShellCommand
 * - timeoutMs is a rolling idle window, not a hard deadline
 * - Always use kill() when the VM should actually be destroyed
 * - Always use try/finally to ensure cleanup
 *
 * The SDK's Sandbox extends SessionHandle, which provides:
 *   connect(), close(), kill(), commands, files, git, etc.
 */
import { Sandbox } from "@solarisdk/sdk";
import { getSdkClient } from "./client.js";
import { store } from "../store/index.js";
import { isSafeReadOnlyArg } from "../orchestrator/action-allowlist.js";

// ── Security: valid URL patterns for repository cloning ────────────────────

const GITHUB_URL_PATTERN = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/;

/**
 * Validate a repository URL for safe cloning.
 *
 * Allowed: public GitHub HTTPS repositories only.
 * Rejected: non-HTTPS, non-GitHub, malformed, credential-embedded, or
 * URLs with special characters that could be interpreted as options.
 */
export function validateRepositoryUrl(url: string): void {
  if (typeof url !== "string" || url.length === 0) {
    throw new Error("Repository URL is required");
  }

  // Must be HTTPS
  if (!url.startsWith("https://")) {
    throw new Error(`Repository URL must use HTTPS: ${url}`);
  }

  // Must be github.com
  if (!url.includes("github.com/")) {
    throw new Error(`Repository URL must be on github.com: ${url}`);
  }

  // Reject credentials in URL (https://user:pass@github.com/...)
  if (url.includes("@")) {
    throw new Error("Repository URL must not contain credentials");
  }

  // Reject port numbers (https://github.com:1234/...)
  if (/github\.com:\d+/.test(url)) {
    throw new Error("Repository URL must not contain a port");
  }

  // Must match strict GitHub pattern
  if (!GITHUB_URL_PATTERN.test(url)) {
    throw new Error(
      `Repository URL must be a valid public GitHub repository: ${url}\n` +
      `Expected format: https://github.com/owner/repo`
    );
  }
}

// ── Security: valid sandbox actions ────────────────────────────────────────

/**
 * Valid actions the orchestrator may dispatch to the sandbox adapter.
 *
 * Sourced from the central allowlist (single source of truth). Note that
 * runCommand/runShellCommand are NOT included: arbitrary command execution
 * is not AI-reachable. AI-planned sandbox observations go through
 * runReadOnlyCommand, which enforces the read-only command allowlist.
 */
import { VALID_SANDBOX_ACTIONS as CENTRAL_SANDBOX_ACTIONS, isReadOnlySandboxCommand } from "../orchestrator/action-allowlist.js";
export const VALID_SANDBOX_ACTIONS: readonly string[] = CENTRAL_SANDBOX_ACTIONS;

/** Valid browser actions — re-exported from the central allowlist. */
export { VALID_BROWSER_ACTIONS } from "../orchestrator/action-allowlist.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface SandboxSession {
  probeSessionId: string;
  sandbox: Sandbox;
  investigationId: string;
}

// ── Session lifecycle ──────────────────────────────────────────────────────

/**
 * Create a new sandbox session.
 *
 * The VM is created remotely and the control channel is connected.
 * If connect() fails after create(), the VM is killed to prevent leaks.
 */
export async function createSandboxSession(
  investigationId: string,
  opts?: { timeoutMs?: number; template?: string }
): Promise<SandboxSession> {
  const client = getSdkClient();
  const sandbox = await client.sandboxes.create({
    template: opts?.template ?? "base",
    timeoutMs: opts?.timeoutMs ?? 5 * 60_000,
  });

  const probeSessionId = `ssess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  try {
    await sandbox.connect();
  } catch (connectErr) {
    // Connect failed after VM creation — kill the VM to prevent orphan.
    try {
      await sandbox.kill();
    } catch {
      // Best effort — if kill also fails, the VM will time out on its own.
    }
    throw connectErr;
  }

  store.createSession({
    id: probeSessionId,
    investigationId,
    type: "sandbox",
    externalSessionId: sandbox.sandboxId,
    status: "active",
    createdAt: new Date().toISOString(),
    releasedAt: null,
  });

  return { probeSessionId, sandbox, investigationId };
}

// ── Command execution ──────────────────────────────────────────────────────

/**
 * Run a command in the sandbox via explicit executable + args.
 *
 * SECURITY: This executes inside the Solari sandbox VM, NOT on the Probe host.
 * The SDK sends the command to the remote VM over the control channel.
 *
 * Uses explicit args (not shell-interpreted).
 * The caller MUST check exitCode !== 0 for failures.
 *
 * SECURITY (AI boundary): orchestrator-owned invocations only (e.g. git
 * clone during recon). AI-planned observations go through
 * runReadOnlyCommand, which enforces the read-only command allowlist. The AI
 * cannot reach arbitrary binaries, shell syntax, or pipelines through any
 * public path in this module.
 */
export async function runCommand(
  session: SandboxSession,
  command: string,
  args?: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  // Validate that command is a simple string (no injection via binary name)
  if (typeof command !== "string" || command.length === 0) {
    throw new Error("Command must be a non-empty string");
  }
  if (args !== undefined && !Array.isArray(args)) {
    throw new Error("Args must be an array of strings");
  }

  // Structural arg validation: plain strings only — nested arrays/objects
  // cannot appear in a real argv.
  if (args !== undefined) {
    for (const arg of args) {
      if (typeof arg !== "string") {
        throw new Error("Args must be an array of strings");
      }
    }
  }

  const result = await session.sandbox.commands.run(command, { args });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/**
 * Execute an AI-planned read-only sandbox command.
 *
 * The command binary must be on the read-only allowlist and arguments must
 * be plain strings. Shell interpretation is never used: every argument is a
 * discrete argv entry, so pipes, redirects, command chaining, and shell
 * expansion are impossible. Non-allowlisted binaries are rejected before any
 * SDK call.
 */
export async function runReadOnlyCommand(
  session: SandboxSession,
  command: string,
  args?: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (typeof command !== "string" || command.length === 0) {
    throw new Error("Command must be a non-empty string");
  }
  if (!isReadOnlySandboxCommand(command)) {
    throw new Error(`Security: command '${command}' is not on the read-only sandbox allowlist`);
  }
  if (args !== undefined) {
    if (!Array.isArray(args)) throw new Error("Args must be an array of strings");
    for (const arg of args) {
      if (typeof arg !== "string" || arg.includes("\x00")) {
        throw new Error("Args must be an array of strings");
      }
      // Option-shaped args that enable execution/file-mutation are rejected
      // even when the binary itself is allowlisted (e.g. find -exec).
      if (!isSafeReadOnlyArg(arg)) {
        throw new Error(`Security: argument '${arg.slice(0, 32)}' is not permitted for read-only sandbox commands`);
      }
    }
  }
  return runCommand(session, command, args);
}

// ── File operations ────────────────────────────────────────────────────────

/** Write a file in the sandbox. */
export async function writeFile(
  session: SandboxSession,
  path: string,
  content: string
): Promise<void> {
  await session.sandbox.files.write(path, content);
}

/** Read a file from the sandbox. */
export async function readFile(
  session: SandboxSession,
  path: string
): Promise<string> {
  return session.sandbox.files.readText(path);
}

/** List a directory in the sandbox. */
export async function listDirectory(
  session: SandboxSession,
  path: string
): Promise<string[]> {
  const entries = await session.sandbox.files.list(path);
  return entries.map((e: { name: string }) => e.name);
}

// ── Repository operations ──────────────────────────────────────────────────

/**
 * Clone a public GitHub repository into the sandbox.
 *
 * SECURITY: The URL is validated against a strict GitHub-only pattern.
 * Git arguments are passed as an explicit array (not shell-interpreted).
 * The clone happens inside the Solari sandbox VM, not on the host.
 */
export async function cloneRepository(
  session: SandboxSession,
  repoUrl: string,
  targetPath = "/workspace/repo"
): Promise<{ exitCode: number; output: string }> {
  // Validate URL before passing to git
  validateRepositoryUrl(repoUrl);

  // Validate target path (no special characters that could be options)
  if (typeof targetPath !== "string" || targetPath.length === 0) {
    throw new Error("Target path must be a non-empty string");
  }

  // Use explicit args array — no shell interpretation
  const result = await runCommand(session, "git", ["clone", "--", repoUrl, targetPath]);
  return { exitCode: result.exitCode, output: result.stdout + result.stderr };
}

// ── Cleanup ────────────────────────────────────────────────────────────────

/**
 * Destroy the sandbox VM.
 *
 * Uses kill() which destroys the remote VM and closes the control channel.
 * This is idempotent — safe to call multiple times.
 * If kill() fails, the session status reflects the failure.
 */
export async function destroySandbox(session: SandboxSession): Promise<void> {
  let killed = false;
  try {
    await session.sandbox.kill();
    killed = true;
  } catch (e) {
    console.error(`Error destroying sandbox ${session.probeSessionId}:`, e);
  }
  store.updateSession(session.probeSessionId, {
    status: killed ? "destroyed" : "active", // keep as active if kill failed
    releasedAt: killed ? new Date().toISOString() : null,
  });
}

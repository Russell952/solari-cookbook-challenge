/**
 * Sandbox adapter tests.
 *
 * Uses mocked Solari SDK to test session lifecycle, cleanup,
 * command execution, and failure semantics.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { store } from "../store/index.js";

// ── Mock setup ─────────────────────────────────────────────────────────────

const mockCommands = {
  run: vi.fn().mockResolvedValue({
    exitCode: 0,
    stdout: "hello world",
    stderr: "",
  }),
};

const mockFiles = {
  write: vi.fn().mockResolvedValue(undefined),
  readText: vi.fn().mockResolvedValue("file content"),
  list: vi.fn().mockResolvedValue([
    { name: "file1.txt" },
    { name: "file2.txt" },
  ]),
};

const mockSandbox = {
  sandboxId: "solari-sandbox-123",
  connect: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  kill: vi.fn().mockResolvedValue(undefined),
  commands: mockCommands,
  files: mockFiles,
};

const mockClient = {
  sandboxes: {
    create: vi.fn().mockResolvedValue(mockSandbox),
  },
};

vi.mock("../solari/client.js", () => ({
  getSdkClient: vi.fn().mockReturnValue(mockClient),
}));

const sandbox = await import("../solari/sandbox.js");

describe("Sandbox Adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.clearAll();
    // Reset sandbox methods to defaults
    mockSandbox.connect.mockReset().mockResolvedValue(undefined);
    mockSandbox.kill.mockReset().mockResolvedValue(undefined);
    mockSandbox.close.mockReset().mockResolvedValue(undefined);
    mockCommands.run.mockReset().mockResolvedValue({
      exitCode: 0,
      stdout: "hello world",
      stderr: "",
    });
    mockFiles.write.mockReset().mockResolvedValue(undefined);
    mockFiles.readText.mockReset().mockResolvedValue("file content");
    mockFiles.list.mockReset().mockResolvedValue([
      { name: "file1.txt" },
      { name: "file2.txt" },
    ]);
    mockClient.sandboxes.create.mockReset().mockResolvedValue(mockSandbox);
  });

  describe("createSandboxSession", () => {
    it("creates and connects a sandbox", async () => {
      const session = await sandbox.createSandboxSession("inv_1");

      expect(mockClient.sandboxes.create).toHaveBeenCalledWith(
        expect.objectContaining({ template: "base" })
      );
      expect(mockSandbox.connect).toHaveBeenCalled();
      expect(session.probeSessionId).toMatch(/^ssess_/);
      expect(session.investigationId).toBe("inv_1");
    });

    it("creates a session record in the store", async () => {
      const session = await sandbox.createSandboxSession("inv_1");
      const stored = store.listSessions("inv_1");

      expect(stored).toHaveLength(1);
      expect(stored[0].id).toBe(session.probeSessionId);
      expect(stored[0].type).toBe("sandbox");
      expect(stored[0].status).toBe("active");
      expect(stored[0].externalSessionId).toBe("solari-sandbox-123");
    });

    it("kills the VM if connect fails after creation", async () => {
      // Create the session first so the sandbox mock exists
      mockSandbox.connect.mockRejectedValueOnce(new Error("connect failed"));

      await expect(
        sandbox.createSandboxSession("inv_1")
      ).rejects.toThrow("connect failed");

      // VM should have been killed to prevent orphan
      expect(mockSandbox.kill).toHaveBeenCalled();
    });

    it("does not create store record if connect fails", async () => {
      mockSandbox.connect.mockRejectedValueOnce(new Error("connect failed"));

      await expect(
        sandbox.createSandboxSession("inv_1")
      ).rejects.toThrow();

      const stored = store.listSessions("inv_1");
      expect(stored).toHaveLength(0);
    });
  });

  describe("runCommand", () => {
    it("runs a command and returns exit code, stdout, stderr", async () => {
      const session = await sandbox.createSandboxSession("inv_1");
      const result = await sandbox.runCommand(session, "ls", ["-la"]);

      expect(mockCommands.run).toHaveBeenCalledWith("ls", { args: ["-la"] });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("hello world");
      expect(result.stderr).toBe("");
    });

    it("returns non-zero exit code for failed commands", async () => {
      mockCommands.run.mockResolvedValueOnce({
        exitCode: 127,
        stdout: "",
        stderr: "command not found",
      });

      const session = await sandbox.createSandboxSession("inv_1");
      const result = await sandbox.runCommand(session, "nonexistent");

      expect(result.exitCode).toBe(127);
      expect(result.stderr).toBe("command not found");
    });

    it("does NOT throw on non-zero exit code", async () => {
      mockCommands.run.mockResolvedValueOnce({
        exitCode: 1,
        stdout: "",
        stderr: "error",
      });

      const session = await sandbox.createSandboxSession("inv_1");
      // Should not throw — caller checks exitCode
      const result = await sandbox.runCommand(session, "false");
      expect(result.exitCode).toBe(1);
    });
  });

  describe("runReadOnlyCommand", () => {
    it("executes an allowlisted read-only command with discrete argv args", async () => {
      const session = await sandbox.createSandboxSession("inv_1");
      await sandbox.runReadOnlyCommand(session, "grep", ["-n", "pattern", "file.txt"]);

      expect(mockCommands.run).toHaveBeenCalledWith("grep", {
        args: ["-n", "pattern", "file.txt"],
      });
    });

    it("rejects non-allowlisted binaries before any SDK call", async () => {
      const session = await sandbox.createSandboxSession("inv_1");
      await expect(
        sandbox.runReadOnlyCommand(session, "curl", ["http://evil.example"])
      ).rejects.toThrow(/not on the read-only sandbox allowlist/);
      expect(mockCommands.run).not.toHaveBeenCalled();
    });

    it("never pipes through a shell — sh is not an allowlisted binary for AI use", async () => {
      const session = await sandbox.createSandboxSession("inv_1");
      await expect(
        sandbox.runReadOnlyCommand(session, "sh", ["-c", "echo hello | grep hello"])
      ).rejects.toThrow(/not on the read-only sandbox allowlist/);
      expect(mockCommands.run).not.toHaveBeenCalled();
    });
  });

  describe("writeFile", () => {
    it("writes a file", async () => {
      const session = await sandbox.createSandboxSession("inv_1");
      await sandbox.writeFile(session, "/tmp/test.txt", "content");

      expect(mockFiles.write).toHaveBeenCalledWith("/tmp/test.txt", "content");
    });
  });

  describe("readFile", () => {
    it("reads a file", async () => {
      const session = await sandbox.createSandboxSession("inv_1");
      const content = await sandbox.readFile(session, "/tmp/test.txt");

      expect(mockFiles.readText).toHaveBeenCalledWith("/tmp/test.txt");
      expect(content).toBe("file content");
    });
  });

  describe("listDirectory", () => {
    it("lists directory entries", async () => {
      const session = await sandbox.createSandboxSession("inv_1");
      const entries = await sandbox.listDirectory(session, "/workspace");

      expect(mockFiles.list).toHaveBeenCalledWith("/workspace");
      expect(entries).toEqual(["file1.txt", "file2.txt"]);
    });
  });

  describe("cloneRepository", () => {
    it("clones via git command", async () => {
      const session = await sandbox.createSandboxSession("inv_1");
      const result = await sandbox.cloneRepository(
        session,
        "https://github.com/user/repo"
      );

      expect(mockCommands.run).toHaveBeenCalledWith("git", {
        args: ["clone", "--", "https://github.com/user/repo", "/workspace/repo"],
      });
      expect(result.exitCode).toBe(0);
    });

    it("returns custom target path", async () => {
      const session = await sandbox.createSandboxSession("inv_1");
      await sandbox.cloneRepository(
        session,
        "https://github.com/user/repo",
        "/tmp/custom"
      );

      expect(mockCommands.run).toHaveBeenCalledWith("git", {
        args: ["clone", "--", "https://github.com/user/repo", "/tmp/custom"],
      });
    });
  });

  describe("destroySandbox", () => {
    it("kills the sandbox and marks as destroyed", async () => {
      const session = await sandbox.createSandboxSession("inv_1");
      await sandbox.destroySandbox(session);

      expect(mockSandbox.kill).toHaveBeenCalled();
      const stored = store.listSessions("inv_1");
      expect(stored[0].status).toBe("destroyed");
      expect(stored[0].releasedAt).not.toBeNull();
    });

    it("keeps status as 'active' if kill fails", async () => {
      const session = await sandbox.createSandboxSession("inv_1");
      mockSandbox.kill.mockRejectedValueOnce(new Error("kill failed"));

      await sandbox.destroySandbox(session);

      const stored = store.listSessions("inv_1");
      expect(stored[0].status).toBe("active");
      expect(stored[0].releasedAt).toBeNull();
    });

    it("does not throw if kill fails", async () => {
      const session = await sandbox.createSandboxSession("inv_1");
      mockSandbox.kill.mockRejectedValueOnce(new Error("kill failed"));

      // Should not throw
      await expect(sandbox.destroySandbox(session)).resolves.toBeUndefined();
    });
  });
});

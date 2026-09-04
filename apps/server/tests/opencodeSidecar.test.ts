import { EventEmitter } from "events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  buildManagedOpencodeConfig,
  buildOpencodeChildEnv,
  buildOpencodeServeArgs,
  expectedSidecarLaunch,
  hashManagedOpencodeConfig,
  OPENCODE_DENIED_TOOLS,
  prepareSidecarFilesystem,
  sidecarLaunchCompatible,
  SIDECAR_FORBIDDEN_ENV,
} from "../src/opencode/sidecarSecurity";
import { resolveOpencodePaths } from "../src/opencode/paths";
import { OpencodeService } from "../src/opencode/opencodeService";

const spawn = vi.hoisted(() => vi.fn());

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    spawn,
  };
});

function fakeChild(pid = 4242) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    exitCode: number | null;
    stderr: EventEmitter;
    stdout: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = pid;
  child.exitCode = null;
  child.stderr = new EventEmitter();
  child.stdout = new EventEmitter();
  child.kill = vi.fn(() => {
    child.exitCode = 0;
    child.emit("exit", 0, null);
    return true;
  });
  return child;
}

function writeDummyBinary(root: string): void {
  const binDir = join(root, ".vendor/opencode/bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "opencode"), "#!/bin/sh\n", { mode: 0o755 });
}

describe("OpenCode sidecar security helpers", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "opencode-sec-"));
  });

  afterEach(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("serve args include --pure and never inherit gateway cwd", () => {
    const args = buildOpencodeServeArgs(23456, "127.0.0.1");
    expect(args).toContain("--pure");
    expect(args).toContain("serve");
    expect(args).toContain("23456");
    expect(args).toContain("127.0.0.1");
  });

  it("managed config is default-deny including coding-agent tools", () => {
    const config = buildManagedOpencodeConfig() as {
      permission: Record<string, string>;
      tools: Record<string, boolean>;
    };
    expect(config.permission["*"]).toBe("deny");
    for (const tool of OPENCODE_DENIED_TOOLS) {
      expect(config.permission[tool]).toBe("deny");
      expect(config.tools[tool]).toBe(false);
    }
    expect(JSON.stringify(config)).not.toMatch(/"ask"/);
    expect(JSON.stringify(config)).not.toMatch(/"allow"/);
  });

  it("child env is a whitelist and drops gateway secrets", () => {
    const prevSecret = process.env.PROMPTGATE_SECRET;
    const prevDb = process.env.DATABASE_URL;
    const prevAws = process.env.AWS_SECRET_ACCESS_KEY;
    process.env.PROMPTGATE_SECRET = "unit-test-placeholder";
    process.env.DATABASE_URL = "postgres://unit-test";
    process.env.AWS_SECRET_ACCESS_KEY = "unit-test-placeholder";
    try {
      const paths = resolveOpencodePaths(root);
      const env = buildOpencodeChildEnv(paths, "loopback-password");
      expect(env.PROMPTGATE_SECRET).toBeUndefined();
      expect(env.DATABASE_URL).toBeUndefined();
      expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      for (const key of SIDECAR_FORBIDDEN_ENV) {
        expect(env[key]).toBeUndefined();
      }
      expect(Object.keys(env)).not.toContain("PROMPTGATE_SECRET");
      expect(env.HOME).toBe(paths.homeDir);
      expect(env.XDG_CONFIG_HOME).toBe(paths.configHome);
      expect(env.OPENCODE_PURE).toBe("1");
      expect(env.OPENCODE_CONFIG).toBe(paths.configFilePath);
      expect(env.OPENCODE_SERVER_PASSWORD).toBe("loopback-password");
      expect(env.PATH).toBeTruthy();
    } finally {
      if (prevSecret === undefined) delete process.env.PROMPTGATE_SECRET;
      else process.env.PROMPTGATE_SECRET = prevSecret;
      if (prevDb === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prevDb;
      if (prevAws === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
      else process.env.AWS_SECRET_ACCESS_KEY = prevAws;
    }
  });

  it("recreates an empty sandbox without host workspace files", async () => {
    const paths = resolveOpencodePaths(root);
    mkdirSync(paths.sandboxDir, { recursive: true });
    writeFileSync(join(paths.sandboxDir, "AGENTS.md"), "should not remain");
    writeFileSync(join(paths.sandboxDir, ".env"), "should not remain");
    writeFileSync(join(paths.sandboxDir, "promptgate.sqlite"), "should not remain");

    const hash = await prepareSidecarFilesystem(paths);
    expect(hash).toBe(hashManagedOpencodeConfig());
    expect(existsSync(join(paths.sandboxDir, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(paths.sandboxDir, ".env"))).toBe(false);
    expect(existsSync(join(paths.sandboxDir, "promptgate.sqlite"))).toBe(false);
    expect(existsSync(join(paths.sandboxDir, ".git", "HEAD"))).toBe(true);

    const written = JSON.parse(readFileSync(paths.configFilePath, "utf8"));
    expect(written.permission["*"]).toBe("deny");
    expect(written.permission.bash).toBe("deny");
    expect(written.permission.read).toBe("deny");
  });

  it("adopts only sidecars whose cwd and config hash match", () => {
    const paths = resolveOpencodePaths(root);
    const expected = expectedSidecarLaunch(paths);
    expect(sidecarLaunchCompatible(null, expected)).toBe(false);
    expect(
      sidecarLaunchCompatible({ version: 1, cwd: "/opt/promptgate", configHash: expected.configHash }, expected),
    ).toBe(false);
    expect(
      sidecarLaunchCompatible({ version: 1, cwd: expected.cwd, configHash: "stale" }, expected),
    ).toBe(false);
    expect(
      sidecarLaunchCompatible({ version: expected.version, cwd: expected.cwd, configHash: expected.configHash }, expected),
    ).toBe(true);
  });
});

describe("OpencodeService start uses sandbox + deny-all + env whitelist", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "opencode-svc-"));
    writeDummyBinary(root);
    spawn.mockReset();
    spawn.mockImplementation(() => fakeChild());
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    OpencodeService.resetInstanceForTests();
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("spawns opencode serve with sandbox cwd, --pure, and no PROMPTGATE_SECRET", async () => {
    const prevSecret = process.env.PROMPTGATE_SECRET;
    process.env.PROMPTGATE_SECRET = "unit-test-placeholder";
    try {
      const service = OpencodeService.createForTests(root);
      vi.stubGlobal(
        "fetch",
        vi.fn()
          .mockResolvedValueOnce({ ok: false })
          .mockResolvedValue({ ok: true, json: async () => ({ version: "1.18.2" }) }),
      );

      await service.start();

      expect(spawn).toHaveBeenCalledTimes(1);
      const [bin, args, opts] = spawn.mock.calls[0];
      const paths = service.getPaths();
      expect(bin).toBe(paths.binPath);
      expect(args).toContain("--pure");
      expect(args).toContain("serve");
      expect(opts.cwd).toBe(paths.sandboxDir);
      expect(opts.cwd).not.toBe(root);
      expect(opts.env.PROMPTGATE_SECRET).toBeUndefined();
      expect(opts.env.HOME).toBe(paths.homeDir);
      expect(opts.env.OPENCODE_PURE).toBe("1");
      expect(existsSync(join(paths.sandboxDir, "AGENTS.md"))).toBe(false);
      const config = JSON.parse(readFileSync(paths.configFilePath, "utf8"));
      expect(config.permission["*"]).toBe("deny");
    } finally {
      if (prevSecret === undefined) delete process.env.PROMPTGATE_SECRET;
      else process.env.PROMPTGATE_SECRET = prevSecret;
    }
  });

  it("adopts a healthy leftover only when launch metadata matches", async () => {
    const service = OpencodeService.createForTests(root);
    const paths = service.getPaths();
    const hash = hashManagedOpencodeConfig();
    mkdirSync(paths.stateHome, { recursive: true });
    writeFileSync(
      paths.launchMetaPath,
      JSON.stringify({ version: 1, cwd: paths.sandboxDir, configHash: hash, pid: 99 }),
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ version: "1.18.2" }) }));

    await service.start();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("restarts a healthy leftover started with the host workspace cwd", async () => {
    const service = OpencodeService.createForTests(root);
    const paths = service.getPaths();
    mkdirSync(paths.stateHome, { recursive: true });
    writeFileSync(
      paths.launchMetaPath,
      JSON.stringify({
        version: 1,
        cwd: "/opt/promptgate",
        configHash: hashManagedOpencodeConfig(),
        pid: 99,
      }),
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ version: "1.18.2" }) }));

    await service.start();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][2].cwd).toBe(paths.sandboxDir);
    expect(spawn.mock.calls[0][2].cwd).not.toBe("/opt/promptgate");
  });

  it("restarts a healthy leftover that has no launch metadata", async () => {
    const service = OpencodeService.createForTests(root);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ version: "1.18.2" }) }));

    await service.start();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][2].cwd).toBe(service.getPaths().sandboxDir);
  });
});

describe("OpenCode sidecar source guards", () => {
  it("spawn path does not spread process.env and uses sandbox cwd", () => {
    const servicePath = existsSync(join(process.cwd(), "src/opencode/opencodeService.ts"))
      ? join(process.cwd(), "src/opencode/opencodeService.ts")
      : join(process.cwd(), "apps/server/src/opencode/opencodeService.ts");
    const src = readFileSync(servicePath, "utf8");
    expect(src).toMatch(/cwd:\s*this\.paths\.sandboxDir/);
    expect(src).toMatch(/buildOpencodeChildEnv/);
    expect(src).toMatch(/buildOpencodeServeArgs/);
    expect(src).not.toMatch(/env:\s*\{\s*\.\.\.process\.env/);
  });
});

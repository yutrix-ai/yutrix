import { spawn, execFile, ChildProcess } from "child_process";
import { existsSync, readFileSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { promisify } from "util";
import { randomBytes } from "crypto";
import pino from "pino";
import {
  OPENCODE_LOOPBACK_HOST,
  OPENCODE_LOOPBACK_PORT,
  OPENCODE_SERVER_USERNAME,
  OPENCODE_SESSION_STREAMING,
  resolveOpencodePaths,
  type OpencodePaths,
} from "./paths";
import { writeOpencodeAuthJson } from "./authJson";
import { getOpencodeDownloadProxy } from "./settings";
import { isOpencodeVersionOutdated } from "./protocol";
import {
  buildOpencodeChildEnv,
  buildOpencodeServeArgs,
  expectedSidecarLaunch,
  parseSidecarLaunchMeta,
  prepareSidecarFilesystem,
  sidecarLaunchCompatible,
  type SidecarLaunchMeta,
} from "./sidecarSecurity";

const logger = pino({ name: "opencode" });
const execFileAsync = promisify(execFile);

export interface OpencodeStatus {
  ready: boolean;
  running: boolean;
  version: string | null;
  arch: string;
  lastError: string | null;
  streaming: typeof OPENCODE_SESSION_STREAMING;
}

export class OpencodeService {
  private static instance: OpencodeService | null = null;
  private process: ChildProcess | null = null;
  private lastError: string | null = null;
  private cachedVersion: string | null = null;
  private startLock: Promise<void> = Promise.resolve();
  private readonly paths: OpencodePaths;
  /** Tests must not fuser/kill listeners on the shared loopback port. */
  private readonly skipExternalProcessReap: boolean;
  public readonly port = OPENCODE_LOOPBACK_PORT;
  public readonly host = OPENCODE_LOOPBACK_HOST;

  private constructor(cwd = process.cwd(), skipExternalProcessReap = false) {
    this.paths = resolveOpencodePaths(cwd);
    this.skipExternalProcessReap = skipExternalProcessReap;
  }

  public static getInstance(): OpencodeService {
    if (!OpencodeService.instance) {
      OpencodeService.instance = new OpencodeService();
    }
    return OpencodeService.instance;
  }

  /** Test-only: drop the singleton so suites can isolate filesystem roots. */
  public static resetInstanceForTests(): void {
    if (OpencodeService.instance) {
      OpencodeService.instance.stop();
      OpencodeService.instance = null;
    }
  }

  public static createForTests(cwd: string): OpencodeService {
    OpencodeService.resetInstanceForTests();
    const service = new OpencodeService(cwd, true);
    OpencodeService.instance = service;
    return service;
  }

  public getPaths(): OpencodePaths {
    return this.paths;
  }

  public isReady(): boolean {
    return existsSync(this.paths.binPath);
  }

  public isRunning(): boolean {
    return this.process !== null && this.process.exitCode === null;
  }

  public getLastError(): string | null {
    return this.lastError;
  }

  public async getStatus(): Promise<OpencodeStatus> {
    const ready = this.isReady();
    let running = this.isRunning();
    if (running) {
      const healthy = await this.probeHealth();
      if (!healthy) running = false;
    } else if (ready) {
      // Adopt a leftover loopback sidecar from a previous process if it still answers.
      const healthy = await this.probeHealth();
      if (healthy) running = true;
    }

    let version = this.cachedVersion;
    if (!version && running) {
      version = await this.readHealthVersion();
    }
    if (!version && ready) {
      version = await this.readBinaryVersion();
    }

    return {
      ready,
      running,
      version,
      arch: process.arch,
      lastError: this.lastError,
      streaming: OPENCODE_SESSION_STREAMING,
    };
  }

  public sidecarHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
      ...extra,
      Authorization: this.basicAuthHeader(),
    };
  }

  public sidecarUrl(pathname: string): string {
    return `http://${this.host}:${this.port}${pathname}`;
  }

  public async start(): Promise<void> {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.startLock;
    this.startLock = previous.then(() => wait);
    await previous;
    try {
      await this.startUnlocked();
    } finally {
      release();
    }
  }

  private async startUnlocked(): Promise<void> {
    if (!this.isReady()) {
      this.lastError = "OpenCode binary not found";
      throw new Error("OpenCode binary not found");
    }

    const configHash = await prepareSidecarFilesystem(this.paths);
    const expected = expectedSidecarLaunch(this.paths, configHash);

    if (await this.probeHealth()) {
      const meta = await this.readLaunchMeta();
      if (sidecarLaunchCompatible(meta, expected)) {
        this.lastError = null;
        return;
      }
      logger.warn(
        { cwd: meta?.cwd ?? null, expectedCwd: expected.cwd },
        "OpenCode sidecar healthy but launched with stale cwd/config; restarting",
      );
      await this.displaceIncompatibleSidecar(meta);
    }

    if (this.isRunning()) {
      this.stop();
    }

    const password = await this.ensureServerPassword();
    this.process = spawn(
      this.paths.binPath,
      buildOpencodeServeArgs(this.port, this.host),
      {
        cwd: this.paths.sandboxDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: buildOpencodeChildEnv(this.paths, password),
      },
    );

    const child = this.process;
    let spawnStderr = "";
    child.stderr?.on("data", (chunk) => {
      spawnStderr += chunk.toString();
      if (spawnStderr.length > 4000) spawnStderr = spawnStderr.slice(-4000);
    });
    child.on("exit", (code, signal) => {
      if (this.process === child) this.process = null;
      if (code && code !== 0) {
        this.lastError = spawnStderr.trim() || `OpenCode sidecar exited (${code}/${signal || "none"})`;
        logger.warn({ code, signal, stderr: spawnStderr }, "OpenCode sidecar exited");
      } else {
        logger.info("OpenCode sidecar exited");
      }
    });

    const ready = await this.waitForHealth(15_000);
    if (!ready) {
      this.lastError = spawnStderr.trim() || "OpenCode sidecar did not become healthy";
      this.stop();
      throw new Error(this.lastError);
    }
    this.lastError = null;
    this.cachedVersion = await this.readHealthVersion();
    await this.writeLaunchMeta({
      ...expected,
      pid: this.process?.pid,
    });
    logger.info({ port: this.port, cwd: this.paths.sandboxDir }, "OpenCode sidecar started");
  }

  private async readLaunchMeta(): Promise<SidecarLaunchMeta | null> {
    try {
      return parseSidecarLaunchMeta(JSON.parse(await readFile(this.paths.launchMetaPath, "utf8")));
    } catch {
      return null;
    }
  }

  private async writeLaunchMeta(meta: SidecarLaunchMeta): Promise<void> {
    await mkdir(this.paths.stateHome, { recursive: true });
    await writeFile(this.paths.launchMetaPath, `${JSON.stringify(meta)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  private async displaceIncompatibleSidecar(meta: SidecarLaunchMeta | null): Promise<void> {
    this.stop();
    if (this.skipExternalProcessReap) return;
    if (typeof meta?.pid === "number" && meta.pid !== process.pid) {
      try {
        process.kill(meta.pid, "SIGTERM");
      } catch {
        // leftover already gone
      }
    }
    await this.reapListenerOnPort(this.port);
  }

  private async reapListenerOnPort(port: number): Promise<void> {
    try {
      const { stdout } = await execFileAsync("fuser", [`${port}/tcp`], { timeout: 2000 });
      for (const token of stdout.split(/\s+/)) {
        const pid = Number(token);
        if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // already gone
        }
      }
    } catch {
      // fuser missing or nothing listening
    }
  }

  public stop(): void {
    if (this.process) {
      try {
        this.process.kill("SIGTERM");
      } catch {
        // already gone
      }
      this.process = null;
      logger.info("OpenCode sidecar stopped");
    }
  }

  public async maybeAutoUpdate(): Promise<void> {
    if (!this.isReady()) return;
    try {
      const current = (await this.readInstalledPackageVersion()) || (await this.readBinaryVersion());
      const latest = await this.fetchLatestPublishedVersion();
      if (!isOpencodeVersionOutdated(current, latest)) return;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.lastError = `OpenCode auto-update check failed: ${message}`;
      logger.error({ err: e }, "OpenCode auto-update check failed");
      return;
    }
    try {
      await this.download();
    } catch {
      // download() already records lastError
    }
  }

  public async download(): Promise<void> {
    const env = await this.downloadEnv();
    logger.info({ proxy: Boolean(env.HTTP_PROXY || env.HTTPS_PROXY) }, "Downloading OpenCode");
    try {
      const { stdout, stderr } = await execFileAsync("bash", ["./scripts/bootstrap-opencode.sh"], {
        cwd: process.cwd(),
        env,
        timeout: 10 * 60 * 1000,
      });
      logger.info({ stdout, stderr }, "OpenCode download complete");
      this.lastError = null;
      this.cachedVersion = null;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.lastError = `Failed to download OpenCode: ${message}`;
      logger.error({ err: e }, "Failed to download OpenCode");
      throw new Error(this.lastError);
    }
  }

  public async syncCredential(provider: string, apiKey: string): Promise<void> {
    await writeOpencodeAuthJson(this.paths.authPath, provider, apiKey);
    logger.info({ provider }, "Synced credential into OpenCode auth.json");
  }

  public async readInstalledPackageVersion(): Promise<string | null> {
    try {
      const pkg = await this.resolveNpmPackageName();
      const pkgJson = join(this.paths.vendorDir, "node_modules", pkg, "package.json");
      const raw = await readFile(pkgJson, "utf8");
      const version = JSON.parse(raw)?.version;
      return typeof version === "string" && version.trim() ? version.trim() : null;
    } catch {
      return null;
    }
  }

  public async fetchLatestPublishedVersion(): Promise<string | null> {
    const pkg = await this.resolveNpmPackageName();
    const env = await this.downloadEnv();
    const { stdout } = await execFileAsync("npm", ["view", pkg, "version"], {
      timeout: 30_000,
      env,
    });
    const version = stdout.toString().trim();
    return version || null;
  }

  private async downloadEnv(): Promise<NodeJS.ProcessEnv> {
    const proxyUrl = await getOpencodeDownloadProxy();
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (proxyUrl) {
      env.HTTP_PROXY = proxyUrl;
      env.HTTPS_PROXY = proxyUrl;
      env.npm_config_proxy = proxyUrl;
      env.npm_config_https_proxy = proxyUrl;
    }
    return env;
  }

  private async resolveNpmPackageName(): Promise<string> {
    const script = join(process.cwd(), "scripts/bootstrap-opencode.sh");
    const { stdout } = await execFileAsync("bash", [script, "--print-pkg"], { timeout: 5000 });
    return stdout.toString().trim();
  }

  public async readBinaryVersion(): Promise<string | null> {
    if (!this.isReady()) return null;
    try {
      const { stdout } = await execFileAsync(this.paths.binPath, ["--version"], { timeout: 5000 });
      const version = stdout.toString().trim();
      this.cachedVersion = version || null;
      return this.cachedVersion;
    } catch {
      return this.cachedVersion;
    }
  }

  private basicAuthHeader(): string {
    const password = this.readPasswordSync();
    const token = Buffer.from(`${OPENCODE_SERVER_USERNAME}:${password}`, "utf8").toString("base64");
    return `Basic ${token}`;
  }

  private readPasswordSync(): string {
    try {
      return readFileSync(this.paths.passwordPath, "utf8").trim();
    } catch {
      return "";
    }
  }

  private async ensureServerPassword(): Promise<string> {
    await mkdir(this.paths.stateHome, { recursive: true });
    try {
      const existing = (await readFile(this.paths.passwordPath, "utf8")).trim();
      if (existing) return existing;
    } catch {
      // create below
    }
    const password = randomBytes(32).toString("hex");
    await writeFile(this.paths.passwordPath, password, { encoding: "utf8", mode: 0o600 });
    return password;
  }

  private async probeHealth(): Promise<boolean> {
    try {
      const res = await fetch(this.sidecarUrl("/global/health"), {
        headers: this.sidecarHeaders(),
        signal: AbortSignal.timeout(1500),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async readHealthVersion(): Promise<string | null> {
    try {
      const res = await fetch(this.sidecarUrl("/global/health"), {
        headers: this.sidecarHeaders(),
        signal: AbortSignal.timeout(1500),
      });
      if (!res.ok) return null;
      const body = await res.json();
      const version = typeof body?.version === "string" ? body.version : null;
      if (version) this.cachedVersion = version;
      return version;
    } catch {
      return null;
    }
  }

  private async waitForHealth(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.probeHealth()) return true;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return false;
  }
}

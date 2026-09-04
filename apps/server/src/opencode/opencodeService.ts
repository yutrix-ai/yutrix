import { spawn, execFile, ChildProcess } from "child_process";
import { existsSync, readFileSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
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
  public readonly port = OPENCODE_LOOPBACK_PORT;
  public readonly host = OPENCODE_LOOPBACK_HOST;

  private constructor(cwd = process.cwd()) {
    this.paths = resolveOpencodePaths(cwd);
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
    const service = new OpencodeService(cwd);
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

    if (await this.probeHealth()) {
      this.lastError = null;
      return;
    }

    if (this.isRunning()) {
      this.stop();
    }

    const password = await this.ensureServerPassword();
    this.process = spawn(
      this.paths.binPath,
      ["serve", "--port", String(this.port), "--hostname", this.host],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          XDG_DATA_HOME: this.paths.dataHome,
          XDG_CONFIG_HOME: this.paths.configHome,
          XDG_STATE_HOME: this.paths.stateHome,
          OPENCODE_SERVER_PASSWORD: password,
          OPENCODE_SERVER_USERNAME: OPENCODE_SERVER_USERNAME,
        },
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
    logger.info({ port: this.port }, "OpenCode sidecar started");
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

  public async download(): Promise<void> {
    const proxyUrl = await getOpencodeDownloadProxy();
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (proxyUrl) {
      env.HTTP_PROXY = proxyUrl;
      env.HTTPS_PROXY = proxyUrl;
      env.npm_config_proxy = proxyUrl;
      env.npm_config_https_proxy = proxyUrl;
    }

    logger.info({ proxy: Boolean(proxyUrl) }, "Downloading OpenCode");
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

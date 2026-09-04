import { spawn, ChildProcess } from "child_process";
import { join } from "path";
import { existsSync } from "fs";
import { db } from "../db";
import { systemSettings } from "../db/schema";
import { eq } from "drizzle-orm";
import { exec } from "child_process";
import { promisify } from "util";
import pino from "pino";

import { mkdir, readFile, writeFile } from "fs/promises";

const logger = pino({ name: "opencode" });
const execAsync = promisify(exec);

export class OpencodeService {
  private static instance: OpencodeService;
  private process: ChildProcess | null = null;
  public readonly port = 23456;
  private binPath = join(process.cwd(), ".vendor/opencode/bin/opencode");

  private constructor() {}

  public static getInstance(): OpencodeService {
    if (!OpencodeService.instance) {
      OpencodeService.instance = new OpencodeService();
    }
    return OpencodeService.instance;
  }

  public isReady(): boolean {
    return existsSync(this.binPath);
  }

  public isRunning(): boolean {
    return this.process !== null;
  }

  public async start(): Promise<void> {
    if (this.isRunning()) return;
    if (!this.isReady()) throw new Error("OpenCode binary not found");

    const vendorDir = join(process.cwd(), ".vendor/opencode");
    this.process = spawn(this.binPath, ["serve", "--port", this.port.toString()], {
      stdio: "ignore",
      detached: true,
      env: {
        ...process.env,
        XDG_DATA_HOME: join(vendorDir, "data"),
        XDG_CONFIG_HOME: join(vendorDir, "config"),
        XDG_STATE_HOME: join(vendorDir, "state"),
      }
    });
    this.process.unref();

    this.process.on("exit", () => {
      this.process = null;
      logger.info("OpenCode sidecar exited");
    });

    // Give it a moment to bind the port
    await new Promise((resolve) => setTimeout(resolve, 2000));
    logger.info("OpenCode sidecar started");
  }

  public stop(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
      logger.info("OpenCode sidecar stopped");
    }
  }

  public async download(): Promise<void> {
    const settings = await db.select().from(systemSettings).where(eq(systemSettings.key, "opencode_download_proxy"));
    const proxyUrl = settings[0]?.value;

    const proxyEnv = proxyUrl ? `HTTP_PROXY=${proxyUrl} HTTPS_PROXY=${proxyUrl} npm_config_proxy=${proxyUrl} npm_config_https_proxy=${proxyUrl} ` : "";
    
    // We run the bootstrap script with optional proxy
    logger.info("Downloading OpenCode...");
    const cmd = `${proxyEnv}bash ./scripts/bootstrap-opencode.sh`;
    
    try {
      const { stdout, stderr } = await execAsync(cmd, { cwd: process.cwd() });
      logger.info({ stdout, stderr }, "OpenCode download complete");
    } catch (e) {
      logger.error({ err: e }, "Failed to download OpenCode");
      throw new Error("Failed to download OpenCode: " + (e as Error).message);
    }
  }

  public async syncCredential(provider: string, apiKey: string): Promise<void> {
    if (!this.isReady()) return;
    try {
      const vendorDir = join(process.cwd(), ".vendor/opencode");
      const authDir = join(vendorDir, "data", "opencode");
      const authPath = join(authDir, "auth.json");
      
      await mkdir(authDir, { recursive: true });
      let authData: Record<string, any> = {};
      try {
        const existing = await readFile(authPath, "utf8");
        authData = JSON.parse(existing);
      } catch (e) {
        // file doesn't exist or invalid JSON
      }

      authData[provider] = { type: "api", key: apiKey };
      await writeFile(authPath, JSON.stringify(authData, null, 2), "utf8");

      logger.info(`Synced credential for ${provider} into OpenCode auth.json`);
    } catch (e) {
      logger.error({ err: e }, `Failed to sync credential for ${provider}`);
      throw e;
    }
  }
}

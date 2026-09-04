import fs from "fs";
import path from "path";
import os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import { FastifyInstance } from "fastify";
import { db } from "../db";
import { systemSettings, endpointRoutes } from "../db/schema";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { requireAdmin, requireAuth } from "../middleware/auth";
import { scheduleDingTalkJobs, triggerDingTalkPush } from "../services/dingtalk";
import { refreshLoopGuardConfigCache, LOOP_GUARD_SETTING_STRING_DEFAULTS } from "../services/loopGuard";
import { Pool } from "pg";
import { getDbDriver, client } from "../db";
import { loadDbConfig } from "../db/config";
import { resolveDbFilePath } from "../db/path";
import { runCopyPipeline, getMigrationProgress } from "../db/copy/pipeline";
import { isMaintenanceMode, setMaintenanceMode } from "../services/maintenance";

const execAsync = promisify(exec);

function getCpuUsage(): Promise<number> {
  const start = os.cpus();
  return new Promise((resolve) => {
    setTimeout(() => {
      const end = os.cpus();
      let totalDiff = 0;
      let idleDiff = 0;
      for (let i = 0; i < start.length; i++) {
        const startCpu = start[i];
        const endCpu = end[i];
        if (!startCpu || !endCpu) continue;
        const startTimes = startCpu.times;
        const endTimes = endCpu.times;
        const startTotal = startTimes.user + startTimes.nice + startTimes.sys + startTimes.idle + startTimes.irq;
        const endTotal = endTimes.user + endTimes.nice + endTimes.sys + endTimes.idle + endTimes.irq;
        totalDiff += (endTotal - startTotal);
        idleDiff += (endTimes.idle - startTimes.idle);
      }
      if (totalDiff === 0) return resolve(0);
      resolve(Math.round((1 - idleDiff / totalDiff) * 100));
    }, 150);
  });
}

async function getDiskUsage() {
  try {
    const { stdout } = await execAsync("df -k .");
    const lines = stdout.trim().split("\n");
    if (lines.length >= 2) {
      const parts = lines[1].split(/\s+/);
      const totalKB = parseInt(parts[1], 10);
      const usedKB = parseInt(parts[2], 10);
      const availableKB = parseInt(parts[3], 10);
      if (!isNaN(totalKB) && !isNaN(usedKB)) {
        return {
          total: totalKB * 1024,
          used: usedKB * 1024,
          free: availableKB * 1024,
        };
      }
    }
  } catch (err) {
    // ignore
  }
  return { total: 0, used: 0, free: 0 };
}

async function getNetworkStats(): Promise<Record<string, { bytesIn: number; bytesOut: number }>> {
  const stats: Record<string, { bytesIn: number; bytesOut: number }> = {};
  try {
    const platform = os.platform();
    if (platform === "darwin") {
      const { stdout } = await execAsync("netstat -ib");
      const lines = stdout.trim().split("\n");
      if (lines.length > 0) {
        const headers = lines[0].toLowerCase().split(/\s+/);
        const nameIdx = headers.indexOf("name");
        const ibytesIdx = headers.indexOf("ibytes");
        const obytesIdx = headers.indexOf("obytes");
        if (nameIdx !== -1 && ibytesIdx !== -1 && obytesIdx !== -1) {
          for (let i = 1; i < lines.length; i++) {
            const parts = lines[i].trim().split(/\s+/);
            if (parts.length > Math.max(nameIdx, ibytesIdx, obytesIdx)) {
              const name = parts[nameIdx];
              const ibytes = parseInt(parts[ibytesIdx], 10);
              const obytes = parseInt(parts[obytesIdx], 10);
              if (!isNaN(ibytes) && !isNaN(obytes)) {
                if (!stats[name]) {
                  stats[name] = { bytesIn: ibytes, bytesOut: obytes };
                } else {
                  stats[name].bytesIn = Math.max(stats[name].bytesIn, ibytes);
                  stats[name].bytesOut = Math.max(stats[name].bytesOut, obytes);
                }
              }
            }
          }
        }
      }
    } else if (platform === "linux") {
      if (fs.existsSync("/proc/net/dev")) {
        const content = fs.readFileSync("/proc/net/dev", "utf8");
        const lines = content.trim().split("\n");
        for (let i = 2; i < lines.length; i++) {
          const parts = lines[i].trim().split(/\s+/);
          if (parts.length >= 10) {
            const name = parts[0].replace(":", "");
            const bytesIn = parseInt(parts[1], 10);
            const bytesOut = parseInt(parts[9], 10);
            if (!isNaN(bytesIn) && !isNaN(bytesOut)) {
              stats[name] = { bytesIn, bytesOut };
            }
          }
        }
      }
    }
  } catch (e) {
    // ignore
  }
  return stats;
}

const settingsSchema = z.object({
  settings: z.array(
    z.object({
      key: z.string(),
      value: z.string(),
    }),
  ),
});

export default async function (fastify: FastifyInstance) {
  fastify.get(
    "/api/settings/public",
    async (request, reply) => {
      const keys = ["theme", "accentColor", "tokenDisplayUnit", "systemName", "systemSlogan", "systemLogoUrl", "sidebarLogoAnimation", "appendSloganToTitle", "hideSystemNameInTitle", "showGithubIcon", "dateFormat", "timeFormat"];
      const list = await db
        .select()
        .from(systemSettings)
        .where(inArray(systemSettings.key, keys));

      const map: Record<string, string> = {};
      list.forEach((item) => {
        map[item.key] = item.value;
      });
      if (!map.tokenDisplayUnit) {
        map.tokenDisplayUnit = "raw";
      }
      if (!map.systemName) map.systemName = "PromptGate";
      if (!map.systemSlogan) map.systemSlogan = "Lightweight LLM Gateway Console";
      if (!map.systemLogoUrl) map.systemLogoUrl = "/favicon.svg";
      if (!map.sidebarLogoAnimation) map.sidebarLogoAnimation = "none";
      if (!map.appendSloganToTitle) map.appendSloganToTitle = "false";
      if (!map.hideSystemNameInTitle) map.hideSystemNameInTitle = "false";
      if (!map.showGithubIcon) map.showGithubIcon = "true";
      if (!map.dateFormat) map.dateFormat = "YYYY-MM-DD";
      if (!map.timeFormat) map.timeFormat = "24h";

      return map;
    },
  );

  fastify.get(
    "/api/admin/settings",
    { onRequest: [requireAdmin] },
    async (request, reply) => {
      const list = await db.select().from(systemSettings);

      const enabledItem = list.find((item) => item.key === "sessionSummaryEnabled");
      const routeItem = list.find((item) => item.key === "sessionSummaryRoute");

      if (enabledItem?.value === "true" && routeItem?.value) {
        // Validate if route still exists
        const routeExists = await db
          .select()
          .from(endpointRoutes)
          .where(eq(endpointRoutes.id, routeItem.value));

        if (routeExists.length === 0) {
          // Route was deleted: automatically turn off and clear route setting
          await db
            .update(systemSettings)
            .set({ value: "false", updatedAt: new Date() })
            .where(eq(systemSettings.key, "sessionSummaryEnabled"));
          await db
            .update(systemSettings)
            .set({ value: "", updatedAt: new Date() })
            .where(eq(systemSettings.key, "sessionSummaryRoute"));

          enabledItem.value = "false";
          routeItem.value = "";
        }
      }

      const payload = list.map((item) => ({ key: item.key, value: item.value }));
      const present = new Set(payload.map((item) => item.key));
      for (const [key, value] of Object.entries(LOOP_GUARD_SETTING_STRING_DEFAULTS)) {
        if (!present.has(key)) payload.push({ key, value });
      }
      if (!present.has("adminHost")) payload.push({ key: "adminHost", value: "" });
      return payload;
    },
  );

  fastify.post(
    "/api/admin/settings",
    { onRequest: [requireAdmin] },
    async (request, reply) => {
      const parsed = settingsSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({ error: "Invalid input" });

      const { settings } = parsed.data;

      for (const item of settings) {
        if (item.value !== undefined) {
          const existing = await db
            .select()
            .from(systemSettings)
            .where(eq(systemSettings.key, item.key));
          if (existing.length > 0) {
            await db
              .update(systemSettings)
              .set({ value: item.value, updatedAt: new Date() })
              .where(eq(systemSettings.key, item.key));
          } else {
            await db.insert(systemSettings).values({
              key: item.key,
              value: item.value,
              description: "",
              createdAt: new Date(),
              updatedAt: new Date(),
            });
          }
        }
      }

      // Re-initialize cron jobs after settings change
      await scheduleDingTalkJobs();
      await refreshLoopGuardConfigCache();

      return { success: true };
    },
  );

  fastify.post(
    "/api/admin/settings/test-dingtalk",
    { onRequest: [requireAdmin] },
    async (request, reply) => {
      try {
        await triggerDingTalkPush();
        return { success: true };
      } catch (e: any) {
        return reply.code(400).send({ error: e.message });
      }
    }
  );

  // --- Database info & download ---

  const dbPath = process.env.DB_FILE || "data/promptgate.sqlite";
  const getDbPath = () => {
    if (path.isAbsolute(dbPath)) return dbPath;
    if (process.cwd().endsWith("server")) {
      return path.join(process.cwd(), "../../", dbPath);
    }
    return path.join(process.cwd(), dbPath);
  };

  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024)
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  };

  fastify.get(
    "/api/admin/database/info",
    { onRequest: [requireAdmin] },
    async (request, reply) => {
      const driver = getDbDriver();
      if (driver === "postgres") {
        return {
          driver: "postgres",
          path: "PostgreSQL",
          size: 0,
          sizeFormatted: "Managed by PostgreSQL",
          isBackupPasswordSet: false,
        };
      }
      const filePath = getDbPath();
      let size = 0;
      try {
        const stat = fs.statSync(filePath);
        size = stat.size;
      } catch {
        // file may not exist yet
      }
      return {
        driver: "sqlite",
        path: dbPath,
        size,
        sizeFormatted: formatSize(size),
        isBackupPasswordSet: !!process.env.DB_BACKUP_PASSWORD,
      };
    },
  );

  fastify.get(
    "/api/admin/database/download",
    { onRequest: [requireAdmin] },
    async (request, reply) => {
      if (getDbDriver() !== "sqlite") {
        return reply.code(400).send({
          error: "Database backup download is only supported for SQLite. For PostgreSQL, please use pg_dump.",
        });
      }

      const backupPassword = process.env.DB_BACKUP_PASSWORD;
      if (!backupPassword) {
        return reply.code(403).send({
          error: "Database backup download is disabled because DB_BACKUP_PASSWORD is not set"
        });
      }

      const clientPassword = request.headers["x-backup-password"];
      if (clientPassword !== backupPassword) {
        return reply.code(401).send({
          error: "Invalid backup password"
        });
      }

      const filePath = getDbPath();
      reply.header("Content-Type", "application/octet-stream");
      reply.header(
        "Content-Disposition",
        'attachment; filename="promptgate.sqlite"',
      );
      const stream = fs.createReadStream(filePath);
      return reply.send(stream);
    },
  );

  // GET /api/settings/database
  fastify.get(
    "/api/settings/database",
    { onRequest: [requireAdmin] },
    async (request, reply) => {
      const config = loadDbConfig();
      const driver = getDbDriver();

      if (driver === "sqlite") {
        const rawFile = config.sqlite?.file || "data/promptgate.sqlite";
        const resolved = resolveDbFilePath(rawFile, process.cwd());
        let sizeBytes = 0;
        let exists = false;
        try {
          if (fs.existsSync(resolved)) {
            const stat = fs.statSync(resolved);
            sizeBytes = stat.size;
            exists = true;
          }
        } catch {
          // Ignore
        }
        return {
          driver: "sqlite",
          sqlite: {
            file: rawFile,
            resolvedPath: resolved,
            sizeBytes,
            sizeFormatted: formatSize(sizeBytes),
            exists,
          },
          maintenance: isMaintenanceMode(),
        };
      }

      const rawUrl = config.postgres?.url || "";
      const urlMasked = rawUrl ? rawUrl.replace(/:[^:@]+@/, ":****@") : "";
      let currentDbName = "unknown";
      let connected = false;
      try {
        const res = await (client as any).query("SELECT current_database() as db;");
        currentDbName = res.rows[0]?.db || "unknown";
        connected = true;
      } catch {
        // Query failed
      }

      return {
        driver: "postgres",
        postgres: {
          urlMasked,
          database: currentDbName,
          connected,
        },
        maintenance: isMaintenanceMode(),
      };
    },
  );

  // POST /api/settings/database/test
  fastify.post<{ Body: { databaseUrl: string } }>(
    "/api/settings/database/test",
    { onRequest: [requireAdmin] },
    async (request, reply) => {
      const { databaseUrl } = request.body || {};
      if (!databaseUrl) {
        return reply.code(400).send({ ok: false, error: "Database URL is required" });
      }
      let pool: Pool | null = null;
      try {
        pool = new Pool({
          connectionString: databaseUrl,
          connectionTimeoutMillis: 4000,
        });
        await pool.query("SELECT 1 as val;");
        return { ok: true, message: "Connected to PostgreSQL database successfully" };
      } catch (err: any) {
        return reply.code(400).send({ ok: false, error: err.message || "Failed to connect to PostgreSQL" });
      } finally {
        if (pool) {
          await pool.end().catch(() => {});
        }
      }
    },
  );

  // POST /api/settings/database/migrate-to-pg
  fastify.post<{ Body: { databaseUrl: string } }>(
    "/api/settings/database/migrate-to-pg",
    { onRequest: [requireAdmin] },
    async (request, reply) => {
      const driver = getDbDriver();
      if (driver === "postgres") {
        return reply.code(400).send({
          ok: false,
          error: "Current database is already PostgreSQL. Migration is only supported from SQLite.",
        });
      }

      const { databaseUrl } = request.body || {};
      if (!databaseUrl) {
        return reply.code(400).send({ ok: false, error: "PostgreSQL databaseUrl is required." });
      }

      const progress = getMigrationProgress();
      if (progress.inProgress) {
        return reply.code(409).send({
          ok: false,
          error: "Migration is already in progress.",
          progress,
        });
      }

      try {
        // 1. Enable maintenance mode & drain requests per PRD §9.2
        await setMaintenanceMode(true, { drain: true, timeoutMs: 60_000 });

        // 2. Run copy pipeline
        const result = await runCopyPipeline({
          targetPgUrl: databaseUrl,
          batchSize: 1000,
        });

        // 3. Turn off maintenance mode (cleans temp setting)
        await setMaintenanceMode(false);

        return {
          ok: true,
          message: "Migration to PostgreSQL completed successfully. Please restart the server to switch to PostgreSQL.",
          result,
        };
      } catch (err: any) {
        await setMaintenanceMode(false);
        return reply.code(500).send({
          ok: false,
          error: err.message || "Migration failed",
        });
      }
    },
  );

  // GET /api/settings/database/migrate-status
  fastify.get(
    "/api/settings/database/migrate-status",
    { onRequest: [requireAdmin] },
    async () => {
      return getMigrationProgress();
    },
  );

  fastify.get(
    "/api/admin/database/system-info",
    { onRequest: [requireAdmin] },
    async (request, reply) => {
      const uptime = process.uptime();
      const memUsage = process.memoryUsage();
      const cpus = os.cpus();

      const networks = os.networkInterfaces();
      const ips: string[] = [];
      for (const name of Object.keys(networks)) {
        for (const net of networks[name] || []) {
          if (net.family === 'IPv4' && !net.internal) {
            ips.push(net.address);
          }
        }
      }

      const [cpuUsage, diskUsage, networkStats] = await Promise.all([
        getCpuUsage(),
        getDiskUsage(),
        getNetworkStats(),
      ]);

      return {
        app: {
          version: "1.0.0",
          nodeVersion: process.version,
          environment: process.env.NODE_ENV || "development",
          uptime: Math.floor(uptime),
          pid: process.pid,
          execPath: process.execPath,
          cwd: process.cwd(),
        },
        memory: {
          rss: memUsage.rss,
          heapTotal: memUsage.heapTotal,
          heapUsed: memUsage.heapUsed,
          external: memUsage.external,
        },
        system: {
          platform: os.platform(),
          arch: os.arch(),
          hostname: os.hostname(),
          osRelease: os.release(),
          totalMemory: os.totalmem(),
          freeMemory: os.freemem(),
          cpuModel: cpus.length > 0 ? cpus[0].model : "Unknown",
          cpuCores: cpus.length,
          loadAverage: os.loadavg(),
          uptime: os.uptime(),
          user: os.userInfo().username,
          ips: ips,
          cpuUsage,
          disk: diskUsage,
          network: networkStats,
        },
      };
    },
  );
}

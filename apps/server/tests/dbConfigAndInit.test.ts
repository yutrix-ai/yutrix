import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { loadDbConfig, DEFAULT_DB_CONFIG, getDbConfigPath, YutrixDbConfig } from "../src/db/config";
import { initDb, createDb, closeDb, getDb, getClient, isDbInitialized, db, client } from "../src/db";
import * as schemaDirect from "../src/db/schema.sqlite";
import * as schemaReExport from "../src/db/schema";
import { resolveDbFilePath } from "../src/db/path";

describe("Slice P0-1: DB Config & initDb", () => {
  const tmpDir = path.join(process.cwd(), "data", `test_config_${crypto.randomUUID()}`);
  const testConfigPath = path.join(tmpDir, "yutrix.config.json");

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await closeDb();
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe("1. DB Config loading and priority", () => {
    it("returns defaults when no config file and no env vars are set", () => {
      const cfg = loadDbConfig({
        configPath: testConfigPath,
        env: {},
      });

      expect(cfg.version).toBe(1);
      expect(cfg.driver).toBe("sqlite");
      expect(cfg.sqlite.file).toBe("data/promptgate.sqlite");
      expect(cfg.postgres.url).toBe("");
      expect(cfg.setupCompletedAt).toBeNull();
      // Does NOT write a file to disk
      expect(fs.existsSync(testConfigPath)).toBe(false);
    });

    it("reads values from yutrix.config.json when present", () => {
      const savedConfig: YutrixDbConfig = {
        version: 1,
        driver: "sqlite",
        sqlite: { file: "data/custom_yutrix.sqlite" },
        postgres: { url: "" },
        setupCompletedAt: "2026-09-02T12:00:00.000Z",
      };
      fs.writeFileSync(testConfigPath, JSON.stringify(savedConfig), "utf-8");

      const cfg = loadDbConfig({
        configPath: testConfigPath,
        env: {},
      });

      expect(cfg.version).toBe(1);
      expect(cfg.driver).toBe("sqlite");
      expect(cfg.sqlite.file).toBe("data/custom_yutrix.sqlite");
      expect(cfg.setupCompletedAt).toBe("2026-09-02T12:00:00.000Z");
    });

    it("priority: env DB_FILE overrides yutrix.config.json sqlite.file", () => {
      fs.writeFileSync(
        testConfigPath,
        JSON.stringify({
          version: 1,
          driver: "sqlite",
          sqlite: { file: "data/from_config.sqlite" },
          postgres: { url: "" },
          setupCompletedAt: null,
        }),
        "utf-8"
      );

      const cfg = loadDbConfig({
        configPath: testConfigPath,
        env: { DB_FILE: "data/from_env.sqlite" },
      });

      expect(cfg.sqlite.file).toBe("data/from_env.sqlite");
    });

    it("detection: DATABASE_URL postgres:// forces postgres driver", () => {
      const cfg = loadDbConfig({
        configPath: testConfigPath,
        env: {
          DATABASE_URL: "postgres://user:password@localhost:5432/yutrix_db",
        },
      });

      expect(cfg.driver).toBe("postgres");
      expect(cfg.postgres.url).toBe("postgres://user:password@localhost:5432/yutrix_db");
    });

    it("detection: DATABASE_URL postgresql:// forces postgres driver", () => {
      const cfg = loadDbConfig({
        configPath: testConfigPath,
        env: {
          DATABASE_URL: "postgresql://user:password@localhost:5432/yutrix_db",
        },
      });

      expect(cfg.driver).toBe("postgres");
      expect(cfg.postgres.url).toBe("postgresql://user:password@localhost:5432/yutrix_db");
    });

    it("detection: DB_DRIVER=postgres with URL sets postgres", () => {
      const cfg = loadDbConfig({
        configPath: testConfigPath,
        env: {
          DB_DRIVER: "postgres",
          DATABASE_URL: "postgres://user:password@localhost:5432/yutrix_db",
        },
      });

      expect(cfg.driver).toBe("postgres");
      expect(cfg.postgres.url).toBe("postgres://user:password@localhost:5432/yutrix_db");
    });

    it("detection: DB_DRIVER=postgres without URL throws error", () => {
      expect(() => {
        loadDbConfig({
          configPath: testConfigPath,
          env: {
            DB_DRIVER: "postgres",
          },
        });
      }).toThrow(/PostgreSQL URL is required/);
    });

    it("detection: DB_DRIVER=sqlite overrides postgres in config file", () => {
      fs.writeFileSync(
        testConfigPath,
        JSON.stringify({
          version: 1,
          driver: "postgres",
          sqlite: { file: "data/promptgate.sqlite" },
          postgres: { url: "postgres://host/db" },
          setupCompletedAt: null,
        }),
        "utf-8"
      );

      const cfg = loadDbConfig({
        configPath: testConfigPath,
        env: {
          DB_DRIVER: "sqlite",
        },
      });

      expect(cfg.driver).toBe("sqlite");
    });
  });

  describe("2. Schema backward compatibility", () => {
    it("schema.sqlite.ts and schema.ts export identical keys", () => {
      const directKeys = Object.keys(schemaDirect).sort();
      const reExportKeys = Object.keys(schemaReExport).sort();

      expect(directKeys).toEqual(reExportKeys);
      expect(directKeys.length).toBeGreaterThan(10);
      expect(directKeys).toContain("users");
      expect(directKeys).toContain("apiKeys");
      expect(directKeys).toContain("systemSettings");
    });
  });

  describe("3. initDb & createDb behavior", () => {
    it("accessing db before initDb throws an uninitialized error", async () => {
      await closeDb();
      expect(isDbInitialized()).toBe(false);

      expect(() => {
        // Accessing property on uninitialized proxy
        db.select();
      }).toThrow(/Database has not been initialized/);

      expect(() => {
        client.execute("SELECT 1;");
      }).toThrow(/Database client has not been initialized/);
    });

    it("createDb creates a connection without mutating global db state", async () => {
      await closeDb();
      expect(isDbInitialized()).toBe(false);

      const testDbFile = path.join(tmpDir, "standalone.sqlite");
      const result = await createDb({
        version: 1,
        driver: "sqlite",
        sqlite: { file: testDbFile },
        postgres: { url: "" },
        setupCompletedAt: null,
      });

      expect(result.db).toBeDefined();
      expect(result.client).toBeDefined();

      // Global db is still not initialized
      expect(isDbInitialized()).toBe(false);

      await result.client.close();
    });

    it("initDb initializes db and client, enabling queries", async () => {
      await closeDb();
      const testDbFile = path.join(tmpDir, "initialized.sqlite");

      await initDb({
        version: 1,
        driver: "sqlite",
        sqlite: { file: testDbFile },
        postgres: { url: "" },
        setupCompletedAt: null,
      });

      expect(isDbInitialized()).toBe(true);
      expect(getDb()).toBeDefined();
      expect(getClient()).toBeDefined();

      // Simple query succeeds
      const result = await client.execute("SELECT 1 as val;");
      expect(result.rows[0].val).toBe(1);

      await closeDb();
      expect(isDbInitialized()).toBe(false);
    });

    it("createDb with postgres driver requires a valid postgres.url", async () => {
      await expect(
        createDb({
          version: 1,
          driver: "postgres",
          sqlite: { file: "data/promptgate.sqlite" },
          postgres: { url: "" },
          setupCompletedAt: null,
        })
      ).rejects.toThrow(/PostgreSQL URL is required/);
    });

    it("path.ts resolution works for relative and absolute paths", () => {
      const absPath = "/var/data/custom.sqlite";
      expect(resolveDbFilePath(absPath, "/any/path")).toBe(absPath);

      const relPath = "data/promptgate.sqlite";
      const resolved = resolveDbFilePath(relPath, process.cwd());
      expect(path.isAbsolute(resolved)).toBe(true);
    });
  });
});

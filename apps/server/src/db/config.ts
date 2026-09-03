import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { resolveDbFilePath } from "./path";

const envPath = process.cwd().endsWith("server") ? "../../.env" : ".env";
dotenv.config({ path: envPath });

export type DbDriver = "sqlite" | "postgres";

export interface YutrixDbConfig {
  version: number;
  driver: DbDriver;
  sqlite: {
    file: string;
  };
  postgres: {
    url: string;
  };
  setupCompletedAt: number | string | null;
}

export const DEFAULT_DB_CONFIG: YutrixDbConfig = {
  version: 1,
  driver: "sqlite",
  sqlite: {
    file: "data/promptgate.sqlite",
  },
  postgres: {
    url: "",
  },
  setupCompletedAt: null,
};

export interface LoadDbConfigOptions {
  cwd?: string;
  configPath?: string;
  env?: NodeJS.ProcessEnv;
}

export function getDbConfigPath(cwd: string = process.cwd()): string {
  return resolveDbFilePath("data/yutrix.config.json", cwd);
}

function readConfigFile(filePath: string): Partial<YutrixDbConfig> | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    return parsed;
  } catch (err) {
    console.error(`[db-config] Failed to parse config file at ${filePath}:`, err);
    throw err;
  }
}

/**
 * Loads DB configuration following PRD §5 priority:
 * 1. Environment variables (DATABASE_URL, DB_DRIVER, DB_FILE)
 * 2. data/yutrix.config.json (on persistent data disk)
 * 3. Default fallback values (driver: sqlite, file: data/promptgate.sqlite)
 *
 * NOTE: This function NEVER creates or writes yutrix.config.json.
 */
export function loadDbConfig(options: LoadDbConfigOptions = {}): YutrixDbConfig {
  const cwd = options.cwd || process.cwd();
  const configPath = options.configPath || getDbConfigPath(cwd);
  const env = options.env || process.env;

  const fileConfig = readConfigFile(configPath) || {};

  let version = fileConfig.version ?? DEFAULT_DB_CONFIG.version;
  let driver: DbDriver = (fileConfig.driver as DbDriver) || DEFAULT_DB_CONFIG.driver;
  let sqliteFile = fileConfig.sqlite?.file || DEFAULT_DB_CONFIG.sqlite.file;
  let postgresUrl = fileConfig.postgres?.url || DEFAULT_DB_CONFIG.postgres.url;
  let setupCompletedAt = fileConfig.setupCompletedAt ?? DEFAULT_DB_CONFIG.setupCompletedAt;

  const dbUrl = env.DATABASE_URL?.trim();
  const dbDriver = env.DB_DRIVER?.trim().toLowerCase();
  const dbFile = env.DB_FILE?.trim();

  // Detection rules (PRD §5):
  // 1. if DATABASE_URL starts with postgres → postgres
  // 2. else if DB_DRIVER=postgres → postgres (requires URL)
  // 3. else if DB_DRIVER=sqlite → sqlite
  // 4. else → keep config file driver / default sqlite
  if (
    dbUrl &&
    (dbUrl.startsWith("postgres://") ||
      dbUrl.startsWith("postgresql://") ||
      dbUrl.startsWith("postgres"))
  ) {
    driver = "postgres";
    postgresUrl = dbUrl;
  } else if (dbDriver === "postgres") {
    driver = "postgres";
    if (dbUrl) {
      postgresUrl = dbUrl;
    }
  } else if (dbDriver === "sqlite") {
    driver = "sqlite";
  }

  // DB_FILE overrides sqlite.file
  if (dbFile) {
    sqliteFile = dbFile;
  }

  // If driver is postgres, validate that URL is provided
  if (driver === "postgres" && !postgresUrl) {
    throw new Error(
      "PostgreSQL URL is required when driver is postgres (set DATABASE_URL or postgres.url in config)"
    );
  }

  return {
    version,
    driver,
    sqlite: {
      file: sqliteFile,
    },
    postgres: {
      url: postgresUrl,
    },
    setupCompletedAt,
  };
}

/**
 * Persists DB configuration to data/yutrix.config.json.
 * Uses file mode 0600 (owner read/write only) per PRD §6.4.
 * Not called during normal startup.
 */
export function saveDbConfig(
  config: YutrixDbConfig,
  options: { configPath?: string; cwd?: string } = {}
): void {
  const targetPath = options.configPath || getDbConfigPath(options.cwd);
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(targetPath, JSON.stringify(config, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
}

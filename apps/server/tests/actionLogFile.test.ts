import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readLogTail, rotateLogFile } from "../src/utils/actionLogger";
import { shouldLogDbQueries } from "../src/db";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "action-log-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("readLogTail", () => {
  it("returns the last lines of a small file", () => {
    const file = path.join(dir, "a.log");
    fs.writeFileSync(file, "l1\nl2\nl3\n");
    expect(readLogTail(file, 2)).toEqual(["l2", "l3"]);
    expect(readLogTail(file, 10)).toEqual(["l1", "l2", "l3"]);
  });

  it("only reads the trailing bytes and drops the partial first line", () => {
    const file = path.join(dir, "b.log");
    const lines = Array.from({ length: 1000 }, (_, i) => `2026-10-14 15:00:00 信息 第${i}行`);
    fs.writeFileSync(file, lines.join("\n") + "\n");

    const tail = readLogTail(file, 1000, 200);
    expect(tail.length).toBeGreaterThan(0);
    expect(tail.length).toBeLessThan(20);
    expect(tail[tail.length - 1]).toBe(lines[999]);
    for (const line of tail) {
      expect(lines).toContain(line);
    }
  });

  it("returns empty for an empty file", () => {
    const file = path.join(dir, "c.log");
    fs.writeFileSync(file, "");
    expect(readLogTail(file, 10)).toEqual([]);
  });
});

describe("rotateLogFile", () => {
  it("shifts rotated files and drops the oldest beyond maxFiles", () => {
    const file = path.join(dir, "action.log");
    fs.writeFileSync(file, "current");
    fs.writeFileSync(`${file}.1`, "one");
    fs.writeFileSync(`${file}.2`, "two");

    rotateLogFile(file, 2);

    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readFileSync(`${file}.1`, "utf-8")).toBe("current");
    expect(fs.readFileSync(`${file}.2`, "utf-8")).toBe("one");
    expect(fs.existsSync(`${file}.3`)).toBe(false);
  });
});

describe("shouldLogDbQueries", () => {
  const original = { NODE_ENV: process.env.NODE_ENV, DB_QUERY_LOG: process.env.DB_QUERY_LOG };

  afterEach(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("is off in production and on elsewhere by default", () => {
    delete process.env.DB_QUERY_LOG;
    process.env.NODE_ENV = "production";
    expect(shouldLogDbQueries()).toBe(false);
    process.env.NODE_ENV = "development";
    expect(shouldLogDbQueries()).toBe(true);
  });

  it("respects DB_QUERY_LOG override", () => {
    process.env.NODE_ENV = "production";
    process.env.DB_QUERY_LOG = "1";
    expect(shouldLogDbQueries()).toBe(true);
    process.env.NODE_ENV = "development";
    process.env.DB_QUERY_LOG = "0";
    expect(shouldLogDbQueries()).toBe(false);
  });
});

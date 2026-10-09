import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dumpUpstreamRejectedBody } from "../src/routes/gateway/diagnostics";

describe("dumpUpstreamRejectedBody", () => {
  let dir: string;
  const original = process.env.GATEWAY_DUMP_UPSTREAM_4XX_DIR;

  beforeEach(() => {
    dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "yutrix-dump-")), "nested");
  });

  afterEach(() => {
    if (original === undefined) delete process.env.GATEWAY_DUMP_UPSTREAM_4XX_DIR;
    else process.env.GATEWAY_DUMP_UPSTREAM_4XX_DIR = original;
  });

  it("is a no-op when the env var is unset", async () => {
    delete process.env.GATEWAY_DUMP_UPSTREAM_4XX_DIR;
    expect(await dumpUpstreamRejectedBody(400, { a: 1 }, { requestId: "r1" })).toBeNull();
  });

  it("only dumps 400/422", async () => {
    process.env.GATEWAY_DUMP_UPSTREAM_4XX_DIR = dir;
    expect(await dumpUpstreamRejectedBody(500, { a: 1 }, { requestId: "r1" })).toBeNull();
    expect(await dumpUpstreamRejectedBody(429, { a: 1 }, { requestId: "r1" })).toBeNull();
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("writes the exact outbound body with meta and a sanitized file name", async () => {
    process.env.GATEWAY_DUMP_UPSTREAM_4XX_DIR = dir;
    const body = { model: "gemini-pro-agent", messages: [{ role: "tool", content: "x" }] };

    const file = await dumpUpstreamRejectedBody(400, body, {
      requestId: "../dd7c2a7b-adc0",
      attempt: 1,
      providerName: "Antigravity",
    });

    expect(file).not.toBeNull();
    expect(path.dirname(file!)).toBe(dir);
    expect(path.basename(file!)).toMatch(/-dd7c2a7b-adc0-1\.json$/);
    const saved = JSON.parse(fs.readFileSync(file!, "utf8"));
    expect(saved.body).toEqual(body);
    expect(saved.status).toBe(400);
    expect(saved.providerName).toBe("Antigravity");
    expect(fs.statSync(file!).mode & 0o777).toBe(0o600);
  });

  it("swallows write failures", async () => {
    const blocker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "yutrix-dump-")), "file");
    fs.writeFileSync(blocker, "");
    process.env.GATEWAY_DUMP_UPSTREAM_4XX_DIR = path.join(blocker, "sub");
    await expect(dumpUpstreamRejectedBody(400, {}, { requestId: "r" })).resolves.toBeNull();
  });
});

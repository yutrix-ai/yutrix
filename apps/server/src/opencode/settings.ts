import { eq } from "drizzle-orm";
import { db } from "../db";
import { systemSettings } from "../db/schema";
import { OPENCODE_AUTO_UPDATE_KEY, OPENCODE_DOWNLOAD_PROXY_KEY } from "./paths";
import { normalizeDownloadProxyUrl, parseOpencodeAutoUpdate } from "./protocol";

export async function getOpencodeDownloadProxy(): Promise<string> {
  const rows = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.key, OPENCODE_DOWNLOAD_PROXY_KEY));
  return rows[0]?.value || "";
}

export async function setOpencodeDownloadProxy(raw: unknown): Promise<string> {
  const proxyUrl = normalizeDownloadProxyUrl(raw);
  const now = new Date();
  const existing = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.key, OPENCODE_DOWNLOAD_PROXY_KEY));

  if (!proxyUrl) {
    if (existing.length > 0) {
      await db.delete(systemSettings).where(eq(systemSettings.key, OPENCODE_DOWNLOAD_PROXY_KEY));
    }
    return "";
  }

  if (existing.length > 0) {
    await db
      .update(systemSettings)
      .set({ value: proxyUrl, updatedAt: now })
      .where(eq(systemSettings.key, OPENCODE_DOWNLOAD_PROXY_KEY));
  } else {
    await db.insert(systemSettings).values({
      key: OPENCODE_DOWNLOAD_PROXY_KEY,
      value: proxyUrl,
      description: "HTTP(S) proxy used when downloading the OpenCode sidecar",
      createdAt: now,
      updatedAt: now,
    });
  }
  return proxyUrl;
}

export async function getOpencodeAutoUpdate(): Promise<boolean> {
  const rows = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.key, OPENCODE_AUTO_UPDATE_KEY));
  return parseOpencodeAutoUpdate(rows[0]?.value);
}

export async function setOpencodeAutoUpdate(enabled: boolean): Promise<boolean> {
  const value = enabled ? "true" : "false";
  const now = new Date();
  const existing = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.key, OPENCODE_AUTO_UPDATE_KEY));

  if (existing.length > 0) {
    await db
      .update(systemSettings)
      .set({ value, updatedAt: now })
      .where(eq(systemSettings.key, OPENCODE_AUTO_UPDATE_KEY));
  } else {
    await db.insert(systemSettings).values({
      key: OPENCODE_AUTO_UPDATE_KEY,
      value,
      description: "Automatically download a newer OpenCode sidecar when one is published",
      createdAt: now,
      updatedAt: now,
    });
  }
  return enabled;
}

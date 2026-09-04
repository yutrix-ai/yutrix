import { eq } from "drizzle-orm";
import { db } from "../db";
import { systemSettings } from "../db/schema";
import { OPENCODE_DOWNLOAD_PROXY_KEY } from "./paths";
import { normalizeDownloadProxyUrl } from "./protocol";

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

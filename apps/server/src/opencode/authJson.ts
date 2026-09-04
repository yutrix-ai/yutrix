import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname } from "path";

const YUTRIX_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type OpencodeAuthFile = Record<string, { type: "api"; key: string }>;

export async function readOpencodeAuthJson(authPath: string): Promise<OpencodeAuthFile> {
  try {
    const existing = await readFile(authPath, "utf8");
    const parsed = JSON.parse(existing);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as OpencodeAuthFile;
    }
  } catch {
    // missing or invalid — start fresh
  }
  return {};
}

/**
 * Keys stay in providerApiKeys. This only mirrors the selected key into
 * OpenCode's auth.json as `{ [provider]: { type: "api", key } }`.
 */
export async function writeOpencodeAuthJson(
  authPath: string,
  provider: string,
  apiKey: string,
): Promise<OpencodeAuthFile> {
  if (!provider || YUTRIX_UUID.test(provider)) {
    throw new Error("OpenCode providerID must be a vendor slug, not a yutrix UUID");
  }

  await mkdir(dirname(authPath), { recursive: true });
  const authData = await readOpencodeAuthJson(authPath);
  authData[provider] = { type: "api", key: apiKey };
  await writeFile(authPath, JSON.stringify(authData, null, 2), { encoding: "utf8", mode: 0o600 });
  return authData;
}

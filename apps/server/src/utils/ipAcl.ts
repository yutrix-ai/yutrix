import { BlockList, isIP } from "node:net";
import type { FastifyRequest } from "fastify";

const UNRESTRICTED_TOKENS = new Set(["*", "all", "0.0.0.0/0", "::/0"]);

export function normalizeIp(ip: string): string {
  if (!ip) return "";
  let value = ip.trim();
  if (!value) return "";

  if (value.startsWith("[") && value.includes("]")) {
    value = value.slice(1, value.indexOf("]"));
  } else {
    const ipv4Port = value.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
    if (ipv4Port) value = ipv4Port[1];
  }

  const lower = value.toLowerCase();
  if (lower.startsWith("::ffff:")) {
    const mapped = value.slice(value.toLowerCase().indexOf("::ffff:") + 7);
    if (isIP(mapped) === 4) return mapped;
  }
  return value;
}

export function getClientIp(request?: FastifyRequest | null): string {
  return normalizeIp(request?.ip || request?.socket?.remoteAddress || "");
}

export function splitIpAclRules(ruleString?: string | null): string[] {
  if (!ruleString) return [];
  return ruleString
    .split(/[\r\n,;]+/)
    .map((rule) => rule.trim())
    .filter(Boolean);
}

function isUnrestrictedToken(rule: string): boolean {
  return UNRESTRICTED_TOKENS.has(rule.trim().toLowerCase());
}

export function isUnrestrictedIpAcl(ruleString?: string | null): boolean {
  const rules = splitIpAclRules(ruleString);
  if (rules.length === 0) return true;
  return rules.every(isUnrestrictedToken);
}

export type IpAclValidation =
  | { ok: true; rules: string[]; unrestricted: boolean }
  | { ok: false; error: string };

function parseOneRule(rule: string): { ok: true } | { ok: false; error: string } {
  if (isUnrestrictedToken(rule)) return { ok: true };

  if (rule.includes("/")) {
    const lastSlash = rule.lastIndexOf("/");
    const ipPart = rule.slice(0, lastSlash);
    const prefix = Number(rule.slice(lastSlash + 1));
    const ipType = isIP(ipPart);
    if (ipType === 4 && Number.isInteger(prefix) && prefix >= 0 && prefix <= 32) {
      return { ok: true };
    }
    if (ipType === 6 && Number.isInteger(prefix) && prefix >= 0 && prefix <= 128) {
      return { ok: true };
    }
    return { ok: false, error: `无效的 CIDR：${rule}` };
  }

  if (rule.includes("-")) {
    const [start, end, extra] = rule.split("-").map((part) => part.trim());
    if (extra || !start || !end) return { ok: false, error: `无效的 IP 范围：${rule}` };
    const startType = isIP(start);
    const endType = isIP(end);
    if (startType !== 0 && startType === endType) return { ok: true };
    return { ok: false, error: `无效的 IP 范围：${rule}` };
  }

  if (isIP(rule) !== 0) return { ok: true };
  return { ok: false, error: `无效的 IP：${rule}` };
}

export function validateIpAcl(ruleString?: string | null): IpAclValidation {
  const rules = splitIpAclRules(ruleString);
  if (rules.length === 0 || rules.every(isUnrestrictedToken)) {
    return { ok: true, rules, unrestricted: true };
  }

  for (const rule of rules) {
    const parsed = parseOneRule(rule);
    if (!parsed.ok) return parsed;
    if (!isUnrestrictedToken(rule)) {
      try {
        addRuleToBlockList(new BlockList(), rule);
      } catch {
        return { ok: false, error: `无效的来源限制：${rule}` };
      }
    }
  }
  return { ok: true, rules, unrestricted: false };
}

export function normalizeIpAclForStorage(ruleString?: string | null): string | null {
  const validated = validateIpAcl(ruleString);
  if (!validated.ok) {
    throw new Error(validated.error);
  }
  if (validated.unrestricted) return null;
  return validated.rules.join(", ");
}

function addRuleToBlockList(blockList: BlockList, rule: string): void {
  if (rule.includes("/")) {
    const lastSlash = rule.lastIndexOf("/");
    const ipPart = rule.slice(0, lastSlash);
    const prefix = Number(rule.slice(lastSlash + 1));
    const ipType = isIP(ipPart);
    if (ipType === 4) blockList.addSubnet(ipPart, prefix, "ipv4");
    else if (ipType === 6) blockList.addSubnet(ipPart, prefix, "ipv6");
    return;
  }

  if (rule.includes("-")) {
    const [start, end] = rule.split("-").map((part) => part.trim());
    const ipType = isIP(start);
    if (ipType === 4) blockList.addRange(start, end, "ipv4");
    else if (ipType === 6) blockList.addRange(start, end, "ipv6");
    return;
  }

  const ipType = isIP(rule);
  if (ipType === 4) blockList.addAddress(rule, "ipv4");
  else if (ipType === 6) blockList.addAddress(rule, "ipv6");
}

const compiledCache = new Map<string, BlockList | null>();

function compileIpAcl(ruleString?: string | null): BlockList | null {
  const key = (ruleString || "").trim();
  if (compiledCache.has(key)) return compiledCache.get(key)!;

  if (isUnrestrictedIpAcl(key)) {
    compiledCache.set(key, null);
    return null;
  }

  const blockList = new BlockList();
  for (const rule of splitIpAclRules(key)) {
    if (isUnrestrictedToken(rule)) continue;
    addRuleToBlockList(blockList, rule);
  }
  compiledCache.set(key, blockList);
  return blockList;
}

export function isClientIpAllowed(clientIp: string, ruleString?: string | null): boolean {
  if (isUnrestrictedIpAcl(ruleString)) return true;

  const normalized = normalizeIp(clientIp);
  const version = isIP(normalized);
  if (version === 0) return false;

  const rules = splitIpAclRules(ruleString);
  for (const rule of rules) {
    const token = rule.trim().toLowerCase();
    if (token === "*" || token === "all") return true;
    if (token === "0.0.0.0/0" && version === 4) return true;
    if (token === "::/0" && version === 6) return true;
  }

  const blockList = compileIpAcl(ruleString);
  if (!blockList) return true;
  return blockList.check(normalized, version === 6 ? "ipv6" : "ipv4");
}

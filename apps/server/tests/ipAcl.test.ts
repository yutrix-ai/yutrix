import { describe, expect, it } from "vitest";
import {
  getClientIp,
  isClientIpAllowed,
  isUnrestrictedIpAcl,
  normalizeIp,
  normalizeIpAclForStorage,
  splitIpAclRules,
  validateIpAcl,
} from "../src/utils/ipAcl";

describe("ipAcl", () => {
  it("treats empty, 0.0.0.0/0 and ::/0 as unrestricted", () => {
    expect(isUnrestrictedIpAcl("")).toBe(true);
    expect(isUnrestrictedIpAcl(null)).toBe(true);
    expect(isUnrestrictedIpAcl(undefined)).toBe(true);
    expect(isUnrestrictedIpAcl("   ")).toBe(true);
    expect(isUnrestrictedIpAcl("0.0.0.0/0")).toBe(true);
    expect(isUnrestrictedIpAcl("::/0")).toBe(true);
    expect(isUnrestrictedIpAcl("0.0.0.0/0, ::/0")).toBe(true);
    expect(isUnrestrictedIpAcl("*")).toBe(true);
    expect(isClientIpAllowed("203.0.113.10", "")).toBe(true);
    expect(isClientIpAllowed("203.0.113.10", null)).toBe(true);
    expect(isClientIpAllowed("203.0.113.10", undefined)).toBe(true);
    expect(isClientIpAllowed("203.0.113.10", "0.0.0.0/0")).toBe(true);
    expect(isClientIpAllowed("2001:db8::1", "0.0.0.0/0")).toBe(true);
    expect(isClientIpAllowed("2001:db8::1", "::/0")).toBe(true);
  });

  it("splits comma, semicolon and newline separated rules", () => {
    expect(splitIpAclRules("192.168.1.1, 10.0.0.1;172.16.0.0/12\n1.2.3.4")).toEqual([
      "192.168.1.1",
      "10.0.0.1",
      "172.16.0.0/12",
      "1.2.3.4",
    ]);
  });

  it("allows any listed exact IPv4", () => {
    const rules = "1.2.3.4, 10.0.0.1";
    expect(isClientIpAllowed("1.2.3.4", rules)).toBe(true);
    expect(isClientIpAllowed("10.0.0.1", rules)).toBe(true);
    expect(isClientIpAllowed("8.8.8.8", rules)).toBe(false);
  });

  it("allows any entry in a comma-separated mix of CIDR and exact IPs", () => {
    const rules = "192.168.1.0/24, 10.0.0.1, 203.0.113.195";
    expect(isClientIpAllowed("192.168.1.50", rules)).toBe(true);
    expect(isClientIpAllowed("10.0.0.1", rules)).toBe(true);
    expect(isClientIpAllowed("203.0.113.195", rules)).toBe(true);
    expect(isClientIpAllowed("8.8.8.8", rules)).toBe(false);
  });

  it("matches CIDR subnets", () => {
    expect(isClientIpAllowed("192.168.1.100", "192.168.1.0/24")).toBe(true);
    expect(isClientIpAllowed("192.168.2.1", "192.168.1.0/24")).toBe(false);
    expect(isClientIpAllowed("2001:db8:ffff::1", "2001:db8::/32")).toBe(true);
    expect(isClientIpAllowed("2001:db9::1", "2001:db8::/32")).toBe(false);
  });

  it("normalizes IPv4-mapped IPv6 addresses", () => {
    expect(normalizeIp("::ffff:192.168.1.5")).toBe("192.168.1.5");
    expect(normalizeIp("::FFFF:192.168.1.5")).toBe("192.168.1.5");
    expect(isClientIpAllowed("::ffff:192.168.1.5", "192.168.1.0/24")).toBe(true);
  });

  it("rejects invalid tokens on save", () => {
    expect(validateIpAcl("999.999.1.1").ok).toBe(false);
    expect(validateIpAcl("10.0.0.0/35").ok).toBe(false);
    expect(validateIpAcl("192.168.1.0/24, not-an-ip").ok).toBe(false);
    expect(validateIpAcl("1.2.3.4, 10.0.0.0/8").ok).toBe(true);
  });

  it("matches inclusive IPv4 ranges", () => {
    expect(isClientIpAllowed("10.0.0.5", "10.0.0.1-10.0.0.10")).toBe(true);
    expect(isClientIpAllowed("10.0.0.11", "10.0.0.1-10.0.0.10")).toBe(false);
  });

  it("does not throw when Fastify request has no ip or socket", () => {
    expect(getClientIp(undefined)).toBe("");
    expect(getClientIp({} as any)).toBe("");
    expect(getClientIp({ ip: "203.0.113.10" } as any)).toBe("203.0.113.10");
  });

  it("stores unrestricted values as null", () => {
    expect(normalizeIpAclForStorage("")).toBeNull();
    expect(normalizeIpAclForStorage("0.0.0.0/0")).toBeNull();
    expect(normalizeIpAclForStorage("  192.168.1.0/24, 10.0.0.1  ")).toBe(
      "192.168.1.0/24, 10.0.0.1",
    );
  });
});

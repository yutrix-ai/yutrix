import { describe, it, expect } from "vitest";
import { decodeValue, encodeValue, transformRow } from "../src/db/copy/codec";
import { ReflectedColumn } from "../src/db/copy/reflect";

describe("Slice P1: Codec Unit Tests", () => {
  describe("bool logicalType", () => {
    it("decodes and encodes 0/1, strings, and booleans accurately", () => {
      expect(decodeValue(1, "bool")).toBe(true);
      expect(decodeValue(0, "bool")).toBe(false);
      expect(decodeValue("1", "bool")).toBe(true);
      expect(decodeValue("0", "bool")).toBe(false);
      expect(decodeValue("true", "bool")).toBe(true);
      expect(decodeValue("false", "bool")).toBe(false);
      expect(decodeValue(true, "bool")).toBe(true);
      expect(decodeValue(false, "bool")).toBe(false);
      expect(decodeValue(null, "bool")).toBeNull();

      expect(encodeValue(true, "bool")).toBe(true);
      expect(encodeValue(false, "bool")).toBe(false);
      expect(encodeValue(null, "bool")).toBeNull();
    });
  });

  describe("unix_seconds logicalType", () => {
    it("normalizes Date objects and millisecond timestamps to identical unix seconds", () => {
      const fixedDate = new Date("2026-09-03T00:00:00.000Z");
      const expectedSeconds = Math.floor(fixedDate.getTime() / 1000);

      // Date object
      expect(decodeValue(fixedDate, "unix_seconds")).toBe(expectedSeconds);

      // Millisecond timestamp
      expect(decodeValue(fixedDate.getTime(), "unix_seconds")).toBe(expectedSeconds);

      // Unix seconds timestamp
      expect(decodeValue(expectedSeconds, "unix_seconds")).toBe(expectedSeconds);

      // String timestamp
      expect(decodeValue(String(expectedSeconds), "unix_seconds")).toBe(expectedSeconds);

      // Null handling
      expect(decodeValue(null, "unix_seconds")).toBeNull();

      // Encode value yields number (for bigint mode number)
      expect(encodeValue(expectedSeconds, "unix_seconds")).toBe(expectedSeconds);
      expect(typeof encodeValue(expectedSeconds, "unix_seconds")).toBe("number");
    });
  });

  describe("json_text logicalType", () => {
    it("preserves raw JSON text without parsing", () => {
      const jsonStr = '{"model":"gpt-4o","routing":{"strategy":"weighted","weights":{"p1":80,"p2":20}}}';
      const decoded = decodeValue(jsonStr, "json_text");
      expect(decoded).toBe(jsonStr);
      expect(typeof decoded).toBe("string");

      const encoded = encodeValue(decoded, "json_text");
      expect(encoded).toBe(jsonStr);
      expect(typeof encoded).toBe("string");

      // Object stringification if already parsed
      const obj = { key: "val" };
      expect(decodeValue(obj, "json_text")).toBe(JSON.stringify(obj));
    });
  });

  describe("ciphertext & text logicalType", () => {
    it("copies encrypted text byte-for-byte without mutation", () => {
      const encrypted = "v1:enc:7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a";
      const decoded = decodeValue(encrypted, "text");
      expect(decoded).toBe(encrypted);
      expect(encodeValue(decoded, "text")).toBe(encrypted);
    });
  });

  describe("int and real logicalTypes", () => {
    it("handles integers and floats properly", () => {
      expect(decodeValue(42, "int")).toBe(42);
      expect(decodeValue("42", "int")).toBe(42);
      expect(decodeValue(3.14159, "real")).toBeCloseTo(3.14159);
      expect(decodeValue("3.14159", "real")).toBeCloseTo(3.14159);
    });
  });

  describe("transformRow", () => {
    it("transforms a complete row according to reflected columns", () => {
      const columns: ReflectedColumn[] = [
        { name: "id", propName: "id", logicalType: "text" },
        { name: "enabled", propName: "enabled", logicalType: "bool" },
        { name: "created_at", propName: "createdAt", logicalType: "unix_seconds" },
        { name: "config_json", propName: "configJson", logicalType: "json_text" },
      ];

      const rawRow = {
        id: "test-uuid-1234",
        enabled: 1,
        createdAt: 1788400000,
        configJson: '{"key":"value"}',
      };

      const transformed = transformRow(rawRow, columns);

      expect(transformed).toEqual({
        id: "test-uuid-1234",
        enabled: true,
        created_at: 1788400000,
        config_json: '{"key":"value"}',
      });
    });
  });
});

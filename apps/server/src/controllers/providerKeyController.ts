import { FastifyRequest, FastifyReply } from "fastify";
import { db } from "../db";
import { providerApiKeys } from "../db/schema";
import { eq, and } from "drizzle-orm";
import crypto from "crypto";
import { encryptText, decryptText } from "../utils/crypto";
import {
  maskApiKey,
  isMaskedApiKey,
} from "../services/providerService";

export const getProviderKeys = async (request: FastifyRequest, reply: FastifyReply) => {
      const { providerId } = request.params as any;
      const keys = await db.select().from(providerApiKeys).where(eq(providerApiKeys.providerId, providerId));
      return keys.map((k: any) => ({
        id: k.id,
        providerId: k.providerId,
        keyMasked: maskApiKey(decryptText(k.keyEncrypted)),
        status: k.status,
        createdAt: k.createdAt,
        updatedAt: k.updatedAt,
        lastUsedAt: k.lastUsedAt,
      }));
    };

export const createProviderKey = async (request: FastifyRequest, reply: FastifyReply) => {
      const { providerId } = request.params as any;
      const { apiKey } = request.body as any;
      if (!apiKey || isMaskedApiKey(apiKey)) return reply.code(400).send({ error: "Invalid API Key" });

      const newId = crypto.randomUUID();
      await db.insert(providerApiKeys).values({
        id: newId,
        providerId,
        keyEncrypted: encryptText(apiKey),
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return { success: true, id: newId };
    };

export const updateProviderKey = async (request: FastifyRequest, reply: FastifyReply) => {
      const { providerId, keyId } = request.params as any;
      const { status } = request.body as any;

      await db.update(providerApiKeys)
        .set({ status, updatedAt: new Date() })
        .where(and(eq(providerApiKeys.id, keyId), eq(providerApiKeys.providerId, providerId)));

      return { success: true };
    };

export const deleteProviderKey = async (request: FastifyRequest, reply: FastifyReply) => {
      const { providerId, keyId } = request.params as any;

      await db.delete(providerApiKeys)
        .where(and(eq(providerApiKeys.id, keyId), eq(providerApiKeys.providerId, providerId)));

      return { success: true };
    };

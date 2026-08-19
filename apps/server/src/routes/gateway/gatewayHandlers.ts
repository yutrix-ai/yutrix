import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import crypto from "crypto";
import { db } from "../../db";
import { apiKeys, providers, providerModels, systemSettings, providerApiKeys } from "../../db/schema";
import { eq, and } from "drizzle-orm";
import { decryptText } from "../../utils/crypto";
import { logAction } from "../../utils/actionLogger";
import { estimateMultimodalInputUsage } from "./inputTokenLimit";
import { logEmitter } from "../../utils/events";
import { detectAIClient } from "../../utils/chatTurns";
import {
  formatError,
  truncateErrorDetail,
  stringifyErrorPayload,
  describeFetchError,
  describeGatewayErrorPayload,
} from "../../utils/gatewayError";
import {
  UsageLogValues,
  resolveUsageForLog,
  extractPromptText,
} from "../../utils/gatewayContent";
import { updateRequestLog } from "../../services/requestLogService";

// Gateway sub-modules
import { createStreamAccumulator } from "./types";
import type { GatewayRequestContext, UpstreamResponseData } from "./types";
import { extractAndValidateApiKey } from "./auth";
import { resolveSubdomain, resolveEndpointAndRoute } from "./routing";
import {
  checkRouteAuthorization,
  createBaseActionLog,
  createInitialAttemptState,
  resolveUserRouteOverride,
} from "./authorization";
import { transformRequestBody, applyPromptPolicy } from "./payload";
import { adaptRequestProtocol, adaptNonStreamResponse } from "./protocolAdapter";
import {
  buildUpstreamHeaders,
  determineUpstreamPath,
  executeUpstreamFetch,
} from "./upstream";
import { forwardStream } from "./streaming";
import {
  buildBaseLog,
  insertInitialRequestLog,
  finalizeStreamLog,
  isAuditExemptUser,
  emitAuditEvent,
  appendRoutingTraceToOutput,
  extractClientSessionId,
} from "./logging";
import { getGlobalQueue, getApiKeyQueue, getProviderQueue } from "./concurrency";
import { globalSessionQueueManager, SessionQueueTimeoutError } from "./sessionQueueManager";
import { checkConcurrencyFallback, checkErrorFallback } from "./fallback";
import { modelsHandler } from "./models";
import { executeGatewayRequest } from "./gatewayExecutor";
import { resolveEffectiveMaxInputTokens } from "../../services/userTokenLimits";

export const proxyHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const startTime = Date.now();

    // --- 1. Auth ---
    const reqPath = request.url.split("?")[0];

    if (reqPath === "/v1/messages/count_tokens" || reqPath === "/v0/messages/count_tokens") {
      const body: any = request.body || {};
      const tokenEst = await estimateMultimodalInputUsage({ body, modelId: body.model || "default" });
      return reply.code(200).send({
        type: "message_tokens_count",
        input_tokens: tokenEst.totalTokens,
      });
    }

    let incomingProtocol = "openai";
    if (reqPath === "/v1/messages" || reqPath === "/v0/messages" || reqPath === "/v1/complete") {
      incomingProtocol = "anthropic";
    }

    const authCtx = await extractAndValidateApiKey(request, reply, incomingProtocol);
    if (!authCtx) return;

    // --- 2. Routing ---
    const subdomainResult = await resolveSubdomain(request.hostname, incomingProtocol, reply);
    if (!subdomainResult) return;

    const routeResult = await resolveEndpointAndRoute(
      reqPath,
      incomingProtocol,
      subdomainResult.subdomainRecord,
      subdomainResult.allowFallback,
      reply,
      request.log,
    );
    if (!routeResult) return;

    const { endpoint, route } = routeResult;
    const body: any = request.body || {};

    // --- 3. Authorization ---
    const authzResult = await checkRouteAuthorization(
      authCtx.userId,
      authCtx.apiKeyRecord,
      route,
      incomingProtocol,
      reply,
      request,
    );
    if (!authzResult) return;

    const baseActionLog = createBaseActionLog(
      authCtx,
      { incomingProtocol, reqPath, endpoint, route, subdomainRecord: subdomainResult.subdomainRecord },
      request.hostname,
      authzResult.username,
      authzResult.clientIp,
    );

    let currentAttempt = createInitialAttemptState(route);
    // Pass client-requested model for Client Override mode (L0 name match / General)
    await resolveUserRouteOverride(
      authCtx.userId,
      route,
      currentAttempt,
      baseActionLog,
      typeof body?.model === "string" ? body.model : null,
    );

    // --- 5. Request State Init ---
    let attemptCount = 0;
    let parsedTargets: any[] = [];
    if (route.targets) {
      try {
        parsedTargets = typeof route.targets === 'string' ? JSON.parse(route.targets) : route.targets;
      } catch (e) {}
    } else {
      parsedTargets = [1];
      if (route.fallbackEnabled) parsedTargets.push(1);
    }
    const maxAttempts =
      (route.retryCount ?? 0) + Math.max(1, parsedTargets.length);
    let responseData: any = null;
    let activeModelConfig: any = null;
    const reqLogId = crypto.randomUUID();
    let isLogInserted = false;
    let isStreaming = false;
    let clientDisconnected = false;
    let streamLogFinalized = false;
    let activeProvider: any = null;
    if (currentAttempt.providerId) {
      const providerList = await db.select().from(providers).where(eq(providers.id, currentAttempt.providerId));
      activeProvider = providerList[0] || null;
    }
    const multimodalEst = await estimateMultimodalInputUsage({ body });
    const estimatedPromptTokens = multimodalEst.totalTokens;
    let usageRequestBody: any = body;
    const inputTokenLimit = await resolveEffectiveMaxInputTokens(authCtx.userId);

    const calculateCostForTokens = (inputTokens: number, outputTokens: number) => {
      // @ts-ignore - ctx will be initialized before this is called
      if (!ctx || !ctx.activeModelConfig) return null;
      const inputPrice = ctx.activeModelConfig.inputTokenPricePerM;
      const outputPrice = ctx.activeModelConfig.outputTokenPricePerM;
      if (inputPrice === null || inputPrice === undefined || outputPrice === null || outputPrice === undefined) {
        return null;
      }
      return (inputTokens * inputPrice / 1000000) + (outputTokens * outputPrice / 1000000);
    };

    // Build GatewayRequestContext for sub-modules
    const ctx: GatewayRequestContext = {
      request,
      reply,
      body,
      startTime,
      auth: authCtx,
      routing: { incomingProtocol, reqPath, endpoint, route, subdomainRecord: subdomainResult.subdomainRecord },
      currentAttempt,
      baseActionLog,
      username: authzResult.username,
      userRole: authzResult.userRole,
      reqLogId,
      isLogInserted,
      isStreaming,
      activeModelConfig,
      activeProvider,
      usageRequestBody,
      clientDisconnected,
      streamLogFinalized,
      routingTrace: [],
      inputTokenLimit,
      stream: { ...createStreamAccumulator(), estimatedPromptTokens },
      continuity: {
        accumulatedCompletionText: "",
        hiddenContinuityText: "",
        forwardedStreamText: "",
        promptTokens: 0,
        completionTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        usageStatus: "success",
        committedRoundIds: new Set<string>(),
        isLastCycle: false,
        hasStartedContinuity: false,
        hasForwardedStreamMaterial: false,
        streamRoundCount: 1,
      } as any,
      calculateCostForTokens,
    };

    // --- 6. Abort/Disconnect Handling ---
    const controller = new AbortController();
    const abortUpstream = () => {
      if (controller.signal.aborted) return;
      clientDisconnected = true;
      ctx.clientDisconnected = true;
      controller.abort();
    };
    const abortOnRequestClose = () => {
      if (request.raw.aborted) abortUpstream();
    };
    const abortOnReplyClose = () => {
      if (!reply.raw.writableEnded) abortUpstream();
    };
    request.raw.on("aborted", abortUpstream);
    request.raw.on("close", abortOnRequestClose);
    reply.raw.on("close", abortOnReplyClose);

    logAction({ ...baseActionLog, level: "INFO", code: "request.started" });

    // --- 7. Session Queueing & Concurrency Queues ---
    const clientSessionId = extractClientSessionId(request, body);
    let sessionLock: { release: () => void } | null = null;

    if (clientSessionId) {
      try {
        sessionLock = await globalSessionQueueManager.acquireLock(clientSessionId);
      } catch (err: any) {
        if (err instanceof SessionQueueTimeoutError || err?.message?.includes("capacity exceeded")) {
          return reply.code(429).send({
            error: {
              message: err.message || "Session concurrency queue timeout",
              type: "session_concurrency_error",
              code: "session_busy",
            },
          });
        }
        throw err;
      }
    }

    let isSessionLockReleased = false;
    const releaseSessionLock = () => {
      if (sessionLock && !isSessionLockReleased) {
        isSessionLockReleased = true;
        sessionLock.release();
      }
    };

    reply.raw.on("finish", releaseSessionLock);
    reply.raw.on("close", releaseSessionLock);

    const processQueue = await getGlobalQueue();
    const userQueue = getApiKeyQueue(authCtx.apiKeyRecord.id, authCtx.apiKeyRecord.concurrencyLimit);
    const triedKeys = new Set<string>();

    const abortHandlers = { abortUpstream, abortOnRequestClose, abortOnReplyClose };
    try {
      await executeGatewayRequest(ctx, controller, maxAttempts, logAction, abortHandlers);
    } finally {
      if (reply.raw.writableEnded) {
        releaseSessionLock();
      }
    }
};

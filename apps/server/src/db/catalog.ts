/**
 * catalog.ts — Canonical metadata catalog for logical database tables and columns.
 * Single source of truth defining logical data types for SQLite/PostgreSQL symmetry.
 *
 * Types per PRD §8:
 * - text: string / UUID / secret text
 * - int: 32-bit integer
 * - real: floating point number (double precision in PG)
 * - bool: boolean flag (0/1 in SQLite, native boolean in PG)
 * - unix_seconds: unix epoch timestamp in seconds (integer in SQLite, bigint with mode "number" in PG)
 * - json_text: raw JSON stored as TEXT without JSONB parsing
 */

export type LogicalType =
  | "text"
  | "int"
  | "real"
  | "bool"
  | "unix_seconds"
  | "json_text";

export interface CatalogColumn {
  name: string;
  propName: string;
  logicalType: LogicalType;
  primaryKey?: boolean;
  notNull?: boolean;
  default?: any;
}

export interface CatalogTable {
  exportName: string;
  tableName: string;
  columns: Record<string, CatalogColumn>;
}

export const CATALOG: Record<string, CatalogTable> = {
  "action_logs": {
    exportName: "actionLogs",
    tableName: "action_logs",
    columns: {
      "id": {
        name: "id",
        propName: "id",
        logicalType: "text",
        primaryKey: true,
        notNull: true,
      },
      "timestamp": {
        name: "timestamp",
        propName: "timestamp",
        logicalType: "text",
        notNull: true,
      },
      "level": {
        name: "level",
        propName: "level",
        logicalType: "text",
        notNull: true,
      },
      "code": {
        name: "code",
        propName: "code",
        logicalType: "text",
        notNull: true,
      },
      "serverLine": {
        name: "serverLine",
        propName: "serverLine",
        logicalType: "text",
        notNull: true,
      },
      "ip": {
        name: "ip",
        propName: "ip",
        logicalType: "text",
      },
      "params": {
        name: "params",
        propName: "params",
        logicalType: "text",
      },
      "createdAt": {
        name: "createdAt",
        propName: "createdAt",
        logicalType: "unix_seconds",
        notNull: true,
      },
    },
  },
  "api_keys": {
    exportName: "apiKeys",
    tableName: "api_keys",
    columns: {
      "id": {
        name: "id",
        propName: "id",
        logicalType: "text",
        primaryKey: true,
        notNull: true,
      },
      "userId": {
        name: "userId",
        propName: "userId",
        logicalType: "text",
        notNull: true,
      },
      "name": {
        name: "name",
        propName: "name",
        logicalType: "text",
        notNull: true,
      },
      "keyHash": {
        name: "keyHash",
        propName: "keyHash",
        logicalType: "text",
        notNull: true,
      },
      "keyPrefix": {
        name: "keyPrefix",
        propName: "keyPrefix",
        logicalType: "text",
        notNull: true,
      },
      "status": {
        name: "status",
        propName: "status",
        logicalType: "text",
        notNull: true,
        default: "active",
      },
      "rpmLimit": {
        name: "rpmLimit",
        propName: "rpmLimit",
        logicalType: "int",
      },
      "tpmLimit": {
        name: "tpmLimit",
        propName: "tpmLimit",
        logicalType: "int",
      },
      "concurrencyLimit": {
        name: "concurrencyLimit",
        propName: "concurrencyLimit",
        logicalType: "int",
        notNull: true,
        default: 10,
      },
      "expiresAt": {
        name: "expiresAt",
        propName: "expiresAt",
        logicalType: "unix_seconds",
      },
      "createdAt": {
        name: "createdAt",
        propName: "createdAt",
        logicalType: "unix_seconds",
        notNull: true,
      },
      "lastUsedAt": {
        name: "lastUsedAt",
        propName: "lastUsedAt",
        logicalType: "unix_seconds",
      },
    },
  },
  "chat_logs": {
    exportName: "chatLogs",
    tableName: "chat_logs",
    columns: {
      "id": {
        name: "id",
        propName: "id",
        logicalType: "text",
        primaryKey: true,
        notNull: true,
      },
      "requestId": {
        name: "requestId",
        propName: "requestId",
        logicalType: "text",
      },
      "serverSessionId": {
        name: "serverSessionId",
        propName: "serverSessionId",
        logicalType: "text",
      },
      "clientSessionId": {
        name: "clientSessionId",
        propName: "clientSessionId",
        logicalType: "text",
      },
      "turnId": {
        name: "turnId",
        propName: "turnId",
        logicalType: "int",
        notNull: true,
        default: 0,
      },
      "userId": {
        name: "userId",
        propName: "userId",
        logicalType: "text",
        notNull: true,
      },
      "clientName": {
        name: "clientName",
        propName: "clientName",
        logicalType: "text",
      },
      "detectedClient": {
        name: "detectedClient",
        propName: "detectedClient",
        logicalType: "text",
      },
      "model": {
        name: "model",
        propName: "model",
        logicalType: "text",
      },
      "inputText": {
        name: "inputText",
        propName: "inputText",
        logicalType: "text",
      },
      "outputText": {
        name: "outputText",
        propName: "outputText",
        logicalType: "text",
      },
      "responseHash": {
        name: "responseHash",
        propName: "responseHash",
        logicalType: "text",
      },
      "conversationRootHash": {
        name: "conversationRootHash",
        propName: "conversationRootHash",
        logicalType: "text",
      },
      "inputTokens": {
        name: "inputTokens",
        propName: "inputTokens",
        logicalType: "int",
        default: 0,
      },
      "outputTokens": {
        name: "outputTokens",
        propName: "outputTokens",
        logicalType: "int",
        default: 0,
      },
      "latencyMs": {
        name: "latencyMs",
        propName: "latencyMs",
        logicalType: "int",
        default: 0,
      },
      "ttft_ms": {
        name: "ttft_ms",
        propName: "ttftMs",
        logicalType: "int",
      },
      "cached_tokens": {
        name: "cached_tokens",
        propName: "cachedTokens",
        logicalType: "int",
        default: 0,
      },
      "is_aborted": {
        name: "is_aborted",
        propName: "isAborted",
        logicalType: "bool",
        default: false,
      },
      "status": {
        name: "status",
        propName: "status",
        logicalType: "text",
        default: "success",
      },
      "error": {
        name: "error",
        propName: "error",
        logicalType: "text",
      },
      "sessionTitle": {
        name: "sessionTitle",
        propName: "sessionTitle",
        logicalType: "text",
      },
      "createdAt": {
        name: "createdAt",
        propName: "createdAt",
        logicalType: "unix_seconds",
        notNull: true,
      },
    },
  },
  "distillation_job_items": {
    exportName: "distillationJobItems",
    tableName: "distillation_job_items",
    columns: {
      "id": {
        name: "id",
        propName: "id",
        logicalType: "text",
        primaryKey: true,
        notNull: true,
      },
      "jobId": {
        name: "jobId",
        propName: "jobId",
        logicalType: "text",
        notNull: true,
      },
      "chatLogId": {
        name: "chatLogId",
        propName: "chatLogId",
        logicalType: "text",
        notNull: true,
      },
      "userId": {
        name: "userId",
        propName: "userId",
        logicalType: "text",
        notNull: true,
      },
      "status": {
        name: "status",
        propName: "status",
        logicalType: "text",
        notNull: true,
        default: "pending",
      },
      "errorMessage": {
        name: "errorMessage",
        propName: "errorMessage",
        logicalType: "text",
      },
      "processedAt": {
        name: "processedAt",
        propName: "processedAt",
        logicalType: "unix_seconds",
      },
      "createdAt": {
        name: "createdAt",
        propName: "createdAt",
        logicalType: "unix_seconds",
        notNull: true,
      },
    },
  },
  "distillation_jobs": {
    exportName: "distillationJobs",
    tableName: "distillation_jobs",
    columns: {
      "id": {
        name: "id",
        propName: "id",
        logicalType: "text",
        primaryKey: true,
        notNull: true,
      },
      "mode": {
        name: "mode",
        propName: "mode",
        logicalType: "text",
        notNull: true,
      },
      "status": {
        name: "status",
        propName: "status",
        logicalType: "text",
        notNull: true,
        default: "pending",
      },
      "analysisRouteId": {
        name: "analysisRouteId",
        propName: "analysisRouteId",
        logicalType: "text",
      },
      "userIdsFilter": {
        name: "userIdsFilter",
        propName: "userIdsFilter",
        logicalType: "json_text",
      },
      "timeRangeStart": {
        name: "timeRangeStart",
        propName: "timeRangeStart",
        logicalType: "unix_seconds",
      },
      "timeRangeEnd": {
        name: "timeRangeEnd",
        propName: "timeRangeEnd",
        logicalType: "unix_seconds",
      },
      "maxRecords": {
        name: "maxRecords",
        propName: "maxRecords",
        logicalType: "int",
      },
      "totalItems": {
        name: "totalItems",
        propName: "totalItems",
        logicalType: "int",
        notNull: true,
        default: 0,
      },
      "processedItems": {
        name: "processedItems",
        propName: "processedItems",
        logicalType: "int",
        notNull: true,
        default: 0,
      },
      "failedItems": {
        name: "failedItems",
        propName: "failedItems",
        logicalType: "int",
        notNull: true,
        default: 0,
      },
      "errorMessage": {
        name: "errorMessage",
        propName: "errorMessage",
        logicalType: "text",
      },
      "generationId": {
        name: "generationId",
        propName: "generationId",
        logicalType: "text",
        notNull: true,
      },
      "startedAt": {
        name: "startedAt",
        propName: "startedAt",
        logicalType: "unix_seconds",
      },
      "completedAt": {
        name: "completedAt",
        propName: "completedAt",
        logicalType: "unix_seconds",
      },
      "createdAt": {
        name: "createdAt",
        propName: "createdAt",
        logicalType: "unix_seconds",
        notNull: true,
      },
    },
  },
  "distillation_learned_records": {
    exportName: "distillationLearnedRecords",
    tableName: "distillation_learned_records",
    columns: {
      "chatLogId": {
        name: "chatLogId",
        propName: "chatLogId",
        logicalType: "text",
        primaryKey: true,
        notNull: true,
      },
      "jobId": {
        name: "jobId",
        propName: "jobId",
        logicalType: "text",
        notNull: true,
      },
      "generationId": {
        name: "generationId",
        propName: "generationId",
        logicalType: "text",
        notNull: true,
      },
      "learnedAt": {
        name: "learnedAt",
        propName: "learnedAt",
        logicalType: "unix_seconds",
        notNull: true,
      },
    },
  },
  "distillation_routing_proposals": {
    exportName: "distillationRoutingProposals",
    tableName: "distillation_routing_proposals",
    columns: {
      "id": {
        name: "id",
        propName: "id",
        logicalType: "text",
        primaryKey: true,
        notNull: true,
      },
      "jobId": {
        name: "jobId",
        propName: "jobId",
        logicalType: "text",
        notNull: true,
      },
      "chatLogId": {
        name: "chatLogId",
        propName: "chatLogId",
        logicalType: "text",
      },
      "sourceUserId": {
        name: "sourceUserId",
        propName: "sourceUserId",
        logicalType: "text",
      },
      "status": {
        name: "status",
        propName: "status",
        logicalType: "text",
        notNull: true,
        default: "draft",
      },
      "payload": {
        name: "payload",
        propName: "payload",
        logicalType: "json_text",
        notNull: true,
      },
      "validationResult": {
        name: "validationResult",
        propName: "validationResult",
        logicalType: "text",
      },
      "createdAt": {
        name: "createdAt",
        propName: "createdAt",
        logicalType: "unix_seconds",
        notNull: true,
      },
    },
  },
  "distillation_signal_versions": {
    exportName: "distillationSignalVersions",
    tableName: "distillation_signal_versions",
    columns: {
      "id": {
        name: "id",
        propName: "id",
        logicalType: "text",
        primaryKey: true,
        notNull: true,
      },
      "versionLabel": {
        name: "versionLabel",
        propName: "versionLabel",
        logicalType: "text",
        notNull: true,
      },
      "weightOverrides": {
        name: "weightOverrides",
        propName: "weightOverrides",
        logicalType: "json_text",
        notNull: true,
      },
      "boundaryRules": {
        name: "boundaryRules",
        propName: "boundaryRules",
        logicalType: "json_text",
        notNull: true,
      },
      "proposalIds": {
        name: "proposalIds",
        propName: "proposalIds",
        logicalType: "json_text",
        notNull: true,
      },
      "isActive": {
        name: "isActive",
        propName: "isActive",
        logicalType: "bool",
        notNull: true,
        default: false,
      },
      "createdAt": {
        name: "createdAt",
        propName: "createdAt",
        logicalType: "unix_seconds",
        notNull: true,
      },
    },
  },
  "distillation_skill_packages": {
    exportName: "distillationSkillPackages",
    tableName: "distillation_skill_packages",
    columns: {
      "id": {
        name: "id",
        propName: "id",
        logicalType: "text",
        primaryKey: true,
        notNull: true,
      },
      "userId": {
        name: "userId",
        propName: "userId",
        logicalType: "text",
        notNull: true,
      },
      "username": {
        name: "username",
        propName: "username",
        logicalType: "text",
        notNull: true,
      },
      "version": {
        name: "version",
        propName: "version",
        logicalType: "int",
        notNull: true,
      },
      "status": {
        name: "status",
        propName: "status",
        logicalType: "text",
        notNull: true,
        default: "draft",
      },
      "files": {
        name: "files",
        propName: "files",
        logicalType: "json_text",
        notNull: true,
      },
      "sourceRecordCount": {
        name: "sourceRecordCount",
        propName: "sourceRecordCount",
        logicalType: "int",
        notNull: true,
        default: 0,
      },
      "jobId": {
        name: "jobId",
        propName: "jobId",
        logicalType: "text",
      },
      "createdAt": {
        name: "createdAt",
        propName: "createdAt",
        logicalType: "unix_seconds",
        notNull: true,
      },
    },
  },
  "endpoint_routes": {
    exportName: "endpointRoutes",
    tableName: "endpoint_routes",
    columns: {
      "id": {
        name: "id",
        propName: "id",
        logicalType: "text",
        primaryKey: true,
        notNull: true,
      },
      "name": {
        name: "name",
        propName: "name",
        logicalType: "text",
        default: "",
      },
      "endpointId": {
        name: "endpointId",
        propName: "endpointId",
        logicalType: "text",
        notNull: true,
      },
      "subdomainId": {
        name: "subdomainId",
        propName: "subdomainId",
        logicalType: "text",
      },
      "providerId": {
        name: "providerId",
        propName: "providerId",
        logicalType: "text",
        notNull: true,
      },
      "providerProtocol": {
        name: "providerProtocol",
        propName: "providerProtocol",
        logicalType: "text",
        notNull: true,
        default: "openai",
      },
      "modelId": {
        name: "modelId",
        propName: "modelId",
        logicalType: "text",
        notNull: true,
      },
      "enabled": {
        name: "enabled",
        propName: "enabled",
        logicalType: "bool",
        notNull: true,
        default: true,
      },
      "promptPolicyId": {
        name: "promptPolicyId",
        propName: "promptPolicyId",
        logicalType: "text",
      },
      "fallbackEnabled": {
        name: "fallbackEnabled",
        propName: "fallbackEnabled",
        logicalType: "bool",
        notNull: true,
        default: false,
      },
      "retryCount": {
        name: "retryCount",
        propName: "retryCount",
        logicalType: "int",
        notNull: true,
        default: 3,
      },
      "fallbackProviderId": {
        name: "fallbackProviderId",
        propName: "fallbackProviderId",
        logicalType: "text",
      },
      "fallbackProviderProtocol": {
        name: "fallbackProviderProtocol",
        propName: "fallbackProviderProtocol",
        logicalType: "text",
      },
      "fallbackModelId": {
        name: "fallbackModelId",
        propName: "fallbackModelId",
        logicalType: "text",
      },
      "fallbackPromptPolicyId": {
        name: "fallbackPromptPolicyId",
        propName: "fallbackPromptPolicyId",
        logicalType: "text",
      },
      "fallbackMatchTarget": {
        name: "fallbackMatchTarget",
        propName: "fallbackMatchTarget",
        logicalType: "bool",
        notNull: true,
        default: false,
      },
      "fallbackStrategyRoutingEnabled": {
        name: "fallbackStrategyRoutingEnabled",
        propName: "fallbackStrategyRoutingEnabled",
        logicalType: "bool",
        notNull: true,
        default: false,
      },
      "fallbackStrategyRoutingRules": {
        name: "fallbackStrategyRoutingRules",
        propName: "fallbackStrategyRoutingRules",
        logicalType: "json_text",
      },
      "strategyRoutingEnabled": {
        name: "strategyRoutingEnabled",
        propName: "strategyRoutingEnabled",
        logicalType: "bool",
        notNull: true,
        default: false,
      },
      "strategyRoutingRules": {
        name: "strategyRoutingRules",
        propName: "strategyRoutingRules",
        logicalType: "json_text",
      },
      "routingMode": {
        name: "routingMode",
        propName: "routingMode",
        logicalType: "text",
        notNull: true,
        default: "strategy",
      },
      "targets": {
        name: "targets",
        propName: "targets",
        logicalType: "json_text",
      },
      "weight": {
        name: "weight",
        propName: "weight",
        logicalType: "int",
        notNull: true,
        default: 1,
      },
      "priority": {
        name: "priority",
        propName: "priority",
        logicalType: "int",
        notNull: true,
        default: 0,
      },
      "status": {
        name: "status",
        propName: "status",
        logicalType: "text",
        default: "active",
      },
      "allowClientModel": {
        name: "allowClientModel",
        propName: "allowClientModel",
        logicalType: "bool",
        notNull: true,
        default: false,
      },
      "schedules": {
        name: "schedules",
        propName: "schedules",
        logicalType: "json_text",
      },
      "ipWhitelist": {
        name: "ipWhitelist",
        propName: "ipWhitelist",
        logicalType: "json_text",
      },
      "timeoutEjectEnabled": {
        name: "timeoutEjectEnabled",
        propName: "timeoutEjectEnabled",
        logicalType: "bool",
        notNull: true,
        default: false,
      },
      "createdAt": {
        name: "createdAt",
        propName: "createdAt",
        logicalType: "unix_seconds",
        notNull: true,
      },
      "updatedAt": {
        name: "updatedAt",
        propName: "updatedAt",
        logicalType: "unix_seconds",
        notNull: true,
      },
    },
  },
  "endpoints": {
    exportName: "endpoints",
    tableName: "endpoints",
    columns: {
      "id": {
        name: "id",
        propName: "id",
        logicalType: "text",
        primaryKey: true,
        notNull: true,
      },
      "userId": {
        name: "userId",
        propName: "userId",
        logicalType: "text",
        notNull: true,
      },
      "name": {
        name: "name",
        propName: "name",
        logicalType: "text",
        default: "",
      },
      "path": {
        name: "path",
        propName: "path",
        logicalType: "text",
        notNull: true,
      },
      "virtualModelAlias": {
        name: "virtualModelAlias",
        propName: "virtualModelAlias",
        logicalType: "text",
      },
      "loadBalanceMode": {
        name: "loadBalanceMode",
        propName: "loadBalanceMode",
        logicalType: "text",
        default: "failover",
      },
      "incomingProtocol": {
        name: "incomingProtocol",
        propName: "incomingProtocol",
        logicalType: "text",
        notNull: true,
        default: "openai",
      },
      "enabled": {
        name: "enabled",
        propName: "enabled",
        logicalType: "bool",
        notNull: true,
        default: true,
      },
      "timeoutMs": {
        name: "timeoutMs",
        propName: "timeoutMs",
        logicalType: "int",
        notNull: true,
        default: 0,
      },
      "queueTimeoutMs": {
        name: "queueTimeoutMs",
        propName: "queueTimeoutMs",
        logicalType: "int",
        notNull: true,
        default: 0,
      },
      "maxBodyMb": {
        name: "maxBodyMb",
        propName: "maxBodyMb",
        logicalType: "int",
        notNull: true,
        default: 0,
      },
      "status": {
        name: "status",
        propName: "status",
        logicalType: "text",
        default: "active",
      },
      "createdAt": {
        name: "createdAt",
        propName: "createdAt",
        logicalType: "unix_seconds",
        notNull: true,
      },
      "updatedAt": {
        name: "updatedAt",
        propName: "updatedAt",
        logicalType: "unix_seconds",
        notNull: true,
      },
    },
  },
  "invite_codes": {
    exportName: "inviteCodes",
    tableName: "invite_codes",
    columns: {
      "id": {
        name: "id",
        propName: "id",
        logicalType: "text",
        primaryKey: true,
        notNull: true,
      },
      "codeHash": {
        name: "codeHash",
        propName: "codeHash",
        logicalType: "text",
        notNull: true,
      },
      "codePrefix": {
        name: "codePrefix",
        propName: "codePrefix",
        logicalType: "text",
        notNull: true,
      },
      "maxUses": {
        name: "maxUses",
        propName: "maxUses",
        logicalType: "int",
        notNull: true,
        default: 1,
      },
      "usedCount": {
        name: "usedCount",
        propName: "usedCount",
        logicalType: "int",
        notNull: true,
        default: 0,
      },
      "expiresAt": {
        name: "expiresAt",
        propName: "expiresAt",
        logicalType: "unix_seconds",
      },
      "status": {
        name: "status",
        propName: "status",
        logicalType: "text",
        notNull: true,
        default: "active",
      },
      "createdBy": {
        name: "createdBy",
        propName: "createdBy",
        logicalType: "text",
        notNull: true,
      },
      "createdAt": {
        name: "createdAt",
        propName: "createdAt",
        logicalType: "unix_seconds",
        notNull: true,
      },
    },
  },
  "openapi_keys": {
    exportName: "openapiKeys",
    tableName: "openapi_keys",
    columns: {
      "id": {
        name: "id",
        propName: "id",
        logicalType: "text",
        primaryKey: true,
        notNull: true,
      },
      "userId": {
        name: "userId",
        propName: "userId",
        logicalType: "text",
        notNull: true,
      },
      "name": {
        name: "name",
        propName: "name",
        logicalType: "text",
        notNull: true,
      },
      "keyHash": {
        name: "keyHash",
        propName: "keyHash",
        logicalType: "text",
        notNull: true,
      },
      "keyPrefix": {
        name: "keyPrefix",
        propName: "keyPrefix",
        logicalType: "text",
        notNull: true,
      },
      "status": {
        name: "status",
        propName: "status",
        logicalType: "text",
        notNull: true,
        default: "active",
      },
      "createdAt": {
        name: "createdAt",
        propName: "createdAt",
        logicalType: "unix_seconds",
        notNull: true,
      },
      "lastUsedAt": {
        name: "lastUsedAt",
        propName: "lastUsedAt",
        logicalType: "unix_seconds",
      },
    },
  },
  "prompt_injection_records": {
    exportName: "promptInjectionRecords",
    tableName: "prompt_injection_records",
    columns: {
      "id": {
        name: "id",
        propName: "id",
        logicalType: "text",
        primaryKey: true,
        notNull: true,
      },
      "userId": {
        name: "userId",
        propName: "userId",
        logicalType: "text",
        notNull: true,
      },
      "apiKeyId": {
        name: "apiKeyId",
        propName: "apiKeyId",
        logicalType: "text",
        notNull: true,
      },
      "endpointId": {
        name: "endpointId",
        propName: "endpointId",
        logicalType: "text",
      },
      "subdomainId": {
        name: "subdomainId",
        propName: "subdomainId",
        logicalType: "text",
      },
      "promptPolicyId": {
        name: "promptPolicyId",
        propName: "promptPolicyId",
        logicalType: "text",
        notNull: true,
      },
      "conversationId": {
        name: "conversationId",
        propName: "conversationId",
        logicalType: "text",
        notNull: true,
      },
      "contentHash": {
        name: "contentHash",
        propName: "contentHash",
        logicalType: "text",
        notNull: true,
      },
      "createdAt": {
        name: "createdAt",
        propName: "createdAt",
        logicalType: "unix_seconds",
        notNull: true,
      },
    },
  },
  "prompt_policies": {
    exportName: "promptPolicies",
    tableName: "prompt_policies",
    columns: {
      "id": {
        name: "id",
        propName: "id",
        logicalType: "text",
        primaryKey: true,
        notNull: true,
      },
      "userId": {
        name: "userId",
        propName: "userId",
        logicalType: "text",
        notNull: true,
      },
      "name": {
        name: "name",
        propName: "name",
        logicalType: "text",
        notNull: true,
      },
      "protocol": {
        name: "protocol",
        propName: "protocol",
        logicalType: "text",
        notNull: true,
        default: "openai",
      },
      "injectPosition": {
        name: "injectPosition",
        propName: "injectPosition",
        logicalType: "text",
        notNull: true,
        default: "append_system",
      },
      "injectMode": {
        name: "injectMode",
        propName: "injectMode",
        logicalType: "text",
        notNull: true,
        default: "every_request",
      },
      "conversationKeySource": {
        name: "conversationKeySource",
        propName: "conversationKeySource",
        logicalType: "text",
        default: "header",
      },
      "conversationKeyName": {
        name: "conversationKeyName",
        propName: "conversationKeyName",
        logicalType: "text",
        default: "X-Conversation-Id",
      },
      "fallbackMode": {
        name: "fallbackMode",
        propName: "fallbackMode",
        logicalType: "text",
        default: "treat_as_new",
      },
      "content": {
        name: "content",
        propName: "content",
        logicalType: "text",
        notNull: true,
      },
      "version": {
        name: "version",
        propName: "version",
        logicalType: "int",
        notNull: true,
        default: 1,
      },
      "description": {
        name: "description",
        propName: "description",
        logicalType: "text",
      },
      "enabled": {
        name: "enabled",
        propName: "enabled",
        logicalType: "bool",
        default: true,
      },
      "createdAt": {
        name: "createdAt",
        propName: "createdAt",
        logicalType: "unix_seconds",
        notNull: true,
      },
      "updatedAt": {
        name: "updatedAt",
        propName: "updatedAt",
        logicalType: "unix_seconds",
        notNull: true,
      },
    },
  },
  "provider_api_keys": {
    exportName: "providerApiKeys",
    tableName: "provider_api_keys",
    columns: {
      "id": {
        name: "id",
        propName: "id",
        logicalType: "text",
        primaryKey: true,
        notNull: true,
      },
      "providerId": {
        name: "providerId",
        propName: "providerId",
        logicalType: "text",
        notNull: true,
      },
      "keyEncrypted": {
        name: "keyEncrypted",
        propName: "keyEncrypted",
        logicalType: "text",
        notNull: true,
      },
      "status": {
        name: "status",
        propName: "status",
        logicalType: "text",
        notNull: true,
        default: "active",
      },
      "createdAt": {
        name: "createdAt",
        propName: "createdAt",
        logicalType: "unix_seconds",
        notNull: true,
      },
      "updatedAt": {
        name: "updatedAt",
        propName: "updatedAt",
        logicalType: "unix_seconds",
        notNull: true,
      },
      "lastUsedAt": {
        name: "lastUsedAt",
        propName: "lastUsedAt",
        logicalType: "unix_seconds",
      },
    },
  },
  "provider_models": {
    exportName: "providerModels",
    tableName: "provider_models",
    columns: {
      "id": {
        name: "id",
        propName: "id",
        logicalType: "text",
        primaryKey: true,
        notNull: true,
      },
      "providerId": {
        name: "providerId",
        propName: "providerId",
        logicalType: "text",
        notNull: true,
      },
      "modelId": {
        name: "modelId",
        propName: "modelId",
        logicalType: "text",
        notNull: true,
      },
      "displayName": {
        name: "displayName",
        propName: "displayName",
        logicalType: "text",
        notNull: true,
      },
      "rawJson": {
        name: "rawJson",
        propName: "rawJson",
        logicalType: "json_text",
      },
      "enabled": {
        name: "enabled",
        propName: "enabled",
        logicalType: "bool",
        notNull: true,
        default: true,
      },
      "contextWindowTokens": {
        name: "contextWindowTokens",
        propName: "contextWindowTokens",
        logicalType: "int",
      },
      "maxOutputTokens": {
        name: "maxOutputTokens",
        propName: "maxOutputTokens",
        logicalType: "int",
      },
      "inputTokenPricePerM": {
        name: "inputTokenPricePerM",
        propName: "inputTokenPricePerM",
        logicalType: "real",
      },
      "outputTokenPricePerM": {
        name: "outputTokenPricePerM",
        propName: "outputTokenPricePerM",
        logicalType: "real",
      },
      "tokenizerRepo": {
        name: "tokenizerRepo",
        propName: "tokenizerRepo",
        logicalType: "text",
      },
      "alias": {
        name: "alias",
        propName: "alias",
        logicalType: "text",
      },
      "active": {
        name: "active",
        propName: "active",
        logicalType: "bool",
        notNull: true,
        default: true,
      },
      "createdAt": {
        name: "createdAt",
        propName: "createdAt",
        logicalType: "unix_seconds",
        notNull: true,
      },
    },
  },
  "provider_test_sessions": {
    exportName: "providerTestSessions",
    tableName: "provider_test_sessions",
    columns: {
      "id": {
        name: "id",
        propName: "id",
        logicalType: "text",
        primaryKey: true,
        notNull: true,
      },
      "protocol": {
        name: "protocol",
        propName: "protocol",
        logicalType: "text",
        notNull: true,
        default: "openai",
      },
      "baseUrlHash": {
        name: "baseUrlHash",
        propName: "baseUrlHash",
        logicalType: "text",
        notNull: true,
      },
      "apiKeyHash": {
        name: "apiKeyHash",
        propName: "apiKeyHash",
        logicalType: "text",
      },
      "models": {
        name: "models",
        propName: "models",
        logicalType: "json_text",
        notNull: true,
      },
      "expiresAt": {
        name: "expiresAt",
        propName: "expiresAt",
        logicalType: "unix_seconds",
        notNull: true,
      },
      "createdAt": {
        name: "createdAt",
        propName: "createdAt",
        logicalType: "unix_seconds",
        notNull: true,
      },
    },
  },
  "providers": {
    exportName: "providers",
    tableName: "providers",
    columns: {
      "id": {
        name: "id",
        propName: "id",
        logicalType: "text",
        primaryKey: true,
        notNull: true,
      },
      "name": {
        name: "name",
        propName: "name",
        logicalType: "text",
        notNull: true,
      },
      "openaiBaseUrl": {
        name: "openaiBaseUrl",
        propName: "openaiBaseUrl",
        logicalType: "text",
      },
      "anthropicBaseUrl": {
        name: "anthropicBaseUrl",
        propName: "anthropicBaseUrl",
        logicalType: "text",
      },
      "concurrencyLimit": {
        name: "concurrencyLimit",
        propName: "concurrencyLimit",
        logicalType: "int",
        notNull: true,
        default: 10,
      },
      "timeoutMs": {
        name: "timeoutMs",
        propName: "timeoutMs",
        logicalType: "int",
        notNull: true,
        default: 30000,
      },
      "streamTimeoutMs": {
        name: "streamTimeoutMs",
        propName: "streamTimeoutMs",
        logicalType: "int",
        notNull: true,
        default: 300000,
      },
      "maxOutputTokens": {
        name: "maxOutputTokens",
        propName: "maxOutputTokens",
        logicalType: "int",
        notNull: true,
        default: 0,
      },
      "hourlyTokenLimit": {
        name: "hourlyTokenLimit",
        propName: "hourlyTokenLimit",
        logicalType: "int",
        notNull: true,
        default: 0,
      },
      "enabled": {
        name: "enabled",
        propName: "enabled",
        logicalType: "bool",
        notNull: true,
        default: true,
      },
      "manualModels": {
        name: "manualModels",
        propName: "manualModels",
        logicalType: "json_text",
      },
      "lastTestAt": {
        name: "lastTestAt",
        propName: "lastTestAt",
        logicalType: "unix_seconds",
      },
      "lastTestStatus": {
        name: "lastTestStatus",
        propName: "lastTestStatus",
        logicalType: "text",
      },
      "lastTestMessage": {
        name: "lastTestMessage",
        propName: "lastTestMessage",
        logicalType: "text",
      },
      "upstreamProxyUrl": {
        name: "upstreamProxyUrl",
        propName: "upstreamProxyUrl",
        logicalType: "text",
      },
      "weightProxyUrl": {
        name: "weightProxyUrl",
        propName: "weightProxyUrl",
        logicalType: "text",
      },
      "createdAt": {
        name: "createdAt",
        propName: "createdAt",
        logicalType: "unix_seconds",
        notNull: true,
      },
      "updatedAt": {
        name: "updatedAt",
        propName: "updatedAt",
        logicalType: "unix_seconds",
        notNull: true,
      },
    },
  },
  "request_logs": {
    exportName: "requestLogs",
    tableName: "request_logs",
    columns: {
      "id": {
        name: "id",
        propName: "id",
        logicalType: "text",
        primaryKey: true,
        notNull: true,
      },
      "requestId": {
        name: "requestId",
        propName: "requestId",
        logicalType: "text",
        notNull: true,
      },
      "userId": {
        name: "userId",
        propName: "userId",
        logicalType: "text",
        notNull: true,
      },
      "apiKeyId": {
        name: "apiKeyId",
        propName: "apiKeyId",
        logicalType: "text",
      },
      "providerId": {
        name: "providerId",
        propName: "providerId",
        logicalType: "text",
      },
      "providerApiKeyId": {
        name: "providerApiKeyId",
        propName: "providerApiKeyId",
        logicalType: "text",
      },
      "endpointId": {
        name: "endpointId",
        propName: "endpointId",
        logicalType: "text",
      },
      "subdomainId": {
        name: "subdomainId",
        propName: "subdomainId",
        logicalType: "text",
      },
      "protocol": {
        name: "protocol",
        propName: "protocol",
        logicalType: "text",
      },
      "model": {
        name: "model",
        propName: "model",
        logicalType: "text",
      },
      "statusCode": {
        name: "statusCode",
        propName: "statusCode",
        logicalType: "int",
      },
      "inputTokens": {
        name: "inputTokens",
        propName: "inputTokens",
        logicalType: "int",
        default: 0,
      },
      "outputTokens": {
        name: "outputTokens",
        propName: "outputTokens",
        logicalType: "int",
        default: 0,
      },
      "cacheReadTokens": {
        name: "cacheReadTokens",
        propName: "cacheReadTokens",
        logicalType: "int",
        default: 0,
      },
      "cacheWriteTokens": {
        name: "cacheWriteTokens",
        propName: "cacheWriteTokens",
        logicalType: "int",
        default: 0,
      },
      "totalTokens": {
        name: "totalTokens",
        propName: "totalTokens",
        logicalType: "int",
        default: 0,
      },
      "latencyMs": {
        name: "latencyMs",
        propName: "latencyMs",
        logicalType: "int",
        default: 0,
      },
      "ttftMs": {
        name: "ttftMs",
        propName: "ttftMs",
        logicalType: "int",
        default: 0,
      },
      "streaming": {
        name: "streaming",
        propName: "streaming",
        logicalType: "bool",
        default: false,
      },
      "usageStatus": {
        name: "usageStatus",
        propName: "usageStatus",
        logicalType: "text",
      },
      "errorCode": {
        name: "errorCode",
        propName: "errorCode",
        logicalType: "text",
      },
      "errorMessage": {
        name: "errorMessage",
        propName: "errorMessage",
        logicalType: "text",
      },
      "ipAddress": {
        name: "ipAddress",
        propName: "ipAddress",
        logicalType: "text",
      },
      "cost": {
        name: "cost",
        propName: "cost",
        logicalType: "real",
      },
      "routingTrace": {
        name: "routingTrace",
        propName: "routingTrace",
        logicalType: "text",
      },
      "createdAt": {
        name: "createdAt",
        propName: "createdAt",
        logicalType: "unix_seconds",
        notNull: true,
      },
    },
  },
  "response_cache": {
    exportName: "responseCache",
    tableName: "response_cache",
    columns: {
      "id": {
        name: "id",
        propName: "id",
        logicalType: "text",
        primaryKey: true,
        notNull: true,
      },
      "inputHash": {
        name: "inputHash",
        propName: "inputHash",
        logicalType: "text",
        notNull: true,
      },
      "inputText": {
        name: "inputText",
        propName: "inputText",
        logicalType: "text",
        notNull: true,
      },
      "responseText": {
        name: "responseText",
        propName: "responseText",
        logicalType: "text",
        notNull: true,
      },
      "model": {
        name: "model",
        propName: "model",
        logicalType: "text",
      },
      "sourceLogId": {
        name: "sourceLogId",
        propName: "sourceLogId",
        logicalType: "text",
      },
      "hitCount": {
        name: "hitCount",
        propName: "hitCount",
        logicalType: "int",
        notNull: true,
        default: 0,
      },
      "lastHitAt": {
        name: "lastHitAt",
        propName: "lastHitAt",
        logicalType: "unix_seconds",
      },
      "createdBy": {
        name: "createdBy",
        propName: "createdBy",
        logicalType: "text",
      },
      "createdAt": {
        name: "createdAt",
        propName: "createdAt",
        logicalType: "unix_seconds",
        notNull: true,
      },
      "updatedAt": {
        name: "updatedAt",
        propName: "updatedAt",
        logicalType: "unix_seconds",
        notNull: true,
      },
    },
  },
  "route_authorizations": {
    exportName: "routeAuthorizations",
    tableName: "route_authorizations",
    columns: {
      "id": {
        name: "id",
        propName: "id",
        logicalType: "text",
        primaryKey: true,
        notNull: true,
      },
      "routeId": {
        name: "routeId",
        propName: "routeId",
        logicalType: "text",
        notNull: true,
      },
      "userId": {
        name: "userId",
        propName: "userId",
        logicalType: "text",
      },
      "groupId": {
        name: "groupId",
        propName: "groupId",
        logicalType: "text",
      },
      "createdAt": {
        name: "createdAt",
        propName: "createdAt",
        logicalType: "unix_seconds",
        notNull: true,
      },
    },
  },
  "subdomains": {
    exportName: "subdomains",
    tableName: "subdomains",
    columns: {
      "id": {
        name: "id",
        propName: "id",
        logicalType: "text",
        primaryKey: true,
        notNull: true,
      },
      "userId": {
        name: "userId",
        propName: "userId",
        logicalType: "text",
        notNull: true,
      },
      "name": {
        name: "name",
        propName: "name",
        logicalType: "text",
        notNull: true,
      },
      "hostname": {
        name: "hostname",
        propName: "hostname",
        logicalType: "text",
        notNull: true,
      },
      "enabled": {
        name: "enabled",
        propName: "enabled",
        logicalType: "bool",
        notNull: true,
        default: true,
      },
      "description": {
        name: "description",
        propName: "description",
        logicalType: "text",
      },
      "createdAt": {
        name: "createdAt",
        propName: "createdAt",
        logicalType: "unix_seconds",
        notNull: true,
      },
      "updatedAt": {
        name: "updatedAt",
        propName: "updatedAt",
        logicalType: "unix_seconds",
        notNull: true,
      },
    },
  },
  "system_settings": {
    exportName: "systemSettings",
    tableName: "system_settings",
    columns: {
      "key": {
        name: "key",
        propName: "key",
        logicalType: "text",
        primaryKey: true,
        notNull: true,
      },
      "value": {
        name: "value",
        propName: "value",
        logicalType: "text",
        notNull: true,
      },
      "description": {
        name: "description",
        propName: "description",
        logicalType: "text",
      },
      "createdAt": {
        name: "createdAt",
        propName: "createdAt",
        logicalType: "unix_seconds",
        notNull: true,
      },
      "updatedAt": {
        name: "updatedAt",
        propName: "updatedAt",
        logicalType: "unix_seconds",
        notNull: true,
      },
    },
  },
  "user_group_members": {
    exportName: "userGroupMembers",
    tableName: "user_group_members",
    columns: {
      "id": {
        name: "id",
        propName: "id",
        logicalType: "text",
        primaryKey: true,
        notNull: true,
      },
      "groupId": {
        name: "groupId",
        propName: "groupId",
        logicalType: "text",
        notNull: true,
      },
      "userId": {
        name: "userId",
        propName: "userId",
        logicalType: "text",
        notNull: true,
      },
      "createdAt": {
        name: "createdAt",
        propName: "createdAt",
        logicalType: "unix_seconds",
        notNull: true,
      },
    },
  },
  "user_groups": {
    exportName: "userGroups",
    tableName: "user_groups",
    columns: {
      "id": {
        name: "id",
        propName: "id",
        logicalType: "text",
        primaryKey: true,
        notNull: true,
      },
      "name": {
        name: "name",
        propName: "name",
        logicalType: "text",
        notNull: true,
      },
      "description": {
        name: "description",
        propName: "description",
        logicalType: "text",
      },
      "isDefault": {
        name: "isDefault",
        propName: "isDefault",
        logicalType: "bool",
        notNull: true,
        default: false,
      },
      "maxInputTokens": {
        name: "maxInputTokens",
        propName: "maxInputTokens",
        logicalType: "int",
        notNull: true,
        default: 0,
      },
      "createdAt": {
        name: "createdAt",
        propName: "createdAt",
        logicalType: "unix_seconds",
        notNull: true,
      },
      "updatedAt": {
        name: "updatedAt",
        propName: "updatedAt",
        logicalType: "unix_seconds",
        notNull: true,
      },
    },
  },
  "user_route_overrides": {
    exportName: "userRouteOverrides",
    tableName: "user_route_overrides",
    columns: {
      "id": {
        name: "id",
        propName: "id",
        logicalType: "text",
        primaryKey: true,
        notNull: true,
      },
      "userId": {
        name: "userId",
        propName: "userId",
        logicalType: "text",
        notNull: true,
      },
      "routeId": {
        name: "routeId",
        propName: "routeId",
        logicalType: "text",
        notNull: true,
      },
      "modelId": {
        name: "modelId",
        propName: "modelId",
        logicalType: "text",
      },
      "useClientModel": {
        name: "useClientModel",
        propName: "useClientModel",
        logicalType: "bool",
        notNull: true,
        default: false,
      },
      "strategyRoutingRules": {
        name: "strategyRoutingRules",
        propName: "strategyRoutingRules",
        logicalType: "json_text",
      },
      "createdAt": {
        name: "createdAt",
        propName: "createdAt",
        logicalType: "unix_seconds",
        notNull: true,
      },
      "updatedAt": {
        name: "updatedAt",
        propName: "updatedAt",
        logicalType: "unix_seconds",
        notNull: true,
      },
    },
  },
  "users": {
    exportName: "users",
    tableName: "users",
    columns: {
      "id": {
        name: "id",
        propName: "id",
        logicalType: "text",
        primaryKey: true,
        notNull: true,
      },
      "username": {
        name: "username",
        propName: "username",
        logicalType: "text",
        notNull: true,
      },
      "passwordHash": {
        name: "passwordHash",
        propName: "passwordHash",
        logicalType: "text",
        notNull: true,
      },
      "role": {
        name: "role",
        propName: "role",
        logicalType: "text",
        notNull: true,
      },
      "status": {
        name: "status",
        propName: "status",
        logicalType: "text",
        notNull: true,
        default: "active",
      },
      "maxInputTokensOverride": {
        name: "maxInputTokensOverride",
        propName: "maxInputTokensOverride",
        logicalType: "int",
      },
      "createdAt": {
        name: "createdAt",
        propName: "createdAt",
        logicalType: "unix_seconds",
        notNull: true,
      },
      "updatedAt": {
        name: "updatedAt",
        propName: "updatedAt",
        logicalType: "unix_seconds",
        notNull: true,
      },
      "lastLoginAt": {
        name: "lastLoginAt",
        propName: "lastLoginAt",
        logicalType: "unix_seconds",
      },
    },
  },
};

export function getCatalogTable(tableName: string): CatalogTable | undefined {
  return CATALOG[tableName];
}

export function getAllCatalogTables(): CatalogTable[] {
  return Object.values(CATALOG);
}

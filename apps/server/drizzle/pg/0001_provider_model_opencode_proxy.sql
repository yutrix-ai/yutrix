ALTER TABLE "provider_models" ADD COLUMN "useOpencodeProxy" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_action_logs_createdat" ON "action_logs" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "idx_api_keys_keyhash" ON "api_keys" USING btree ("keyHash");--> statement-breakpoint
CREATE INDEX "idx_api_keys_userid" ON "api_keys" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "idx_api_keys_user_status" ON "api_keys" USING btree ("userId","status");--> statement-breakpoint
CREATE INDEX "idx_chat_logs_session_created" ON "chat_logs" USING btree ("serverSessionId","createdAt");--> statement-breakpoint
CREATE INDEX "idx_chat_logs_user_client_session" ON "chat_logs" USING btree ("userId","clientSessionId");--> statement-breakpoint
CREATE INDEX "idx_distillation_learned_records_jobid" ON "distillation_learned_records" USING btree ("jobId");--> statement-breakpoint
CREATE INDEX "idx_distillation_proposals_jobid" ON "distillation_routing_proposals" USING btree ("jobId");--> statement-breakpoint
CREATE INDEX "idx_distillation_signal_versions_is_active" ON "distillation_signal_versions" USING btree ("isActive");--> statement-breakpoint
CREATE INDEX "idx_endpoint_routes_endpointid" ON "endpoint_routes" USING btree ("endpointId");--> statement-breakpoint
CREATE INDEX "idx_endpoint_routes_subdomainid" ON "endpoint_routes" USING btree ("subdomainId");--> statement-breakpoint
CREATE INDEX "idx_endpoint_routes_endpoint_status" ON "endpoint_routes" USING btree ("endpointId","status");--> statement-breakpoint
CREATE INDEX "idx_invite_codes_codehash" ON "invite_codes" USING btree ("codeHash");--> statement-breakpoint
CREATE INDEX "idx_openapi_keys_keyhash" ON "openapi_keys" USING btree ("keyHash");--> statement-breakpoint
CREATE INDEX "idx_openapi_keys_userid" ON "openapi_keys" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "idx_prompt_injection_records_conv_policy" ON "prompt_injection_records" USING btree ("conversationId","promptPolicyId");--> statement-breakpoint
CREATE INDEX "idx_prompt_injection_records_user_created" ON "prompt_injection_records" USING btree ("userId","createdAt");--> statement-breakpoint
CREATE INDEX "idx_provider_api_keys_provider_status" ON "provider_api_keys" USING btree ("providerId","status");--> statement-breakpoint
CREATE INDEX "idx_provider_api_keys_providerid" ON "provider_api_keys" USING btree ("providerId");--> statement-breakpoint
CREATE INDEX "idx_response_cache_createdat" ON "response_cache" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "idx_route_authorizations_userid" ON "route_authorizations" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "idx_route_authorizations_groupid" ON "route_authorizations" USING btree ("groupId");--> statement-breakpoint
CREATE UNIQUE INDEX "unq_user_one_group" ON "user_group_members" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "idx_users_status" ON "users" USING btree ("status");

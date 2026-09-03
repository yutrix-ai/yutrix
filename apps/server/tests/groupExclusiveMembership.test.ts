import { describe, it, expect, beforeAll } from "vitest";
import crypto from "crypto";
import path from "path";
import Fastify, { FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import jwt from "@fastify/jwt";
import { eq } from "drizzle-orm";

const testDb = `data/promptgate_group_exclusive_test_${crypto.randomUUID()}.sqlite`;
process.env.DB_FILE = testDb;

describe("exclusive user-group membership and boot repair", () => {
  let fastify: FastifyInstance;
  let adminToken: string;
  let adminUserId: string;

  beforeAll(async () => {
    const { migrate } = await import("drizzle-orm/libsql/migrator");
    const { db, initAutoMigrations, initDb } = await import("../src/db");
    await initDb();
    const { users } = await import("../src/db/schema");
    const migrationsFolder = path.resolve(process.cwd(), "drizzle");
    await migrate(db, { migrationsFolder });
    await initAutoMigrations();

    adminUserId = crypto.randomUUID();
    await db.insert(users).values({
      id: adminUserId,
      username: "exclusive-admin",
      passwordHash: "hash",
      role: "admin",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const secret = "test-secret-key-1234567890123456";
    fastify = Fastify();
    await fastify.register(cookie);
    await fastify.register(jwt, {
      secret,
      cookie: { cookieName: "token", signed: false },
    });
    adminToken = fastify.jwt.sign({
      id: adminUserId,
      role: "admin",
      username: "exclusive-admin",
    });

    const groupsRoutes = (await import("../src/routes/groups")).default;
    await fastify.register(groupsRoutes);
  }, 60000);

  it("POST add to group B while user in group A -> moves user so they are only in B", async () => {
    const { db } = await import("../src/db");
    const { users, userGroups, userGroupMembers } = await import("../src/db/schema");

    const testUserId = crypto.randomUUID();
    await db.insert(users).values({
      id: testUserId,
      username: `user-move-${Date.now()}`,
      passwordHash: "hash",
      role: "user",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const groupAId = crypto.randomUUID();
    const groupBId = crypto.randomUUID();

    await db.insert(userGroups).values([
      {
        id: groupAId,
        name: `Group A ${Date.now()}`,
        isDefault: false,
        maxInputTokens: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: groupBId,
        name: `Group B ${Date.now()}`,
        isDefault: false,
        maxInputTokens: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    // Put user into Group A initially
    await db.insert(userGroupMembers).values({
      id: crypto.randomUUID(),
      groupId: groupAId,
      userId: testUserId,
      createdAt: new Date(),
    });

    // Verify initially in Group A
    const initialMemberships = await db
      .select()
      .from(userGroupMembers)
      .where(eq(userGroupMembers.userId, testUserId));
    expect(initialMemberships).toHaveLength(1);
    expect(initialMemberships[0].groupId).toBe(groupAId);

    // POST add user to Group B
    const res = await fastify.inject({
      method: "POST",
      url: `/api/admin/groups/${groupBId}/members`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { userId: testUserId },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.moved).toBe(true);
    expect(body.previousGroupIds).toContain(groupAId);

    // Verify user is now ONLY in Group B
    const updatedMemberships = await db
      .select()
      .from(userGroupMembers)
      .where(eq(userGroupMembers.userId, testUserId));
    expect(updatedMemberships).toHaveLength(1);
    expect(updatedMemberships[0].groupId).toBe(groupBId);
  });

  it("POST add when already only in target -> ok, still one row (idempotent)", async () => {
    const { db } = await import("../src/db");
    const { users, userGroups, userGroupMembers } = await import("../src/db/schema");

    const testUserId = crypto.randomUUID();
    await db.insert(users).values({
      id: testUserId,
      username: `user-idempotent-${Date.now()}`,
      passwordHash: "hash",
      role: "user",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const targetGroupId = crypto.randomUUID();
    await db.insert(userGroups).values({
      id: targetGroupId,
      name: `Target Group ${Date.now()}`,
      isDefault: false,
      maxInputTokens: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Put user into target group
    await db.insert(userGroupMembers).values({
      id: crypto.randomUUID(),
      groupId: targetGroupId,
      userId: testUserId,
      createdAt: new Date(),
    });

    // POST add to same target group again
    const res = await fastify.inject({
      method: "POST",
      url: `/api/admin/groups/${targetGroupId}/members`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { userId: testUserId },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.moved).toBe(false);

    // Still exactly one row
    const memberships = await db
      .select()
      .from(userGroupMembers)
      .where(eq(userGroupMembers.userId, testUserId));
    expect(memberships).toHaveLength(1);
    expect(memberships[0].groupId).toBe(targetGroupId);
  });

  it("Repair function collapses multi-membership according to keep-which-group heuristic", async () => {
    const { db } = await import("../src/db");
    const { users, userGroups, userGroupMembers } = await import("../src/db/schema");
    const { ensureExclusiveUserGroupMembership } = await import("../src/startup/migrations");

    // Case 1: user in default + custom -> only custom remains
    const userDefaultAndCustom = crypto.randomUUID();
    await db.insert(users).values({
      id: userDefaultAndCustom,
      username: `user-default-custom-${Date.now()}`,
      passwordHash: "hash",
      role: "user",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const defaultGroupId = crypto.randomUUID();
    const customGroupId1 = crypto.randomUUID();

    await db.insert(userGroups).values([
      {
        id: defaultGroupId,
        name: `Default Group ${Date.now()}`,
        isDefault: true,
        maxInputTokens: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: customGroupId1,
        name: `Custom Group 1 ${Date.now()}`,
        isDefault: false,
        maxInputTokens: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    // Insert polluted memberships: default group created later, custom group created earlier
    // Custom must still be preferred over default!
    await db.insert(userGroupMembers).values([
      {
        id: "mem-custom-1",
        groupId: customGroupId1,
        userId: userDefaultAndCustom,
        createdAt: new Date(1000),
      },
      {
        id: "mem-default-1",
        groupId: defaultGroupId,
        userId: userDefaultAndCustom,
        createdAt: new Date(5000),
      },
    ]);

    // Case 2: user in two customs -> keeps latest createdAt
    const userTwoCustoms = crypto.randomUUID();
    await db.insert(users).values({
      id: userTwoCustoms,
      username: `user-two-customs-${Date.now()}`,
      passwordHash: "hash",
      role: "user",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const customGroupId2 = crypto.randomUUID();
    const customGroupId3 = crypto.randomUUID();

    await db.insert(userGroups).values([
      {
        id: customGroupId2,
        name: `Custom Group 2 ${Date.now()}`,
        isDefault: false,
        maxInputTokens: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: customGroupId3,
        name: `Custom Group 3 ${Date.now()}`,
        isDefault: false,
        maxInputTokens: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    await db.insert(userGroupMembers).values([
      {
        id: "mem-custom-older",
        groupId: customGroupId2,
        userId: userTwoCustoms,
        createdAt: new Date(10000),
      },
      {
        id: "mem-custom-newer",
        groupId: customGroupId3,
        userId: userTwoCustoms,
        createdAt: new Date(20000),
      },
    ]);

    // Case 3: user in two customs with identical createdAt -> keeps lexicographically smallest id
    const userTiedCustoms = crypto.randomUUID();
    await db.insert(users).values({
      id: userTiedCustoms,
      username: `user-tied-${Date.now()}`,
      passwordHash: "hash",
      role: "user",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const sameTime = new Date(15000);
    await db.insert(userGroupMembers).values([
      {
        id: "mem-tied-z",
        groupId: customGroupId2,
        userId: userTiedCustoms,
        createdAt: sameTime,
      },
      {
        id: "mem-tied-a",
        groupId: customGroupId3,
        userId: userTiedCustoms,
        createdAt: sameTime,
      },
    ]);

    // Run repair
    const repairResult = await ensureExclusiveUserGroupMembership();
    expect(repairResult.repairedUsers).toBeGreaterThanOrEqual(3);
    expect(repairResult.repairedRows).toBeGreaterThanOrEqual(3);

    // Verify Case 1: only custom group 1 remains
    const m1 = await db
      .select()
      .from(userGroupMembers)
      .where(eq(userGroupMembers.userId, userDefaultAndCustom));
    expect(m1).toHaveLength(1);
    expect(m1[0].groupId).toBe(customGroupId1);
    expect(m1[0].id).toBe("mem-custom-1");

    // Verify Case 2: only newer createdAt remains (custom group 3)
    const m2 = await db
      .select()
      .from(userGroupMembers)
      .where(eq(userGroupMembers.userId, userTwoCustoms));
    expect(m2).toHaveLength(1);
    expect(m2[0].groupId).toBe(customGroupId3);
    expect(m2[0].id).toBe("mem-custom-newer");

    // Verify Case 3: only lexicographically smaller id remains ("mem-tied-a")
    const m3 = await db
      .select()
      .from(userGroupMembers)
      .where(eq(userGroupMembers.userId, userTiedCustoms));
    expect(m3).toHaveLength(1);
    expect(m3[0].id).toBe("mem-tied-a");

    // Verify idempotence: running again repairs 0 rows
    const secondRun = await ensureExclusiveUserGroupMembership();
    expect(secondRun.repairedRows).toBe(0);
    expect(secondRun.repairedUsers).toBe(0);
  });
});

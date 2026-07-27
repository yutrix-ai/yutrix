import re

with open("apps/server/src/routes/logs.ts", "r") as f:
    code = f.read()

# Add providerModels import
if "providerModels" not in code:
    code = code.replace(
        'import { requestLogs, systemSettings } from "../db/schema";',
        'import { requestLogs, systemSettings, providerModels } from "../db/schema";'
    )

# Modify the logs query
old_query = '''      // Get paginated results
      const logs = await db
        .select()
        .from(requestLogs)
        .where(whereClause)
        .orderBy(desc(requestLogs.createdAt))
        .limit(limitNum)
        .offset(offset);

      return {
        data: logs,'''

new_query = '''      // Get paginated results
      const logsRaw = await db
        .select({
          log: requestLogs,
          alias: providerModels.alias
        })
        .from(requestLogs)
        .leftJoin(providerModels, and(
          eq(requestLogs.providerId, providerModels.providerId),
          eq(requestLogs.model, providerModels.modelId)
        ))
        .where(whereClause)
        .orderBy(desc(requestLogs.createdAt))
        .limit(limitNum)
        .offset(offset);

      const logs = logsRaw.map(r => ({
        ...r.log,
        model: r.alias || r.log.model
      }));

      return {
        data: logs,'''

code = code.replace(old_query, new_query)

with open("apps/server/src/routes/logs.ts", "w") as f:
    f.write(code)


import re

with open("apps/server/src/services/statistics.ts", "r") as f:
    code = f.read()

# Add alias to the select query
code = code.replace(
    'providerId: requestLogs.providerId,',
    'providerId: requestLogs.providerId,\n      alias: providerModels.alias,'
)

# Use alias for model grouping
code = code.replace(
    'const modelKey = row.model || "unknown";',
    'const modelKey = row.alias || row.model || "unknown";'
)

with open("apps/server/src/services/statistics.ts", "w") as f:
    f.write(code)


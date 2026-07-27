import re

with open("apps/web/src/components/Routes/RouteList.tsx", "r") as f:
    code = f.read()

# Replace modelName assignment with alias support
code = code.replace(
    'const modelName = model?.displayName || rule.modelId || "";',
    'const modelName = model?.alias || model?.displayName || rule.modelId || "";'
)

with open("apps/web/src/components/Routes/RouteList.tsx", "w") as f:
    f.write(code)


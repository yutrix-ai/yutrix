import re

with open("apps/web/src/components/Routes/RouteDialog.tsx", "r") as f:
    code = f.read()

# remove buildDefaultStrategyRules
code = re.sub(r'const buildDefaultStrategyRules.*?setShowStrategyPanel\(enabled\);\s*\};', '', code, flags=re.DOTALL)

# replace filteredPolicies
code = code.replace('filteredPolicies.map', 'policies.map')

# remove promptPolicyId from dialog since it's on target now!
prompt_policy_section = r'<div className="space-y-2">\s*<Label>\{t\("routes.fields.policy", "提示词策略 \(可选\)"\)\}</Label>.*?</div>'
code = re.sub(prompt_policy_section, '', code, flags=re.DOTALL)

with open("apps/web/src/components/Routes/RouteDialog.tsx", "w") as f:
    f.write(code)

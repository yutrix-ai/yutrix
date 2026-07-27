import re

with open("apps/web/src/components/Routes/useRoutesState.ts", "r") as f:
    code = f.read()

# remove duplicate return blocks and extra braces at the end
clean_end = '''    handleProtocolChange, handleSave, closeDialog, openCreate, openEdit, handleDelete, toggleEnable, getReadinessBadge
  };
}'''

code = re.sub(r'    handleProtocolChange, handleSave, closeDialog, openCreate, openEdit, handleDelete, toggleEnable, getReadinessBadge\s*\};\s*\}\s*\};\s*return \{[\s\S]*\}\s*', clean_end + '\n', code)

with open("apps/web/src/components/Routes/useRoutesState.ts", "w") as f:
    f.write(code)

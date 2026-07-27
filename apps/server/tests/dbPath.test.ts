import { describe, it, expect } from 'vitest';
import path from 'path';
import { resolveDbFilePath } from '../src/db/path';

describe('resolveDbFilePath', () => {
  it('returns absolute path as-is', () => {
    const result = resolveDbFilePath('/absolute/path/db.sqlite', '/any/cwd');
    expect(result).toBe('/absolute/path/db.sqlite');
  });

  it('resolves relative path from repo root cwd', () => {
    const cwd = '/Users/tom/projects/PromptGate';
    const result = resolveDbFilePath('data/promptgate.sqlite', cwd);
    expect(result).toBe(path.join(cwd, 'data/promptgate.sqlite'));
  });

  it('resolves relative path from apps/server cwd to repo root', () => {
    const cwd = '/Users/tom/projects/PromptGate/apps/server';
    const result = resolveDbFilePath('data/promptgate.sqlite', cwd);
    expect(result).toBe(path.join(cwd, '../../', 'data/promptgate.sqlite'));
  });

  it('resolves data/test.sqlite from apps/server', () => {
    const cwd = '/Users/tom/IdeaProjects/PromptGate/apps/server';
    const result = resolveDbFilePath('data/test.sqlite', cwd);
    expect(result).toBe(path.join('/Users/tom/IdeaProjects/PromptGate', 'data/test.sqlite'));
  });

  it('handles cwd ending with server but different prefix', () => {
    const cwd = '/opt/myserver';
    const result = resolveDbFilePath('data/db.sqlite', cwd);
    // '/opt/myserver' ends with 'server', so it applies the ../../ rule
    expect(result).toBe(path.join(cwd, '../../', 'data/db.sqlite'));
  });
});

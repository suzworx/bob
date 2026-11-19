/**
 * Spec 015 FR-004 to FR-006 (U1): marketing reaches the core turn only through
 * the app extension point (bob-apps/app-turn-extension.ts, wired as
 * TurnDeps.appTurnTools / AppDeps.appTurnTools). No core turn file, nor the
 * @bob/ai agent, prompt or specialist module, imports a module whose path
 * names marketing.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../../..');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith('.ts') ? [path] : [];
  });
}

const CORE_FILES = [
  ...walk(join(ROOT, 'apps/api/src/voice/turn')),
  join(ROOT, 'apps/api/src/workflows/workflow-voice-turn.ts'),
  join(ROOT, 'apps/api/src/workflows/workflow-web-chat-turn.ts'),
  join(ROOT, 'apps/ai/src/agents.ts'),
  join(ROOT, 'apps/ai/src/prompts.ts'),
  join(ROOT, 'apps/ai/src/specialists.ts'),
];

/** Every static, re-export, side-effect and dynamic import specifier in a source file. */
function specifiers(source: string): string[] {
  const pattern = /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s+['"]([^'"]+)['"]/g;
  return [...source.matchAll(pattern)].map((match) => match[1] ?? match[2] ?? match[3] ?? '');
}

describe('core turn files never import marketing (spec 015 U1)', () => {
  it('scans the device turn folder and the named core files', () => {
    expect(CORE_FILES.length).toBeGreaterThan(8);
  });

  it.each(CORE_FILES.map((path) => [relative(ROOT, path), path]))('%s imports no /marketing/ module', (_name, path) => {
    const offending = specifiers(readFileSync(path, 'utf8')).filter((specifier) => /marketing/.test(specifier));
    expect(offending).toEqual([]);
  });
});

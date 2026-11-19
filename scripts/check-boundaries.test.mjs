import { describe, expect, it } from 'vitest';
import { check, importedNames, resolveSpecifier, specifiersOf } from './check-boundaries.mjs';

const file = (path, text) => ({ path, text });

describe('specifiersOf', () => {
  it('reads static, type, re-export, side-effect, dynamic and require specifiers', () => {
    const text = `
      import a from './a.ts';
      import type { B } from "../b.ts";
      import { c,
        d } from '../../c.ts';
      export * from './e.ts';
      export { f } from './f.ts';
      import './g.ts';
      const h = await import('./h.ts');
      const i = require('./i.cjs');
    `;
    expect(specifiersOf(text)).toEqual(['./a.ts', '../b.ts', '../../c.ts', './e.ts', './f.ts', './g.ts', './h.ts', './i.cjs']);
  });

  it('ignores imports inside comments', () => {
    expect(specifiersOf("// import x from './x.ts';\n/* import y from './y.ts'; */\nimport z from './z.ts';")).toEqual(['./z.ts']);
  });
});

describe('importedNames', () => {
  it('lists the named imports of one specifier, ignoring type modifiers and aliases', () => {
    const text = "import { getDb, type Db, withUser as w } from './platform/db/db.ts';\nimport x from './other.ts';";
    expect(importedNames(text, './platform/db/db.ts')).toEqual(['getDb', 'Db', 'withUser']);
    expect(importedNames(text, './other.ts')).toEqual([]);
  });
});

describe('resolveSpecifier', () => {
  it('resolves a relative specifier to a repo-relative path and keeps a package name', () => {
    expect(resolveSpecifier('apps/api/src/store/x.ts', '../web-tasks.ts')).toBe('apps/api/src/web-tasks.ts');
    expect(resolveSpecifier('apps/api/tests/x.test.ts', '../../ai/src/agents.ts')).toBe('apps/ai/src/agents.ts');
    expect(resolveSpecifier('apps/api/src/x.ts', '@bob/ai')).toBe('@bob/ai');
  });
});

describe('check', () => {
  const violationsOf = (path, text) => check([file(path, text)]).violations.map((v) => `${v.rule.id}: ${v.from} -> ${v.to}`);

  it('fails a store file importing a router (the throwaway-commit case from #613)', () => {
    expect(violationsOf('apps/api/src/tasks/store.ts', "import { x } from '../web-health.ts';")).toEqual([
      'module-store-below-http: apps/api/src/tasks/store.ts -> apps/api/src/web-health.ts',
    ]);
  });

  it.each([
    ['apps/api/src/integrations/google-calendar-service.ts', "import x from './google-http.ts';", 'module-store-below-http'],
    ['apps/api/src/integrations/google-calendar-service.ts', "import x from '../voice/turn/run.ts';", 'module-store-below-http'],
    ['apps/api/src/routines/store.ts', "import x from './http.ts';", 'module-store-below-http'],
    ['apps/api/src/tasks/store.ts', "import x from '../server.ts';", 'module-store-below-http'],
    ['apps/api/tests/a.test.ts', "import x from '../../ai/src/agents.ts';", 'api-uses-ai-public-api'],
    ['apps/api/src/web-x.ts', "import { getDb, type Db } from './platform/db/db.ts';", 'singletons-only-at-the-roots'],
    ['apps/api/src/platform/db/a.ts', "import x from '../../account/store.ts';", 'platform-is-shared-infrastructure'],
    ['apps/api/src/platform/http/a.ts', "import x from '../../web-schemas.ts';", 'platform-is-shared-infrastructure'],
    ['apps/api/src/platform/outbox/a.ts', "import x from '../../notifications/notify.ts';", 'platform-is-shared-infrastructure'],
    ['apps/api/src/platform/a.ts', "import x from '../voice/protocol.ts';", 'platform-is-shared-infrastructure'],
    ['apps/ai/src/a.ts', "import x from '../../api/src/platform/logger.ts';", 'ai-is-pure'],
    ['apps/ai/src/a.ts', "import postgres from 'postgres';", 'ai-is-pure'],
    ['apps/ui-v2/src/a.ts', "import x from '../../api/src/store/tasks.ts';", 'ui-only-web-schemas'],
    ['apps/ui-v2/src/a.ts', "import x from '../../api/src/schemas.ts';", 'ui-only-web-schemas'],
    ['apps/ui-v2/e2e/support/a.ts', "import x from '../../../api/src/store/x.ts';", 'e2e-only-public-contracts'],
    ['apps/ui-v2/e2e/a.e2e.ts', "import x from '../../api/src/session.ts';", 'e2e-only-public-contracts'],
    ['apps/ui-v2/e2e/a.e2e.ts', "import x from '@bob/api';", 'e2e-only-public-contracts'],
    ['apps/cardputer/src/a.ts', "import x from '../../ai/src/index.ts';", 'firmware-has-no-ts-imports'],
    ['apps/api/src/reminders/store.ts', "import x from '../workflows/workflow-x.ts';", 'features-never-import-workflows'],
    ['apps/api/src/tools/a.ts', "import x from '../workflows/workflow-x.ts';", 'features-never-import-workflows'],
    ['apps/api/src/workflows/workflow-x.ts', "import x from '../spaces/http.ts';", 'workflows-below-http'],
    ['apps/api/src/workflows/workflow-x.ts', "import x from '../web-tasks.ts';", 'workflows-below-http'],
    ['apps/api/src/workflows/workflow-x.ts', "import x from '../server.ts';", 'workflows-below-http'],
  ])('%s: %s breaks %s', (path, text, rule) => {
    expect(violationsOf(path, text).map((line) => line.split(':')[0])).toEqual([rule]);
  });

  it.each([
    ['apps/api/src/tasks/store.ts', "import x from '../platform/logger.ts';"],
    ['apps/api/src/platform/http/a.ts', "import x from '../logger.ts';"],
    ['apps/api/src/tasks/store.ts', "import x from '../platform/db/db.ts';"],
    ['apps/api/src/server.ts', "import { getDb } from './platform/db/db.ts';"],
    ['apps/api/src/app-deps.ts', "import { getDeviceSessions } from './voice/device-sessions.ts';"],
    ['apps/api/src/web-x.ts', "import { withUser, type Db } from './platform/db/db.ts';"],
    ['apps/api/src/web-schemas.ts', "import x from './tasks/schemas.ts';"],
    ['apps/api/src/tasks/store.ts', "import { requireSpaceMember } from '../spaces/store.ts';"],
    ['apps/api/src/voice/session.ts', "import x from './turn/run.ts';"],
    ['apps/api/tests/a.test.ts', "import x from '@bob/ai/testing';"],
    ['apps/ui-v2/src/a.ts', "import x from '../../api/src/web-schemas.ts';"],
    ['apps/ui-v2/e2e/support/a.ts', "import x from '../../../api/src/voice/protocol.ts';"],
    ['apps/ui-v2/e2e/a.e2e.ts', "import x from '../../api/src/web-schemas.ts';"],
    ['apps/ai/src/a.ts', "import x from './agents.ts';"],
    ['apps/api/src/spaces/http.ts', "import x from '../workflows/workflow-x.ts';"],
    ['apps/api/src/outbox-module.ts', "import x from './workflows/workflow-x.ts';"],
    ['apps/api/src/voice/session-handlers.ts', "import x from '../workflows/workflow-x.ts';"],
    ['apps/api/src/workflows/workflow-x.ts', "import x from '../reminders/store.ts';"],
  ])('%s: %s is allowed', (path, text) => {
    expect(violationsOf(path, text)).toEqual([]);
  });

  it('fails a non-root file importing getDeviceSessions', () => {
    const ids = (path, text) => check([file(path, text)]).violations.map((v) => v.rule.id);
    expect(ids('apps/api/src/tasks/http.ts', "import { getDeviceSessions } from '../voice/device-sessions.ts';")).toEqual(['singletons-only-at-the-roots']);
  });

  it('keeps a module store below its own http layer', () => {
    const ids = (path, text) => check([file(path, text)]).violations.map((v) => v.rule.id);
    expect(ids('apps/api/src/tasks/store.ts', "import { h } from './http.ts';")).toEqual(['module-store-below-http']);
    expect(ids('apps/api/src/tasks/store.ts', "import { s } from '../voice/protocol.ts';")).toEqual(['module-store-below-http']);
    expect(ids('apps/api/src/voice/device-tools.ts', "import { s } from './protocol.ts';")).toEqual([]);
    expect(ids('apps/api/src/conversations/store.ts', "import { r } from './chat-http.ts';")).toEqual(['module-store-below-http']);
    expect(ids('apps/api/src/spaces/publication-service.ts', "import { r } from '../spaces/http.ts';")).toEqual(['module-store-below-http']);
    expect(ids('apps/api/src/tasks/http.ts', "import { s } from './store.ts';")).toEqual([]);
  });

  it('keeps platform from importing a workflow (platform is also a feature-free zone)', () => {
    const ids = (path, text) => check([file(path, text)]).violations.map((v) => v.rule.id);
    expect(ids('apps/api/src/platform/outbox/worker.ts', "import { w } from '../../workflows/workflow-x.ts';")).toContain('features-never-import-workflows');
  });
});

/**
 * GET /api/version: which commit is live, and against which schema (#350).
 *
 * Unauthenticated, like /api/public-config: mount it before the /api JWT guard
 * (`app.use('/api/version', createVersionRouter({ db: getDb }))`). The post-deploy workflow
 * (`.github/workflows/post-deploy.yml`, `scripts/smoke-prod.mjs --expect-sha`)
 * polls it to learn when the commit it was started for is the one serving.
 *
 * The commit comes from RAILWAY_GIT_COMMIT_SHA, which Railway sets on every
 * GitHub-sourced deployment, or BOB_COMMIT_SHA on any other host. A value
 * that is not a hex sha is reported as null rather than echoed back, so the
 * route can never leak an arbitrary environment value.
 */
import { Router, type Request, type Response } from 'express';
import { checkSchema, type SchemaStatus } from './web-health.ts';
import type { Db } from './platform/db/db.ts';
import { resolveCommit } from './platform/commit.ts';


interface VersionBody {
  commit: string | null;
  commit_short: string | null;
  schema_version: string | null;
  schema_expected: string | null;
  schema_status: SchemaStatus;
}

interface VersionRouteOptions {
  env?: NodeJS.ProcessEnv;
  db: () => Promise<Db>;
  timeoutMs?: number;
}


export function createVersionHandler(options: VersionRouteOptions): (request: Request, response: Response) => Promise<void> {
  const commit = resolveCommit(options.env ?? process.env);
  const db = options.db;
  return async (_request: Request, response: Response): Promise<void> => {
    const schema = await checkSchema(db, options.timeoutMs);
    const body: VersionBody = {
      commit,
      commit_short: commit ? commit.slice(0, 7) : null,
      ...schema,
    };
    response.status(200).set('Cache-Control', 'no-store').json(body);
  };
}

export function createVersionRouter(options: VersionRouteOptions): Router {
  const router = Router();
  router.get('/', createVersionHandler(options));
  return router;
}

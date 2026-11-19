/**
 * GET /api/operator/metrics/:page, the aggregate-only operator dashboard API.
 * Each page is one bob_private function returning one jsonb document; the
 * document is parsed through a strict schema before it is sent, so an
 * unexpected field can never leak. The operator gate and the JWT guard run
 * before this router (api-modules.ts).
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asServer, type Db } from '../db/db.ts';
import { createMemoCache } from '../cache/memo-cache.ts';
import { moduleJournal } from '../logger.ts';
import { sendError } from '../http/route.ts';
import { SCHEMAS, type Page } from './operator-metrics-schemas.ts';

const journal = moduleJournal('platform');

const SQL: Record<Page, string> = {
  users: 'SELECT bob_private.operator_metrics_users($1::timestamptz, $2::timestamptz, $3::text) AS doc',
  usage: 'SELECT bob_private.operator_metrics_usage($1::timestamptz, $2::timestamptz, $3::text) AS doc',
  voice: 'SELECT bob_private.operator_metrics_voice($1::timestamptz, $2::timestamptz, $3::text) AS doc',
  platform: 'SELECT bob_private.operator_metrics_platform($1::timestamptz, $2::timestamptz, $3::text) AS doc',
  ai: 'SELECT bob_private.operator_metrics_ai($1::timestamptz, $2::timestamptz, $3::text) AS doc',
  devices: 'SELECT bob_private.operator_metrics_devices($1::timestamptz, $2::timestamptz, $3::text) AS doc',
  features: 'SELECT bob_private.operator_metrics_features($1::timestamptz, $2::timestamptz, $3::text) AS doc',
};

const PageSchema = z.custom<Page>((value) => typeof value === 'string' && Object.hasOwn(SQL, value));

const RANGE_MS = { '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000, '90d': 90 * 86_400_000 } as const;
const BUCKET_MS = { hour: 3_600_000, day: 86_400_000, week: 7 * 86_400_000 } as const;
const DEFAULT_BUCKET = { '24h': 'hour', '7d': 'day', '30d': 'day', '90d': 'week' } as const;
const MAX_BUCKETS = 200;

export const QuerySchema = z
  .object({
    range: z.enum(['24h', '7d', '30d', '90d']).default('7d'),
    bucket: z.enum(['hour', 'day', 'week']).optional(),
  })
  .strict();

export function createOperatorMetricsRouter({ getDb }: { getDb: () => Promise<Db> }): Router {
  const router = Router();
  const memo = createMemoCache<unknown>({ max: 64, ttlMs: 60_000 });

  router.get('/access', (_request: Request, response: Response): void => {
    response.status(204).end();
  });

  // Hand-written: an unknown page is a 404 before the query is validated, and
  // every failure is answered here rather than rethrown.
  router.get('/metrics/:page', async (request: Request, response: Response): Promise<void> => {
    const page = PageSchema.safeParse(request.params.page);
    if (!page.success) {
      sendError(response, 404, 'not_found');
      return;
    }
    const query = QuerySchema.safeParse(request.query);
    if (!query.success) {
      sendError(response, 400, 'invalid_request');
      return;
    }
    const { range } = query.data;
    const bucket = query.data.bucket ?? DEFAULT_BUCKET[range];
    const windowMs = RANGE_MS[range];
    if (Math.ceil(windowMs / BUCKET_MS[bucket]) + 1 > MAX_BUCKETS) {
      sendError(response, 400, 'invalid_request');
      return;
    }
    try {
      const { value } = await memo.getOrCreate(`${page.data}:${range}:${bucket}`, async () => {
        const started = Date.now();
        const to = new Date(started);
        const from = new Date(started - windowMs);
        const db = await getDb();
        const rows = await asServer(db, (s) => s.query<{ doc: unknown }>(SQL[page.data], [from.toISOString(), to.toISOString(), bucket]));
        const document = SCHEMAS[page.data].parse(rows[0]?.doc);
        journal('v2.operator_metrics_read', { page: page.data, range, bucket, duration_ms: Date.now() - started });
        return document;
      });
      response.status(200).json(value);
    } catch (error) {
      if (error instanceof Error && error.message.includes('invalid_window')) {
        sendError(response, 400, 'invalid_request');
        return;
      }
      sendError(response, 500, 'store_error');
    }
  });

  return router;
}

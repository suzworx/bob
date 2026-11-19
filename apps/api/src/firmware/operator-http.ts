/**
 * The operator's firmware controls: what each channel serves, promote, halt and
 * ingest. The operator gate and the JWT guard run before this router (server.ts).
 * Errors are neutral reason codes; nothing here echoes a manifest, key or URL.
 */
import { Router, type Response } from 'express';
import { z } from 'zod';
import { asServer, type Db } from '../platform/db/db.ts';
import { moduleJournal } from '../platform/logger.ts';
import { IngestSourceError, ingestFromGithub } from './ingest-github.ts';
import { getChannel, type IngestResult } from './store.ts';
import { parseVersion } from './semver.ts';
import { FirmwareVerifyError } from './verify.ts';

const journal = moduleJournal('firmware');

export interface OperatorFirmwareDeps {
  getDb: () => Promise<Db>;
  ingest?: (db: Db, input: { tag: string }) => Promise<IngestResult>;
}

const CHANNELS = ['dev', 'beta', 'stable'] as const;
const Channel = z.enum(CHANNELS);
const Board = z.string().min(1).max(64);
const Version = z.string().refine((text) => parseVersion(text) !== null);

export const PromoteBody = z.object({ channel: Channel, board: Board, version: Version, rollout_pct: z.number().int().min(0).max(100).default(100) }).strict();
export const HaltBody = z.object({ channel: Channel, board: Board, halted: z.boolean() }).strict();
export const IngestBody = z.object({ tag: z.string().min(1).max(32) }).strict();
export const BoardQuery = z.union([Board, z.array(Board).max(16)]).default('cardputer');

interface ReleaseRow {
  version: string;
  boards: string[];
  size: number;
  mandatory: boolean;
  security_fix: boolean;
  key_id: string;
  created_at: Date | string;
}

const fail = (response: Response, status: number, code: string): void => {
  response.status(status).json({ error: { code } });
};

const call = <T>(db: Db, sql: string, params: unknown[]): Promise<T[]> => asServer(db, (s) => s.query<T>(sql, params));

async function release(db: Db, version: string): Promise<ReleaseRow | null> {
  return (await call<ReleaseRow>(db, 'select * from bob_private.fw_get_release($1)', [version]))[0] ?? null;
}

async function channelReport(db: Db, channel: (typeof CHANNELS)[number], board: string): Promise<object | null> {
  const current = await getChannel(db, channel, board);
  if (current === null) return null;
  const [counts] = await call<{ attempts: number; rollbacks: number; fleet_size: number }>(
    db, 'select * from bob_private.fw_halt_counts($1, $2)', [channel, board],
  );
  const row = await release(db, current.version);
  return {
    channel, board, version: current.version, rollout_pct: current.rolloutPct, halted: current.halted,
    release: row === null ? null : { boards: row.boards, size: row.size, mandatory: row.mandatory, security_fix: row.security_fix, key_id: row.key_id, created_at: row.created_at },
    last_7_days: { attempts: counts?.attempts ?? 0, rollbacks: counts?.rollbacks ?? 0, fleet_size: counts?.fleet_size ?? 0 },
  };
}

const INGEST_STATUS: Record<string, number> = { bad_tag: 400, release_not_found: 404, asset_missing: 404, too_large: 413, fetch_failed: 502 };

export function createOperatorFirmwareRouter({ getDb, ingest }: OperatorFirmwareDeps): Router {
  const router = Router();

  router.get('/', async (request, response) => {
    const boards = BoardQuery.safeParse(request.query.board);
    if (!boards.success) return fail(response, 400, 'invalid_request');
    const db = await getDb();
    const channels = [];
    for (const channel of CHANNELS) {
      for (const board of [boards.data].flat()) {
        const entry = await channelReport(db, channel, board);
        if (entry !== null) channels.push(entry);
      }
    }
    response.json({ channels });
  });

  router.post('/channel', async (request, response) => {
    const body = PromoteBody.safeParse(request.body);
    if (!body.success) return fail(response, 400, 'invalid_request');
    const { channel, board, version, rollout_pct } = body.data;
    const db = await getDb();
    const row = await release(db, version);
    if (row === null) return fail(response, 404, 'unknown_release');
    if (!row.boards.includes(board)) return fail(response, 400, 'board_not_in_release');
    await call(db, 'select bob_private.fw_set_channel($1, $2, $3, $4)', [channel, board, version, rollout_pct]);
    journal('v2.ota.promote', { channel, board, version, rollout_pct });
    response.json({ channel, board, version, rollout_pct });
  });

  router.post('/halt', async (request, response) => {
    const body = HaltBody.safeParse(request.body);
    if (!body.success) return fail(response, 400, 'invalid_request');
    const { channel, board, halted } = body.data;
    const db = await getDb();
    if ((await getChannel(db, channel, board)) === null) return fail(response, 404, 'unknown_channel');
    const [set] = await call<{ changed: boolean }>(db, 'select bob_private.fw_set_halted($1, $2, $3) as changed', [channel, board, halted]);
    if (set?.changed === true) journal('v2.ota.halt', { channel, board, halted });
    response.json({ channel, board, halted });
  });

  router.post('/ingest', async (request, response) => {
    const body = IngestBody.safeParse(request.body);
    if (!body.success) return fail(response, 400, 'invalid_request');
    try {
      const db = await getDb();
      const result = await (ingest ?? ((d, input) => ingestFromGithub(d, input)))(db, body.data);
      response.json(result);
    } catch (error) {
      if (error instanceof FirmwareVerifyError) return fail(response, 422, error.code);
      if (error instanceof IngestSourceError) return fail(response, INGEST_STATUS[error.code] ?? 502, error.code);
      throw error;
    }
  });

  return router;
}

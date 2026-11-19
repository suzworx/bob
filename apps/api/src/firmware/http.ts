/**
 * GET /v2/firmware/:board/:version.bin (the image) and :version.manifest (the signed
 * manifest bytes, signature in X-Bob-Signature), for a paired device.
 * Authenticated by the device's olxd_ bearer (the same token the device socket
 * uses). A device may only fetch what it could be offered, its own pin, or the
 * version it says it runs (`?from=`, to resume an interrupted download). The
 * response is a plain byte-range file with an ETag; images are signed, so a
 * device verifies them itself and nothing here is a secret.
 */
import { createHash } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { asServer, type Db } from '../platform/db/db.ts';
import { moduleJournal } from '../platform/logger.ts';
import { decideOffer } from './offer-policy.ts';
import { compareVersions, parseVersion } from './semver.ts';
import { channelFor, getChannel, getImage, getManifest, getRelease, recentFailures } from './store.ts';

const journal = moduleJournal('firmware');

const TOKEN_RE = /^olxd_[A-Za-z0-9_-]{43}$/;

const fail = (response: Response, status: number, code: string): void => {
  response.status(status).json({ error: { code } });
};

async function deviceIdFor(db: Db, request: Request): Promise<string | null> {
  const header = request.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  if (!TOKEN_RE.test(token)) return null;
  const hash = createHash('sha256').update(token, 'utf8').digest();
  const [row] = await asServer(db, (s) =>
    s.query<{ device_id: string; revoked: boolean; disabled: boolean }>('select * from bob_private.device_for_token($1)', [hash]),
  );
  return row === undefined || row.revoked || row.disabled ? null : row.device_id;
}

async function mayDownload(db: Db, deviceId: string, board: string, version: string, from: string): Promise<boolean> {
  if (version === from) return true;
  const device = await channelFor(db, deviceId);
  if (device === null) return false;
  if (device.pinVersion === version) return true;
  const channel = await getChannel(db, device.channel, board);
  const target = channel === null ? null : await getRelease(db, channel.version);
  const behindMinFrom = target !== null && (compareVersions(from, target.minFrom) ?? 0) < 0;
  const offer = decideOffer({
    deviceId, board, current: from, deviceChannel: device.channel, pinVersion: device.pinVersion,
    pinnedRelease: device.pinVersion === null ? null : await getRelease(db, device.pinVersion), channel, target,
    steppingStone: behindMinFrom ? await getRelease(db, target.minFrom) : null,
    recentFailures: target === null ? 0 : await recentFailures(db, deviceId, target.version),
  });
  return offer?.version === version;
}

/** One `bytes=a-b` or `bytes=a-` range; anything else (suffix, several ranges) is ignored and the full body is sent. */
function parseRange(header: string, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  const match = /^bytes=(\d+)-(\d*)$/.exec(header.trim());
  if (match === null) return null;
  const start = Number(match[1]);
  const end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  return start >= size || end < start ? 'unsatisfiable' : { start, end };
}

function sendImage(request: Request, response: Response, image: { bytes: Buffer; etag: string }, version: string, board: string): void {
  const { bytes, etag } = image;
  response.set({ ETag: etag, 'Accept-Ranges': 'bytes', 'Content-Type': 'application/octet-stream' });
  const notModified = request.get('if-none-match') === etag;
  const ifRange = request.get('if-range');
  const range = notModified || (ifRange !== undefined && ifRange !== etag) ? null : parseRange(request.get('range') ?? '', bytes.length);
  if (range === 'unsatisfiable') {
    response.set('Content-Range', `bytes */${bytes.length}`);
    return fail(response, 416, 'range_not_satisfiable');
  }
  let body = notModified ? Buffer.alloc(0) : bytes;
  let status = notModified ? 304 : 200;
  if (range !== null) {
    status = 206;
    body = bytes.subarray(range.start, range.end + 1);
    response.set('Content-Range', `bytes ${range.start}-${range.end}/${bytes.length}`);
  }
  response.once('close', () => {
    const completed = response.writableFinished;
    journal('v2.ota.download', { version, board, status: completed ? 'completed' : 'aborted', bytes: completed ? body.length : (response.socket?.bytesWritten ?? 0) });
  });
  if (status !== 304) response.set('Content-Length', String(body.length));
  response.status(status).end(body);
}

function fromVersion(request: Request): string {
  const from = request.query.from;
  return typeof from === 'string' && parseVersion(from) !== null ? from : '0.0.0';
}

function parseFile(file: string): { version: string; kind: 'bin' | 'manifest' } | null {
  const match = /^(.+)\.(bin|manifest)$/.exec(file);
  return match?.[1] !== undefined && parseVersion(match[1]) !== null ? { version: match[1], kind: match[2] as 'bin' | 'manifest' } : null;
}

export function createFirmwareRouter({ getDb }: { getDb: () => Promise<Db> }): Router {
  const router = Router();

  router.get('/:board/:file', async (request, response) => {
    const db = await getDb();
    const deviceId = await deviceIdFor(db, request);
    if (deviceId === null) return fail(response, 401, 'unauthorized');
    const { board = '', file = '' } = request.params;
    const target = parseFile(file);
    if (target === null) return fail(response, 404, 'not_found');
    const { version, kind } = target;
    const artifact = kind === 'manifest' ? await getManifest(db, version, board) : await getImage(db, version, board);
    if (artifact === null) return fail(response, 404, 'not_found');
    if (!(await mayDownload(db, deviceId, board, version, fromVersion(request)))) return fail(response, 403, 'forbidden');

    if ('signature' in artifact) {
      response.set({ 'Content-Type': 'application/json', 'X-Bob-Signature': artifact.signature });
      return void response.status(200).end(artifact.bytes);
    }
    return sendImage(request, response, artifact, version, board);
  });

  return router;
}

import { createPrivateKey, sign } from 'node:crypto';
import { connect, type ClientHttp2Session } from 'node:http2';

export interface ApnsRequest {
  host: string; headers: Record<string,string>; body: string; signal?: AbortSignal;
}
interface ApnsConfig { keyId: string; teamId: string; privateKey: string }
interface ApnsMessage {
  token: string; environment: 'sandbox' | 'production'; topic: string;
  id: string; payload: Record<string,unknown>; expiresAt: number; signal?: AbortSignal;
}
type ApnsResult = 'sent' | 'invalid';
type ApnsTransport = (request: ApnsRequest) => Promise<{ status: number; body: string }>;
const connections = new Map<string,ClientHttp2Session>();

function connection(host: string): ClientHttp2Session {
  const cached = connections.get(host);
  if (cached && !cached.closed && !cached.destroyed) return cached;
  const session = connect(host);
  connections.set(host,session);
  session.on('error',() => { session.destroy(); });
  session.on('goaway',() => { session.close(); });
  session.on('close',() => { if (connections.get(host) === session) connections.delete(host); });
  session.setTimeout(60_000,() => session.close());
  session.unref();
  return session;
}

export const sendApnsRequest: ApnsTransport = async ({ host,headers,body,signal }) => new Promise((resolve,reject) => {
  if (signal?.aborted) { reject(new Error('push_aborted')); return; }
  const session = connection(host);
  const request = session.request(headers);
  let status = 0;
  let response = '';
  let settled = false;
  // A stream's timeout disappears when it closes. An independent deadline also
  // bounds broken sessions that never emit a terminal stream event.
  const deadline = setTimeout(() => finish(new Error('push_timeout')),10_000);
  deadline.unref();
  const abort = (): void => finish(new Error('push_aborted'));
  const closed = (): void => finish(new Error('push_transport_closed'));
  function finish(error: Error | null): void {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    signal?.removeEventListener('abort',abort);
    session.removeListener('close',closed);
    if (error) { reject(error); request.close(); }
    else resolve({ status,body:response });
  }
  signal?.addEventListener('abort',abort,{ once:true });
  session.once('close',closed);
  request.setEncoding('utf8');
  request.on('response',(h) => { status = Number(h[':status'] ?? 0); });
  request.on('data',(chunk: string) => {
    response += chunk;
    if (response.length > 4096) finish(new Error('push_response_size'));
  });
  request.on('error',() => finish(new Error('push_transport_failed')));
  request.once('aborted',closed);
  request.once('end',() => finish(status > 0 && !request.aborted ? null : new Error('push_transport_closed')));
  request.once('close',closed);
  request.end(body);
});

/** Public provider seam. Never returns an Apple error body or token to a logger. */
export function createApnsSender(config: ApnsConfig, transport: ApnsTransport = sendApnsRequest,
  now: () => number = Date.now): (message: ApnsMessage) => Promise<ApnsResult> {
  const key = createPrivateKey(config.privateKey);
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('push_key_invalid');
  }
  let token = '';
  let issuedAt = 0;
  function bearer(): string {
    const at = Math.floor(now()/1000);
    if (token && at-issuedAt < 50*60 && at >= issuedAt) return token;
    const header = Buffer.from(JSON.stringify({ alg:'ES256',kid:config.keyId })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({ iss:config.teamId,iat:at })).toString('base64url');
    const input = `${header}.${claims}`;
    token = `${input}.${sign('sha256',Buffer.from(input),{ key,dsaEncoding:'ieee-p1363' }).toString('base64url')}`;
    issuedAt = at;
    return token;
  }
  return async (message): Promise<ApnsResult> => {
    const body = JSON.stringify(message.payload);
    if (Buffer.byteLength(body) > 4096) throw new Error('push_payload_size');
    const result = await transport({
      host:message.environment === 'sandbox' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com',
      headers:{ ':method':'POST', ':path':`/3/device/${message.token}`, authorization:`bearer ${bearer()}`,
        'apns-topic':message.topic, 'apns-push-type':'alert','apns-priority':'10',
        'apns-id':message.id,'apns-collapse-id':message.id,'apns-expiration':String(Math.floor(message.expiresAt/1000)) },
      body, ...(message.signal ? { signal:message.signal } : {}),
    });
    if (result.status === 200) return 'sent';
    let reason: unknown;
    try { reason = (JSON.parse(result.body) as { reason?: unknown }).reason; } catch { reason = null; }
    if (result.status === 410 || (result.status === 400 && (reason === 'BadDeviceToken' || reason === 'DeviceTokenNotForTopic'))) return 'invalid';
    throw new Error('push_provider_failed');
  };
}

export function pushTopics(): string[] {
  return (process.env.APNS_TOPICS ?? 'xyz.heybob.ios').split(',').map((s) => s.trim()).filter(Boolean);
}

/** Secrets come from the environment at server start, never persisted by this module. */
export function configuredApnsSender(): ReturnType<typeof createApnsSender> | null {
  const keyId = process.env.APNS_KEY_ID;
  const teamId = process.env.APNS_TEAM_ID;
  const privateKey = process.env.APNS_PRIVATE_KEY;
  if (!keyId || !teamId || !privateKey) return null;
  try { return createApnsSender({ keyId,teamId,privateKey }); }
  catch { return null; }
}

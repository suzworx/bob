import { generateKeyPairSync, verify } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createApnsSender, type ApnsRequest } from '../src/notifications/push-apns.ts';

it('signs ES256, selects sandbox, sends generic payload and reuses JWT', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec',{ namedCurve:'P-256' });
  const requests: ApnsRequest[] = [];
  const transport = vi.fn(async (r: ApnsRequest) => { requests.push(r); return { status:200, body:'' }; });
  const send = createApnsSender({ keyId:'KEY1234567', teamId:'TEAM123456', privateKey:privateKey.export({ type:'pkcs8',format:'pem' }).toString() },transport,() => 1_800_000_000_000);
  const message = { token:'ab'.repeat(32), environment:'sandbox' as const, topic:'xyz.heybob.ios',
    id:'12345678-1234-4123-8123-123456789abc', payload:{ aps:{ alert:{ title:'Bob',body:'Your timer is ready.' },sound:'default' } }, expiresAt:1_800_000_900_000 };
  expect(await send(message)).toBe('sent');
  await send(message);
  expect(requests[0]?.host).toBe('https://api.sandbox.push.apple.com');
  expect(requests[0]?.headers['apns-topic']).toBe('xyz.heybob.ios');
  const auth = requests[0]?.headers.authorization ?? '';
  expect(auth).toBe(requests[1]?.headers.authorization);
  const jwt = auth.slice(7).split('.');
  expect(JSON.parse(Buffer.from(jwt[0] ?? '', 'base64url').toString())).toEqual({ alg:'ES256',kid:'KEY1234567' });
  expect(verify('sha256',Buffer.from(`${jwt[0]}.${jwt[1]}`),{ key:publicKey,dsaEncoding:'ieee-p1363' },Buffer.from(jwt[2] ?? '', 'base64url'))).toBe(true);
});

it('invalidates only explicit invalid-device responses and retries provider failures',async () => {
 const { privateKey }=generateKeyPairSync('ec',{ namedCurve:'P-256' });
 const transport=vi.fn().mockResolvedValueOnce({ status:410,body:'{"reason":"Unregistered"}' })
  .mockResolvedValueOnce({ status:503,body:'{"reason":"ServiceUnavailable"}' });
 const send=createApnsSender({ keyId:'KEY1234567',teamId:'TEAM123456',privateKey:privateKey.export({ type:'pkcs8',format:'pem' }).toString() },transport);
 const message={ token:'ab'.repeat(32),environment:'production' as const,topic:'xyz.heybob.ios',id:'12345678-1234-4123-8123-123456789abc',payload:{},expiresAt:Date.now()+60_000 };
 expect(await send(message)).toBe('invalid');
 await expect(send(message)).rejects.toThrow('push_provider_failed');
});

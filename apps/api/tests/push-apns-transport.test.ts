import { createServer,constants,type Http2Server,type ServerHttp2Session,type ServerHttp2Stream } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { afterEach,expect,it,vi } from 'vitest';
import { sendApnsRequest } from '../src/notifications/push-apns.ts';
let server: Http2Server | undefined;
const sessions=new Set<ServerHttp2Session>();
afterEach(async () => {
 vi.useRealTimers();
 for (const session of sessions) session.destroy();
 sessions.clear();
 await new Promise<void>((resolve) => { if (server) server.close(() => resolve()); else resolve(); });
 server=undefined;
});
async function listen(handle: (stream: ServerHttp2Stream) => void): Promise<string> {
 server=createServer();
 server.on('session',(session) => { sessions.add(session); session.on('error',() => undefined); });
 server.on('stream',(stream) => { stream.on('error',() => undefined); handle(stream as ServerHttp2Stream); });
 await new Promise<void>((resolve) => server?.listen(0,'127.0.0.1',resolve));
 return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
it('rejects an HTTP/2 stream closed before response completion instead of leaving delivery pending',async () => {
 const host=await listen((stream) => { stream.resume(); stream.on('end',() => stream.close(constants.NGHTTP2_NO_ERROR)); });
 await expect(sendApnsRequest({ host,headers:{ ':method':'POST',':path':'/3/device/test' },body:'{}' })).rejects.toThrow('push_transport_closed');
},2000);
it('rejects an abruptly closed HTTP/2 session',async () => {
 const host=await listen((stream) => { stream.resume(); stream.on('end',() => stream.session?.destroy()); });
 await expect(sendApnsRequest({ host,headers:{ ':method':'POST',':path':'/3/device/test' },body:'{}' })).rejects.toThrow();
},2000);
it.each(['','{}'])('accepts a complete response body %j and reuses the session for a later request',async (body) => {
 const host=await listen((stream) => { stream.resume(); stream.on('end',() => { stream.respond({ ':status':200 }); stream.end(body); }); });
 const request={ host,headers:{ ':method':'POST',':path':'/3/device/test' },body:'{}' };
 expect(await sendApnsRequest(request)).toEqual({ status:200,body });
 expect(await sendApnsRequest(request)).toEqual({ status:200,body });
 expect(sessions.size).toBe(1);
});
it('rejects an incomplete response closed after headers instead of reporting an accepted delivery',async () => {
 // Node 24 can finish an empty response cleanly when the server closes immediately.
 // Declare an unfinished body so this fixture always describes an incomplete delivery.
 const host=await listen((stream) => { stream.resume(); stream.on('end',() => { stream.respond({ ':status':200,'content-length':'2' }); stream.close(constants.NGHTTP2_CANCEL); }); });
 await expect(sendApnsRequest({ host,headers:{ ':method':'POST',':path':'/3/device/test' },body:'{}' })).rejects.toThrow();
},2000);

it('bounds a nonresponding session with a deadline and cleans its abort listener',async () => {
 let ready: (() => void) | undefined;
 const reached=new Promise<void>((resolve) => { ready=resolve; });
 const host=await listen((stream) => { stream.resume(); stream.on('end',() => ready?.()); });
 const controller=new AbortController();
 const removed=vi.spyOn(controller.signal,'removeEventListener');
 vi.useFakeTimers({ toFake:['setTimeout','clearTimeout'] });
 const request=sendApnsRequest({ host,headers:{ ':method':'POST',':path':'/3/device/test' },body:'{}',signal:controller.signal });
 const rejected=expect(request).rejects.toThrow('push_timeout');
 await reached;
 await vi.advanceTimersByTimeAsync(10_000);
 await rejected;
 expect(vi.getTimerCount()).toBe(0);
 expect(removed).toHaveBeenCalledWith('abort',expect.any(Function));
});
it('aborts an in-flight request and clears the deadline',async () => {
 let ready: (() => void) | undefined;
 const reached=new Promise<void>((resolve) => { ready=resolve; });
 const host=await listen((stream) => { stream.resume(); stream.on('end',() => ready?.()); });
 vi.useFakeTimers({ toFake:['setTimeout','clearTimeout'] });
 const controller=new AbortController();
 const request=sendApnsRequest({ host,headers:{ ':method':'POST',':path':'/3/device/test' },body:'{}',signal:controller.signal });
 const rejected=expect(request).rejects.toThrow('push_aborted');
 await reached;
 controller.abort();
 await rejected;
 expect(vi.getTimerCount()).toBe(0);
});

import { describe, expect, it } from 'vitest';
import { deviceStatus, lastRssi, parseArgs, readJsonLines, replyFromStream, report, runChecks, turnOutcome } from './demo-check.mjs';

const line = (o) => JSON.stringify(o);

describe('parseArgs', () => {
  it('defaults to the local stack and gemini-2.5-flash', () => {
    const opts = parseArgs([]);
    expect(opts.api).toBe('http://localhost:7444');
    expect(opts.web).toBe('http://localhost:5173');
    expect(opts.model).toBe('google/gemini-2.5-flash');
  });
  it('takes overrides and rejects unknown flags', () => {
    expect(parseArgs(['--root', 'D:/x', '--web', 'http://h:1']).root).toBe('D:/x');
    expect(() => parseArgs(['--nope'])).toThrow(/unknown flag/);
    expect(() => parseArgs(['--api'])).toThrow(/needs a value/);
  });
});

describe('journal parsing', () => {
  const text = [line({ event: 'v2.turn_stage_agent_completed', turn_id: 't1', outcome: 'completed', model: 'google/gemini-2.5-flash' }),
    'not json', '', line({ event: 'v2.turn_stage_agent_completed', turn_id: 't2', outcome: 'failed', model: 'openai/gpt-4o' })].join('\r\n');
  it('skips non-JSON lines', () => expect(readJsonLines(text)).toHaveLength(2));
  it('finds a turn by id, else null', () => {
    const events = readJsonLines(text);
    expect(turnOutcome(events, 't1')).toEqual({ outcome: 'completed', model: 'google/gemini-2.5-flash' });
    expect(turnOutcome(events, 'zz')).toBeNull();
  });
});

describe('deviceStatus', () => {
  const at = (s) => `2026-09-26T12:00:${String(s).padStart(2, '0')}.000Z`;
  it('connected when the last presence is online and not closed after it', () => {
    const events = [{ ts: at(1), event: 'v2.closed', session: 's1' }, { ts: at(2), event: 'v2.welcome', session: 's1' },
      { ts: at(3), event: 'v2.device_presence', session: 's1', state: 'online' }];
    expect(deviceStatus(events)).toMatchObject({ connected: true, session: 's1' });
  });
  it('not connected when closed after coming online, or offline, or never seen', () => {
    expect(deviceStatus([{ ts: at(1), event: 'v2.device_presence', session: 's1', state: 'online' },
      { ts: at(5), event: 'v2.closed', session: 's1' }]).connected).toBe(false);
    expect(deviceStatus([{ ts: at(1), event: 'v2.device_presence', session: 's1', state: 'offline' }]).connected).toBe(false);
    expect(deviceStatus([]).connected).toBe(false);
  });
});

describe('lastRssi', () => {
  it('reads the newest rssi= value', () => {
    expect(lastRssi('a rssi=-70\nINFO v2.wifi_heartbeat rssi=-61\n')).toBe(-61);
    expect(lastRssi('nothing here')).toBeNull();
  });
});

describe('replyFromStream', () => {
  it('joins text deltas and finds the conversation id', () => {
    const stream = 'data: {"type":"start","messageMetadata":{"conversationId":"cnv_1"}}\n\ndata: {"type":"text-delta","id":"a","delta":"It is "}\n\n'
      + 'data: {"type":"text-delta","id":"a","delta":"9 AM."}\n\ndata: [DONE]\n';
    expect(replyFromStream(stream)).toEqual({ text: 'It is 9 AM.', conversationId: 'cnv_1', failed: false });
  });
  it('flags an error part', () => expect(replyFromStream('data: {"type":"error","errorText":"x"}\n').failed).toBe(true));
});

describe('report', () => {
  it('prints PASS/FAIL with fix hints and counts failures', () => {
    const out = report([{ name: 'a', ok: true, detail: 'fine' }, { name: 'b', ok: false, detail: 'down', fix: 'start it' }]);
    expect(out.failed).toBe(1);
    expect(out.lines.join('\n')).toMatch(/PASS\s+a/);
    expect(out.lines.join('\n')).toMatch(/FAIL\s+b.*\n.*fix: start it/);
  });
});

function fakeDeps(overrides = {}) {
  const calls = [];
  const journal = [line({ ts: '2026-09-26T12:00:00Z', event: 'v2.device_presence', session: 's9', state: 'online' })];
  const routes = {
    'GET http://localhost:7444/health': () => ({ status: 200, body: '{"ok":true}' }),
    'GET http://localhost:5173/': () => ({ status: 200, body: '<html>' }),
    'POST http://localhost:7444/api/chat': (init) => {
      const id = JSON.parse(init.body).message.id;
      journal.push(line({ event: 'v2.turn_stage_agent_completed', turn_id: id, outcome: 'completed', model: 'google/gemini-2.5-flash' }));
      return { status: 200, body: 'data: {"type":"start","messageMetadata":{"conversationId":"cnv_9"}}\ndata: {"type":"text-delta","delta":"Noon."}\n' };
    },
    'GET http://localhost:7444/api/timers': () => ({ status: 200, body: '{"timers":[]}' }),
    'GET http://localhost:7444/api/spaces': () => ({ status: 200, body: '{"spaces":[{"id":"sp1"}]}' }),
    'GET http://localhost:7444/api/spaces/sp1/reminders': () => ({ status: 200, body: '{"reminders":[]}' }),
    'DELETE http://localhost:7444/api/conversations/cnv_9': () => ({ status: 204, body: '' }),
    ...overrides.routes,
  };
  const fetch = async (url, init = {}) => {
    const key = `${init.method ?? 'GET'} ${url}`;
    calls.push(key);
    const route = routes[key];
    if (!route) throw new Error(`ECONNREFUSED ${key}`);
    const { status, body } = route(init);
    return { ok: status < 300, status, text: async () => body, json: async () => JSON.parse(body) };
  };
  return { calls, deps: { opts: parseArgs([]), fetch, signIn: async () => 'tok', supabaseUp: () => true,
    readText: (name) => (name === 'journal' ? journal.join('\n') : 'rssi=-58\n'), sleep: async () => {}, ...overrides.deps } };
}

describe('runChecks', () => {
  it('all PASS against a healthy fake stack, and deletes its conversation', async () => {
    const { calls, deps } = fakeDeps();
    const results = await runChecks(deps);
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(calls).toContain('DELETE http://localhost:7444/api/conversations/cnv_9');
    expect(results.find((r) => r.name.startsWith('Cardputer')).detail).toMatch(/-58 dBm/);
  });
  it('fails the model check on the wrong model and the API checks when it is down', async () => {
    const wrong = fakeDeps({ routes: { 'POST http://localhost:7444/api/chat': () => ({ status: 200, body: 'data: {"type":"text-delta","delta":"x"}\n' }) } });
    wrong.deps.readText = (name) => (name === 'journal' ? line({ event: 'v2.turn_stage_agent_completed', turn_id: 'old', model: 'openai/gpt-4o' }) : '');
    const results = await runChecks(wrong.deps);
    expect(results.find((r) => r.name === 'chat model').ok).toBe(false);
    const down = fakeDeps({ routes: { 'GET http://localhost:7444/health': () => { throw new Error('ECONNREFUSED'); } } });
    expect((await runChecks(down.deps)).find((r) => r.name === 'API /health').ok).toBe(false);
  });
});

/**
 * #898: speakable() (apps/api/src/voice/audio/stt-tts.ts) strips markdown
 * for speech but had no caller -- device TTS spoke "**", "#", "- " and backticks
 * verbatim. These tests pin speakable() as the sanitiser on every path that
 * reaches deps.ttsMp3 / deps.ttsPcm: the one-shot batch paths, the streamed
 * per-sentence path, and a spoken announcement.
 */
import type { WebSocket } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { BOB_TTS_VOICE } from '@bob/ai';
import { MP3_16K_MONO_FORMAT, PCM16_16K_MONO_FORMAT } from '../../src/voice/protocol.ts';
import { createSession } from '../../src/voice/session-handlers.ts';
import type { TurnDeps } from '../../src/voice/turn/deps.ts';
import { createSentencePlayback, streamPlayback } from '../../src/voice/turn/playback.ts';
import { runAnnouncement } from '../../src/voice/turn/announce.ts';

vi.mock('@bob/ai', async (orig) => ({
  ...(await orig<typeof import('@bob/ai')>()),
  traceSpan: vi.fn(async (_name, _attrs, run) => run()),
}));

type FakeSocket = { readyState: number; bufferedAmount: number; send: ReturnType<typeof vi.fn> };
const fakeSocket = (): FakeSocket => ({ readyState: 1, bufferedAmount: 0, send: vi.fn() });
const asWs = (socket: FakeSocket): WebSocket => socket as unknown as WebSocket;

function fakeDeps(over: Partial<TurnDeps> = {}): TurnDeps {
  const unexpected = (name: string) => (): never => { throw new Error(`unexpected deps.${name}`); };
  return {
    getDb: unexpected('getDb') as TurnDeps['getDb'],
    deviceSessions: { flushPending: vi.fn() } as unknown as TurnDeps['deviceSessions'],
    timersChanged: unexpected('timersChanged') as TurnDeps['timersChanged'],
    embedder: unexpected('embedder') as TurnDeps['embedder'],
    stt: unexpected('stt') as TurnDeps['stt'],
    ttsPcm: unexpected('ttsPcm') as TurnDeps['ttsPcm'],
    ttsMp3: unexpected('ttsMp3') as TurnDeps['ttsMp3'],
    agent: unexpected('agent') as unknown as TurnDeps['agent'],
    accountEvents: unexpected('accountEvents') as TurnDeps['accountEvents'],
    ...over,
  };
}

function mp3Session(): ReturnType<typeof createSession> {
  const session = createSession();
  session.formatId = MP3_16K_MONO_FORMAT;
  return session;
}

describe('device TTS speaks sanitised text, never markdown (#898)', () => {
  it('streamed enqueue sends speakable(piece) to ttsMp3, not the raw markdown piece', async () => {
    const ttsMp3 = vi.fn().mockResolvedValue({ mp3: Buffer.alloc(80) });
    const playback = createSentencePlayback(fakeDeps({ ttsMp3 }), asWs(fakeSocket()), mp3Session(), 'turn_1', Date.now());
    playback.push('**Hi** there. ');
    await playback.finish();
    expect(ttsMp3).toHaveBeenCalledWith('Hi there.', BOB_TTS_VOICE);
  });

  it('a fence-only piece is never synthesized', async () => {
    const ttsMp3 = vi.fn().mockResolvedValue({ mp3: Buffer.alloc(80) });
    const playback = createSentencePlayback(fakeDeps({ ttsMp3 }), asWs(fakeSocket()), mp3Session(), 'turn_1', Date.now());
    playback.push('```\n');
    await playback.finish();
    expect(ttsMp3).not.toHaveBeenCalled();
  });

  it('a sanitised piece still counts its full raw length toward heardChars', async () => {
    const ttsMp3 = vi.fn().mockResolvedValue({ mp3: Buffer.alloc(80) });
    const socket = fakeSocket();
    const playback = createSentencePlayback(fakeDeps({ ttsMp3 }), asWs(socket), mp3Session(), 'turn_1', Date.now());
    const piece = '**Hi** there. ';
    playback.push(piece);
    const result = await playback.finish();
    expect(result.heardChars).toBe(piece.length);
  });

  it('one-shot MP3 playback sanitises the reply before synthesis', async () => {
    const ttsMp3 = vi.fn().mockResolvedValue({ mp3: Buffer.alloc(2_048) });
    await streamPlayback(fakeDeps({ ttsMp3 }), asWs(fakeSocket()), mp3Session(), '**Hi** there.', 'turn_1', Date.now());
    expect(ttsMp3).toHaveBeenCalledWith('Hi there.', BOB_TTS_VOICE);
  });

  it('one-shot MP3 playback falls back to the raw reply when sanitising leaves nothing audible', async () => {
    const ttsMp3 = vi.fn().mockResolvedValue({ mp3: Buffer.alloc(2_048) });
    await streamPlayback(fakeDeps({ ttsMp3 }), asWs(fakeSocket()), mp3Session(), '```\n', 'turn_1', Date.now());
    expect(ttsMp3).toHaveBeenCalledWith('```\n', BOB_TTS_VOICE);
  });

  it('one-shot PCM playback sanitises the reply before synthesis', async () => {
    const session = createSession();
    session.formatId = PCM16_16K_MONO_FORMAT;
    const ttsPcm = vi.fn().mockResolvedValue({ pcm: Buffer.alloc(640), sourceRateHz: 16_000 });
    await streamPlayback(fakeDeps({ ttsPcm }), asWs(fakeSocket()), session, '# Title\nhello', 'turn_1', Date.now());
    expect(ttsPcm).toHaveBeenCalledWith('Title\nhello', BOB_TTS_VOICE);
  });

  it('a spoken announcement is sanitised: "**Pay** rent" is heard as "Pay rent"', async () => {
    const session = createSession();
    session.formatId = MP3_16K_MONO_FORMAT;
    session.stage = 'ready';
    const ttsMp3 = vi.fn().mockResolvedValue({ mp3: Buffer.alloc(1_024) });
    const announcement = { announce_id: 'a1', kind: 'reminder', speech: '**Pay** rent' } as never;
    await runAnnouncement(fakeDeps({ ttsMp3 }), asWs(fakeSocket()), session, announcement);
    expect(ttsMp3).toHaveBeenCalledWith('Pay rent', BOB_TTS_VOICE);
  });

  it('a symbol-only announcement falls back to the raw speech instead of going silent', async () => {
    const session = createSession();
    session.formatId = MP3_16K_MONO_FORMAT;
    session.stage = 'ready';
    const ttsMp3 = vi.fn().mockResolvedValue({ mp3: Buffer.alloc(1_024) });
    const announcement = { announce_id: 'a1', kind: 'reminder', speech: '```\n' } as never;
    await runAnnouncement(fakeDeps({ ttsMp3 }), asWs(fakeSocket()), session, announcement);
    expect(ttsMp3).toHaveBeenCalledWith('```\n', BOB_TTS_VOICE);
  });
});

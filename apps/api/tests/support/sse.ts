// One reader for the /api/events SSE body in tests (SSE-FIRST-BYTE): yields
// parsed event frames and skips comment blocks (`: open`, `: ping`,
// `: expired`), so no test depends on which block arrives first.
// web-events.test.ts keeps its own byte-level reader because it asserts the
// comments themselves.

/** A parsed SSE event frame. */
export interface SseEvent {
  type: string;
  id: string;
  data: unknown;
}

/** Parses an SSE body into event frames as they arrive; comments are skipped. */
export async function* sseEvents(response: Response): AsyncGenerator<SseEvent> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let sep = buffer.indexOf('\n\n');
      while (sep >= 0) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        let type = '';
        let id = '';
        const data: string[] = [];
        for (const line of block.split('\n')) {
          if (line.startsWith(':')) continue;
          if (line.startsWith('event:')) type = line.slice(6).trim();
          else if (line.startsWith('id:')) id = line.slice(3).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).trim());
        }
        if (type !== '' || data.length > 0) {
          yield { type, id, data: data.length ? JSON.parse(data.join('\n')) : undefined };
        }
        sep = buffer.indexOf('\n\n');
      }
    }
  } catch {
    // Aborted by the caller; the stream is closed.
  } finally {
    reader.releaseLock();
  }
}

/** Opens `${baseUrl}/api/events` for a bearer token; abort() closes it. */
export async function openSse(baseUrl: string, token: string): Promise<{
  response: Response;
  events: AsyncGenerator<SseEvent>;
  abort: () => void;
}> {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/api/events`, {
    headers: { authorization: `Bearer ${token}` },
    signal: controller.signal,
  });
  return { response, events: sseEvents(response), abort: () => controller.abort() };
}

/** The first event of `type` (others are skipped), or null on timeout or close. */
export async function waitForEvent(
  events: AsyncGenerator<SseEvent>,
  type: string,
  timeoutMs = 3000,
): Promise<SseEvent | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  try {
    while (true) {
      const outcome = await Promise.race([events.next(), timeout]);
      if (outcome === 'timeout' || outcome.done) return null;
      if (outcome.value.type === type) return outcome.value;
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Pumps every event into `frames` in the background until the stream closes. */
export function collectEvents(events: AsyncGenerator<SseEvent>): { frames: SseEvent[]; done: Promise<void> } {
  const frames: SseEvent[] = [];
  const done = (async (): Promise<void> => {
    for await (const event of events) frames.push(event);
  })();
  return { frames, done };
}

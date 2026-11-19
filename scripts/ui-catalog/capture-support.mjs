import { assertLoopbackTargets } from '../seed-demo.mjs';

// seed-demo owns spaces/tasks, but deliberately seeds no personal memories.
// POST is idempotent by current content, so repeated catalogs keep one fixture.
export async function ensureCaptureMemories(api, token, supabaseEnv, request = fetch) {
  assertLoopbackTargets(api, supabaseEnv);
  for (const memory of [
    { kind: 'fact', content: 'Catalog demo: enjoys cycling on weekends.' },
    { kind: 'action_item', content: 'Catalog demo: plan a weekend cycle ride.' },
  ]) {
    const response = await request(`${api}/api/memories`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(memory),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`Catalog memory setup failed (${response.status})`);
  }
}


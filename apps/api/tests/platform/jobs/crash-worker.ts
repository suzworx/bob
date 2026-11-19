import { createRoutineJobQueue } from '../../../src/platform/jobs/routine-queue.ts';

const connectionString = process.env.ROUTINE_PROOF_DATABASE_URL;
if (!connectionString) throw new Error('proof_database_missing');
const queue = createRoutineJobQueue({ connectionString, handle: async () => {
  process.send?.({ event: 'active' });
  if (process.env.ROUTINE_PROOF_BLOCK === '1') await new Promise<void>(() => undefined);
  else process.send?.({ event: 'handled' });
} });
process.on('message', (message: unknown) => {
  if (message === 'stop') void queue.stop().then(() => process.exit(0));
});
await queue.start();
process.send?.({ event: 'ready' });
if (process.env.ROUTINE_PROOF_RUN_ID) await queue.send(process.env.ROUTINE_PROOF_RUN_ID);

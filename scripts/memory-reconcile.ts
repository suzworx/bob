/**
 * memory:reconcile (follow-up to #758): merges memories stored twice before
 * the memory judge existed, such as "User has a wife named Maya." beside
 * "My wife's name is Maya".
 *
 *   npm run memory:reconcile -- --all                  dry run, every account
 *   npm run memory:reconcile -- --account <uuid>       dry run, one account
 *   npm run memory:reconcile -- --account <uuid> --show-content
 *   npm run memory:reconcile -- --all --apply          retire the duplicates
 *
 * Dry run by default: it prints the plan and changes nothing. --apply marks
 * each retired row superseded_by the kept one (nothing is deleted; the
 * Memories page keeps the history). Pairs come from embedding distance; the
 * memory judge (@bob/ai) decides each one, so this needs AI_GATEWAY_API_KEY
 * as well as BOB_DATABASE_URL (the bob_server connection getDb() uses).
 *
 * Output is JSON lines: account tags, memory ids, verdicts and distances.
 * Memory content is printed only with --show-content, and only for a single
 * --account, so an operator can review their own memories.
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { createMemoryJudge } from '@bob/ai';
import { asServer, createPostgresDb, endDb } from '../apps/api/src/platform/db/db.ts';
import { applyReconcile, planReconcile } from '../apps/api/src/memory/reconcile.ts';

interface Args {
  account: string | null;
  all: boolean;
  apply: boolean;
  showContent: boolean;
}

function parseArgs(argv: readonly string[]): Args | string {
  const args: Args = { account: null, all: false, apply: false, showContent: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--all') args.all = true;
    else if (arg === '--apply') args.apply = true;
    else if (arg === '--show-content') args.showContent = true;
    else if (arg === '--account') args.account = argv[++i] ?? null;
    else return `unknown argument: ${arg}`;
  }
  if (args.all === (args.account !== null)) return 'pass exactly one of --all or --account <uuid>';
  if (args.showContent && args.account === null) return '--show-content needs a single --account';
  return args;
}

/** The journal's account tag: the first 8 hex of the id's sha256. */
function acct(userId: string): string {
  return createHash('sha256').update(userId).digest('hex').slice(0, 8);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args === 'string') {
    console.error(`memory:reconcile: ${args}`);
    process.exitCode = 2;
    return;
  }
  const url = process.env.BOB_DATABASE_URL;
  if (!url) {
    console.error('memory:reconcile: BOB_DATABASE_URL is not set.');
    process.exitCode = 2;
    return;
  }
  const db = createPostgresDb(url);
  try {
    const judge = createMemoryJudge();
    const accounts = args.account !== null
      ? [args.account]
      : (await asServer(db, (server) =>
          server.query<{ user_id: string }>('SELECT user_id FROM bob_private.accounts_with_current_memories()'),
        )).map((row) => row.user_id);

    let planned = 0;
    let applied = 0;
    for (const userId of accounts) {
      const plan = await planReconcile(db, userId, judge);
      planned += plan.decisions.length;
      for (const decision of plan.decisions) {
        console.log(JSON.stringify({
          acct: acct(userId),
          verdict: decision.verdict,
          keep: decision.keep,
          retire: decision.retire,
          distance: Math.round(decision.distance * 1000) / 1000,
          ...(args.showContent ? { kept: decision.keptContent, retired: decision.retiredContent } : {}),
        }));
      }
      if (args.apply && plan.decisions.length > 0) {
        applied += await applyReconcile(db, userId, plan.decisions, (event, fields) => console.log(JSON.stringify({ event, ...fields })));
      }
      console.log(JSON.stringify({ acct: acct(userId), judged: plan.judged, decisions: plan.decisions.length, without_embedding: plan.withoutEmbedding }));
    }
    console.log(JSON.stringify({ accounts: accounts.length, decisions: planned, applied, mode: args.apply ? 'apply' : 'dry-run' }));
  } finally {
    await endDb(db);
  }
}

main().catch((error: unknown) => {
  console.error('memory:reconcile: failed:', error instanceof Error ? error.message : error);
  process.exitCode = 2;
});

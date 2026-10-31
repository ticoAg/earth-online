/**
 * Cloudflare Workers scheduled entrypoint. This does not start a permanent process:
 * Cron Triggers call scheduled() even when the site has no active visitors.
 * Configure DB and triggers in wrangler.jsonc before deployment.
 * No public administration endpoints are exposed by this prototype.
 */
import { advanceDueWorld, getWorld, type Database } from './world/runtime.ts';

export interface Env { DB: Database }

export default {
  async scheduled(_controller: unknown, env: Env): Promise<void> {
    if (!(await getWorld(env.DB, 'earth-main'))) return; // Administrator must initialize/enable the world.
    const summary = await advanceDueWorld(env.DB, 'earth-main', Date.now(), 64);
    if (summary.backlog > 0) console.warn('world_backlog', summary.backlog);
  },
};

/**
 * Deterministic autonomous world progression with SQLite / D1-compatible queries.
 * No AI, no online player, no long-running process required.
 * Production: invoke advanceDueWorld() from a scheduled Cloudflare Worker.
 */
export type SqlValue = string | number | null;
export interface Statement { bind(...values: SqlValue[]): Statement }
export interface Database {
  prepare(sql: string): Statement;
  batch(statements: Statement[]): Promise<{ results: Record<string, unknown>[]; meta?: {changes?: number} }[]>;
}
export type WorldStatus = 'STOPPED' | 'RUNNING' | 'PAUSED' | 'MAINTENANCE';
export type Season = 'spring' | 'summer' | 'autumn' | 'winter';
export interface RuleSet {
  version: number;
  effectiveTick: number;
  seasonLengthTicks: number;
  resourcePerTick: number;
  festivalEveryTicks: number;
}
export interface WorldState {
  id: string;
  status: WorldStatus;
  epochMs: number | null;
  pauseStartedMs: number | null;
  tickDurationMs: number;
  lastTick: number;
  activeRuleVersion: number;
  resources: number;
  revision: string;
}
export interface WorldEvent {
  worldId: string;
  tick: number;
  type: 'world.season_changed' | 'world.festival' | 'world.rules_changed';
  ruleVersion: number;
  payload: Record<string, string | number>;
}
export interface AdvanceResult { processed: number; lastTick: number; events: WorldEvent[]; backlog: number }
const seasons: readonly Season[] = ['spring','summer','autumn','winter'];
const stmt = (db: Database, sql: string, ...args: SqlValue[]) => db.prepare(sql).bind(...args);
const text = (v: unknown): string => { if (typeof v !== 'string') throw Error('invalid_world_row'); return v; };
const num = (v: unknown): number => { if (typeof v !== 'number' || !Number.isFinite(v)) throw Error('invalid_world_row'); return v; };
const time = (v: number): number => { if (!Number.isSafeInteger(v) || v < 0) throw Error('invalid_time'); return v; };
const versionToken = (): string => crypto.randomUUID();
const allowed: readonly WorldStatus[] = ['STOPPED','RUNNING','PAUSED','MAINTENANCE'];
export const DEFAULT_RULES: RuleSet = Object.freeze({version:1,effectiveTick:1,seasonLengthTicks:30,resourcePerTick:4,festivalEveryTicks:7});
function validateRules(rule: RuleSet): void {
  if (![rule.version, rule.effectiveTick,rule.seasonLengthTicks,rule.resourcePerTick,rule.festivalEveryTicks].every(Number.isSafeInteger) ||
      rule.version < 1 || rule.effectiveTick < 1 || rule.seasonLengthTicks < 1 || rule.seasonLengthTicks > 100000 ||
      rule.resourcePerTick < -100 || rule.resourcePerTick > 100 || rule.festivalEveryTicks < 1 || rule.festivalEveryTicks > 100000) {
    throw Error('invalid_world_rules');
  }
}
function fromRow(row: Record<string, unknown>): WorldState {
  const status = text(row.status);
  if (!allowed.includes(status as WorldStatus)) throw Error('invalid_world_status');
  return {id:text(row.world_id),status:status as WorldStatus,
    epochMs:row.epoch_ms === null ? null : num(row.epoch_ms),
    pauseStartedMs:row.pause_started_ms === null ? null : num(row.pause_started_ms),
    tickDurationMs:num(row.tick_duration_ms),lastTick:num(row.last_committed_tick),
    activeRuleVersion:num(row.active_rule_version),resources:num(row.resources),revision:text(row.revision_token)};
}
function ruleFromRow(row: Record<string,unknown>): RuleSet {
  return {version:num(row.version),effectiveTick:num(row.effective_tick),
    seasonLengthTicks:num(row.season_length_ticks),resourcePerTick:num(row.resource_per_tick),
    festivalEveryTicks:num(row.festival_every_ticks)};
}
export async function getWorld(db:Database, id:string):Promise<WorldState|null> {
  const [res] = await db.batch([stmt(db,'SELECT * FROM world_runtime WHERE world_id = ?',id)]);
  return res?.results[0] ? fromRow(res.results[0]) : null;
}
export async function getRuleSets(db:Database,id:string):Promise<RuleSet[]> {
  const [r] = await db.batch([stmt(db,'SELECT version, effective_tick, season_length_ticks, resource_per_tick, festival_every_ticks FROM world_rule_sets WHERE world_id = ? ORDER BY effective_tick',id)]);
  return (r?.results ?? []).map(ruleFromRow);
}
export async function initializeWorld(db:Database, id='earth-main', tickDurationMs=86_400_000, rule:RuleSet=DEFAULT_RULES):Promise<void> {
  if (!id || id.length > 128 || !Number.isSafeInteger(tickDurationMs) || tickDurationMs < 1000) throw Error('invalid_world_config');
  validateRules(rule);
  if (rule.version !== 1 || rule.effectiveTick !== 1) throw Error('initial_rule_must_start_at_one');
  const revision = versionToken();
  await db.batch([
    stmt(db,`INSERT INTO world_runtime(world_id,status,tick_duration_ms,revision_token)
      VALUES(?,'STOPPED',?,?)`,id,tickDurationMs,revision),
    stmt(db,`INSERT INTO world_rule_sets(world_id,version,effective_tick,season_length_ticks,resource_per_tick,festival_every_ticks)
      VALUES(?,?,?,?,?,?)`,id,rule.version,rule.effectiveTick,rule.seasonLengthTicks,rule.resourcePerTick,rule.festivalEveryTicks)
  ]);
}
/** All mode changes are CAS-protected, so concurrent jobs cannot silently overwrite them. */
export async function setWorldStatus(db:Database,id:string,next:WorldStatus,atMs:number):Promise<WorldState> {
  time(atMs);
  if (!allowed.includes(next)) throw Error('invalid_world_status');
  for(let retry=0;retry<10;retry++) {
    const current=await getWorld(db,id);
    if (!current) throw Error('world_not_found');
    if (current.status === next) return current;
    if (next === 'STOPPED') throw Error('cannot_stop_started_world');
    if (current.status === 'STOPPED' && next !== 'RUNNING') throw Error('world_not_started');
    if (current.status === 'RUNNING' && next === 'RUNNING') return current;
    if (current.status !== 'RUNNING' && current.status !== 'STOPPED' && next !== 'RUNNING' &&
        !(['MAINTENANCE','PAUSED'] as WorldStatus[]).includes(next)) throw Error('invalid_transition');
    // Pause counts from its first entry; shifting the epoch on resume freezes game time.
    let epoch=current.epochMs;
    let pause=current.pauseStartedMs;
    if(current.status==='STOPPED') epoch=atMs;
    else if(current.status==='RUNNING' && next!=='RUNNING') {
      if(epoch===null || atMs<epoch+current.lastTick*current.tickDurationMs) throw Error('pause_before_committed_time');
      pause=atMs;
    }
    else if(current.status!=='RUNNING' && next==='RUNNING') {
      if(epoch===null || pause===null) throw Error('missing_pause_clock');
      if(atMs<pause) throw Error('time_before_pause');
      epoch+=atMs-pause; pause=null;
    }
    const newRevision=versionToken();
    const [result]=await db.batch([stmt(db,`UPDATE world_runtime
      SET status=?,epoch_ms=?,pause_started_ms=?,revision_token=?
      WHERE world_id=? AND revision_token=?`,next,epoch,pause,newRevision,id,current.revision)]);
    if(result?.meta?.changes===1) return (await getWorld(db,id))!;
  }
  throw Error('world_status_conflict');
}
/** Schedule immutable rule version for a future tick; no downtime required. */
export async function stageRuleSet(db:Database,id:string,rule:RuleSet):Promise<void> {
  validateRules(rule);
  for(let retry=0;retry<10;retry++) {
    const current=await getWorld(db,id);
    if(!current) throw Error('world_not_found');
    if(rule.effectiveTick<=current.lastTick) throw Error('rule_must_be_future');
    const existing=await getRuleSets(db,id);
    if(rule.effectiveTick<=Math.max(...existing.map(x=>x.effectiveTick))) throw Error('rule_tick_must_increase');
    if(existing.some(r=>r.version===rule.version || r.effectiveTick===rule.effectiveTick)) throw Error('rule_version_or_tick_exists');
    if(rule.version<=Math.max(...existing.map(x=>x.version))) throw Error('rule_version_must_increase');
    const revision=versionToken();
    const results=await db.batch([
      stmt(db,'UPDATE world_runtime SET revision_token=? WHERE world_id=? AND revision_token=?',revision,id,current.revision),
      stmt(db,`INSERT INTO world_rule_sets(world_id,version,effective_tick,season_length_ticks,resource_per_tick,festival_every_ticks)
        SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM world_runtime WHERE world_id=? AND revision_token=?)`,
        id,rule.version,rule.effectiveTick,rule.seasonLengthTicks,rule.resourcePerTick,rule.festivalEveryTicks,id,revision)
    ]);
    if(results[0]?.meta?.changes===1) return;
  }
  throw Error('rule_update_conflict');
}
function eventsForTick(world:WorldState,tick:number, rule:RuleSet):{season:Season; resources:number; events:WorldEvent[]} {
  const seasonIndex=Math.floor((tick-1)/rule.seasonLengthTicks)%4;
  const season=seasons[seasonIndex]!;
  const events:WorldEvent[]=[];
  const emit=(type:WorldEvent['type'], payload:WorldEvent['payload'])=>events.push({worldId:world.id,tick,type,ruleVersion:rule.version,payload});
  if(tick===1 || (tick-1)%rule.seasonLengthTicks===0) emit('world.season_changed',{season});
  if(tick%rule.festivalEveryTicks===0) emit('world.festival',{festivalTick:tick});
  if(rule.version!==world.activeRuleVersion) emit('world.rules_changed',{from:world.activeRuleVersion,to:rule.version});
  return {season,resources:Math.min(1000,Math.max(0,world.resources+rule.resourcePerTick)),events};
}
/** Claim exactly one due world tick. Other workers will lose CAS and retry safely. */
async function commitNextTick(db:Database,id:string,nowMs:number):Promise<{ committed:boolean; events:WorldEvent[]; nextTick:number }|null> {
  const [stateRes,rulesRes]=await db.batch([
    stmt(db,'SELECT * FROM world_runtime WHERE world_id=?',id),
    stmt(db,`SELECT version,effective_tick,season_length_ticks,resource_per_tick,festival_every_ticks
      FROM world_rule_sets WHERE world_id=? ORDER BY effective_tick`,id)
  ]);
  const state=stateRes?.results[0];
  if(!state) throw Error('world_not_found');
  const world=fromRow(state);
  if(world.status!=='RUNNING') return null;
  if(world.epochMs===null) throw Error('world_epoch_missing');
  const dueTick=Math.floor((nowMs-world.epochMs)/world.tickDurationMs);
  const tick=world.lastTick+1;
  if(tick>dueTick) return null;
  const eligible=(rulesRes?.results??[]).map(ruleFromRow).filter(r=>r.effectiveTick<=tick);
  const rule=eligible.at(-1);
  if(!rule) throw Error('no_rule_for_tick');
  const next=eventsForTick(world,tick,rule);
  const revision=versionToken();
  const queries:Statement[]=[
    stmt(db,`UPDATE world_runtime SET last_committed_tick=?,active_rule_version=?,resources=?,revision_token=?
      WHERE world_id=? AND revision_token=? AND status='RUNNING'`,tick,rule.version,next.resources,revision,id,world.revision),
    stmt(db,`INSERT INTO world_ticks(world_id,tick_index,rule_version,season,resources_after)
      SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM world_runtime WHERE world_id=? AND revision_token=?)`,
      id,tick,rule.version,next.season,next.resources,id,revision)
  ];
  for(const e of next.events){
    queries.push(stmt(db,`INSERT INTO world_events(world_id,tick_index,event_key,event_type,rule_version,payload_json)
      SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM world_runtime WHERE world_id=? AND revision_token=?)`,
      id,tick,e.type,e.type,rule.version,JSON.stringify(e.payload),id,revision));
  }
  const results=await db.batch(queries);
  if(results[0]?.meta?.changes!==1) return {committed:false,events:[],nextTick:tick};
  return {committed:true,events:next.events,nextTick:tick};
}
/**
 * On-demand scheduler catch-up: processes as many due ticks as the bounded budget allows.
 * Cron can call this with no players online. A backlog remains pending for the next invocation.
 */
export async function advanceDueWorld(db:Database,id:string,nowMs:number,maxTicks=64):Promise<AdvanceResult> {
  time(nowMs);
  if(!Number.isSafeInteger(maxTicks)||maxTicks<1||maxTicks>1000) throw Error('invalid_tick_budget');
  let processed=0;
  const events:WorldEvent[]=[];
  let collisions=0;
  while(processed<maxTicks){
    const outcome=await commitNextTick(db,id,nowMs);
    if(!outcome)break;
    if(!outcome.committed){
      if(++collisions>maxTicks*8+16) throw Error('world_tick_contention');
      continue;
    }
    processed++;
    collisions=0;
    events.push(...outcome.events);
  }
  const state=await getWorld(db,id);
  if(!state) throw Error('world_not_found');
  const due=(state.status==='RUNNING' && state.epochMs!==null)
    ?Math.max(0,Math.floor((nowMs-state.epochMs)/state.tickDurationMs)-state.lastTick):0;
  return {processed,lastTick:state.lastTick,events,backlog:due};
}
export async function recentWorldEvents(db:Database,id:string,limit=50):Promise<WorldEvent[]> {
  if(!Number.isInteger(limit)||limit<1||limit>500)throw Error('invalid_query_limit');
  const [r]=await db.batch([stmt(db,`SELECT world_id,tick_index,event_type,rule_version,payload_json
    FROM world_events WHERE world_id=? ORDER BY tick_index DESC, event_key LIMIT ?`,id,limit)]);
  return (r?.results??[]).map(row=>({worldId:text(row.world_id),tick:num(row.tick_index),
    type:text(row.event_type) as WorldEvent['type'],ruleVersion:num(row.rule_version),
    payload:JSON.parse(text(row.payload_json)) as WorldEvent['payload']}));
}

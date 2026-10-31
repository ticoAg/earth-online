import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLocalDatabase } from '../scripts/local-sqlite.ts';
import { advanceDueWorld, initializeWorld, getWorld, getRuleSets, setWorldStatus, recentWorldEvents, stageRuleSet } from '../src/world/runtime.ts';
const DAY=86_400_000;
const START=Date.parse('2026-01-01T00:00:00.000Z');
async function fixture(fn:(db:ReturnType<typeof openLocalDatabase>)=>Promise<void>){
  const dir=mkdtempSync(join(tmpdir(),'earth-world-'));
  const db=openLocalDatabase(join(dir,'state.sqlite'));
  try {db.migrate();await fn(db);}finally{db.close();rmSync(dir,{recursive:true,force:true});}
}

test('new world is stopped; world time starts only after explicit start',async()=>fixture(async db=>{
  await initializeWorld(db);
  assert.equal((await getWorld(db,'earth-main'))?.status,'STOPPED');
  assert.equal((await advanceDueWorld(db,'earth-main',START+30*DAY)).processed,0);
  await assert.rejects(setWorldStatus(db,'earth-main','MAINTENANCE',START),/world_not_started/);
  await setWorldStatus(db,'earth-main','RUNNING',START);
  assert.equal((await getWorld(db,'earth-main'))?.epochMs,START);
  assert.equal((await advanceDueWorld(db,'earth-main',START)).processed,0);
}));

test('zero players: 30 days advance in batches, deterministic festivals, season and resources',async()=>fixture(async db=>{
  await initializeWorld(db);
  await setWorldStatus(db,'earth-main','RUNNING',START);
  const first=await advanceDueWorld(db,'earth-main',START+30*DAY,5);
  assert.equal(first.processed,5);
  assert.equal(first.backlog,25);
  const rest=await advanceDueWorld(db,'earth-main',START+30*DAY,64);
  assert.equal(rest.processed,25);
  assert.equal(rest.backlog,0);
  assert.equal(rest.lastTick,30);
  assert.equal((await getWorld(db,'earth-main'))?.resources,120);
  const events=await recentWorldEvents(db,'earth-main',50);
  assert.equal(events.filter(e=>e.type==='world.festival').length,4);
  assert.equal(events.filter(e=>e.type==='world.season_changed').length,1);
  assert.equal((await advanceDueWorld(db,'earth-main',START+30*DAY)).processed,0);
  const seasonChange=await advanceDueWorld(db,'earth-main',START+31*DAY);
  assert.equal(seasonChange.events.find(e=>e.type==='world.season_changed')?.payload.season,'summer');
}));

test('pause / maintenance freezes logical world time and resumes without artificial catch-up',async()=>fixture(async db=>{
  await initializeWorld(db);
  await setWorldStatus(db,'earth-main','RUNNING',START);
  await advanceDueWorld(db,'earth-main',START+3*DAY);
  await setWorldStatus(db,'earth-main','PAUSED',START+3*DAY);
  assert.equal((await advanceDueWorld(db,'earth-main',START+100*DAY)).processed,0);
  await setWorldStatus(db,'earth-main','MAINTENANCE',START+5*DAY);
  await setWorldStatus(db,'earth-main','RUNNING',START+100*DAY);
  assert.equal((await advanceDueWorld(db,'earth-main',START+100*DAY)).processed,0);
  assert.equal((await advanceDueWorld(db,'earth-main',START+101*DAY)).processed,1);
  assert.equal((await getWorld(db,'earth-main'))?.lastTick,4);
}));

test('future immutable rules activate only at specified tick and retain previous history',async()=>fixture(async db=>{
  await initializeWorld(db);
  await setWorldStatus(db,'earth-main','RUNNING',START);
  await stageRuleSet(db,'earth-main',{version:2,effectiveTick:5,seasonLengthTicks:30,resourcePerTick:10,festivalEveryTicks:2});
  await assert.rejects(stageRuleSet(db,'earth-main',{version:2,effectiveTick:7,seasonLengthTicks:5,resourcePerTick:1,festivalEveryTicks:7}),/rule_version_or_tick_exists/);
  const result=await advanceDueWorld(db,'earth-main',START+8*DAY);
  assert.equal(result.processed,8);
  assert.equal(result.events.filter(e=>e.type==='world.rules_changed').length,1);
  assert.equal((await getWorld(db,'earth-main'))?.activeRuleVersion,2);
  assert.equal((await getWorld(db,'earth-main'))?.resources,4*4+4*10);
  const rules=await getRuleSets(db,'earth-main');
  assert.deepEqual(rules.map(r=>r.version),[1,2]);
  assert.equal((await recentWorldEvents(db,'earth-main')).filter(e=>e.ruleVersion===2 && e.type==='world.rules_changed').length,1);
  await assert.rejects(stageRuleSet(db,'earth-main',{version:3,effectiveTick:4,seasonLengthTicks:30,resourcePerTick:2,festivalEveryTicks:7}),/rule_must_be_future/);
}));

test('simultaneous schedulers commit each tick once, no duplicate world history',async()=>fixture(async db=>{
  await initializeWorld(db);
  await setWorldStatus(db,'earth-main','RUNNING',START);
  const [a,b,c]=await Promise.all([1,2,3].map(()=>advanceDueWorld(db,'earth-main',START+31*DAY,40)));
  assert.equal(a.processed+b.processed+c.processed,31);
  assert.equal((await getWorld(db,'earth-main'))?.lastTick,31);
  const events=await recentWorldEvents(db,'earth-main',100);
  assert.equal(events.length,6); // season: day 1 and 31, festivals: days 7,14,21,28
}));

test('rejects bad time, bad rules, wrong statuses and invalid tick budgets',async()=>fixture(async db=>{
  await assert.rejects(initializeWorld(db,'earth-main',1),/invalid_world_config/);
  await initializeWorld(db);
  await assert.rejects(stageRuleSet(db,'earth-main',{version:2,effectiveTick:3,seasonLengthTicks:0,resourcePerTick:2,festivalEveryTicks:1}),/invalid_world_rules/);
  await assert.rejects(advanceDueWorld(db,'earth-main',-1),/invalid_time/);
  await assert.rejects(advanceDueWorld(db,'earth-main',START,0),/invalid_tick_budget/);
  await setWorldStatus(db,'earth-main','RUNNING',START);
  await assert.rejects(setWorldStatus(db,'earth-main','STOPPED',START),/cannot_stop_started_world/);
}));

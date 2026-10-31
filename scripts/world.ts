/** Local admin / test CLI only; production must expose protected admin workflows. */
import { openLocalDatabase } from './local-sqlite.ts';
import { advanceDueWorld, getWorld, initializeWorld, recentWorldEvents, setWorldStatus, stageRuleSet, type WorldStatus } from '../src/world/runtime.ts';

const db=openLocalDatabase(process.env.EARTH_DB_PATH ?? '.data/earth-online.sqlite');
const DAYS=86_400_000;
const DEMO_START=Date.parse('2026-01-01T00:00:00.000Z');
const command=process.argv[2] ?? 'demo';
const id='earth-main';
function atArg(raw?:string):number { if(!raw) return Date.now(); const value=Date.parse(raw); if(!Number.isFinite(value))throw Error('invalid date');return value; }
try {
  db.migrate();
  switch(command){
    case 'demo': {
      let world=await getWorld(db,id);
      if(!world){await initializeWorld(db,id); world=await getWorld(db,id);}
      if(world?.status==='STOPPED')await setWorldStatus(db,id,'RUNNING',DEMO_START);
      // Simulated 30 days elapsed: no player activity needed.
      const summary=await advanceDueWorld(db,id,DEMO_START+30*DAYS,64);
      console.log(JSON.stringify({summary,world:await getWorld(db,id),events:await recentWorldEvents(db,id)},null,2));
      break;
    }
    case 'init': await initializeWorld(db,id); console.log('world initialized: STOPPED');break;
    case 'start': case 'resume':case 'pause':case 'maintenance':{
      const next:WorldStatus=command==='pause'?'PAUSED':command==='maintenance'?'MAINTENANCE':'RUNNING';
      console.log(JSON.stringify(await setWorldStatus(db,id,next,atArg(process.argv[3])),null,2));break;
    }
    case 'advance':{
      const at=atArg(process.argv[3]);
      console.log(JSON.stringify(await advanceDueWorld(db,id,at),null,2));break;
    }
    case 'status': console.log(JSON.stringify({world:await getWorld(db,id),recentEvents:await recentWorldEvents(db,id)},null,2));break;
    case 'stage':{
      const version=Number(process.argv[3]);const effectiveTick=Number(process.argv[4]);
      await stageRuleSet(db,id,{version,effectiveTick,seasonLengthTicks:30,resourcePerTick:8,festivalEveryTicks:7});
      console.log(`rule set v${version} scheduled at tick ${effectiveTick}`);break;
    }
    default:throw Error('Usage: world.ts [demo|init|start [ISO]|resume [ISO]|pause [ISO]|maintenance [ISO]|advance [ISO]|status|stage <version> <effectiveTick>]');
  }
} finally {db.close();}

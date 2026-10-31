import type { Achievement, Encounter, World } from './engine.ts';

export interface TimelineEntry {
  id: string;
  occurredAt: string;
  type: 'study' | 'encounter' | 'choice' | 'achievement';
  sourceEventId: string;
  source: 'self_reported' | 'system_simulated';
  explanation: string;
  durationMinutes?: number;
  delta?: number;
  encounterId?: string;
  achievementId?: Achievement['definitionId'];
  verification?: 'unverified';
}

export interface PublicEncounter {
  id: string;
  type: 'research_lead';
  sourceEventId: string;
  source: 'system_simulated';
  status: 'pending_choice';
  verification: 'unverified';
}

export interface PublicCharacter {
  id: string;
  mathAnalysis: number;
  pendingEncounters: PublicEncounter[];
  achievements: Achievement[];
  timeline: TimelineEntry[];
}

const typeOrder: Record<TimelineEntry['type'], number> = { study: 0, encounter: 1, choice: 2, achievement: 3 };
const compareId = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

function publicAchievement(achievement: Achievement): Achievement {
  return {
    definitionId: achievement.definitionId,
    version: achievement.version,
    category: achievement.category,
    unlockedAt: achievement.unlockedAt,
    sourceEventId: achievement.sourceEventId,
    source: 'system_simulated'
  };
}

function publicEncounter(encounter: Encounter): PublicEncounter {
  return {
    id: encounter.id,
    type: encounter.type,
    sourceEventId: encounter.sourceEventId,
    source: 'system_simulated',
    status: 'pending_choice',
    verification: 'unverified'
  };
}

/** Read stored outcomes only: never recalculate growth or expose rule attempts. */
export function getTimeline(world: World): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  const events = new Map(world.accepted.map(event => [event.id, event]));
  const results = new Map(Object.values(world.idempotency).map(result => [result.eventId, result]));
  for (const event of world.accepted) {
    const result = results.get(event.id);
    if (!result) throw new Error('incomplete_event_result');
    entries.push({
      id: `study:${event.id}`, occurredAt: event.occurredAt, type: 'study',
      sourceEventId: event.id, source: 'self_reported',
      durationMinutes: event.durationMinutes, delta: result.delta,
      explanation: `自述数学学习 ${event.durationMinutes} 分钟；游戏熟练度增加 ${result.delta}。`
    });
  }
  for (const encounter of world.encounters) {
    const event = events.get(encounter.sourceEventId);
    if (!event) throw new Error('incomplete_encounter_state');
    entries.push({
      id: `encounter:${encounter.id}`, occurredAt: event.occurredAt, type: 'encounter',
      sourceEventId: encounter.sourceEventId, source: 'system_simulated',
      encounterId: encounter.id, verification: 'unverified',
      explanation: '游戏中出现一条待探索的研究线索，尚未验证。'
    });
  }
  for (const choice of world.choices ?? []) {
    const encounter = world.encounters.find(item => item.id === choice.encounterId);
    if (!encounter || encounter.status !== 'resolved') throw new Error('incomplete_encounter_state');
    entries.push({
      id: `choice:${choice.id}`, occurredAt: choice.occurredAt, type: 'choice',
      sourceEventId: encounter.sourceEventId, source: 'system_simulated', encounterId: encounter.id,
      explanation: choice.choice === 'continue_research'
        ? '你选择继续探索这条游戏研究线索；尚未证明任何真实结论。'
        : '线索已归档，本次不再结算。'
    });
  }
  for (const achievement of world.achievements ?? []) {
    entries.push({
      id: `achievement:${achievement.definitionId}`, occurredAt: achievement.unlockedAt,
      type: 'achievement', sourceEventId: achievement.sourceEventId,
      source: 'system_simulated', achievementId: achievement.definitionId,
      explanation: `解锁游戏成就：${achievement.definitionId}。`
    });
  }
  return entries.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt)
    || typeOrder[a.type] - typeOrder[b.type] || compareId(a.id, b.id));
}

/** Explicit whitelist for future UI reads; World remains an internal model. */
export function getPublicCharacter(world: World): PublicCharacter {
  return {
    id: world.character.id,
    mathAnalysis: world.character.mathAnalysis,
    pendingEncounters: world.encounters.filter(encounter => encounter.status === 'pending_choice').map(publicEncounter),
    achievements: (world.achievements ?? []).map(publicAchievement),
    timeline: getTimeline(world)
  };
}

/**
 * Earth Online: dependency-free, in-memory gameplay prototype.
 * Not a real-life prediction system. No AI, no persistence or authentication.
 * Production must run validation, idempotency and rolls within a DB transaction.
 */

export type Method = 'problem_solving' | 'review' | 'cross_domain';
export type EventSource = 'self_reported';

export interface StudyEvent {
  id: string;
  actorId: string;
  type: 'study.completed';
  source: EventSource;
  occurredAt: string; // ISO UTC start time
  durationMinutes: number;
  idempotencyKey: string;
  payload: { subject: 'math_analysis'; method: Method };
}

export interface Character {
  id: string;
  mathAnalysis: number; // 0...100
  hidden: { learningAdaptation: number; associativeThinking: number }; // 0...1
  fatigue: number; // game value, not a medical measurement
  researchSessions: number;
  crossDomainSessions: number;
  crossDomainLinks: number;
  lastSettledAt: string;
}

export type Path =
  | 'character.skills.math_analysis'
  | 'character.research.math.sessions'
  | 'character.knowledge.cross_domain_links'
  | 'character.state.fatigue'
  | 'character.hidden.associative_thinking'
  | 'event.context.new_perspective';

export type Condition = { path: Path; op: 'gte' | 'lte' | 'eq'; value: number | boolean };
export interface Rule {
  id: string;
  version: number;
  enabled?: boolean;
  scope?: 'character';
  listen: 'study.completed'[];
  require: { all: Condition[] };
  chance: {
    model: 'additive';
    base: number;
    modifiers: { path: Path; weight: number }[];
    cap: number;
  };
  limit: { cooldown_days: number; window_days: number; max_attempts_per_window: number };
  effects: { type: 'encounter.create'; encounter_type: 'research_lead' }[];
}

export interface RuleAttempt {
  eventId: string;
  ruleId: string;
  version: number;
  at: string;
  probability: number;
  roll: number;
  triggered: boolean;
}
export interface Encounter {
  id: string;
  ruleId: string;
  type: 'research_lead';
  sourceEventId: string;
  source: 'system_simulated';
  ruleVersion?: number;
  status: 'pending_choice' | 'resolved';
  choice?: EncounterChoice['choice'];
  choiceEventId?: string;
  resolvedAt?: string;
  verification: 'unverified';
}
export interface EncounterChoice {
  id: string;
  actorId: string;
  encounterId: string;
  choice: 'continue_research' | 'archive';
  occurredAt: string;
  idempotencyKey: string;
}
export interface Achievement {
  definitionId: 'first_record' | 'steady_practice' | 'research_lead';
  version: 1;
  category: 'ordinary' | 'accumulation' | 'hidden';
  unlockedAt: string;
  sourceEventId: string;
  source: 'system_simulated';
}
export interface ChoiceResult {
  eventId: string;
  encounterId: string;
  choice: EncounterChoice['choice'];
  encounter: Encounter;
  newAchievements: Achievement[];
}
export type CommandRecord =
  | { type: 'study'; input: StudyEvent; result: EventResult }
  | { type: 'choice'; input: EncounterChoice; result: ChoiceResult };
export interface EventResult {
  eventId: string;
  delta: number;
  mastery: number;
  createdEncounters: Encounter[];
  attemptedRules: string[];
  newAchievements: Achievement[];
}
export interface World {
  character: Character;
  accepted: StudyEvent[];
  idempotency: Record<string, EventResult>;
  attempts: RuleAttempt[];
  encounters: Encounter[];
  achievements?: Achievement[];
  choices?: EncounterChoice[];
  commands?: Record<string, CommandRecord>;
}

const clamp = (n: number, min: number, max: number): number => Math.max(min, Math.min(max, n));
const DAY = 86_400_000;

/** Event validation checks dates, time budget and overlapping sessions. */
export function validateEvent(world: World, event: StudyEvent): string[] {
  const errors: string[] = [];
  if (event.actorId !== world.character.id) errors.push('actor_mismatch');
  if (event.type !== 'study.completed' || event.source !== 'self_reported') errors.push('unsupported_event');
  if (event.payload?.subject !== 'math_analysis' ||
      !['problem_solving', 'review', 'cross_domain'].includes(event.payload?.method)) errors.push('invalid_payload');
  const validDuration = Number.isInteger(event.durationMinutes) && event.durationMinutes >= 15 && event.durationMinutes <= 240;
  if (!validDuration) errors.push('invalid_duration');
  if (typeof event.id !== 'string' || !event.id || typeof event.idempotencyKey !== 'string' || !event.idempotencyKey) errors.push('missing_id');
  if (typeof event.occurredAt !== 'string') { errors.push('invalid_time'); return errors; }
  const start = Date.parse(event.occurredAt);
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
  const canonical = event.occurredAt.replace(/Z$/, event.occurredAt.includes('.') ? 'Z' : '.000Z');
  if (!Number.isFinite(start) || !iso.test(event.occurredAt) || new Date(start).toISOString() !== canonical) {
    errors.push('invalid_time');
    return errors;
  }
  if (!validDuration) return errors;
  const end = start + event.durationMinutes * 60_000;
  // Explicit UTC day budget for MVP; crossing midnight is disallowed to avoid ambiguity.
  if (new Date(start).toISOString().slice(0, 10) !== new Date(end - 1).toISOString().slice(0, 10)) errors.push('crosses_utc_day');
  if (start < Date.parse(world.character.lastSettledAt)) errors.push('out_of_order');
  let used = 0;
  for (const past of world.accepted) {
    const pastStart = Date.parse(past.occurredAt);
    const pastEnd = pastStart + past.durationMinutes * 60_000;
    if (past.occurredAt.slice(0, 10) === event.occurredAt.slice(0, 10)) used += past.durationMinutes;
    if (start < pastEnd && pastStart < end) errors.push('overlaps_existing_event');
    if (past.id === event.id) errors.push('duplicate_event_id');
  }
  if (used + event.durationMinutes > 240) errors.push('daily_time_budget_exceeded');
  return [...new Set(errors)];
}

/** Pure deterministic progression; no random calls or persistence. */
export function applyProgression(character: Character, event: StudyEvent): { character: Character; delta: number } {
  const hoursSince = Math.max(0, (Date.parse(event.occurredAt) - Date.parse(character.lastSettledAt)) / 3_600_000);
  const fatigueBefore = clamp(character.fatigue - 0.2 * hoursSince, 0, 100);
  const methodFactor: Record<Method, number> = { problem_solving: 1.0, review: 0.9, cross_domain: 0.8 };
  const effectiveHours = event.durationMinutes / 60;
  const adaptation = 0.75 + 0.5 * character.hidden.learningAdaptation;
  const delta = 1.1 * effectiveHours * adaptation * methodFactor[event.payload.method]
    * Math.max(0.05, 1 - character.mathAnalysis / 100)
    * (1 - 0.3 * fatigueBefore / 100);
  const crossDomainSessions = character.crossDomainSessions + Number(event.payload.method === 'cross_domain');
  const crossDomainLinks = clamp(character.crossDomainLinks + Number(
    event.payload.method === 'cross_domain' && crossDomainSessions % 3 === 0 && character.mathAnalysis >= 30
  ), 0, 50);
  return {
    delta: clamp(character.mathAnalysis + delta, 0, 100) - character.mathAnalysis,
    character: {
      ...character,
      mathAnalysis: clamp(character.mathAnalysis + delta, 0, 100),
      fatigue: clamp(fatigueBefore + effectiveHours * 1.5, 0, 100),
      researchSessions: character.researchSessions + Number(event.payload.method === 'problem_solving'),
      crossDomainSessions,
      crossDomainLinks,
      hidden: {
        learningAdaptation: clamp(character.hidden.learningAdaptation + 0.0002, 0, 1),
        associativeThinking: clamp(character.hidden.associativeThinking + (event.payload.method === 'cross_domain' ? 0.0005 : 0), 0, 1)
      },
      lastSettledAt: event.occurredAt
    }
  };
}

function readValue(path: Path, character: Character, event: StudyEvent): number | boolean {
  switch (path) {
    case 'character.skills.math_analysis': return character.mathAnalysis;
    case 'character.research.math.sessions': return character.researchSessions;
    case 'character.knowledge.cross_domain_links': return character.crossDomainLinks;
    case 'character.state.fatigue': return character.fatigue;
    case 'character.hidden.associative_thinking': return character.hidden.associativeThinking;
    case 'event.context.new_perspective': return event.payload.method === 'cross_domain';
  }
}

/** Reject malformed rules rather than executing arbitrary scripts. */
export function validateRule(rule: Rule): void {
  if (!rule || typeof rule !== 'object' || typeof rule.id !== 'string' || !rule.id || !Number.isInteger(rule.version) || rule.version < 1) throw new Error('invalid_rule_identity');
  if ((rule.enabled !== undefined && typeof rule.enabled !== 'boolean') || (rule.scope !== undefined && rule.scope !== 'character') ||
      !Array.isArray(rule.listen) || rule.listen.length !== 1 || rule.listen[0] !== 'study.completed' ||
      !rule.require || !Array.isArray(rule.require.all) || !rule.require.all.length ||
      !rule.chance || !Array.isArray(rule.chance.modifiers) || !rule.limit ||
      !Array.isArray(rule.effects) || rule.effects.length !== 1) throw new Error('invalid_rule_structure');
  if (rule.chance.model !== 'additive' || !Number.isFinite(rule.chance.base) || rule.chance.base < 0 ||
      !Number.isFinite(rule.chance.cap) || rule.chance.cap < 0 || rule.chance.cap > 1) throw new Error('invalid_probability');
  if (rule.chance.modifiers.some(m => !m || !Number.isFinite(m.weight) || m.weight < 0 ||
      !['character.hidden.associative_thinking', 'event.context.new_perspective'].includes(m.path))) throw new Error('invalid_modifier');
  if (!rule.listen.includes('study.completed') || !rule.require.all.length ||
      rule.effects.some(e => !e || e.type !== 'encounter.create' || e.encounter_type !== 'research_lead')) throw new Error('invalid_rule_structure');
  const l = rule.limit;
  if (![l.cooldown_days, l.window_days, l.max_attempts_per_window].every(Number.isInteger) ||
      l.cooldown_days < 0 || l.window_days < 1 || l.max_attempts_per_window < 1) throw new Error('invalid_limits');
  const allowed: Path[] = [
    'character.skills.math_analysis', 'character.research.math.sessions',
    'character.knowledge.cross_domain_links', 'character.state.fatigue',
    'character.hidden.associative_thinking', 'event.context.new_perspective'
  ];
  if (rule.require.all.some(c => !c || !allowed.includes(c.path) || !['gte','lte','eq'].includes(c.op) ||
      (c.path === 'event.context.new_perspective'
        ? typeof c.value !== 'boolean' || c.op !== 'eq'
        : typeof c.value !== 'number' || !Number.isFinite(c.value))) ||
      rule.chance.modifiers.some(m => !allowed.includes(m.path))) throw new Error('invalid_path_or_condition');
}

export function evaluateRules(character: Character, event: StudyEvent, rules: Rule[]): { rule: Rule; probability: number }[] {
  const identities = new Set<string>();
  for (const rule of rules) {
    validateRule(rule);
    const identity = JSON.stringify([rule.id, rule.version]);
    if (identities.has(identity)) throw new Error('duplicate_rule_identity');
    identities.add(identity);
  }
  return rules.filter(rule => rule.enabled !== false && rule.listen.includes(event.type)).flatMap(rule => {
    const passes = rule.require.all.every(c => {
      const actual = readValue(c.path, character, event);
      if (c.op === 'eq') return actual === c.value;
      if (typeof actual !== 'number' || typeof c.value !== 'number') return false;
      return c.op === 'gte' ? actual >= c.value : actual <= c.value;
    });
    if (!passes) return [];
    const raw = rule.chance.base + rule.chance.modifiers.reduce((total, m) => {
      const v = readValue(m.path, character, event);
      return total + m.weight * (typeof v === 'boolean' ? Number(v) : clamp(v, 0, 1));
    }, 0);
    return [{ rule, probability: clamp(raw, 0, rule.chance.cap) }];
  });
}

/** Injectable RNG for deterministic tests; production should persist the first roll. */
export type Roll = (key: string) => number;
export const secureRoll: Roll = () => {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return bytes[0]! / 0x1_0000_0000;
};

export function processEvent(world: World, event: StudyEvent, rules: Rule[], roll: Roll = secureRoll): { world: World; result: EventResult } {
  if (event.actorId !== world.character.id) throw new Error('actor_mismatch');
  const previous = commandAt(world, event.idempotencyKey);
  if (previous) {
    if (previous.type !== 'study') throw new Error('idempotency_conflict');
    if (!sameStudy(previous.input, event)) throw new Error('idempotency_key_conflict');
    return { world, result: structuredClone(previous.result) };
  }
  if (Object.hasOwn(world.idempotency, event.idempotencyKey)) {
    const original = world.accepted.find(past => past.idempotencyKey === event.idempotencyKey);
    if (!original || original.id !== event.id || original.type !== event.type || original.source !== event.source ||
        original.occurredAt !== event.occurredAt || original.durationMinutes !== event.durationMinutes ||
        original.payload?.subject !== event.payload?.subject || original.payload?.method !== event.payload?.method) {
      throw new Error('idempotency_key_conflict');
    }
    return { world, result: structuredClone(world.idempotency[event.idempotencyKey]!) };
  }
  if ((world.choices ?? []).some(choice => choice.id === event.id)) throw new Error('duplicate_event_id');
  const errors = validateEvent(world, event);
  if (errors.length) throw new Error(errors.join(','));
  const { character, delta } = applyProgression(world.character, event);
  const time = Date.parse(event.occurredAt);
  const candidates = evaluateRules(character, event, rules).sort((a, b) => a.rule.id.localeCompare(b.rule.id));
  const attempts: RuleAttempt[] = [];
  const encounters: Encounter[] = [];
  for (const { rule, probability } of candidates) {
    const relevant = [...world.attempts, ...attempts].filter(a => a.ruleId === rule.id);
    const newestSuccess = relevant.filter(a => a.triggered).at(-1);
    if (newestSuccess && time - Date.parse(newestSuccess.at) < rule.limit.cooldown_days * DAY) continue;
    const usedInWindow = relevant.filter(a => time - Date.parse(a.at) >= 0 &&
      time - Date.parse(a.at) < rule.limit.window_days * DAY).length;
    if (usedInWindow >= rule.limit.max_attempts_per_window) continue;
    const key = `${event.id}|${rule.id}|${rule.version}`;
    const value = roll(key);
    if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error('invalid_roll');
    const triggered = value < probability;
    attempts.push({ eventId: event.id, ruleId: rule.id, version: rule.version, at: event.occurredAt, probability, roll: value, triggered });
    if (triggered) for (const effect of rule.effects) {
      encounters.push({ id: `enc:${key}`, ruleId: rule.id, ruleVersion: rule.version, type: effect.encounter_type,
        sourceEventId: event.id, source: 'system_simulated', status: 'pending_choice', verification: 'unverified' });
    }
  }
  const accepted = [...world.accepted, structuredClone(event)];
  const newAchievements: Achievement[] = [];
  const unlock = (definitionId: Achievement['definitionId'], category: Achievement['category']) => {
    if (!(world.achievements ?? []).some(a => a.definitionId === definitionId)) {
      newAchievements.push({ definitionId, version: 1, category, unlockedAt: event.occurredAt,
        sourceEventId: event.id, source: 'system_simulated' });
    }
  };
  unlock('first_record', 'ordinary');
  if (new Set(accepted.map(e => e.occurredAt.slice(0, 10))).size >= 3) unlock('steady_practice', 'accumulation');
  newAchievements.sort((a, b) => a.definitionId.localeCompare(b.definitionId));
  const result: EventResult = { eventId: event.id, delta, mastery: character.mathAnalysis,
    createdEncounters: encounters, attemptedRules: attempts.map(a => a.ruleId), newAchievements };
  return {
    result,
    world: {
      character,
      accepted,
      idempotency: { ...world.idempotency, [event.idempotencyKey]: structuredClone(result) },
      attempts: [...world.attempts, ...attempts],
      encounters: [...world.encounters, ...structuredClone(encounters)],
      achievements: [...(world.achievements ?? []), ...structuredClone(newAchievements)],
      choices: [...(world.choices ?? [])],
      commands: { ...(world.commands ?? {}), [event.idempotencyKey]: {
        type: 'study', input: structuredClone(event), result: structuredClone(result)
      } }
    }
  };
}

export function createWorld(id: string, initialMath: number, learningAdaptation: number, associativeThinking: number,
  startAt = '2026-01-01T00:00:00.000Z'): World {
  if (![initialMath, learningAdaptation, associativeThinking].every(Number.isFinite) ||
      initialMath < 0 || initialMath > 100 || learningAdaptation < 0 || learningAdaptation > 1 ||
      associativeThinking < 0 || associativeThinking > 1) throw new Error('invalid_initial_state');
  return {
    character: {
      id, mathAnalysis: initialMath, hidden: { learningAdaptation, associativeThinking },
      fatigue: 0, researchSessions: 0, crossDomainSessions: 0, crossDomainLinks: 0, lastSettledAt: startAt
    },
    accepted: [], idempotency: {}, attempts: [], encounters: [], achievements: [], choices: [], commands: {}
  };
}


function commandAt(world: World, key: string): CommandRecord | undefined {
  return world.commands && Object.hasOwn(world.commands, key) ? world.commands[key] : undefined;
}
function sameStudy(a: StudyEvent, b: StudyEvent): boolean {
  return a.id === b.id && a.actorId === b.actorId && a.type === b.type && a.source === b.source &&
    a.occurredAt === b.occurredAt && a.durationMinutes === b.durationMinutes &&
    a.payload?.subject === b.payload?.subject && a.payload?.method === b.payload?.method &&
    a.idempotencyKey === b.idempotencyKey;
}
function sameChoice(a: EncounterChoice, b: EncounterChoice): boolean {
  return a.id === b.id && a.actorId === b.actorId && a.encounterId === b.encounterId &&
    a.choice === b.choice && a.occurredAt === b.occurredAt && a.idempotencyKey === b.idempotencyKey;
}
function validUtc(value: string): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value.replace(/Z$/, value.includes('.') ? 'Z' : '.000Z');
}

/** Resolve a simulated opportunity once, without changing real-world study history. */
export function resolveEncounter(world: World, command: EncounterChoice): { world: World; result: ChoiceResult } {
  if (command.actorId !== world.character.id) throw new Error('actor_mismatch');
  const previous = commandAt(world, command.idempotencyKey);
  if (previous) {
    if (previous.type !== 'choice' || !sameChoice(previous.input, command)) throw new Error('idempotency_conflict');
    return { world, result: structuredClone(previous.result) };
  }
  if (Object.hasOwn(world.idempotency, command.idempotencyKey)) throw new Error('idempotency_conflict');
  if (typeof command.id !== 'string' || !command.id || typeof command.idempotencyKey !== 'string' || !command.idempotencyKey) throw new Error('missing_id');
  if (!['continue_research', 'archive'].includes(command.choice)) throw new Error('invalid_choice');
  if (!validUtc(command.occurredAt)) throw new Error('invalid_time');
  const encounter = world.encounters.find(e => e.id === command.encounterId);
  if (!encounter) throw new Error('encounter_not_found');
  if (encounter.status !== 'pending_choice') throw new Error('encounter_already_resolved');
  if (world.accepted.some(e => e.id === command.id) || (world.choices ?? []).some(c => c.id === command.id)) throw new Error('duplicate_event_id');
  const source = world.accepted.find(e => e.id === encounter.sourceEventId);
  const sourceAttempts = world.attempts.filter(a => a.eventId === encounter.sourceEventId && a.ruleId === encounter.ruleId && a.triggered);
  const exactAttempt = sourceAttempts.find(a => encounter.id === `enc:${a.eventId}|${a.ruleId}|${a.version}`);
  const ruleVersion = encounter.ruleVersion ?? exactAttempt?.version ??
    (sourceAttempts.length === 1 ? sourceAttempts[0]!.version : undefined);
  if (!source || !Number.isInteger(ruleVersion) || ruleVersion! < 1) throw new Error('incomplete_encounter_state');
  if (Date.parse(command.occurredAt) < Date.parse(source.occurredAt) + source.durationMinutes * 60_000) throw new Error('choice_before_source_end');
  const resolved: Encounter = { ...encounter, ruleVersion, status: 'resolved', choice: command.choice,
    choiceEventId: command.id, resolvedAt: command.occurredAt };
  const newAchievements: Achievement[] = command.choice === 'continue_research' &&
    !(world.achievements ?? []).some(a => a.definitionId === 'research_lead') ? [{
      definitionId: 'research_lead', version: 1, category: 'hidden', unlockedAt: command.occurredAt,
      sourceEventId: command.id, source: 'system_simulated'
    }] : [];
  const result: ChoiceResult = { eventId: command.id, encounterId: command.encounterId, choice: command.choice,
    encounter: structuredClone(resolved), newAchievements: structuredClone(newAchievements) };
  return { result, world: {
    ...world,
    encounters: world.encounters.map(e => e.id === encounter.id ? resolved : e),
    achievements: [...(world.achievements ?? []), ...newAchievements],
    choices: [...(world.choices ?? []), structuredClone(command)],
    commands: { ...(world.commands ?? {}), [command.idempotencyKey]: {
      type: 'choice', input: structuredClone(command), result: structuredClone(result)
    } }
  } };
}

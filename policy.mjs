export function validateSettings(s) {
  if (!s || !['off', 'shadow', 'active'].includes(s.defaultMode)) throw Error('Invalid defaultMode');
  for (const [key, min, max] of [['timeoutMs', 100, 10000], ['maxInputChars', 1, 20000], ['continuityTtlMs', 0, 21600000]]) {
    if (!Number.isInteger(s[key]) || s[key] < min || s[key] > max) throw Error(`Invalid ${key}`);
  }
  if (typeof s.respectManualOverrides !== 'boolean') throw Error('Invalid override policy');
  if (!Number.isFinite(s.minConfidence) || s.minConfidence < 0 || s.minConfidence > 1) throw Error('Invalid confidence');
  if (typeof s.instructions !== 'string' || !s.instructions) throw Error('Missing instructions');
  for (const key of ['allowedAgents', 'allowedChannels', 'catalog']) {
    if (!Array.isArray(s[key]) || !s[key].length || s[key].some(x => typeof x !== 'string' || !x)) throw Error(`Invalid ${key}`);
  }
  if (!s.cases || Object.keys(s.cases).length < 2 || Object.keys(s.cases).length > 254) throw Error('Invalid cases');
  for (const [id, c] of Object.entries(s.cases)) {
    if (id === 'inherit' || !/^[a-z][a-z0-9_-]{0,40}$/u.test(id) || typeof c.description !== 'string' || !c.description) throw Error('Invalid case');
    if (!/^gpt-[a-z0-9.-]+$/u.test(c.model) || !s.catalog.includes(c.model)) throw Error('Unverified model');
    if (Object.hasOwn(c, 'thinking')) throw Error('Thinking is host-owned; remove legacy per-case thinking');
  }
  if (!s.cases[s.fallbackCase]) throw Error('Invalid fallbackCase');
  return s;
}
export const routeFor = (settings, id, reason, confidence) => ({ case: id, provider: 'openai',
  model: settings.cases[id].model, reason, ...(confidence !== undefined ? { confidence } : {}) });
export function buildRequest(settings, text, previous, attachmentKinds = []) {
  return { model: 'jev-latest', state: { message: text, attachmentKinds,
    previousCase: previous?.case ?? null, previousCapabilityFailures: previous?.failures ?? 0 },
    questions: { route: { type: 'choice', instructions: settings.instructions,
      criteria: { ...Object.fromEntries(Object.entries(settings.cases).map(([id, c]) => [id, c.description])),
        inherit: 'Continuation of the same task; use only when previousCase is not null.' } } } };
}
export function parseDecision(result, settings, previous) {
  const a = result?.answers?.route, fallback = reason => routeFor(settings, settings.fallbackCase, reason);
  if (a?.type !== 'choice' || typeof a.choice !== 'string' || !Number.isFinite(a.confidence)
    || a.confidence < 0 || a.confidence > 1 || !a.probabilities || typeof a.probabilities !== 'object' || Array.isArray(a.probabilities)) return fallback('invalid-jev-response');
  const expected = [...Object.keys(settings.cases), 'inherit'];
  if (Object.keys(a.probabilities).length !== expected.length || expected.some(id => !Object.hasOwn(a.probabilities, id))) return fallback('invalid-jev-distribution');
  const probs = Object.values(a.probabilities);
  if (probs.some(p => !Number.isFinite(p) || p < 0 || p > 1) || Math.abs(probs.reduce((x, y) => x + y, 0) - 1) > 0.02
    || !expected.includes(a.choice) || a.probabilities[a.choice] < Math.max(...probs) - 0.00001) return fallback('invalid-jev-distribution');
  const resolveCase = option => option === 'inherit' ? previous?.case : option;
  if (!settings.cases[resolveCase(a.choice)]) return fallback('inherit-without-state');
  // Route models, not task labels. Uncertainty among equivalent labels must not
  // force escalation. Unresolvable inherit mass is not assigned to any model.
  const groups = new Map();
  const total = probs.reduce((x, y) => x + y, 0);
  for (const option of expected) {
    const id = resolveCase(option), model = settings.cases[id]?.model;
    if (!model) continue;
    const group = groups.get(model) ?? { probability: 0, option, weight: -1 };
    group.probability += a.probabilities[option] / total;
    if (a.probabilities[option] > group.weight || (a.probabilities[option] === group.weight && option === a.choice)) {
      group.option = option; group.weight = a.probabilities[option];
    }
    groups.set(model, group);
  }
  const ranked = [...groups.values()].sort((x, y) => y.probability - x.probability);
  const best = ranked[0];
  if (!best || best.probability < settings.minConfidence ||
    (ranked[1] && Math.abs(best.probability - ranked[1].probability) < 0.00001)) return fallback('low-confidence');
  const option = best.option, id = resolveCase(option);
  return { ...routeFor(settings, id, option === 'inherit' ? 'jev-inherit' : 'jev-choice', best.probability),
    caseConfidence: a.confidence };

}
export function skipReason(event, ctx, mode, settings, entry, control) {
  if (mode === 'off') return 'disabled';
  if (!settings.allowedAgents.includes(ctx.agentId)) return 'agent-excluded';
  if (ctx.trigger !== 'user' || ctx.jobId || entry?.spawnedBy) return 'not-interactive';
  const channel = ctx.channel ?? ctx.messageProvider;
  if (!settings.allowedChannels.includes(channel)) return 'channel-excluded';
  // WebChat may omit senderId on model hooks. An owner-scoped command grants
  // routing for this exact agent/chat, not a fabricated sender identity.
  if (!ctx.senderId && !(channel === 'webchat' && control?.ownerEnabled === true && control.channel === channel)) return 'no-channel-sender';
  const kind = event.inputProvenance?.kind ?? ctx.inputProvenance?.kind;
  if (kind && kind !== 'external_user') return 'internal-provenance';
  if (ctx.modelProviderId !== 'openai') return 'not-codex-provider';
  if (entry?.modelSelectionLocked) return 'locked-model';
  if (settings.respectManualOverrides && entry?.modelOverride && entry.modelOverrideSource !== 'auto') return 'manual-model';
  if (typeof event.prompt !== 'string' || !event.prompt.trim()) return 'no-current-prompt';
  if (/^\s*\/(?:model|think|thinking|t|autoroute)(?:\s|:|$)/iu.test(event.prompt)) return 'explicit-directive';
}
export function continuityState(previous, settings, now) {
  if (!previous || !previous.route || previous.mode !== 'active' || !previous.settledAt ||
    now - previous.settledAt > settings.continuityTtlMs || previous.status !== 'output-observed' ||
    previous.observedModel !== `openai/${previous.route.model}` || !settings.cases[previous.case]) return undefined;
  if (previous.success !== true && !(previous.capabilityFailures >= 2 && previous.success === false)) return undefined;
  if (settings.cases[previous.case].model !== previous.route.model) return undefined;
  return { case: previous.case, failures: previous.success ? 0 : previous.capabilityFailures };
}
export const isShortContinuation = text => /^\s*(?:continue|go on|carry on|proceed|weiter|mach weiter|fortfahren)[.!]?\s*$/iu.test(text);
export function isCapabilityFailure(error) {
  const text = typeof error === 'string' ? error : '';
  if (/permission|authoriz|denied|quota|rate.?limit|429|network|timeout|ECONN|unavailable/iu.test(text)) return false;
  return /invalid (?:tool )?(?:arguments?|parameters?)|schema validation|structured.output|malformed (?:json|arguments?)/iu.test(text);
}

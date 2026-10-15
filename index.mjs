import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { validateSettings, skipReason, continuityState, isShortContinuation, isCapabilityFailure, routeFor } from './policy.mjs';
import { evaluate } from './jev.mjs';
import { openStore } from './state.mjs';

export function createPlugin(makeStore = openStore) { return {
  id: 'jarvis-codex-router', name: 'OpenClaw JEV Router for Codex',
  register(api) {
    const settingsPath = api.pluginConfig?.settingsPath ?? new URL('./settings.json', import.meta.url);
    const settings = async () => validateSettings(JSON.parse(await readFile(settingsPath, 'utf8')));
    const controls = makeStore({ namespace: 'controls-v1', maxEntries: 1000 });
    const routes = makeStore({ namespace: 'model-routes-v2', maxEntries: 1000, defaultTtlMs: 21600000 });
    const hash = fields => createHash('sha256').update(JSON.stringify(fields)).digest('hex');
    const controlKey = ctx => hash([ctx.agentId, ctx.sessionKey]);
    const routeKey = ctx => hash([ctx.agentId, ctx.sessionKey, ctx.sessionId]);
    const epochs = new Map(), runs = new Map(), owners = new Map(), writes = new Map();
    const epoch = ctx => epochs.get(controlKey(ctx));
    const log = fields => api.logger.info(`[codex-router] ${JSON.stringify(fields)}`);
    const serial = (key, task) => {
      const promise = (writes.get(key) ?? Promise.resolve()).catch(() => {}).then(task);
      writes.set(key, promise);
      return promise.finally(() => { if (writes.get(key) === promise) writes.delete(key); });
    };
    const update = async (ctx, mutate) => {
      if (!ctx.sessionKey || !ctx.sessionId || !ctx.runId) return;
      const key = routeKey(ctx);
      await serial(key, async () => {
        const previous = await routes.lookup(key);
        if (previous?.runId === ctx.runId) await routes.register(key, mutate(previous));
      });
    };
    api.registerCommand({ name: 'autoroute', description: 'Model routing for this chat: on, off, shadow, status, settings',
      acceptsArgs: true, requireAuth: true, requiredScopes: ['operator.write'],
      handler: async ctx => {
        if (!ctx.senderIsOwner || typeof ctx.assertOwnerCurrent !== 'function' || !ctx.sessionKey) return { text: 'Owner authorization and a chat session are required.' };
        ctx.assertOwnerCurrent();
        try {
          const s = await settings(), action = (ctx.args ?? '').trim().toLowerCase() || 'status';
          if (['on', 'off', 'shadow'].includes(action)) {
            const mode = action === 'on' ? 'active' : action;
            epochs.set(controlKey(ctx), Symbol());
            if (epochs.size > 1000) epochs.delete(epochs.keys().next().value);
            await controls.register(controlKey(ctx), { mode, ownerEnabled: true, channel: ctx.channel }, { assertCurrent: ctx.assertOwnerCurrent });
            return { text: `Automatic model routing ${mode === 'active' ? 'ON' : mode.toUpperCase()} for this chat. Thinking settings, native locks and host fallbacks are unchanged. No runtime patch is needed.` };
          }
          if (action === 'settings') return { text: Object.entries(s.cases).map(([id, c]) => `${id}: openai/${c.model}\n${c.description}`).join('\n\n') + '\n\nThinking: host-controlled, never changed by this plugin.' };
          if (action !== 'status') return { text: 'Usage: /autoroute on | off | shadow | status | settings' };
          const control = await controls.lookup(controlKey(ctx));
          const last = ctx.sessionId ? await routes.lookup(routeKey(ctx)) : undefined;
          return { text: `Automatic model routing: ${control?.mode ?? s.defaultMode} (this chat)\nThinking: unchanged (host settings)\nJEV key: ${process.env.TYPESAFE_API_KEY ? 'available' : 'missing'}\n${last?.skipReason ? `Last turn skipped: ${last.skipReason}` : last ? `Selected: openai/${last.route.model} (${last.route.reason})\nObserved: ${last.observedModel ?? 'not reported'}\nEvidence: ${last.status}${last.observedThinking ? ` · reported thinking ${last.observedThinking}` : ''}` : 'No decision recorded.'}\nPatch: not required.` };
        } catch { return { text: 'Routing settings/state unavailable; normal host selections are preserved.' }; }
      } });
    api.on('before_model_resolve', async (event, ctx) => {
      if (!ctx.sessionKey || !ctx.sessionId || !ctx.runId) return;
      const runKey = hash([ctx.agentId, ctx.sessionKey, ctx.sessionId, ctx.runId]);
      // Mark before the first await. Later invocations preserve every fallback candidate,
      // including retries to the same model. No automatic agent replay.
      if (runs.has(runKey)) return;
      for (const [id, at] of runs) if (Date.now() - at > 21600000) runs.delete(id);
      if (runs.size >= 2000) { api.logger.warn('[codex-router] run-cache-full; preserving host candidate'); return; }
      runs.set(runKey, Date.now());
      try {
        const s = await settings(), control = await controls.lookup(controlKey(ctx)), mode = control?.mode ?? s.defaultMode;
        if (mode === 'off') return;
        const entry = await api.runtime.agent.session.getSessionEntry({ agentId: ctx.agentId, sessionKey: ctx.sessionKey, readConsistency: 'latest' });
        const skip = skipReason(event, ctx, mode, s, entry, control);
        if (skip) {
          await serial(routeKey(ctx), () => routes.register(routeKey(ctx), { runId: ctx.runId, status: 'skipped', skipReason: skip }));
          log({ event: 'skip', reason: skip, channel: ctx.channel, messageProvider: ctx.messageProvider, hasSender: Boolean(ctx.senderId) }); return;
        }
        const revision = epoch(ctx), key = routeKey(ctx), owner = Symbol();
        owners.set(key, owner);
        if (owners.size > 1000) owners.delete(owners.keys().next().value);
        const previous = await routes.lookup(key), inherited = continuityState(previous, s, Date.now());
        const kinds = (event.attachments ?? []).map(a => a.kind).filter(k => typeof k === 'string');
        // Stock hook exposes host current prompt, not raw-admission text.
        // Never parse envelope markers or load extra conversation history.
        const route = inherited && previous.success && !kinds.length && isShortContinuation(event.prompt)
          ? routeFor(s, inherited.case, 'verified-short-continuation')
          : await evaluate(s, event.prompt, inherited, kinds);
        const current = () => epoch(ctx) === revision && owners.get(key) === owner;
        if (!current()) return;
        const latest = await controls.lookup(controlKey(ctx));
        if (!current() || (latest?.mode ?? s.defaultMode) !== mode) return;
        await serial(key, () => routes.register(key, { case: route.case, route, runId: ctx.runId, mode,
          status: mode === 'active' ? 'override-requested' : 'recommended', capabilityFailures: 0 },
          { assertCurrent: () => { if (!current()) throw Error('stale route'); } }));
        if (!current()) return;
        log({ event: 'selected', mode, runId: ctx.runId, case: route.case, model: route.model, reason: route.reason, modelConfidence: route.confidence, caseConfidence: route.caseConfidence });
        if (mode !== 'active') return;
        return { providerOverride: 'openai', modelOverride: route.model };
      } catch { api.logger.warn('[codex-router] settings-state-or-host-error; preserving host candidate'); }
    });
    const observe = (event, ctx, output) => update({ ...ctx, runId: event.runId ?? ctx.runId }, row => {
      if (!row.route || !event.provider || !event.model) return row;
      const observedModel = `${event.provider}/${event.model}`;
      const next = { ...row, observedModel, status: output ? 'output-observed' : 'input-observed' };
      if (observedModel !== row.observedModel) delete next.observedThinking;
      if (typeof event.reasoningEffort === 'string') next.observedThinking = event.reasoningEffort;
      log({ event: output ? 'output-observed' : 'input-observed', runId: event.runId ?? ctx.runId,
        selectedModel: `openai/${row.route.model}`, observedModel, ...(event.reasoningEffort ? { observedThinking: event.reasoningEffort } : {}) });
      return next;
    });
    api.on('llm_input', (event, ctx) => observe(event, ctx, false).catch(() => api.logger.warn('[codex-router] observation-unavailable')));
    api.on('llm_output', (event, ctx) => observe(event, ctx, true).catch(() => api.logger.warn('[codex-router] observation-unavailable')));
    api.on('after_tool_call', async (event, ctx) => {
      if (!isCapabilityFailure(event.error) || !event.toolCallId) return;
      try { await update({ ...ctx, runId: event.runId ?? ctx.runId }, row => {
        const ids = row.failureIds ?? [];
        if (ids.includes(event.toolCallId) || ids.length >= 3) return row;
        return { ...row, failureIds: [...ids, event.toolCallId], capabilityFailures: ids.length + 1 };
      }); } catch { api.logger.warn('[codex-router] failure-observation-unavailable'); }
    });
    api.on('agent_end', async (event, ctx) => {
      try { await update({ ...ctx, runId: event.runId ?? ctx.runId }, row => row.settledAt ? row :
        { ...row, settledAt: Date.now(), success: event.success }); }
      catch { api.logger.warn('[codex-router] outcome-state-unavailable'); }
    });
  },
}; }
export default createPlugin();

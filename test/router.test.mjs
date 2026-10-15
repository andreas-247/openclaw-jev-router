import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateSettings, buildRequest, parseDecision, skipReason, continuityState, isCapabilityFailure, isQuotaFailure } from '../policy.mjs';
import { evaluate } from '../jev.mjs';
import { createPlugin } from '../index.mjs';

const settings = validateSettings({ ...JSON.parse(await readFile(new URL('../settings.json', import.meta.url), 'utf8')), defaultMode: 'off' });
const result = (choice = 'simple', confidence = 0.99) => ({ answers: { route: { type: 'choice', choice, confidence,
  probabilities: Object.fromEntries([...Object.keys(settings.cases), 'inherit'].map(k => [k, k === choice ? 1 : 0])) } } });
const event = { prompt: 'Hello' };
const ctx = { trigger: 'user', channel: 'webchat', senderId: 'owner', modelProviderId: 'openai', agentId: 'main', sessionKey: 'chat-a', sessionId: 'id-a', runId: 'run-a' };
const response = data => new Response(JSON.stringify(data), { status: 200 });

test('settings reject unsupported thinking and non-Codex model routes', () => {
  const bad = structuredClone(settings); bad.cases.simple.thinking = 'high';
  assert.throws(() => validateSettings(bad));
  delete bad.cases.simple.thinking; bad.cases.simple.model = 'openrouter/deepseek';
  assert.throws(() => validateSettings(bad));
});
test('request contains only current text, route metadata and configurable cases', () => {
  const r = buildRequest(settings, 'Hi', { case: 'complex', failures: 1, secret: 'MUST NOT SEND' });
  assert.equal(r.state.previousCase, 'complex');
  assert.equal(JSON.stringify(r).includes('MUST NOT SEND'), false);
  assert.equal(r.questions.route.criteria.standard, settings.cases.standard.description);
});
test('JEV choice yields model only and never a thinking setting', () => {
  const r = parseDecision(result('complex'), settings);
  assert.equal(r.model, 'gpt-6.1-sol'); assert.equal(Object.hasOwn(r, 'thinking'), false);
});
test('inherit preserves ongoing task tier', () => {
  assert.equal(parseDecision(result('inherit'), settings, { case: 'complex' }).case, 'complex');
  assert.equal(parseDecision(result('inherit'), settings).reason, 'inherit-without-state');
});
test('low confidence, missing confidence, unknown choices and bad distributions use standard', () => {
  const uncertain = result('simple', 0.3);
  uncertain.answers.route.probabilities = {simple:0.3,routine:0.2,standard:0.25,complex:0.1,advanced:0.1,inherit:0.05};
  assert.equal(parseDecision(uncertain, settings).reason, 'low-confidence');
  for (const mutate of [r => delete r.answers.route.confidence, r => r.answers.route.choice = 'evil',
    r => r.answers.route.probabilities.simple = 0.2, r => r.answers.route.probabilities.simple = NaN]) {
    const r = result(); mutate(r); assert.equal(parseDecision(r, settings).case, 'standard');
  }
});
test('off, cron, internal provenance, missing sender, locks and explicit directives skip', () => {
  assert.equal(skipReason(event, ctx, 'off', settings), 'disabled');
  assert.equal(skipReason(event, { ...ctx, trigger: 'cron' }, 'active', settings), 'not-interactive');
  assert.equal(skipReason({ ...event, inputProvenance: { kind: 'inter_session' } }, ctx, 'active', settings), 'internal-provenance');
  assert.equal(skipReason(event, { ...ctx, senderId: undefined }, 'active', settings), 'no-channel-sender');
  assert.equal(skipReason(event, ctx, 'active', settings, {modelSelectionLocked:true}), 'locked-model');
  assert.equal(skipReason({prompt:'/think high'}, ctx, 'active', settings), 'explicit-directive');
  assert.equal(skipReason(event, ctx, 'active', settings), undefined);
});
test('on owns ordinary pins; optional respectManualOverrides preserves models, never controls thinking', () => {
  const entry={modelOverride:'gpt-6-astra',modelOverrideSource:'user',thinkingLevel:'high'};
  assert.equal(skipReason(event, ctx, 'active', settings, entry), undefined);
  assert.equal(skipReason(event, ctx, 'active', {...settings,respectManualOverrides:true}, entry), 'manual-model');
});
test('JEV request uses only approved host, ENV credential and no redirects', async () => {
  const route = await evaluate(settings, 'Hello', undefined, [], { apiKey: 'synthetic-key', fetch: async (url, init) => {
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone'); assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, 'Bearer synthetic-key');
    return response(result());
  } });
  assert.equal(route.case, 'simple');
});
test('401, invalid JSON, network failure and oversized responses use standard without error bodies', async () => {
  for (const fetch of [async () => new Response('secret error echo', { status: 401 }),
    async () => new Response('invalid'), async () => { throw Error('secret'); },
    async () => new Response('x'.repeat(70000))]) {
    const route = await evaluate(settings, 'Hello', undefined, [], { apiKey: 'synthetic', fetch });
    assert.equal(route.case, 'standard'); assert.equal(JSON.stringify(route).includes('secret'), false);
  }
});
test('timeout aborts JEV and falls back; long text is not transmitted', async () => {
  const route = await evaluate({ ...settings, timeoutMs: 15 }, 'Hello', undefined, [], { apiKey: 'synthetic', fetch: async (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(Error('abort')))) });
  assert.equal(route.reason, 'jev-timeout');
  const oversized = await evaluate(settings, 'x'.repeat(8001), undefined, [], { apiKey: 'synthetic', fetch: () => { throw Error('must not call'); } });
  assert.equal(oversized.reason, 'input-exceeds-limit');
});

function harness(existingStores, s = settings) {
  const hooks = {}, commands = {}, stores = existingStores ?? new Map(), logs = [];
  const cfgDir = mkdtempSync(join(tmpdir(), 'router-cfg-'));
  writeFileSync(join(cfgDir, 'settings.json'), JSON.stringify(s));
  const api = { pluginConfig: { settingsPath: join(cfgDir, 'settings.json') }, logger: { info: x => logs.push(x), warn: x => logs.push(x) },
    runtime: { agent: { session: { getSessionEntryAsync: async () => ({}), getSessionEntry: () => { throw Error("unexpected legacy read"); } } }, state: { openKeyedStore: opts => {
      if (!stores.has(opts.namespace)) stores.set(opts.namespace, new Map());
      const db = stores.get(opts.namespace);
      return { lookup: async key => db.get(key), register: async (key, value, options) => {
        options?.assertCurrent?.(); db.set(key, value);
      } };
    } } }, on: (name, fn) => hooks[name] = fn, registerCommand: spec => commands[spec.name] = spec };
  createPlugin(api.runtime.state.openKeyedStore).register(api);
  const owner = { ...ctx, senderIsOwner: true, assertOwnerCurrent() {} };
  return { hooks, commands, stores, logs, owner, session: api.runtime.agent.session };
}
test('owner command toggles chat only, persists through registration, and off avoids JEV', async t => {
  const h = harness(); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return response(result()); });
  const old = process.env.TYPESAFE_API_KEY; process.env.TYPESAFE_API_KEY = 'synthetic';
  t.after(() => { if (old === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = old; });
  assert.equal(await h.hooks.before_model_resolve(event, {...ctx,runId:'off-run'}), undefined); assert.equal(calls, 0);
  await h.commands.autoroute.handler({ ...h.owner, args: 'on' });
  const recreated = harness(h.stores);
  assert.match((await recreated.commands.autoroute.handler({ ...h.owner, args: 'status' })).text, /Automatic model routing: active/);
  const route = await h.hooks.before_model_resolve(event, ctx);
  assert.deepEqual(route, { providerOverride: 'openai', modelOverride: 'gpt-6-luna' });
  assert.equal(await h.hooks.before_model_resolve(event, { ...ctx, sessionKey: 'chat-b' }), undefined);
  await h.commands.autoroute.handler({ ...h.owner, args: 'off' });
  assert.equal(await h.hooks.before_model_resolve(event, ctx), undefined); assert.equal(calls, 1);
  assert.equal(h.logs.some(x => x.includes('Hello') || x.includes('synthetic')), false);
});
test('non-owner and revoked owner cannot toggle routing', async () => {
  const h = harness();
  assert.equal(h.commands.autoroute.requireAuth, true);
  // Host exposes senderIsOwner/assertOwnerCurrent only to scoped commands.
  assert.deepEqual(h.commands.autoroute.requiredScopes, ['operator.write']);
  assert.match((await h.commands.autoroute.handler({ ...h.owner, senderIsOwner: false, args: 'on' })).text, /Owner authorization/);
  await assert.rejects(h.commands.autoroute.handler({ ...h.owner, args: 'on', assertOwnerCurrent() { throw Error('revoked'); } }));
});
test('shadow does not switch model, retries reuse JEV result and reset isolates task state', async t => {
  const h = harness(); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return response(result('complex')); });
  const old = process.env.TYPESAFE_API_KEY; process.env.TYPESAFE_API_KEY = 'synthetic';
  t.after(() => { if (old === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = old; });
  await h.commands.autoroute.handler({ ...h.owner, args: 'shadow' });
  assert.equal(await h.hooks.before_model_resolve(event, ctx), undefined);
  assert.equal(await h.hooks.before_model_resolve(event, ctx), undefined); assert.equal(calls, 1);
  await h.hooks.before_model_resolve(event, { ...ctx, sessionId: 'new-id', runId: 'new-run' }); assert.equal(calls, 2);
});
test('off during JEV request invalidates result', async t => {
  const h = harness(); let release, started;
  const ready = new Promise(r => started = r);
  t.mock.method(globalThis, 'fetch', async () => { started(); return new Promise(r => release = () => r(response(result()))); });
  const old = process.env.TYPESAFE_API_KEY; process.env.TYPESAFE_API_KEY = 'synthetic';
  t.after(() => { if (old === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = old; });
  await h.commands.autoroute.handler({ ...h.owner, args: 'on' });
  const pending = h.hooks.before_model_resolve(event, ctx); await ready;
  await h.commands.autoroute.handler({ ...h.owner, args: 'off' }); release();
  assert.equal(await pending, undefined);
});

test('concurrent duplicate hook calls classify once; subsequent same/different-model retries keep host candidate', async t => {
  const h = harness(); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return response(result()); });
  const old = process.env.TYPESAFE_API_KEY; process.env.TYPESAFE_API_KEY = 'synthetic';
  t.after(() => { if (old === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = old; });
  await h.commands.autoroute.handler({ ...h.owner, args: 'on' });
  const output = await Promise.all([h.hooks.before_model_resolve(event, ctx),h.hooks.before_model_resolve(event, ctx)]);
  assert.equal(calls,1); assert.equal(output.filter(Boolean).length,1);
  assert.equal(await h.hooks.before_model_resolve(event, {...ctx,modelId:'gpt-6.1-sol'}),undefined);
  assert.equal(await h.hooks.before_model_resolve(event, {...ctx,modelProviderId:'openrouter',modelId:'fallback'}),undefined);
  assert.equal(calls,1);
});
test('observed output and successful settlement enable no-call short follow-up continuity', async t => {
  const h = harness(); let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return response(result('complex'));});
  const old=process.env.TYPESAFE_API_KEY;process.env.TYPESAFE_API_KEY='synthetic';
  t.after(()=>{if(old===undefined)delete process.env.TYPESAFE_API_KEY;else process.env.TYPESAFE_API_KEY=old;});
  await h.commands.autoroute.handler({...h.owner,args:'on'});
  await h.hooks.before_model_resolve(event,ctx);
  await h.hooks.llm_input({runId:ctx.runId,provider:'openai',model:'gpt-6.1-sol'},ctx);
  await h.hooks.llm_output({runId:ctx.runId,provider:'openai',model:'gpt-6.1-sol',reasoningEffort:'low'},ctx);
  await h.hooks.agent_end({success:true},ctx);
  const status=await h.commands.autoroute.handler({...h.owner,args:'status'});
  assert.match(status.text,/output-observed/);assert.match(status.text,/reported thinking low/);
  assert.deepEqual(await h.hooks.before_model_resolve({prompt:'continue'}, {...ctx,runId:'next'}),{providerOverride:'openai',modelOverride:'gpt-6.1-sol'});
  assert.equal(calls,1);
});
test('continuity rejects expired, changed-model, failed, shadow and unobserved suggestions', () => {
  const base={case:'complex',route:{model:settings.cases.complex.model},mode:'active',settledAt:100,status:'output-observed',observedModel:'openai/gpt-6.1-sol',success:true};
  assert.equal(continuityState(base,settings,200).case,'complex');
  for(const patch of [{mode:'shadow'},{status:'override-requested'},{observedModel:'openai/gpt-6-luna'},{success:false},{settledAt:1}]) {
    assert.equal(continuityState({...base,...patch},settings,patch.settledAt===1?settings.continuityTtlMs+2:200),undefined);
  }
});
test('permission, quota and network failures are not capability escalation signals', () => {
  for(const error of ['permission denied','invalid arguments: quota exceeded','network timeout','rate limit 429','unauthorized']) assert.equal(isCapabilityFailure(error),false);
  for(const error of ['invalid tool arguments','schema validation failed','malformed JSON']) assert.equal(isCapabilityFailure(error),true);
});
test('identical prompts in new runs classify again when previous execution is not verified', async t => {
  const h=harness();let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return response(result());});
  const old=process.env.TYPESAFE_API_KEY;process.env.TYPESAFE_API_KEY='synthetic';
  t.after(()=>{if(old===undefined)delete process.env.TYPESAFE_API_KEY;else process.env.TYPESAFE_API_KEY=old;});
  await h.commands.autoroute.handler({...h.owner,args:'on'});
  await h.hooks.before_model_resolve(event,ctx);
  await h.hooks.before_model_resolve(event,{...ctx,runId:'second-admission'});
  assert.equal(calls,2);
});
test('only stock model hook and observers are registered; no dispatch, prompt injection or thinking override', () => {
  const h=harness();
  assert.deepEqual(Object.keys(h.hooks).sort(),['before_model_resolve','llm_input','llm_output','after_tool_call','agent_end'].sort());
});

test('realistic WebChat hook without sender routes only after owner grants this exact chat', async t => {
  const h = harness(); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return response(result()); });
  const old = process.env.TYPESAFE_API_KEY; process.env.TYPESAFE_API_KEY = 'synthetic';
  t.after(() => { if (old === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = old; });
  const noSender = { ...ctx, senderId: undefined };
  assert.equal(skipReason(event, noSender, 'active', settings, {}, {ownerEnabled:true,channel:'telegram'}), 'no-channel-sender');
  assert.equal(skipReason(event, {...noSender,trigger:'cron'}, 'active', settings, {}, {ownerEnabled:true,channel:'webchat'}), 'not-interactive');
  await h.commands.autoroute.handler({ ...h.owner, args: 'on' });
  assert.deepEqual(await h.hooks.before_model_resolve(event, noSender), { providerOverride: 'openai', modelOverride: 'gpt-6-luna' });
  await h.hooks.llm_output({runId:ctx.runId,provider:'openai',model:'gpt-6-luna'},noSender);
  const status = (await h.commands.autoroute.handler({...h.owner,args:'status'})).text;
  assert.match(status,/Selected: openai\/gpt-6-luna/); assert.match(status,/Observed: openai\/gpt-6-luna/);
  assert.equal(await h.hooks.before_model_resolve(event,{...noSender,sessionKey:'other-chat'}),undefined);
  assert.equal(calls,1);
});
test('skipped turns expose their reason without pretending a decision exists', async () => {
  const h = harness(); await h.commands.autoroute.handler({...h.owner,args:'on'});
  await h.hooks.before_model_resolve(event,{...ctx,trigger:'cron'});
  assert.match((await h.commands.autoroute.handler({...h.owner,args:'status'})).text,/Last turn skipped: not-interactive/);
});

const distribution = (choice, probabilities) => ({ answers: { route: { type:'choice', choice,
  confidence: probabilities[choice], probabilities } } });
test('equivalent Luna cases aggregate instead of escalating on label uncertainty', () => {
  const r = parseDecision(distribution('simple', {simple:0.4,routine:0.35,standard:0.1,complex:0.05,advanced:0.05,inherit:0.05}), settings);
  assert.equal(r.model,'gpt-6-luna'); assert.equal(r.confidence,0.75); assert.equal(r.caseConfidence,0.4);
});
test('model group can win even when another model owns the top individual case', () => {
  const r = parseDecision(distribution('standard', {simple:0.34,routine:0.32,standard:0.34,complex:0,advanced:0,inherit:0}), settings);
  assert.equal(r.model,'gpt-6-luna'); assert.equal(r.case,'simple');
});
test('inherit mass counts only for its resolved model and cannot borrow unknown state', () => {
  const r = distribution('simple', {simple:0.4,routine:0.1,standard:0.15,complex:0.05,advanced:0.05,inherit:0.25});
  assert.equal(parseDecision(r,settings,{case:'simple'}).model,'gpt-6-luna');
  assert.equal(parseDecision(r,settings).reason,'low-confidence');
  assert.equal(parseDecision(r,settings,{case:'standard'}).reason,'low-confidence');
});
test('cross-model uncertainty, malformed distributions and model ties remain conservative', () => {
  const r = distribution('simple', {simple:0.4,routine:0.1,standard:0.35,complex:0.1,advanced:0.05,inherit:0});
  assert.equal(parseDecision(r,settings).reason,'low-confidence');
  assert.equal(parseDecision(r,{...settings,minConfidence:0.5}).model,'gpt-6-luna');
  r.answers.route.probabilities = {simple:0.4,routine:0.1,standard:0.4,complex:0.1,advanced:0,inherit:0};
  assert.equal(parseDecision(r,{...settings,minConfidence:0.5}).reason,'low-confidence');
  r.answers.route.probabilities.simple = -0.1;
  assert.equal(parseDecision(r,settings).reason,'invalid-jev-distribution');
});

const defaultActive = validateSettings({ ...settings, defaultMode: 'active' });
test('settings default active routes owner-less webchat turns; telegram needs explicit grant; per-chat off wins', async t => {
  const noSender = { ...ctx, senderId: undefined };
  assert.equal(skipReason(event, noSender, 'active', defaultActive, {}, undefined), undefined);
  const tg = { ...ctx, channel: 'telegram' };
  assert.equal(skipReason(event, tg, 'active', defaultActive, {}, undefined), 'default-outside-verified-channel');
  assert.equal(skipReason(event, tg, 'active', defaultActive, {}, { ownerEnabled: true, channel: 'telegram' }), undefined);
  assert.equal(skipReason(event, noSender, 'off', defaultActive, {}, { mode: 'off' }), 'disabled');
  const h = harness(undefined, defaultActive); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return response(result()); });
  const old = process.env.TYPESAFE_API_KEY; process.env.TYPESAFE_API_KEY = 'synthetic';
  t.after(() => { if (old === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = old; });
  assert.deepEqual(await h.hooks.before_model_resolve(event, noSender), { providerOverride: 'openai', modelOverride: 'gpt-6-luna' });
  await h.hooks.llm_output({ runId: ctx.runId, provider: 'openai', model: 'gpt-6-luna' }, noSender);
  const status = (await h.commands.autoroute.handler({ ...h.owner, args: 'status' })).text;
  assert.match(status, /Automatic model routing: active/); assert.match(status, /Observed: openai\/gpt-6-luna/);
  // The settings-level default is chat-agnostic: every webchat chat routes until
  // that chat explicitly turns routing off.
  assert.deepEqual(await h.hooks.before_model_resolve(event, { ...noSender, sessionKey: 'other-chat', runId: 'other-run' }), { providerOverride: 'openai', modelOverride: 'gpt-6-luna' });
  assert.equal(calls, 2);
  await h.commands.autoroute.handler({ ...h.owner, args: 'off' });
  assert.equal(await h.hooks.before_model_resolve(event, { ...noSender, runId: 'post-off' }), undefined);
  assert.equal(calls, 2);
});


test('quota detector is definitive and settings remain backward-compatible', () => {
  for (const e of ['You have reached your usage limit', "You've hit your usage limit", 'Usage limit reached', 'quota exceeded', {code:'insufficient_quota'}, {error:{code:'usage_limit_reached'}}]) assert.equal(isQuotaFailure(e), true);
  for (const e of ['rate limit exceeded', '429 Too Many Requests', 'network timeout', 'permission denied', 'invalid arguments', undefined, {status:429}]) assert.equal(isQuotaFailure(e), false);
  const legacy = {...settings}; delete legacy.autoDisableOnQuota; delete legacy.quotaCooldownMs;
  assert.equal(validateSettings(legacy).autoDisableOnQuota, false);
  for (const patch of [{autoDisableOnQuota:'true'},{quotaCooldownMs:-1},{quotaCooldownMs:Infinity}]) assert.throws(()=>validateSettings({...settings,...patch}));
});

test('quota auto-off is persistent, per-chat, opt-in and preserves subsequent host candidates', async t => {
  t.mock.method(globalThis, 'fetch', async () => response(result()));
  const oldKey = process.env.TYPESAFE_API_KEY; process.env.TYPESAFE_API_KEY = 'synthetic';
  t.after(() => { if (oldKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = oldKey; });
  const h = harness(undefined, {...settings, defaultMode:'active', autoDisableOnQuota:true});
  await h.hooks.before_model_resolve(event, ctx);
  await h.hooks.agent_end({success:false,error:'usage limit reached'},ctx);
  const status = (await h.commands.autoroute.handler({...h.owner,args:'status'})).text;
  assert.match(status,/off .*auto-disabled: quota/);
  const recreated = harness(h.stores,{...settings,defaultMode:'active',autoDisableOnQuota:true});
  assert.equal(await recreated.hooks.before_model_resolve(event,{...ctx,runId:'next'}),undefined);
  assert.equal(await recreated.hooks.before_model_resolve(event,{...ctx,runId:'fallback',modelProviderId:'openrouter'}),undefined);
  assert.ok(await recreated.hooks.before_model_resolve(event,{...ctx,sessionKey:'other',runId:'other'}));
  await recreated.commands.autoroute.handler({...h.owner,args:'on'});
  assert.doesNotMatch((await recreated.commands.autoroute.handler({...h.owner,args:'status'})).text,/auto-disabled/);
  assert.ok(await recreated.hooks.before_model_resolve(event,{...ctx,runId:'manual-on'}));
});

test('transient, tool, shadow, disabled-feature, stale-run and changed-control errors cannot suspend routing', async t => {
  t.mock.method(globalThis, 'fetch', async () => response(result()));
  const oldKey = process.env.TYPESAFE_API_KEY; process.env.TYPESAFE_API_KEY = 'synthetic';
  t.after(() => { if (oldKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = oldKey; });
  for (const kind of ['transient','tool','shadow','opt-out','stale','manual-on','manual-off','success','fallback']) {
    const h = harness(undefined,{...settings,autoDisableOnQuota:kind!=='opt-out'});
    await h.commands.autoroute.handler({...h.owner,args:kind==='shadow'?'shadow':'on'});
    await h.hooks.before_model_resolve(event,ctx);
    if (kind==='manual-on' || kind==='manual-off') await h.commands.autoroute.handler({...h.owner,args:kind==='manual-on'?'on':'off'});
    if (kind==='fallback') await h.hooks.llm_input({provider:'openrouter',model:'other'},ctx);
    if (kind==='tool') await h.hooks.after_tool_call({error:'quota exceeded',toolCallId:'x'},ctx);
    else await h.hooks.agent_end({success:kind==='success',error:kind==='transient'?'429 rate limit exceeded':'quota exceeded'},kind==='stale'?{...ctx,runId:'old'}:ctx);
    assert.doesNotMatch((await h.commands.autoroute.handler({...h.owner,args:'status'})).text,/auto-disabled/,kind);
  }
});

test('cooldown restores explicit activation even with default off, without overriding manual off', async t => {
  t.mock.method(globalThis, 'fetch', async () => response(result()));
  const oldKey = process.env.TYPESAFE_API_KEY; process.env.TYPESAFE_API_KEY = 'synthetic';
  t.after(() => { if (oldKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = oldKey; });
  let now = Date.now(); t.mock.method(Date,'now',()=>now);
  const h = harness(undefined,{...settings,autoDisableOnQuota:true,quotaCooldownMs:1000});
  await h.commands.autoroute.handler({...h.owner,args:'on'});
  await h.hooks.before_model_resolve(event,ctx);
  await h.hooks.agent_end({success:false,error:'quota exceeded'},ctx);
  assert.match((await h.commands.autoroute.handler({...h.owner,args:'status'})).text,/until/);
  assert.equal(await h.hooks.before_model_resolve(event,{...ctx,runId:'before-expiry'}),undefined);
  now+=1001;
  assert.ok(await h.hooks.before_model_resolve(event,{...ctx,runId:'expired'}));
  await h.hooks.agent_end({success:false,error:'quota exceeded'},{...ctx,runId:'expired'});
  await h.commands.autoroute.handler({...h.owner,args:'off'});
  now+=1001;
  assert.equal(await h.hooks.before_model_resolve(event,{...ctx,runId:'manual-off'}),undefined);
});


test('prefers async session reader, awaits native locks and never calls legacy reader', async () => {
  const h = harness();
  await h.commands.autoroute.handler({ ...h.owner, args: 'on' });
  let calls = 0;
  h.session.getSessionEntry = () => { throw Error('legacy reader must not run'); };
  h.session.getSessionEntryAsync = async function (params) {
    assert.equal(this, h.session);
    assert.deepEqual(params, { agentId: ctx.agentId, sessionKey: ctx.sessionKey, readConsistency: 'latest' });
    await new Promise(resolve => setImmediate(resolve));
    calls++;
    return { modelSelectionLocked: true };
  };
  assert.equal(await h.hooks.before_model_resolve(event, ctx), undefined);
  assert.equal(calls, 1);
  assert.match((await h.commands.autoroute.handler({ ...h.owner, args: 'status' })).text, /locked-model/);
});

test('async reader failures preserve host candidate without legacy retry or classification', async t => {
  const h = harness();
  await h.commands.autoroute.handler({ ...h.owner, args: 'on' });
  h.session.getSessionEntryAsync = async () => { throw Error('read failed'); };
  h.session.getSessionEntry = () => { assert.fail('must not retry legacy'); };
  t.mock.method(globalThis, 'fetch', () => { assert.fail('must not classify'); });
  assert.equal(await h.hooks.before_model_resolve(event, ctx), undefined);
  assert.ok(h.logs.some(line => line.includes('preserving host candidate')));
});

test('released-host synchronous reader retains native lock protection', async () => {
  const h = harness();
  delete h.session.getSessionEntryAsync;
  await h.commands.autoroute.handler({ ...h.owner, args: 'on' });
  h.session.getSessionEntry = function (params) {
    assert.equal(this, h.session);
    assert.equal(params.readConsistency, 'latest');
    return { modelSelectionLocked: true };
  };
  assert.equal(await h.hooks.before_model_resolve(event, ctx), undefined);
  assert.match((await h.commands.autoroute.handler({ ...h.owner, args: 'status' })).text, /locked-model/);
});

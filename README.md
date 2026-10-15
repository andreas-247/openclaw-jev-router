# OpenClaw JEV Router for Codex

Model-only routing for OpenClaw, powered by TypeSafe JEV. Choose a model per
interactive turn without asking the main assistant to classify its own workload.

**Early release:** tested against OpenClaw 2026.9.9 and Node.js 24.21.0. Native
Codex/WebChat delivered responses have been verified for small talk, a simple
calculation and a weather lookup. Other channel/environment combinations require
local acceptance testing. This is a community plugin, not an official OpenClaw,
OpenAI or TypeSafe product.

## What it does

- Owner-controlled `/autoroute on`, `off`, `shadow`, `status`, and `settings` per chat.
- Routes simple/routine tasks to Luna, standard/complex work to Sol, and exceptional
  tasks to Astra by default. Cases and model names are editable.
- Combines JEV probability across categories mapped to the same model.
- Preserves native locks, delivery and thinking settings; the host controls fallback eligibility.
- Persists chat controls and bounded route observations in private SQLite storage.
- Classifies once per initial run; never automatically replays an agent task.

**It does not route thinking effort.** Your host/session thinking settings remain
in effect. It does not provision model access or guarantee quota/cost savings.

## Supported models and providers

This release is **Codex/OpenAI-only**, not a provider-agnostic router. Routing is
restricted to OpenClaw's `openai` provider and configurable `gpt-*` model IDs.
Anthropic/Claude, Gemini, local models and other providers are not supported.
Only the default Luna/Sol/Astra setup has received live delivery verification.

## Requirements

- OpenClaw plugin API >=2026.9.9.
- Node.js >=22.13 with `node:sqlite`; verified runtime: Node.js 24.21.0.
- OpenClaw's `openai` provider configured with access to your chosen models.
- A TypeSafe JEV API key supplied as `TYPESAFE_API_KEY` to the Gateway runtime.
  Each classification calls an external service; its usage/terms are separate.
- Owner command authorization and explicit conversation-hook access.

## Privacy — read before enabling

Active **and shadow** modes send the **host-provided current prompt** to
`https://api.typesafe.ai/v1/systemone`. The hook may include host-added context;
do not assume it contains only your last typed sentence. Attachment kind labels,
the eligible prior case and a bounded failure count are also sent. The plugin
neither loads extra transcript history nor independently reads attachment files.
OFF makes no classifier call. See [SECURITY.md](SECURITY.md).

## Install

Once the ClawHub release is public:

```bash
openclaw plugins install clawhub:@andreas-247/openclaw-jev-router
```

Alternatively, clone this repository and install locally:

```bash
git clone https://github.com/andreas-247/openclaw-jev-router.git
cd openclaw-jev-router
npm test
openclaw plugins install --link .
```

The runtime plugin ID is **`jarvis-codex-router`** (retained for compatibility).
Do not install two copies with this ID.

Merge these fields into your existing OpenClaw configuration; preserve unrelated
entries and append to an existing `plugins.allow` array rather than replacing it:

```json
{
  "plugins": {
    "allow": ["jarvis-codex-router"],
    "entries": {
      "jarvis-codex-router": {
        "enabled": true,
        "config": {
          "settingsPath": "/absolute/path/to/your/router-settings.json"
        },
        "hooks": {
          "allowConversationAccess": true,
          "allowPromptInjection": false,
          "timeouts": {"before_model_resolve": 6000}
        }
      }
    }
  }
}
```

Copy the repository's `settings.json` to that persistent settings path first.
Keep credentials out of this file. Validate with `openclaw config validate` and
use your installation's supported plugin reload workflow. A managed reload may
wait for active turns; do not assume code is live until it reports success.

Default mode is **off**. In an owner-operated test chat, start with:

```text
/autoroute shadow
Hello
/autoroute status
/autoroute on
Calculate a circle's circumference with radius 200 km.
/autoroute status
```

Shadow records a recommendation but does not request a model switch. Status
separates **Selected** from **Observed**; only output-observed is execution
telemetry, and even that does not prove the answer is correct. Use
`/autoroute off` to stop routing for that chat.

## Settings

`settings.json` is validated and reread on each initial selection and command.
Use an external persistent copy to preserve customization across package updates.

| Case | Default model |
| --- | --- |
| simple, routine | openai/gpt-6-luna |
| standard, complex | openai/gpt-6.1-sol |
| advanced | openai/gpt-6-astra |

- `catalog` and `cases`: edit both when choosing different supported `gpt-*`
  models. Provider is currently restricted to `openai`; arbitrary providers and
  per-case thinking fields are not supported.
- `allowedAgents`: default `["main"]`; list your actual agent IDs.
- `allowedChannels`: default `["webchat", "telegram"]`. WebChat was live-tested;
  other channels need local acceptance testing. Jobs/subagent and known internal
  inputs are excluded. The stock hook does not guarantee full ingress provenance.
- `defaultMode`: off unless explicitly changed. Default-active applies to WebChat;
  other channels still require an explicit per-chat owner grant. Per-chat OFF wins.
- `respectManualOverrides`: false by default, so active routing owns ordinary model
  pins. Set true to preserve them. Native model locks always win.
- `minConfidence`: 0.65 at model-group level; cross-model uncertainty, ties,
  missing keys and classifier errors use `fallbackCase` (standard/Sol).
- `timeoutMs`: 3500; `maxInputChars`: 8000. Oversized input is not sent to JEV.
- `continuityTtlMs`: two hours. Exact short continuations may reuse a settled,
  successfully observed route without a classifier call.

Controls/state live in
`$OPENCLAW_STATE_DIR/plugin-state/jarvis-codex-router/router.sqlite`, falling back
to `~/.openclaw/plugin-state/jarvis-codex-router/router.sqlite`. Prompts, answers
and API keys are not persisted by this plugin. State/control keys are hashed;
route logs can include run identifiers.

## Session-reader compatibility

The router prefers `api.runtime.agent.session.getSessionEntryAsync` when the host
provides it. Released hosts through OpenClaw 2026.10.3 expose only the legacy
reader, which remains a compatibility fallback. Static inspectors may still flag
that fallback as deprecated; this release does not claim all deprecation warnings
are removed. A failed async read preserves host selection without retrying the
legacy reader. Native model locks remain checked on both paths.

## Development and verification

No build step or runtime dependencies are required.

```bash
npm test
node cli.mjs 'Hello'           # preview request, no external call
node cli.mjs --live 'Hello'    # synthetic live classification; uses JEV key
npm pack --dry-run
```

The tests mock classifier responses and exercise owner permissions, race handling,
fallback preservation, WebChat identity, model-group confidence and SQLite state.
They do not call external models. A live classifier result is not proof of a
real delivered agent response. Benchmark representative tasks before broad use.

Disable the plugin through your supported OpenClaw plugin controls for full
removal. No core patch, custom image, fallback-chain edit or separate service is
required. Preserve unrelated config and retain private state only if desired.

## License

[MIT](LICENSE), copyright 2026 Andreas (andreas-247).

## Quota exhaustion and host fallbacks

Some OpenClaw versions disable configured fallbacks when a plugin overrides the
model. The router cannot recover or replay the currently failing turn.

Set `autoDisableOnQuota: true` in your persistent settings to suspend active
routing for that chat after a definitive usage-limit/quota failure. Default is
`false`; generic HTTP 429/rate-limit errors do not trigger suspension. Only failed
routed agent runs qualify, not tool errors, shadow runs, or unrelated fallbacks.
Subsequent turns request no override, allowing the host default and its configured
fallback policy to operate. This does not guarantee host fallback success.

`quotaCooldownMs` defaults to `0` (manual `/autoroute on` required), and accepts up
to 30 days in milliseconds. A positive value restores the prior activation mode
on the first selection/status check after expiry, not at a guaranteed quota reset.
Manual ON/OFF/shadow takes precedence over cooldown or delayed run errors.
`/autoroute status` reports quota suspension and its optional expiry. No error
text is stored or sent to JEV. This is availability recovery, not stronger-model
escalation or a correctness guarantee.

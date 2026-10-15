# Axeon JEV Router

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
- Preserves native locks, host fallback decisions, delivery and thinking settings.
- Persists chat controls and bounded route observations in private SQLite storage.
- Classifies once per initial run; never automatically replays an agent task.

**It does not route thinking effort.** Your host/session thinking settings remain
in effect. It does not provision model access or guarantee quota/cost savings.

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
openclaw plugins install clawhub:@axeon-at/openclaw-jev-router
```

Alternatively, clone this repository and install locally:

```bash
git clone https://github.com/axeon-at/openclaw-jev-router.git
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
- `defaultMode`: off unless you explicitly change it; prefer per-chat activation.
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

[MIT](LICENSE), copyright 2026 Axeon.

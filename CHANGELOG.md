# Changelog

## 0.2.6 — Quota suspension and configurable defaults

- Opt-in per-chat auto-disable after definitive routed-run quota exhaustion.
- Optional cooldown restores previous activation; manual controls take precedence.
- Ignore transient 429s, tool errors, shadow runs and stale/changed controls.
- Status displays quota suspension; no failed-turn replay or fallback guarantee.
- Include 0.2.5 default-active WebChat support; public default remains OFF.
- Keep host fallback limitations explicit.

## 0.2.4 — Public naming clarification

- Publish under the personal GitHub account andreas-247.
- Rename public display name to OpenClaw JEV Router for Codex.
- Explicitly document the existing OpenAI-provider/GPT-model restriction.
- No routing behavior changes.

## 0.2.3 — First public release

- Model-only routing through OpenClaw's stock before_model_resolve hook.
- JEV classification with probability grouped by destination model.
- Owner-scoped per-chat on/off/shadow/status/settings commands.
- Persistent private SQLite controls and selected-versus-observed telemetry.
- WebChat support when owner-enabled model hooks omit sender identity.
- Host thinking, native model locks, delivery and fallback chains preserved.

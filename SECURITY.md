# Security and privacy

Report suspected vulnerabilities privately through GitHub private vulnerability
reporting when enabled. If unavailable, open a minimal issue requesting a private
contact without exploit details, credentials, prompts or personal information.

When routing is active or in shadow mode, the host-provided current prompt is
sent to https://api.typesafe.ai/v1/systemone using TYPESAFE_API_KEY. The prompt
may include host-added context, not just the last sentence typed by a user.
Attachment kind labels, the eligible prior route label and a bounded failure
count are also sent; attachment files are not independently read by this plugin.
Review TypeSafe's terms and data handling before enabling it for sensitive chats.

The plugin does not log prompt/answer text or API keys. Route metadata and bounded
identifiers are logged locally. Controls and route observations are stored in a
plugin-owned SQLite file with mode 0600. The containing directory is created with
mode 0700; existing directory permissions are not tightened automatically.

There are no runtime npm dependencies, shell execution, dynamic code downloads,
or task replay. The JEV request has a timeout, a response-size cap, no redirects
and no automatic retries. Missing keys, malformed results and classifier failures
use the configured fallback case. Host/settings/storage errors preserve the host
candidate. A classifier confidence score is not a guarantee of answer correctness.

Native model locks always win. Ordinary model pins may be overridden in active
mode unless respectManualOverrides is enabled. Thinking is never changed.
Default routing mode is off. Enabling the plugin does not activate every chat.

Optional `autoDisableOnQuota` suspends a chat after a definitive failed routed
run. It stores only reason/timestamps and previous control metadata, never error
text. Generic transient rate limits and tool errors cannot suspend routing.
It does not rescue the failed turn or replay actions. Subsequent turns use host
selection and fallback policy; availability and correctness are not guaranteed.
Cooldown is optional and manual controls always take precedence.

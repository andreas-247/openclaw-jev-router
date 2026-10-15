import { buildRequest, parseDecision, routeFor } from './policy.mjs';
export async function evaluate(settings, text, previous, attachmentKinds = [], options = {}) {
  const fallback = reason => routeFor(settings, settings.fallbackCase, reason);
  const apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY;
  if (!apiKey) return fallback('jev-key-unavailable');
  if (text.length > settings.maxInputChars) return fallback('input-exceeds-limit');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), settings.timeoutMs);
  try {
    const response = await (options.fetch ?? fetch)('https://api.typesafe.ai/v1/systemone', {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(buildRequest(settings, text, previous, attachmentKinds)), signal: controller.signal, redirect: 'error' });
    if (!response.ok) { await response.body?.cancel(); return fallback(`jev-http-${response.status}`); }
    let raw = '', bytes = 0;
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > 65536) { controller.abort(); return fallback('jev-response-too-large'); }
      raw += decoder.decode(chunk, { stream: true });
    }
    raw += decoder.decode();
    return parseDecision(JSON.parse(raw), settings, previous);
  } catch { return fallback(controller.signal.aborted ? 'jev-timeout' : 'jev-request-failed'); }
  finally { clearTimeout(timer); }
}

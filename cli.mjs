import { readFile } from 'node:fs/promises';
import { validateSettings, buildRequest } from './policy.mjs';
import { evaluate } from './jev.mjs';
const args = process.argv.slice(2), live = args[0] === '--live';
if (live) args.shift();
const text = args.join(' ');
if (!text) { console.error('Usage: node cli.mjs [--live] <task text>'); process.exitCode = 2; }
else {
  const settings = validateSettings(JSON.parse(await readFile(new URL('./settings.json', import.meta.url), 'utf8')));
  console.log(JSON.stringify(live ? await evaluate(settings, text) : buildRequest(settings, text), null, 2));
}

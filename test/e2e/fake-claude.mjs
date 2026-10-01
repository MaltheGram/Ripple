#!/usr/bin/env node
// Stand-in for the `claude` CLI in e2e tests: canned structured output per schema, and logs its argv.
import { appendFileSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const logFile = process.env.BR_FAKE_CLAUDE_LOG;

if (args[0] === 'auth') {
  process.stdout.write(JSON.stringify({ loggedIn: true }));
  process.exit(0);
}

const input = readFileSync(0, 'utf8');
if (logFile) appendFileSync(logFile, JSON.stringify({ args, input }) + '\n');
const schema = args[args.indexOf('--json-schema') + 1] ?? '';
let out;
if (schema.includes('"groups"')) {
  const files = [...input.matchAll(/^- [AMDR] (\S+) \([^)]*\)$/gm)].map((m) => m[1]);
  out = {
    summary: '- Adds pagination to orders.',
    groups: [
      { title: 'Types', why: 'Contracts first.', files: files.filter((f) => f.includes('dto')) },
      { title: 'Core logic', why: 'Then the service.', files: files.filter((f) => f.includes('service') || f.includes('math')) },
    ],
    risks: [{ file: 'src/app.service.ts', line: 4, severity: 'high', category: 'error handling', note: 'No bounds check on pageSize.' }],
  };
} else if (schema.includes('"comments"')) {
  const line = Number(/^\s*(\d+) \+/m.exec(input)?.[1] ?? 1);
  out = { comments: [{ line, severity: 'issue', body: 'Is 20 the right default?' }] };
} else if (schema.includes('"verdict"')) {
  out = {
    verdict: 'affected',
    summary: 'handle() is unchanged but calls sum3, whose body changed.',
    effects: [{ kind: 'behavior', description: 'Result now comes from the new sum3.', cause: { file: 'src/app.service.ts', line: 16, symbol: 'sum3' } }],
    checks: ['Confirm sum3 still returns the same total.'],
  };
} else if (schema.includes('"markdown"')) {
  out = { markdown: 'Still adds them. See `src/app.service.ts:16`.' };
} else {
  out = {};
}
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(out), structured_output: out }));

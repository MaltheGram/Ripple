// Build the extension + e2e suite, then run the suite inside a real VS Code instance.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { runTests } from '@vscode/test-electron';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

await esbuild.build({
  entryPoints: [path.join(root, 'test/e2e/suite.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outfile: path.join(root, 'dist-test/suite.js'),
  external: ['vscode'],
  logLevel: 'warning',
});

const scratch = mkdtempSync(path.join(tmpdir(), 'br-vscode-'));
await runTests({
  extensionDevelopmentPath: root,
  extensionTestsPath: path.join(root, 'dist-test/suite.js'),
  launchArgs: [scratch, '--disable-extensions', '--skip-welcome', '--skip-release-notes', `--user-data-dir=${path.join(scratch, '.user')}`],
  extensionTestsEnv: { BR_E2E_PAUSE_MS: process.env.BR_E2E_PAUSE_MS ?? '' },
});

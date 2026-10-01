import { copyFileSync, mkdirSync } from 'node:fs';
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

// The webview HTML is a template filled in by the extension (CSP nonce, script URI).
const copyHtml = {
  name: 'copy-trace-html',
  setup(build) {
    build.onEnd(() => {
      mkdirSync('dist/webview', { recursive: true });
      copyFileSync('src/webview/trace.html', 'dist/webview/trace.html');
    });
  },
};

const webview = await esbuild.context({
  entryPoints: ['src/webview/trace.ts'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  outfile: 'dist/webview/trace.js',
  plugins: [copyHtml],
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
});

const ctx = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
});

if (watch) {
  await Promise.all([ctx.watch(), webview.watch()]);
} else {
  await Promise.all([ctx.rebuild(), webview.rebuild()]);
  await Promise.all([ctx.dispose(), webview.dispose()]);
}

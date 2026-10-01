import * as vscode from 'vscode';

let channel: vscode.LogOutputChannel | undefined;

/** "Ripple" in the Output panel. */
export function log(): vscode.LogOutputChannel {
  channel ??= vscode.window.createOutputChannel('Ripple', { log: true });
  return channel;
}

/** Run `fn` and log how long it took, so slow steps are visible in the Output panel. */
export async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    log().info(`${label}: ${Date.now() - start} ms`);
  }
}

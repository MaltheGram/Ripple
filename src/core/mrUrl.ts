import type { MrRef } from './types';

/** Parse `https://gitlab.com/group/sub/project/-/merge_requests/123[/diffs…]`. */
export function parseMrUrl(input: string): MrRef | undefined {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return undefined;
  }
  const m = /^\/(.+?)\/-\/merge_requests\/(\d+)/.exec(url.pathname);
  if (!m) return undefined;
  return { baseUrl: url.origin, projectPath: decodeURIComponent(m[1]), iid: Number(m[2]) };
}

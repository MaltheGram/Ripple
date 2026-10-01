import { isTestPath } from './classify';

export type Layer =
  | 'component'
  | 'hook'
  | 'api'
  | 'controller'
  | 'service'
  | 'repository'
  | 'entity'
  | 'dto'
  | 'migration'
  | 'job'
  | 'module'
  | 'test'
  | 'util'
  | 'other';

export const LAYER_LABEL: Record<Layer, string> = {
  component: 'Component',
  hook: 'Hook',
  api: 'API endpoint',
  controller: 'Controller',
  service: 'Service',
  repository: 'Repository',
  entity: 'Entity',
  dto: 'DTO',
  migration: 'Migration',
  job: 'Job',
  module: 'Module',
  test: 'Test',
  util: 'Util',
  other: 'Code',
};

/** App or library a file belongs to: `apps/orders-service/…` → `orders-service`. */
export function appOf(path: string): string {
  const parts = path.split('/');
  if (['apps', 'libs', 'packages', 'services'].includes(parts[0]) && parts.length > 2) return parts[1];
  return parts.length > 1 ? parts[0] : '(root)';
}

/** Architectural role of a function from its file, name and class. */
export function layerOf(path: string, name: string, container?: string): Layer {
  const p = path.toLowerCase();
  const c = container ?? '';
  if (isTestPath(path)) return 'test';
  if (/(^|\/)migrations?\//.test(p)) return 'migration';
  if (/^use[A-Z]/.test(name)) return 'hook';
  if (/\.(tsx|jsx)$/.test(p) && /^[A-Z]/.test(name) && !c) return 'component';
  if (/controller|resolver|gateway/.test(p) || /(Controller|Resolver|Gateway)$/.test(c)) return 'controller';
  if (/repositor(y|ies)/.test(p) || /Repository$/.test(c)) return 'repository';
  if (/(job|cron|processor|consumer|worker|listener|scheduler)s?(\.|\/)/.test(p) || /(Job|Processor|Consumer|Worker|Listener)$/.test(c)) return 'job';
  if (/\.entity\.|(^|\/)entit(y|ies)\//.test(p)) return 'entity';
  if (/(^|\/|\.)dtos?(\.|\/)/.test(p)) return 'dto';
  if (/\.module\./.test(p)) return 'module';
  if (/service/.test(p) || /Service$/.test(c)) return 'service';
  if (/(^|\/)(api|apis)\//.test(p) || /api\.(ts|js)$/.test(p)) return 'api';
  if (/(^|\/)(utils?|helpers?|lib)\//.test(p)) return 'util';
  if (/\.(tsx|jsx)$/.test(p)) return /^[A-Z]/.test(name) ? 'component' : 'other';
  return 'other';
}

/** Layers where walking further up rarely helps (auto-expansion stops there). */
export function isEntryLayer(l: Layer): boolean {
  return l === 'test' || l === 'job' || l === 'migration' || l === 'module';
}

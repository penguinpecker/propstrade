// Module registry. Modules live in ./<name>/index.ts and default-export a ModuleRegister; they are registered in
// dependency order and each one's service lands on ctx.services[name]. A module whose folder does not exist yet is
// reported as absent and the server starts without it; a module that exists but fails to load stops startup.
import { existsSync } from 'node:fs';
import type { ModuleContext, ModuleRegister } from './types.js';

const MODULE_NAMES = ['marketdata', 'sim', 'chain', 'keeper'] as const;
export type ModuleName = (typeof MODULE_NAMES)[number];
export type ModuleStatus = Map<ModuleName, 'running' | 'absent'>;

export async function registerModules(ctx: ModuleContext, status: ModuleStatus, dir = new URL('./', import.meta.url)): Promise<void> {
  for (const name of MODULE_NAMES) {
    if (!existsSync(new URL(`${name}/`, dir))) {
      ctx.log.warn({ module: name }, 'module not present, starting without it');
      status.set(name, 'absent');
      continue;
    }
    const mod = (await import(new URL(`${name}/index.js`, dir).href)) as { default: ModuleRegister<unknown> };
    (ctx.services as Record<string, unknown>)[name] = await mod.default(ctx);
    status.set(name, 'running');
    ctx.log.info({ module: name }, 'module registered');
  }
}

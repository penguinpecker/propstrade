// Test double for the registry: registers a route and returns a service object.
import type { ModuleRegister } from '../../../../src/modules/types.js';

const register: ModuleRegister<{ name: string; aborted: () => boolean }> = async (ctx) => {
  ctx.app.get('/v1/fixture-module', async () => ({ ok: true }));
  return { name: 'fixture-marketdata', aborted: () => ctx.signal.aborted };
};
export default register;

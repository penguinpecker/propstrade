// Test double for the registry: a present module whose registration fails.
import type { ModuleRegister } from '../../../../src/modules/types.js';

const register: ModuleRegister<never> = async () => {
  throw new Error('upstream unreachable');
};
export default register;

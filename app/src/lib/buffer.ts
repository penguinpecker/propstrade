// Anchor's account coder and @props/sdk read the Node `Buffer` global, which browsers do not have.
// chain.ts imports this module first so the global exists before either one loads.
import { Buffer } from 'buffer';

(globalThis as { Buffer?: typeof Buffer }).Buffer ??= Buffer;

// Anchor's account coder and @props/sdk read the Node `Buffer` global, which browsers do not have.
// chain.ts and privy-bridge.ts (Privy's Solana signing reads it too) import this module first so the global exists before
// anything that needs it loads.
import { Buffer } from 'buffer';

(globalThis as { Buffer?: typeof Buffer }).Buffer ??= Buffer;

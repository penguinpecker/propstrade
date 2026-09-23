// Node entry: loads the wasm-bindgen nodejs build synchronously.
import { createRequire } from 'node:module';
import { createModel, type Bindings } from './model.ts';

export * from './model.ts';

const bindings = createRequire(import.meta.url)('../pkg-node/props_gmsol.js') as Bindings;

export const model = createModel(bindings);

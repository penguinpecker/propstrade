// Browser entry: the web build must be instantiated before use.
import init, * as bindings from '../pkg-web/props_gmsol.js';
import { createModel, type Model } from './model.ts';

export * from './model.ts';

/** `wasm` defaults to fetching props_gmsol_bg.wasm next to the module; bundlers may pass a URL or bytes. */
export async function loadModel(wasm?: URL | string | BufferSource): Promise<Model> {
  await init(wasm === undefined ? undefined : { module_or_path: wasm });
  return createModel(bindings);
}

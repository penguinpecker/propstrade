// IDL-driven account decoder for Anchor 0.30+ IDLs. Zero-copy (bytemuck, repr C) accounts in
// gmsol_store declare their padding explicitly, so the same sequential layout decodes them.
import { base58Encode } from './solana.ts';

export type IdlType =
  | string
  | { array: [IdlType, number] }
  | { defined: { name: string } }
  | { option: IdlType }
  | { vec: IdlType };

interface IdlField { name: string; type: IdlType }
export interface IdlTypeDef {
  name: string;
  type: { kind: 'struct'; fields?: IdlField[] } | { kind: 'enum'; variants: { name: string; fields?: unknown }[] };
}
export interface Idl {
  accounts?: { name: string; discriminator: number[] }[];
  types?: IdlTypeDef[];
}

export type Decoded = bigint | number | boolean | string | null | Decoded[] | { [field: string]: Decoded };

const FIXED: Record<string, number> = {
  bool: 1, u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, u64: 8, i64: 8, u128: 16, i128: 16, pubkey: 32,
};

export class IdlCoder {
  readonly #types: Map<string, IdlTypeDef>;
  readonly #accounts: Map<string, Uint8Array>;

  constructor(idl: Idl) {
    this.#types = new Map((idl.types ?? []).map((t) => [t.name, t]));
    this.#accounts = new Map((idl.accounts ?? []).map((a) => [a.name, Uint8Array.from(a.discriminator)]));
  }

  discriminator(account: string): Uint8Array {
    const d = this.#accounts.get(account);
    if (!d) throw new Error(`IDL has no account ${account}`);
    return d;
  }

  /** Decodes account data (discriminator included) after checking the discriminator. */
  decodeAccount(account: string, data: Uint8Array): { [field: string]: Decoded } {
    const disc = this.discriminator(account);
    if (data.length < 8 || disc.some((b, i) => data[i] !== b)) throw new Error(`not a ${account} account`);
    const cursor = { view: new DataView(data.buffer, data.byteOffset, data.byteLength), bytes: data, at: 8 };
    return this.#read({ defined: { name: account } }, cursor) as { [field: string]: Decoded };
  }

  /** Byte offset (discriminator included) of a dotted field path in a fixed-size account. */
  offsetOf(account: string, path: string): number {
    let type: IdlType = { defined: { name: account } };
    let offset = 8;
    for (const name of path.split('.')) {
      const fields = this.#struct(type);
      const i = fields.findIndex((f) => f.name === name);
      if (i < 0) throw new Error(`no field ${name} in ${path}`);
      for (const f of fields.slice(0, i)) offset += this.sizeOf(f.type);
      type = fields[i]!.type;
    }
    return offset;
  }

  sizeOf(type: IdlType): number {
    if (typeof type === 'string') {
      const n = FIXED[type];
      if (n === undefined) throw new Error(`variable or unsupported IDL type ${type}`);
      return n;
    }
    if ('array' in type) return this.sizeOf(type.array[0]) * type.array[1];
    if ('defined' in type) {
      const def = this.#def(type.defined.name);
      if (def.type.kind === 'enum') {
        if (def.type.variants.some((v) => v.fields)) throw new Error(`enum ${def.name} has data`);
        return 1;
      }
      return (def.type.fields ?? []).reduce((s, f) => s + this.sizeOf(f.type), 0);
    }
    throw new Error(`variable-size IDL type ${JSON.stringify(type)}`);
  }

  #def(name: string): IdlTypeDef {
    const def = this.#types.get(name);
    if (!def) throw new Error(`IDL has no type ${name}`);
    return def;
  }

  #struct(type: IdlType): IdlField[] {
    if (typeof type === 'object' && 'defined' in type) {
      const def = this.#def(type.defined.name);
      if (def.type.kind === 'struct') return def.type.fields ?? [];
    }
    throw new Error(`not a struct: ${JSON.stringify(type)}`);
  }

  #read(type: IdlType, c: { view: DataView; bytes: Uint8Array; at: number }): Decoded {
    const at = c.at;
    if (typeof type === 'string') {
      const size = FIXED[type];
      if (type === 'string') {
        const len = c.view.getUint32(at, true);
        c.at += 4 + len;
        return new TextDecoder().decode(c.bytes.subarray(at + 4, at + 4 + len));
      }
      if (size === undefined) throw new Error(`unsupported IDL type ${type}`);
      if (at + size > c.bytes.length) throw new Error('account data too short');
      c.at += size;
      switch (type) {
        case 'bool': return c.view.getUint8(at) !== 0;
        case 'u8': return c.view.getUint8(at);
        case 'i8': return c.view.getInt8(at);
        case 'u16': return c.view.getUint16(at, true);
        case 'i16': return c.view.getInt16(at, true);
        case 'u32': return c.view.getUint32(at, true);
        case 'i32': return c.view.getInt32(at, true);
        case 'u64': return c.view.getBigUint64(at, true);
        case 'i64': return c.view.getBigInt64(at, true);
        case 'u128': return c.view.getBigUint64(at, true) | (c.view.getBigUint64(at + 8, true) << 64n);
        case 'i128': return c.view.getBigUint64(at, true) | (c.view.getBigInt64(at + 8, true) << 64n);
        default: return base58Encode(c.bytes.subarray(at, at + 32));
      }
    }
    if ('array' in type) return Array.from({ length: type.array[1] }, () => this.#read(type.array[0], c));
    if ('option' in type) {
      c.at += 1;
      return c.view.getUint8(at) === 0 ? null : this.#read(type.option, c);
    }
    if ('vec' in type) {
      c.at += 4;
      return Array.from({ length: c.view.getUint32(at, true) }, () => this.#read(type.vec, c));
    }
    const def = this.#def(type.defined.name);
    if (def.type.kind === 'enum') {
      const variant = def.type.variants[c.view.getUint8(at)];
      if (!variant || variant.fields) throw new Error(`unsupported variant of ${def.name}`);
      c.at += 1;
      return variant.name;
    }
    const out: { [field: string]: Decoded } = {};
    for (const f of def.type.fields ?? []) out[f.name] = this.#read(f.type, c);
    return out;
  }
}

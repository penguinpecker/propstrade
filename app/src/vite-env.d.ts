/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_RPC_URL?: string;
  readonly VITE_PROGRAM_ID?: string;
  readonly VITE_CLUSTER?: string;
}

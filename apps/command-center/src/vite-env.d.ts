/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEFAULT_BASE_URL?: string;
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_RUM_ENABLED?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

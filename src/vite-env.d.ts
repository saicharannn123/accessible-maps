/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_ORS_KEY?: string
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}

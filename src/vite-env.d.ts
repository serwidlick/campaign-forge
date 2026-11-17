/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Set by the Tauri CLI: windows, macos, linux, android or ios. Unset under plain `vite`. */
  readonly TAURI_ENV_PLATFORM?: string;
}

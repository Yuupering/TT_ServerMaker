/// <reference types="vite/client" />

import type { HostApi } from '../../preload/index'

declare global {
  interface Window {
    api: HostApi
  }
}

export {}

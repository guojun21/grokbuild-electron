import type { GrokBuildBridge } from '../../shared/bridge'

declare global {
  interface Window {
    grokbuild: GrokBuildBridge
  }
}

export {}

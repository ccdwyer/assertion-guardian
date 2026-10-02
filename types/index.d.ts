// The last change Assertion Guardian refused, for the band and /allow-test-change.
// `fp` fingerprints the exact call (tool, path, payload), so an allowance
// covers that change and nothing else.
export type Blocked = { target: string; signals: string[]; fp: string }

declare module 'claude-code' {
  interface PluginState {
    'assertion-guardian': {
      blocked: Blocked | null
      // Fingerprints of calls cleared to run once each.
      allowed: string[]
    }
  }
}

/**
 * `title` is the title this mod produced, if any; `done` is set once the
 * session's first prompt has been handled, so the mod never runs again.
 */
export type TitleState = { title?: string; done: boolean }

declare module 'claude-code' {
  interface PluginState {
    'session-management': { sessionTitle: TitleState }
  }
}

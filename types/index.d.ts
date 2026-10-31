/**
 * `title` is the title this mod produced, if any; `done` is set once the
 * session's first prompt has been handled, so the mod never runs again;
 * `pending` is a title not yet applied, waiting for the session to be idle.
 */
export type TitleState = { title?: string; done: boolean; pending?: string }

declare module 'claude-code' {
  interface PluginState {
    'session-management': { sessionTitle: TitleState }
  }
}

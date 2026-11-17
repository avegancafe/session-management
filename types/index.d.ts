/**
 * `title` is the title `/autoname` last produced, if any; `pending` is a
 * title not yet applied, waiting for the session to be idle.
 */
export type TitleState = { title?: string; pending?: string }

declare module 'claude-code' {
  interface PluginState {
    'session-management': { sessionTitle: TitleState }
  }
}

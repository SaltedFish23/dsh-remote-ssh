/** Same-origin signal exposed only by a Web window attached to a remote Host. */
export const REMOTE_BACKEND_CONTEXT_PATH = '/dsh-remote-ssh/backend-context'

/**
 * Local control-plane endpoints hidden inside a remote Backend window. Keep
 * this exact: the browser bundle may itself be served below `/plugins/`.
 */
export const REMOTE_SSH_LOCAL_CONTROL_PATHS = new Set([
  '/plugins/dsh-remote-ssh/state',
  '/plugins/dsh-remote-ssh/workspace',
  '/plugins/dsh-remote-ssh/workspace/remove',
  '/plugins/dsh-remote-ssh/local-workspace',
  '/plugins/dsh-remote-ssh/probe',
  '/plugins/dsh-remote-ssh/ssh-config/host',
  '/plugins/dsh-remote-ssh/settings',
  '/plugins/dsh-remote-ssh/directory',
  '/plugins/dsh-remote-ssh/open-file',
  '/plugins/dsh-remote-ssh/backend/connect',
])

export interface RemoteBackendContext {
  attached: true
  transport: 'ssh'
}

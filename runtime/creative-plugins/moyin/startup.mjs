// In-process consumer only: the trusted launcher must supply the activation client.
// Importing this file does not import the business backend or touch member data.
// Not a CLI entrypoint, authentication endpoint, or readiness acknowledgement.
export function start(activation) {
  return activation.runStartupOnce(() => import('./greenroom-server.mjs'));
}

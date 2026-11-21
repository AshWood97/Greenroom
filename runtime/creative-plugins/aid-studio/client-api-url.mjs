/** Managed fetch/SSE URLs must share the existing Axios owner-protected proxy. */
export function patchClientApiUrl(patch) {
  patch('frontend/web/utils/api.ts', `export function resolveClientApiUrl(path: string): string {
  const p = path.startsWith('/') ? path : \`/\${path}\`
  if ((process.env.NODE_ENV === 'development')) {
    return \`\${API_BASE_DEVELOPMENT.replace(/\\/$/, '')}\${p}\`
  }
  if ((typeof window !== 'undefined')) {
    const base = \`\${window.location.protocol}//\${window.location.host}/aid\`
    return \`\${base.replace(/\\/$/, '')}\${p}\`
  }
  return \`\${API_BASE_DEVELOPMENT.replace(/\\/$/, '')}\${p}\`
}`, `export function resolveClientApiUrl(path: string): string {
  const p = path.startsWith('/') ? path : \`/\${path}\`
  // This prepared bundle runs only behind Greenroom's authenticated AID proxy.
  return \`/plugins/aid-studio/url\${p}\`
}`);
}

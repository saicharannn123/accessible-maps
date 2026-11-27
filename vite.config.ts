import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

// Content-Security-Policy for the published site. GitHub Pages can't send security headers, so it
// goes in a <meta> tag. It is the browser-side safety net if any bad text ever slips into the page:
// only our own scripts may run (no inline or injected <script>, no eval), no plugins, and the page
// can't be re-pointed at another site with <base> or have forms post elsewhere. Map data, tiles,
// search and routing come from many public https services, so connections and images may use any
// https host. Only added to production builds: the dev server needs inline scripts for hot reload.
// If you add a new kind of resource (e.g. an iframe or a font host), extend this list.
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' https: data: blob:",
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  'upgrade-insecure-requests',
].join('; ')

function securityHeaders(): Plugin {
  return {
    name: 'bm-security-meta',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      // Right after <meta charset>, so the policy covers every font, style and script tag below it.
      handler: (html) => {
        if (!/<meta charset="UTF-8" \/>/i.test(html)) throw new Error('index.html needs <meta charset="UTF-8" /> for the security meta tags')
        return html.replace(/(<meta charset="UTF-8" \/>)/i,
        `$1\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />` +
        '\n    <meta name="referrer" content="strict-origin-when-cross-origin" />')
      },
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), securityHeaders()],
  // Relative paths so the built site works under any folder, e.g. GitHub Pages at /accessible-maps/.
  base: './',
})

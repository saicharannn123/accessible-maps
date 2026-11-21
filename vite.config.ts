import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Relative paths so the built site works under any folder, e.g. GitHub Pages at /accessible-maps/.
  base: './',
})

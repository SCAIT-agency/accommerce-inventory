import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  root: 'client',
  plugins: [react()],
  server: {
    proxy: {
      // Whole /api prefix, not just /api/trpc — the login page talks to
      // /api/auth/* directly, and the route guard polls /api/auth/status.
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: path.resolve(__dirname, 'dist/client'),
    emptyOutDir: true,
  },
})

import { defineConfig } from 'vite'
import path from 'node:path'

export default defineConfig({
  root: 'client',
  server: {
    proxy: {
      '/api/trpc': {
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

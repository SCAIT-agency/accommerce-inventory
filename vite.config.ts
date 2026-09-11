import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    proxy: {
      '/api/trpc': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist/client',
  },
})

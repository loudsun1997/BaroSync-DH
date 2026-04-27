import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/upload': { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/align-baro': { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/synthesize-baseline': { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/pace-vs-reference': { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/health': { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/process-data-folder': { target: 'http://127.0.0.1:8000', changeOrigin: true },
    },
  },
})

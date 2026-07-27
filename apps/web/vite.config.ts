import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true,
    allowedHosts: ['safetyplan.thoughtlabs.co.nz'],
    fs: {
      allow: [path.resolve(__dirname, '..', '..')],
    },
    proxy: {
      '/api/overpass': {
        target: 'http://192.168.4.110:12345',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/overpass/, '/api/interpreter'),
      },
    },
  },
})

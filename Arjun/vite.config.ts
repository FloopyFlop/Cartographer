import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import cesium from 'vite-plugin-cesium'
import { fileURLToPath, URL } from 'node:url'
export default defineConfig({
  plugins: [react(), cesium()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  define: { CESIUM_BASE_URL: JSON.stringify('/cesium/') },
  server: { port: 5173, strictPort: true, proxy: { '/api': { target: 'http://127.0.0.1:5050', changeOrigin: true } } },
  preview: { port: 4173, proxy: { '/api': { target: 'http://127.0.0.1:5050', changeOrigin: true } } },
})

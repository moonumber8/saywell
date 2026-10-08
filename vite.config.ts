import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    watch: { ignored: ['**/.runtime/**', '**/models/**', '**/data/**', '**/tmp/**'] },
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
})

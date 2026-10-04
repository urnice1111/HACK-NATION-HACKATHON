import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // MapLibre 6 carga su propio worker; el optimizador de Vite lo rompe en modo dev.
  optimizeDeps: { exclude: ['maplibre-gl'] },
})

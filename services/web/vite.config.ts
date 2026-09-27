import { defineConfig} from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Vite config — https://vitejs.dev/config/
export default defineConfig({
  // .figma/make/deploy-preview passes `--mode development` for cached-preview builds.
      plugins: [
      react(),
      tailwindcss()
    ],
    resolve: {
      alias: {
        '@': '/src',
      },
    },
});

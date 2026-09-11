import { defineConfig } from 'vite';

// BASE_PATH lets the same build target a user/apex domain (Vercel, Netlify, "/")
// or a GitHub Pages project subpath ("/<repo>/") without code changes.
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  build: {
    target: 'es2020',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks: { three: ['three'] },
      },
    },
  },
  server: { host: true, port: 5173 },
});

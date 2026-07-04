import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => ({
  root: '.',
  base: mode === 'github-pages' ? '/AgencyDitherFX/' : '/',
  build: {
    outDir: 'dist-demo',
    emptyOutDir: true
  }
}));

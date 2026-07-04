import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.ts',
      name: 'AgencyDitherFX',
      formats: ['es', 'umd'],
      fileName: format =>
        format === 'es' ? 'agency-dither-fx.js' : 'agency-dither-fx.umd.cjs'
    },
    rollupOptions: {
      external: ['gsap'],
      output: {
        globals: { gsap: 'gsap' }
      }
    }
  }
});

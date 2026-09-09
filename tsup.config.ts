import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/steadfast/index.ts', 'src/bkash/index.ts', 'src/pathao/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: 'node18',
  outDir: 'dist',
})

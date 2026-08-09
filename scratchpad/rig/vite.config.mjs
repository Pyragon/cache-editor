import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import * as path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const entry = process.env.RIG_ENTRY ?? 'roles'

export default defineConfig({
  build: {
    ssr: path.join(here, `${entry}.ts`),
    outDir: path.join(here, 'out'),
    emptyOutDir: false,
    target: 'node20',
    rollupOptions: { output: { entryFileNames: `${entry}.mjs` } },
  },
})

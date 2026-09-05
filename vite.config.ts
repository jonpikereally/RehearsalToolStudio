import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Which build this is, and when it was made.
 *
 * Shown in Settings, so "is the fix in yet?" is a question the app answers.
 * A checkout answers with git; anything else says so rather than claiming a
 * version it doesn't know. The launcher holds the stamp in build.json against
 * git to decide whether to rebuild, and an open window compares it against
 * its own to notice it has gone stale.
 */
function buildStamp(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'dev';
  }
}

const BUILD = buildStamp();
const BUILT_AT = new Date().toISOString();
const APP_NAME = 'Rehearsal Tool Studio';
let outDir = 'dist';

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'app-name',
      configResolved(config) {
        outDir = config.build.outDir;
      },
      transformIndexHtml: (html) => html.replace(/<title>[^<]*<\/title>/, `<title>${APP_NAME}</title>`),
      closeBundle() {
        writeFileSync(
          `${outDir}/build.json`,
          JSON.stringify({ build: BUILD, builtAt: BUILT_AT }) + '\n',
        );
        // The manifest is a public file, copied rather than bundled, so it is
        // rewritten on disk once the copy has happened.
        const file = `${outDir}/manifest.webmanifest`;
        if (!existsSync(file)) return;
        const manifest = JSON.parse(readFileSync(file, 'utf8'));
        writeFileSync(
          file,
          JSON.stringify(
            {
              ...manifest,
              name: APP_NAME,
              short_name: 'Studio',
              description: 'Prepares Ableton sets into songs the band can play, and plays them.',
            },
            null,
            2,
          ) + '\n',
        );
      },
    },
  ],
  define: {
    __BUILD__: JSON.stringify(BUILD),
    __BUILT_AT__: JSON.stringify(BUILT_AT),
  },
  // Relative base so the built app works from wherever it is served.
  base: './',
  server: {
    port: 5174,
    strictPort: true,
    // The studio reads its disk through its own server; the dev server has
    // no such API, so the calls are passed along to the real one on 5177.
    proxy: { '/__fs': 'http://127.0.0.1:5177' },
  },
  build: {
    target: 'es2022',
    /*
     * Never empty dist/ on a build. A page already open keeps running the
     * bundle it loaded, and it fetches more of it as it goes — the encoder
     * spawns a worker per part from a file under assets/. A rebuild under
     * that page used to sweep the folder first, and a renamed worker file
     * would have failed every part after it. Old assets stay until the
     * launcher prunes them, a day on, when no open page can still want them.
     */
    emptyOutDir: false,
  },
  worker: {
    format: 'es',
  },
});

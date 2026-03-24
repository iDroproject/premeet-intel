import { defineConfig } from 'vite';
import webExtension from 'vite-plugin-web-extension';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));

export default defineConfig({
  plugins: [
    webExtension({
      manifest: () => {
        const manifest = JSON.parse(readFileSync('src/manifest.json', 'utf-8'));
        manifest.version = pkg.version;
        return manifest;
      },
    }),
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});

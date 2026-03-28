import { defineConfig, loadEnv } from 'vite';
import webExtension from 'vite-plugin-web-extension';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [
      webExtension({
        manifest: () => {
          const manifest = JSON.parse(readFileSync('src/manifest.json', 'utf-8'));
          manifest.version = pkg.version;

          // Inject Google OAuth client ID from env
          const googleClientId = env.VITE_GOOGLE_OAUTH_CLIENT_ID || process.env.VITE_GOOGLE_OAUTH_CLIENT_ID;
          if (googleClientId && !googleClientId.startsWith('ROTATE')) {
            manifest.oauth2 = manifest.oauth2 || {};
            manifest.oauth2.client_id = googleClientId;
          } else if (manifest.oauth2?.client_id?.startsWith('YOUR_')) {
            if (mode === 'production') {
              throw new Error(
                'VITE_GOOGLE_OAUTH_CLIENT_ID is not set — production builds require a valid Google OAuth client ID.\n' +
                'Set it in .env or as an environment variable.'
              );
            }
            console.warn(
              '\n⚠ VITE_GOOGLE_OAUTH_CLIENT_ID is not set — Google sign-in will not work.\n' +
              '  Set it in .env or as an environment variable.\n'
            );
          }

          return manifest;
        },
      }),
    ],
    build: {
      outDir: 'dist',
      emptyOutDir: true,
    },
  };
});

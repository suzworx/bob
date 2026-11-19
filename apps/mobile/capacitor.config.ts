import type { CapacitorConfig } from '@capacitor/cli';

// Live mode is the pilot choice: the WebView loads the production ui-v2 from
// server.url. Bundled mode (webDir served from the app) comes before a public
// App Store release. CAPACITOR_SERVER_URL points the shell at a dev server.
const serverUrl: string = process.env.CAPACITOR_SERVER_URL || 'https://app.heybob.xyz';

const config: CapacitorConfig = {
  appId: 'xyz.heybob.ios',
  appName: 'Bob',
  webDir: '../ui-v2/dist',
  server: {
    url: serverUrl,
    // Plain http is for a local dev server only; https needs no cleartext.
    ...(serverUrl.startsWith('http://') ? { cleartext: true } : {}),
  },
};

export default config;

// One-time: get a Drive refresh token for the Worker.
// Usage: GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… node scripts/google-auth.ts
// The OAuth client must be of type "Desktop app" in Google Cloud Console.
import { createServer } from 'node:http';

const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret } = process.env;
if (!clientId || !clientSecret) throw new Error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET');

const port = 8765;
const redirectUri = `http://127.0.0.1:${port}`;
const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
authUrl.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: 'code',
  scope: 'https://www.googleapis.com/auth/drive.readonly',
  access_type: 'offline',
  prompt: 'consent',
}).toString();

console.log(`Open this URL and approve access:\n\n${authUrl}\n`);

const server = createServer(async (req, res) => {
  const code = new URL(req.url!, redirectUri).searchParams.get('code');
  if (!code) return void res.end('No code');
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
  });
  const tokens = (await tokenRes.json()) as { refresh_token?: string; error?: string };
  res.end(tokens.refresh_token ? 'Done. Return to the terminal.' : `Failed: ${JSON.stringify(tokens)}`);
  console.log(tokens.refresh_token ? `GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}` : tokens);
  server.close();
});
server.listen(port, '127.0.0.1');

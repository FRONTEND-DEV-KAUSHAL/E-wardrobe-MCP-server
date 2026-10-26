# E-Wardrobe MCP Server

A personal digital wardrobe that AI assistants can use. Clothing photos live in a private Google Drive folder (or come from shop links), clothing details live in Cloudflare D1, and a Cloudflare Worker exposes it all as a remote [MCP](https://modelcontextprotocol.io) server. Connect it to Claude, ChatGPT, Gemini CLI or any MCP client, then ask things like:

> I'm going to a wedding reception tonight in Surat. Suggest three outfits using only clothes I own, show me the photos, and avoid anything I wore recently.

Outfit ranking is plain TypeScript. No paid AI API is needed, and the whole thing runs on free tiers.

## How it works

```
Google Drive (photos) ─┐
Shop / image links ────┼─▶ Cloudflare Worker (/mcp, auth, tools) ─▶ AI client (Claude, ChatGPT, …)
                       │         │
                       │         ├─ Cloudflare D1: clothing details, outfits, wear history
                       │         └─ Outfit engine: filtering and scoring
```

- **Photos stay where they are.** Drive photos are read with read-only access. Items added from a link keep their image at that link. The server sends small thumbnails to the AI, so the AI never needs to open private Drive URLs.
- **Tagging is done by your AI client.** It looks at each photo and saves category, colours, occasions and so on through `update_clothing_item`.
- **Recommendations are deterministic:** occasion and formality match, season, colour harmony, style consistency, and a penalty for recently worn items and combinations.

## Tools

| Tool | What it does |
|---|---|
| `list_wardrobe` | Browse items, filtered by category, colour, occasion, or untagged only |
| `import_drive_photos` | Scan the Drive folder (and one level of subfolders) and add new photos |
| `add_item_from_url` | Add an item from an image link or a product page (uses the page's `og:image`) |
| `get_clothing_item` | Full details, recent wears and the photo of one item |
| `update_clothing_item` | Set or correct attributes and availability |
| `mark_item_worn` | Record what you wore, saved as an outfit when there are several items |
| `recommend_outfit` | Ranked outfits with reasons and photos |

## Setup

Requires Node 24 (`nvm use`), a Cloudflare account and a Google account.

```sh
npm install
cp .dev.vars.example .dev.vars   # fill in as you go
```

### 1. Cloudflare D1

```sh
npx wrangler login
npx wrangler d1 create wardrobe
```

Put the printed `database_id` in `wrangler.jsonc`. Keep the binding named `DB`: `d1 create` may offer to add its own entry with a different binding name. Then create the tables:

```sh
npm run db:migrate:remote
```

### 2. Google Drive access

1. In [Google Cloud Console](https://console.cloud.google.com), create a project and enable the **Google Drive API**.
2. **OAuth consent screen:** choose External, add your Gmail as a test user, and add the scope `https://www.googleapis.com/auth/drive.readonly`.
3. **Credentials → OAuth client ID → Desktop app.** Copy the client ID and secret into `.dev.vars`.
4. Get a refresh token. Open the printed URL, approve, and copy the token it prints:
   ```sh
   GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… node scripts/google-auth.ts
   ```
5. **Publish the app** on the consent screen. While it's in "Testing", Google expires refresh tokens after 7 days. Personal use needs no verification.
6. `DRIVE_FOLDER_ID` is the last part of the folder URL: `drive.google.com/drive/folders/<ID>`. Use only the ID, not the full URL.

### 3. Auth token, secrets and deploy

```sh
openssl rand -hex 32                 # use as MCP_AUTH_TOKEN in .dev.vars
npm run deploy
npx wrangler secret bulk .dev.vars   # uploads all five secrets
```

If wrangler fails with `fetch failed`, run the same command again. On some networks this error is intermittent.

### 4. Check it

```sh
curl -s https://e-wardrobe.<subdomain>.workers.dev/mcp \
  -H "Authorization: Bearer <MCP_AUTH_TOKEN>" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"import_drive_photos","arguments":{}}}'
```

## Connect an AI client

Endpoint: `https://e-wardrobe.<subdomain>.workers.dev/mcp`

| Client | How |
|---|---|
| Claude Code | `claude mcp add --transport http wardrobe <endpoint> --header "Authorization: Bearer <token>"` |
| Gemini CLI, Cursor, VS Code | Add the endpoint with the header `Authorization: Bearer <token>` to the client's MCP config |
| Claude.ai / Claude Desktop | Settings → Connectors → Add custom connector → URL `<endpoint>?key=<token>`, OAuth fields empty |
| ChatGPT | Settings → Apps & Connectors → Advanced → Developer mode → Create → URL `<endpoint>?key=<token>`, No authentication |

A `?key=` URL gives full access to your wardrobe, so keep it private. To rotate the token: `npx wrangler secret put MCP_AUTH_TOKEN`, then update your clients.

## Using it

1. Upload photos to the Drive folder (one garment per photo), then ask: *"Import my Drive photos."*
2. Or add from a shop: *"Add this to my wardrobe: <link>"*. If the shop blocks bots, use the photo's direct address (right-click → Copy image address).
3. *"Tag my untagged clothes."* The AI views each photo and saves its attributes. Check `formality` (1 lounge … 5 wedding) and `occasions`, since recommendations rely on them most.
4. *"Suggest three outfits for a wedding reception tonight."*
5. *"I wore items 3, 7 and 12 today."*

## Development

```sh
npm test         # outfit engine tests
npm run local    # Worker in Node at http://localhost:8787/mcp
npm run dev      # wrangler dev (needs glibc ≥ 2.35, e.g. Ubuntu 22.04+)
```

- `npm run local` uses `.dev.vars` for secrets and a local SQLite file (`.wrangler/local.sqlite`, delete it to reset) in place of D1. Drive calls are real.
- To try tools in a browser, run `npx @modelcontextprotocol/inspector`, choose Streamable HTTP, enter the URL above and add the header `Authorization: Bearer <token>`.

```
src/index.ts      Worker entry: auth + MCP tools
src/engine.ts     outfit scoring (pure, unit tested)
src/drive.ts      Google Drive client, link and image fetching
migrations/       D1 schema
scripts/          google-auth.ts (refresh token), local.ts (Node runner)
```

## Limits

- **Drive scope:** read-only access to the whole Drive. Restricting it to one folder needs Google's file picker.
- **Link items:** if the shop removes the image, the item's photo disappears. Images over 1.5 MB are saved but not previewed.
- **Auth:** one shared token. Per-user OAuth login isn't implemented.
- **Free tier:** Workers allow 10 ms of CPU per request, which is why photos are never processed in the Worker.

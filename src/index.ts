import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { itemImage, listPhotos, resolveImageUrl } from './drive';
import { comboKey, recommend, type Item } from './engine';

export interface Env {
  DB: D1Database;
  MCP_AUTH_TOKEN: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_REFRESH_TOKEN: string;
  DRIVE_FOLDER_ID: string;
}

const CATEGORIES = ['top', 'bottom', 'one_piece', 'outerwear', 'footwear', 'accessory'] as const;
const JSON_COLUMNS = ['colors', 'occasions', 'seasons'] as const;

type Row = Record<string, unknown>;
const parseRow = (row: Row) => {
  const out: Row = { ...row, available: !!row.available };
  for (const c of JSON_COLUMNS) out[c] = JSON.parse((row[c] as string) ?? '[]');
  return out;
};
const json = (value: unknown) => ({ type: 'text' as const, text: JSON.stringify(value, null, 2) });
const lower = (xs: string[]) => xs.map((x) => x.trim().toLowerCase());

const ATTRIBUTES = {
  name: z.string().optional(),
  category: z.enum(CATEGORIES).optional(),
  subcategory: z.string().optional().describe('e.g. kurta, shirt, jeans, saree, sneakers'),
  colors: z.array(z.string()).optional(),
  pattern: z.string().optional(),
  fabric: z.string().optional(),
  fit: z.string().optional(),
  style: z.string().optional().describe('e.g. ethnic, western, indo-western, sporty'),
  formality: z.number().int().min(1).max(5).optional(),
  occasions: z.array(z.string()).optional(),
  seasons: z.array(z.enum(['summer', 'monsoon', 'winter', 'all'])).optional(),
  available: z.boolean().optional(),
  notes: z.string().optional(),
};

/** Set the given attributes on an item; returns the updated row, or null if the item doesn't exist. */
async function updateItem(db: D1Database, id: number, fields: Record<string, unknown>) {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined).map(([k, v]): [string, unknown] =>
    Array.isArray(v) ? [k, JSON.stringify(lower(v))] : typeof v === 'boolean' ? [k, v ? 1 : 0] : [k, v]);
  const sets = [...entries.map(([k]) => `${k} = ?`), "updated_at = datetime('now')"].join(', ');
  return db.prepare(`UPDATE clothing_items SET ${sets} WHERE id = ? RETURNING *`).bind(...entries.map(([, v]) => v), id).first();
}

function buildServer(env: Env): McpServer {
  const server = new McpServer({ name: 'e-wardrobe', version: '0.1.0' });
  const db = env.DB;

  server.registerTool('list_wardrobe', {
    description: 'Browse clothing items. Use untagged_only to find freshly imported photos that still need category/colour tags.',
    inputSchema: {
      category: z.enum(CATEGORIES).optional(),
      color: z.string().optional(),
      occasion: z.string().optional(),
      available_only: z.boolean().default(true),
      untagged_only: z.boolean().default(false),
      limit: z.number().int().min(1).max(500).default(100),
    },
    annotations: { readOnlyHint: true },
  }, async (a) => {
    const where: string[] = [], args: unknown[] = [];
    if (a.category) { where.push('category = ?'); args.push(a.category); }
    if (a.color) { where.push('EXISTS (SELECT 1 FROM json_each(colors) WHERE value = ?)'); args.push(a.color.toLowerCase()); }
    if (a.occasion) { where.push('EXISTS (SELECT 1 FROM json_each(occasions) WHERE value = ?)'); args.push(a.occasion.toLowerCase()); }
    if (a.available_only) where.push('available = 1');
    if (a.untagged_only) where.push('category IS NULL');
    const sql = `SELECT id, name, category, subcategory, colors, style, formality, occasions, seasons, available, drive_folder, file_name
      FROM clothing_items ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY category, id LIMIT ?`;
    const { results } = await db.prepare(sql).bind(...args, a.limit).all();
    return { content: [json({ count: results.length, items: results.map(parseRow) })] };
  });

  server.registerTool('import_drive_photos', {
    description: 'Scan the wardrobe Google Drive folder (and its subfolders) and add any new photos as untagged clothing items.',
    inputSchema: {},
  }, async () => {
    const photos = await listPhotos(env);
    const insert = db.prepare('INSERT OR IGNORE INTO clothing_items (drive_file_id, file_name, drive_folder) VALUES (?, ?, ?)');
    const results = photos.length ? await db.batch(photos.map((p) => insert.bind(p.id, p.name, p.folder || null))) : [];
    const added = results.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
    const known = await db.prepare('SELECT id, drive_file_id, name FROM clothing_items').all<{ id: number; drive_file_id: string; name: string | null }>();
    const inDrive = new Set(photos.map((p) => p.id));
    const missing = known.results.filter((r) => !r.drive_file_id.startsWith('url:') && !inDrive.has(r.drive_file_id));
    return { content: [json({ photos_in_drive: photos.length, newly_imported: added, missing_from_drive: missing })] };
  });

  server.registerTool('get_clothing_item', {
    description: 'Full details for one item, plus its photo. To tag an untagged item, look at the photo and call update_clothing_item.',
    inputSchema: { id: z.number().int(), include_image: z.boolean().default(true) },
    annotations: { readOnlyHint: true },
  }, async ({ id, include_image }) => {
    const row = await db.prepare('SELECT * FROM clothing_items WHERE id = ?').bind(id).first();
    if (!row) return { content: [{ type: 'text', text: `No item ${id}` }], isError: true };
    const worn = await db.prepare('SELECT worn_on, occasion FROM wear_history WHERE item_id = ? ORDER BY worn_on DESC LIMIT 5').bind(id).all();
    const content: any[] = [json({ ...parseRow(row), recent_wears: worn.results })];
    const img = include_image && (await itemImage(env, row));
    if (img) content.push({ type: 'image', ...img });
    return { content };
  });

  server.registerTool('update_clothing_item', {
    description: 'Correct or fill in attributes of an item. Lists replace the existing list. formality: 1 lounge/gym, 2 casual, 3 smart casual/office, 4 party/festive, 5 wedding/black tie.',
    inputSchema: { id: z.number().int(), ...ATTRIBUTES },
  }, async ({ id, ...fields }) => {
    if (!Object.values(fields).some((v) => v !== undefined)) return { content: [{ type: 'text', text: 'Nothing to update' }], isError: true };
    const row = await updateItem(db, id, fields);
    if (!row) return { content: [{ type: 'text', text: `No item ${id}` }], isError: true };
    return { content: [json(parseRow(row))] };
  });

  server.registerTool('add_item_from_url', {
    description: 'Add a clothing item from a web link: a direct image link, or a product page (Myntra, Amazon, brand sites) whose main photo is used. '
      + 'Fill in any attributes you know; otherwise look at the returned photo and call update_clothing_item.',
    inputSchema: { url: z.string().url().refine((u) => /^https?:/i.test(u), 'Must be an http(s) link'), ...ATTRIBUTES },
  }, async ({ url, ...fields }) => {
    let resolved;
    try { resolved = await resolveImageUrl(url); } catch (e) { return { content: [{ type: 'text', text: (e as Error).message }], isError: true }; }
    const fileName = resolved.title ?? decodeURIComponent(new URL(resolved.imageUrl).pathname.split('/').pop() || 'web image');
    const inserted = await db.prepare(`INSERT INTO clothing_items (drive_file_id, file_name, image_url, source_url) VALUES (?, ?, ?, ?)
      ON CONFLICT (drive_file_id) DO NOTHING RETURNING *`).bind(`url:${url}`, fileName, resolved.imageUrl, url).first();
    if (!inserted) {
      const existing = await db.prepare('SELECT id FROM clothing_items WHERE drive_file_id = ?').bind(`url:${url}`).first<{ id: number }>();
      return { content: [{ type: 'text', text: `Already in your wardrobe as item ${existing?.id}.` }], isError: true };
    }
    const row = Object.values(fields).some((v) => v !== undefined) ? (await updateItem(db, inserted.id as number, fields))! : inserted;
    const content: any[] = [json(parseRow(row))];
    const img = await itemImage(env, row);
    content.push(img ? { type: 'image', ...img } : { type: 'text', text: `Saved, but the image couldn't be previewed (too large or blocked): ${resolved.imageUrl}` });
    return { content };
  });

  server.registerTool('mark_item_worn', {
    description: 'Record that items were worn (together, as one outfit) so recommendations avoid repeating them.',
    inputSchema: {
      item_ids: z.array(z.number().int()).min(1),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD, defaults to today'),
      occasion: z.string().optional(),
    },
  }, async ({ item_ids, date, occasion }) => {
    const day = date ?? new Date().toISOString().slice(0, 10);
    let outfitId: number | null = null;
    if (item_ids.length > 1) {
      const outfit = await db.prepare('INSERT INTO outfits (description) VALUES (?) RETURNING id').bind(occasion ?? null).first<{ id: number }>();
      outfitId = outfit!.id;
      await db.batch(item_ids.map((i) => db.prepare('INSERT INTO outfit_items (outfit_id, item_id) VALUES (?, ?)').bind(outfitId, i)));
    }
    await db.batch(item_ids.map((i) =>
      db.prepare('INSERT INTO wear_history (item_id, outfit_id, worn_on, occasion) VALUES (?, ?, ?, ?)').bind(i, outfitId, day, occasion ?? null)));
    return { content: [json({ recorded: item_ids, worn_on: day, outfit_id: outfitId })] };
  });

  server.registerTool('recommend_outfit', {
    description: 'Rank outfits built only from clothes the user owns and has marked available. Returns photos and the reasoning for each outfit.',
    inputSchema: {
      occasion: z.string().optional().describe('e.g. wedding reception, office, casual outing'),
      formality: z.number().int().min(1).max(5).optional().describe('Overrides the formality guessed from the occasion'),
      season: z.enum(['summer', 'monsoon', 'winter']).optional(),
      temperature_c: z.number().optional(),
      count: z.number().int().min(1).max(5).default(3),
      avoid_days: z.number().int().min(0).max(90).default(7).describe('Penalise items and skip combos worn in this many days'),
      include_images: z.boolean().default(true),
    },
    annotations: { readOnlyHint: true },
  }, async (a) => {
    const rows = await db.prepare('SELECT * FROM clothing_items WHERE available = 1 AND category IS NOT NULL').all();
    const items: Item[] = rows.results.map(parseRow) as unknown as Item[];
    const since = `-${a.avoid_days} days`;
    const wears = await db.prepare(`SELECT item_id, outfit_id, CAST(julianday('now') - julianday(worn_on) AS INTEGER) AS days
      FROM wear_history WHERE worn_on >= date('now', ?)`).bind(since).all<{ item_id: number; outfit_id: number | null; days: number }>();
    const recentlyWorn = new Map<number, number>();
    const combos = new Map<number, { id: number }[]>();
    for (const w of wears.results) {
      recentlyWorn.set(w.item_id, Math.min(w.days, recentlyWorn.get(w.item_id) ?? Infinity));
      if (w.outfit_id) combos.set(w.outfit_id, [...(combos.get(w.outfit_id) ?? []), { id: w.item_id }]);
    }
    const outfits = recommend(items, {
      occasion: a.occasion, formality: a.formality, season: a.season, temperatureC: a.temperature_c, count: a.count,
    }, recentlyWorn, new Set([...combos.values()].map(comboKey)));

    if (!outfits.length) {
      return { content: [{ type: 'text', text: `No outfits possible from ${items.length} tagged, available items. Tag more items (need a top+bottom or a one_piece).` }] };
    }
    const content: any[] = [json(outfits.map((o, n) => ({
      outfit: n + 1, score: o.score, reasons: o.reasons,
      items: o.items.map((i) => ({ id: i.id, name: i.name, category: i.category, colors: i.colors })),
    })))];
    if (a.include_images) {
      const ids = [...new Set(outfits.flatMap((o) => o.items.map((i) => i.id)))];
      const byId = new Map(rows.results.map((r) => [r.id as number, r]));
      const images = await Promise.all(ids.map((id) => itemImage(env, byId.get(id)!, 320)));
      ids.forEach((id, n) => { if (images[n]) content.push({ type: 'text', text: `Item ${id}:` }, { type: 'image', ...images[n] }); });
    }
    return { content };
  });

  return server;
}

async function authorized(request: Request, env: Env): Promise<boolean> {
  if (!env.MCP_AUTH_TOKEN) return false;
  // Header for clients that support it; ?key= for clients that only accept a URL.
  const given = request.headers.get('Authorization')?.replace(/^Bearer /, '') ?? new URL(request.url).searchParams.get('key') ?? '';
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([given, env.MCP_AUTH_TOKEN].map((s) => crypto.subtle.digest('SHA-256', enc.encode(s))));
  return crypto.subtle.timingSafeEqual(a, b);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/') return new Response('e-wardrobe MCP server. Endpoint: /mcp');
    if (pathname !== '/mcp') return new Response('Not found', { status: 404 });
    if (!(await authorized(request, env))) return new Response('Unauthorized', { status: 401 });

    // ponytail: stateless (new server per request), add sessions via Durable Objects if a tool ever needs streaming state
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await buildServer(env).connect(transport);
    return transport.handleRequest(request);
  },
} satisfies ExportedHandler<Env>;

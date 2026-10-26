import type { Env } from './index';

let cached: { token: string; expires: number } | undefined;

async function accessToken(env: Env): Promise<string> {
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`Google token refresh failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cached = { token: json.access_token, expires: Date.now() + json.expires_in * 1000 };
  return cached.token;
}

async function drive<T>(env: Env, path: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(`https://www.googleapis.com/drive/v3/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${await accessToken(env)}` } });
  if (!res.ok) throw new Error(`Drive ${path} failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

export interface DrivePhoto { id: string; name: string; folder: string }

/** All images under the wardrobe folder, one level of subfolders deep (e.g. Wardrobe/Shirts/*.jpg). */
export async function listPhotos(env: Env): Promise<DrivePhoto[]> {
  type Page = { files: { id: string; name: string; mimeType: string }[]; nextPageToken?: string };
  const list = async (folderId: string) => {
    const files: Page['files'] = [];
    let pageToken: string | undefined;
    do {
      const page = await drive<Page>(env, 'files', {
        q: `'${folderId}' in parents and trashed = false and (mimeType contains 'image/' or mimeType = 'application/vnd.google-apps.folder')`,
        fields: 'nextPageToken, files(id, name, mimeType)',
        pageSize: '1000',
        ...(pageToken && { pageToken }),
      });
      files.push(...page.files);
      pageToken = page.nextPageToken;
    } while (pageToken);
    return files;
  };

  const photos: DrivePhoto[] = [];
  for (const f of await list(env.DRIVE_FOLDER_ID)) {
    if (f.mimeType.startsWith('image/')) photos.push({ id: f.id, name: f.name, folder: '' });
    else for (const g of await list(f.id)) if (g.mimeType.startsWith('image/')) photos.push({ id: g.id, name: g.name, folder: f.name });
  }
  return photos;
}

const MAX_URL_IMAGE = 1_500_000;

/** Image for an item: from its web link if it has one, else its Drive thumbnail. */
export async function itemImage(env: Env, row: Record<string, unknown>, size = 512) {
  if (typeof row.image_url !== 'string') return thumbnail(env, row.drive_file_id as string, size);
  const res = await fetch(row.image_url).catch(() => null);
  const mimeType = res?.headers.get('content-type')?.split(';')[0] ?? '';
  if (!res?.ok || !mimeType.startsWith('image/') || Number(res.headers.get('content-length')) > MAX_URL_IMAGE) return null;
  const buf = await res.arrayBuffer();
  return buf.byteLength > MAX_URL_IMAGE ? null : { data: Buffer.from(buf).toString('base64'), mimeType };
}

/** Resolve a link to a direct image URL: the link itself if it's an image, else the page's og:image / twitter:image. */
export async function resolveImageUrl(url: string): Promise<{ imageUrl: string; title?: string }> {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; e-wardrobe/1.0)', Accept: 'text/html,image/*' } });
  if (!res.ok) throw new Error(`Couldn't open the link (HTTP ${res.status}). Try the direct image link instead.`);
  const type = res.headers.get('content-type') ?? '';
  if (type.startsWith('image/')) { await res.body?.cancel(); return { imageUrl: res.url }; }
  const html = (await res.text()).slice(0, 500_000);
  const meta = (key: string) => {
    for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
      if (!new RegExp(`(property|name)\\s*=\\s*["']${key}["']`, 'i').test(tag)) continue;
      const content = tag.match(/content\s*=\s*["']([^"']+)["']/i)?.[1];
      if (content) return content.replace(/&amp;/g, '&');
    }
  };
  const image = meta('og:image') ?? meta('og:image:url') ?? meta('twitter:image');
  if (!image) throw new Error('No product image found on that page (the site may block bots). Paste the direct image link instead: right-click the photo → Copy image address.');
  return { imageUrl: new URL(image, res.url).href, title: meta('og:title') };
}

/** Small JPEG thumbnail as base64. Never pulls the original: Workers CPU is too tight to shuffle multi-MB photos. */
export async function thumbnail(env: Env, fileId: string, size = 512): Promise<{ data: string; mimeType: string } | null> {
  const { thumbnailLink } = await drive<{ thumbnailLink?: string }>(env, `files/${fileId}`, { fields: 'thumbnailLink' });
  if (!thumbnailLink) return null;
  const res = await fetch(thumbnailLink.replace(/=s\d+$/, `=s${size}`), { headers: { Authorization: `Bearer ${await accessToken(env)}` } });
  if (!res.ok) return null;
  return { data: Buffer.from(await res.arrayBuffer()).toString('base64'), mimeType: res.headers.get('content-type') ?? 'image/jpeg' };
}

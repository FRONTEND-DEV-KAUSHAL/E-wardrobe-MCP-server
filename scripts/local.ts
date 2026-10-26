// Run the Worker in plain Node with a local SQLite file standing in for D1.
// For machines where `wrangler dev` can't run (workerd needs glibc >= 2.35).
// Usage: npm run local   → http://localhost:8787/mcp  (secrets from .dev.vars, data in .wrangler/local.sqlite)
import { createServer } from 'node:http';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { build } from 'esbuild';

mkdirSync('.wrangler', { recursive: true });
const sqlite = new DatabaseSync('.wrangler/local.sqlite');
sqlite.exec('PRAGMA foreign_keys = ON; CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY)');
for (const name of readdirSync('migrations').filter((f) => f.endsWith('.sql')).sort()) {
  if (sqlite.prepare('SELECT 1 FROM _migrations WHERE name = ?').get(name)) continue;
  sqlite.exec(readFileSync(`migrations/${name}`, 'utf8'));
  sqlite.prepare('INSERT INTO _migrations VALUES (?)').run(name);
  console.log(`applied ${name}`);
}

// ponytail: minimal D1 shim covering only the calls src/ makes (prepare/bind/all/first/batch)
const statement = (sql: string, args: SQLInputValue[] = []) => ({
  bind: (...a: SQLInputValue[]) => statement(sql, a),
  async all() {
    const s = sqlite.prepare(sql);
    if (s.columns().length) return { results: s.all(...args), meta: {} };
    return { results: [], meta: { changes: Number(s.run(...args).changes) } };
  },
  async first() { return sqlite.prepare(sql).get(...args) ?? null; },
});
const DB = { prepare: (sql: string) => statement(sql), batch: (stmts: ReturnType<typeof statement>[]) => Promise.all(stmts.map((s) => s.all())) };

// Workers-only API used by the auth check.
(crypto.subtle as any).timingSafeEqual ??= (a: ArrayBuffer, b: ArrayBuffer) => Buffer.from(a).equals(Buffer.from(b));

await build({ entryPoints: ['src/index.ts'], bundle: true, platform: 'node', format: 'esm', outfile: '.wrangler/local/worker.mjs', logLevel: 'error' });
const worker = (await import(`${process.cwd()}/.wrangler/local/worker.mjs?${Date.now()}`)).default;
const env = { ...process.env, DB };

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c);
  const request = new Request(`http://localhost:8787${req.url}`, {
    method: req.method,
    headers: req.headers as Record<string, string>,
    body: chunks.length ? Buffer.concat(chunks) : undefined,
  });
  try {
    const response: Response = await worker.fetch(request, env);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    console.error(e);
    res.writeHead(500).end(String(e));
  }
}).listen(8787, () => console.log('e-wardrobe local: http://localhost:8787/mcp'));

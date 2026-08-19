import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Object storage, with a local-disk driver for now.
 *
 * Production belongs on S3 or Cloudflare R2 with presigned uploads so photo
 * bytes never pass through the app server. That is a Phase 2 change and the
 * interface here is deliberately the same shape, so swapping the driver does
 * not touch any caller.
 *
 * Keys are content-addressed by date and a random id rather than by customer
 * name, so a leaked key reveals nothing and two photos of the same heater never
 * collide.
 */

function root(): string {
  // Anchored to the repo, never to cwd. ETL_DATA_DIR is './data', which the
  // ETL resolved against the repo root and the web server resolved against
  // apps/web - so photos landed somewhere no ignore rule covered. Relative
  // paths in shared config have to be resolved from a shared origin.
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const fromEnv = process.env.ETL_DATA_DIR;
  return fromEnv
    ? resolve(repoRoot, fromEnv, 'photos')
    : resolve(repoRoot, 'data', 'photos');
}

export function buildKey(clientActionId: string, ext = 'jpg'): string {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${yyyy}/${mm}/${clientActionId}.${ext}`;
}

export async function putObject(key: string, body: Buffer): Promise<void> {
  const path = join(root(), key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body);
}

export async function getObject(key: string): Promise<Buffer | null> {
  try {
    return await readFile(join(root(), key));
  } catch {
    return null;
  }
}

/**
 * Reject anything that is not a real image before it reaches disk.
 *
 * Checked by magic bytes rather than by the declared content type, because the
 * declared type is whatever the client says it is.
 */
export function sniffImage(buf: Buffer): 'jpg' | 'png' | 'webp' | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF'
      && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

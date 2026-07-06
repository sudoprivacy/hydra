import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import { exec, resolveCommandPath } from '../core/exec';
import { shellQuote } from '../core/shell';

export interface GcsLocationOptions {
  bucket: string;
  prefix?: string;
  shareId: string;
}

export interface PublicHttpLocationOptions {
  publicBaseUrl: string;
  prefix?: string;
  shareId: string;
}

export function stripSlashes(value: string): string {
  return value.replace(/^\/+/, '').replace(/\/+$/, '');
}

export function normalizeGcsBucket(bucket: string): string {
  return bucket.replace(/^gs:\/\//, '').replace(/\/+$/, '').trim();
}

export function buildGcsBundleUrl(options: GcsLocationOptions): string {
  const bucket = normalizeGcsBucket(options.bucket);
  if (!bucket) {
    throw new Error('GCS bucket is required');
  }
  const prefix = stripSlashes(options.prefix || 'shares');
  const key = [prefix, options.shareId, 'bundle.json'].filter(Boolean).join('/');
  return `gs://${bucket}/${key}`;
}

export function buildPublicHttpBundleUrl(options: PublicHttpLocationOptions): string {
  const baseUrl = options.publicBaseUrl.replace(/\/+$/, '').trim();
  if (!baseUrl) {
    throw new Error('Public base URL is required');
  }
  const prefix = stripSlashes(options.prefix || 'shares');
  const key = [prefix, options.shareId, 'bundle.json'].filter(Boolean).join('/');
  return `${baseUrl}/${key}`;
}

export function buildDefaultPublicBaseUrl(bucket: string): string {
  const normalizedBucket = normalizeGcsBucket(bucket);
  if (!normalizedBucket) {
    throw new Error('GCS bucket is required');
  }
  return `https://storage.googleapis.com/${normalizedBucket}`;
}

export function resolveShareRef(
  shareRef: string,
  options: { bucket?: string; prefix?: string },
): string {
  const trimmed = shareRef.trim();
  if (trimmed.startsWith('gs://')) {
    return trimmed;
  }
  if (!options.bucket) {
    throw new Error('A GCS bucket is required when share ref is not a gs:// URL');
  }
  return buildGcsBundleUrl({
    bucket: options.bucket,
    prefix: options.prefix,
    shareId: trimmed,
  });
}

async function getStorageCopyCommand(source: string, target: string): Promise<string> {
  const gcloud = await resolveCommandPath('gcloud');
  if (gcloud) {
    return `${shellQuote(gcloud)} storage cp ${shellQuote(source)} ${shellQuote(target)}`;
  }

  const gsutil = await resolveCommandPath('gsutil');
  if (gsutil) {
    return `${shellQuote(gsutil)} cp ${shellQuote(source)} ${shellQuote(target)}`;
  }

  throw new Error('Neither gcloud nor gsutil was found on PATH. Install the Google Cloud CLI to use Hydra share.');
}

export async function uploadBundle(localBundlePath: string, gcsUrl: string): Promise<void> {
  const command = await getStorageCopyCommand(localBundlePath, gcsUrl);
  await exec(command, { cwd: path.dirname(localBundlePath) });
}

export async function downloadBundle(gcsUrl: string, localBundlePath: string): Promise<void> {
  const command = await getStorageCopyCommand(gcsUrl, localBundlePath);
  await exec(command, { cwd: path.dirname(localBundlePath) });
}

export function isHttpBundleUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

export async function downloadHttpBundle(url: string, localBundlePath: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(localBundlePath), { recursive: true });
  await downloadHttpBundleWithRedirects(url, localBundlePath, 0);
}

function downloadHttpBundleWithRedirects(
  url: string,
  localBundlePath: string,
  redirects: number,
): Promise<void> {
  if (redirects > 5) {
    return Promise.reject(new Error(`Too many redirects while downloading share bundle: ${url}`));
  }

  const parsed = new URL(url);
  const client = parsed.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const request = client.get(parsed, (response) => {
      const statusCode = response.statusCode || 0;
      const location = response.headers.location;

      if (statusCode >= 300 && statusCode < 400 && location) {
        response.resume();
        const nextUrl = new URL(location, parsed).toString();
        downloadHttpBundleWithRedirects(nextUrl, localBundlePath, redirects + 1)
          .then(resolve, reject);
        return;
      }

      if (statusCode < 200 || statusCode >= 300) {
        response.resume();
        reject(new Error(`Failed to download share bundle from ${url}: HTTP ${statusCode}`));
        return;
      }

      const file = fs.createWriteStream(localBundlePath, { mode: 0o600 });
      file.on('error', reject);
      file.on('finish', () => {
        file.close((error) => {
          if (error) reject(error); else resolve();
        });
      });
      response.pipe(file);
    });

    request.on('error', reject);
    request.setTimeout(30000, () => {
      request.destroy(new Error(`Timed out downloading share bundle from ${url}`));
    });
  });
}

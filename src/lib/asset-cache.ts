/**
 * Blob URLs for images read through Rust (campaign assets, or a GM's assets
 * over the network). Each key is loaded once per session; replaced images get
 * a new file name on disk, so a key never goes stale.
 */
const urls = new Map<string, Promise<string>>();

export function cachedAssetUrl(
  key: string,
  load: () => Promise<ArrayBuffer>,
): Promise<string> {
  let pending = urls.get(key);
  if (!pending) {
    pending = load().then((buf) => URL.createObjectURL(new Blob([buf])));
    pending.catch(() => urls.delete(key));
    urls.set(key, pending);
  }
  return pending;
}

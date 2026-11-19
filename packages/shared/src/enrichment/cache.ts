export interface EdgeCache {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
}

export function edgeCache(): EdgeCache | null {
  const candidate = (globalThis as { caches?: { default?: EdgeCache } }).caches;
  return candidate?.default ?? null;
}

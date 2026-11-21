export const CACHE_MAX_BYTES: number;
export const MEDIA_MAX_BYTES: number;
export function assertStorageAvailable(path: string, options?: { reserveBytes?: number; maxBytes?: number; usedBytes?: number }): void;

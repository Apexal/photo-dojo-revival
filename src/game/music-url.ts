/**
 * Where the music lives. The tracks are licensed, not open source, so they're
 * kept out of the repo: in dev they sit in git-ignored public/music/, and
 * production builds set VITE_MUSIC_BASE_URL to the R2 bucket holding the same
 * files. Missing files just mean silence (Phaser skips audio that fails to load).
 */
// `||`: CI passes an unset repository variable through as an empty string.
const BASE = (import.meta.env.VITE_MUSIC_BASE_URL || `${import.meta.env.BASE_URL}music`).replace(/\/+$/, "");

/** URL of a track by file name, e.g. "TomboFry - Space-Time.ogg". */
export const musicUrl = (file: string): string => `${BASE}/${encodeURIComponent(file)}`;

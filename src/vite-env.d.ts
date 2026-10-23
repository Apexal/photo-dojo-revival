/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** wss:// URL of the signaling Worker; defaults to the page's origin. */
  readonly VITE_SIGNALING_URL?: string;
  readonly VITE_POSE_MODEL_URL?: string;
  readonly VITE_MATTING_MODEL_URL?: string;
  /** The fp16 copy of the matting model (WebGPU with shader-f16); unset in a build with VITE_MATTING_MODEL_URL = fp32 only. */
  readonly VITE_MATTING_MODEL_FP16_URL?: string;
  /** Base URL of the music files (the R2 bucket); defaults to /music/ (git-ignored public/music/). */
  readonly VITE_MUSIC_BASE_URL?: string;
}

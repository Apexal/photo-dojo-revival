/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** wss:// URL of the signaling Worker; defaults to the page's origin. */
  readonly VITE_SIGNALING_URL?: string;
  readonly VITE_POSE_MODEL_URL?: string;
  readonly VITE_MATTING_MODEL_URL?: string;
}

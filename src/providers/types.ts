export type Tier = 'premium' | 'standard' | 'basic';

export interface Shape {
  w: number; h: number; // delivery size
  genW: number; genH: number; // size we ask the model for (multiples of 16)
  aspect: '1:1' | '9:16' | '16:9';
}

export interface ImageRequest {
  prompt: string;
  shape: Shape;
  seed: number;
  /** Public URL of a reference photo/anchor image (face consistency). */
  refUrl?: string;
  /** Same image on local disk, when we generated it ourselves (avoids calling our own server). */
  refPath?: string;
}

export interface ImageProvider {
  id: string;
  label: string;
  /** premium/standard = production quality; basic = last resort, only used if ALLOW_BASIC_IMAGES=true and it passes the size gate. */
  tier: Tier;
  /** text = text-to-image only, ref = needs a reference image, both = works either way. */
  mode: 'text' | 'ref' | 'both';
  /** attempts on transient errors (default 1) */
  tries?: number;
  enabled(): boolean;
  generate(req: ImageRequest): Promise<Buffer>;
}

export interface VideoRequest {
  imageUrl: string;
  imagePath: string;
  prompt: string;
  durationSec: number;
}

export interface VideoProvider {
  id: string;
  label: string;
  enabled(): boolean;
  /** Returns an MP4 (any length/size; the caller fits it to the scene). */
  generate(req: VideoRequest): Promise<Buffer>;
}

/** One spoken word with timings in seconds (relative to the source video). */
export interface Word {
  text: string;
  start: number;
  end: number;
}

export interface VideoMeta {
  id: string;
  title: string;
  channel?: string;
  duration: number;
  url: string;
  language?: string;
  subtitles: string[];
  autoCaptions: string[];
}

/** A clip as picked by Claude, then snapped to word boundaries. Times in seconds. */
export interface Clip {
  start: number;
  end: number;
  title: string;
  hook: string;
  reason: string;
  score: number;
  /** YouTube upload text (present on new picks; older clips.json files may lack it). */
  ytTitle?: string;
  description?: string;
  hashtags?: string[];
}

export interface RenderedClip extends Clip {
  index: number;
  file?: string;
  error?: string;
}

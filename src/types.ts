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
  /** "Most replayed" buckets from yt-dlp, value 0..1. Absent when YouTube has no data. */
  heatmap?: { start: number; end: number; value: number }[];
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
  /** Seconds into the clip to grab the thumbnail from (default: the hook frame). */
  thumbAt?: number;
}

export interface RenderedClip extends Clip {
  index: number;
  file?: string;
  error?: string;
}

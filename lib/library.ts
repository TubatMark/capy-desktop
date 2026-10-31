export interface LibraryVideo {
  id: string;
  videoId: string;
  title: string;
  channel?: string;
  duration?: number;
  status: string;
  clips: number;
  rendered: number;
}

/** Keeps a video whose title or channel contains the search, in the order given. */
export function filterLibrary(videos: LibraryVideo[], search: string) {
  const q = search.trim().toLowerCase();
  if (!q) return videos;
  return videos.filter((v) => v.title.toLowerCase().includes(q) || v.channel?.toLowerCase().includes(q));
}

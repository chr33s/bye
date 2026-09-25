// Published World object layout in the public bucket (§11): site/<handle>/... MailCore writes these
// keys on publish and deletes them on unpublish/erasure; the Public Worker reads them. One table so
// a writer and the reader can't drift.

export const publishedKey = {
  prefix: (handle: string) => `site/${handle}/`,
  index: (handle: string) => `site/${handle}/index.html`,
  post: (handle: string, slug: string) => `site/${handle}/posts/${slug}.html`,
  feed: (handle: string) => `site/${handle}/feed.xml`,
  media: (handle: string, name: string) => `site/${handle}/media/${name}`,
} as const;

// The latest release's files, read from GitHub when the site is built (the docs workflow also
// rebuilds the site when a release is published). Without network it returns null, and the
// install page links to the Releases page instead.
import { defineLoader } from 'vitepress';

export interface Asset {
  name: string;
  url: string;
  size: number;
}

export interface Release {
  version: string;
  date: string;
  url: string;
  assets: Asset[];
}

declare const data: Release | null;
export { data };

export default defineLoader({
  async load(): Promise<Release | null> {
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    try {
      const res = await fetch('https://api.github.com/repos/bilelbho/phpblitz/releases/latest', { headers });
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      const r = await res.json();
      return {
        version: String(r.tag_name).replace(/^v/, ''),
        date: String(r.published_at).slice(0, 10),
        url: r.html_url,
        assets: r.assets
          .filter((a: { name: string }) => !a.name.endsWith('.sig'))
          .map((a: { name: string; browser_download_url: string; size: number }) => ({
            name: a.name,
            url: a.browser_download_url,
            size: a.size,
          })),
      };
    } catch (e) {
      console.warn(`release.data: no release information (${(e as Error).message})`);
      return null;
    }
  },
});

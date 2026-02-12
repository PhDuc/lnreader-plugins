import { Plugin } from '@/types/plugin';
import { fetchApi } from '@libs/fetch';
import { FilterTypes, Filters } from '@libs/filterInputs';
import { load as parseHTML } from 'cheerio';

class WTRLAB implements Plugin.PluginBase {
  id = 'wtrlab-new';
  name = 'WTR-LAB-NEW';
  site = 'https://wtr-lab.com/';
  version = '1.0.1';
  icon = 'src/en/wtrlab/icon.png';
  sourceLang = 'en/';

  async popularNovels(
    page: number,
    {
      showLatestNovels,
      filters,
    }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    let link = this.site + this.sourceLang + 'novel-list?';
    link += `orderBy=${filters.order.value}`;
    link += `&order=${filters.sort.value}`;
    link += `&filter=${filters.storyStatus.value}`;
    link += `&page=${page}`; //TODO Genre & Advance Searching Filter. Ez to implement, too much manual work, too lazy.

    if (showLatestNovels) {
      const response = await fetchApi(this.site + 'api/home/recent', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ page: page }),
      });

      const recentNovel: JsonNovel = await response.json();

      // Parse novels from JSON
      const novels: Plugin.NovelItem[] = recentNovel.data.map(
        (datum: Datum) => ({
          name: datum.serie.data.title || '',
          cover: datum.serie.data.image,
          path:
            this.sourceLang +
              'serie-' +
              datum.serie.raw_id +
              '/' +
              datum.serie.slug || '',
        }),
      );

      return novels;
    } else {
      const body = await fetchApi(link).then(res => res.text());
      const loadedCheerio = parseHTML(body);
      const novels: Plugin.NovelItem[] = loadedCheerio('.serie-item')
        .map((index, element) => ({
          name:
            loadedCheerio(element)
              .find('.title-wrap > a')
              .text()
              .replace(loadedCheerio(element).find('.rawtitle').text(), '') ||
            '',
          cover: loadedCheerio(element).find('img').attr('src'),
          path: loadedCheerio(element).find('a').attr('href') || '',
        }))
        .get()
        .filter(novel => novel.name && novel.path);
      return novels;
    }
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const body = await fetchApi(this.site + novelPath).then(res => res.text());
    const loadedCheerio = parseHTML(body);

    const novel: Plugin.SourceNovel = {
      path: novelPath,
      name: loadedCheerio('h1.text-uppercase').text(),
      cover: loadedCheerio('.img-wrap > img').attr('src'),
      summary: loadedCheerio('.lead').text().trim(),
    };

    novel.genres = loadedCheerio('td:contains("Genre")')
      .next()
      .find('a')
      .map((i, el) => loadedCheerio(el).text())
      .toArray()
      .join(',');

    novel.author = loadedCheerio('td:contains("Author")')
      .next()
      .text()
      .replace(/[\t\n]/g, '');

    novel.status = loadedCheerio('td:contains("Status")')
      .next()
      .text()
      .replace(/[\t\n]/g, '');

    const chapterJson = loadedCheerio('#__NEXT_DATA__').html() + '';
    const jsonData: NovelJson = JSON.parse(chapterJson);

    const chapters: Plugin.ChapterItem[] =
      jsonData.props.pageProps.serie.chapters.map(
        (jsonChapter, chapterIndex) => ({
          name: jsonChapter.title,
          path:
            this.sourceLang +
            'serie-' +
            jsonData.props.pageProps.serie.serie_data.raw_id +
            '/' +
            jsonData.props.pageProps.serie.serie_data.slug +
            '/chapter-' +
            jsonChapter.order, // Assuming 'slug' is the intended path
          releaseTime: (
            jsonChapter?.created_at || jsonChapter?.updated_at
          )?.substring(0, 10),
          chapterNumber: chapterIndex + 1,
        }),
      );

    novel.chapters = chapters;

    return novel;
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const TIMEOUT_MS = 5000; // 5 seconds

    const fetchWithTimeout = async (url: string, timeoutMs: number) => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        // fetchApi's init typing doesn't include AbortSignal; cast to keep this change local.
        return await fetchApi(url, { signal: controller.signal } as any);
      } finally {
        clearTimeout(timeoutId);
      }
    };

    const parseChapterContent = (html: string): string | null => {
      const $ = parseHTML(html);

      // 1) Preferred: Next.js payload
      try {
        const nextData = $('#__NEXT_DATA__').html();
        if (nextData) {
          const jsonData: NovelJson = JSON.parse(nextData);
          const rawBody: any =
            jsonData?.props?.pageProps?.serie?.chapter_data?.data?.body;

          let lines: unknown = rawBody;
          if (typeof rawBody === 'string') {
            const s = rawBody.trim();
            // If it looks like JSON, try to parse it; otherwise treat as HTML
            if (s.startsWith('[') || s.startsWith('{')) {
              try {
                lines = JSON.parse(rawBody);
              } catch (err) {
                // Malformed JSON: do not return here; fall through to DOM parsing
                lines = undefined;
              }
            } else {
              // Do not return rawBody; fall through to DOM parsing.
              lines = undefined;
            }
          }

          if (Array.isArray(lines) && lines.length > 0) {
            return lines.map(t => `<p>${t}</p>`).join('');
          }
        }
      } catch (err) {
        // Fall back to DOM parsing, but surface the error for diagnostics
        // eslint-disable-next-line no-console
        console.warn('parseChapter: Next-data parse failed', err);
      }

      // 2) Fallback: DOM-rendered chapter body (web/webplus)
      const domHtml =
        $('.chapter-body.menu-target').first().html() ||
        $('.chapter-body').first().html() ||
        $('[data-chapter-id]').first().html();

      return domHtml || null;
    };

    // Try webplus first (with timeout)
    try {
      const base = new URL(chapterPath, this.site);
      base.searchParams.set('service', 'webplus');
      const webplusUrl = base.toString();
      const res = await fetchWithTimeout(webplusUrl, TIMEOUT_MS);
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${webplusUrl}`);
      const html = await res.text();
      const parsed = parseChapterContent(html);
      if (parsed) return parsed;
    } catch (err) {
      // Log the issue but continue to the web fallback
      // eslint-disable-next-line no-console
      console.warn('parseChapter: webplus fetch/parse failed', err);
    }

    // Fallback to web
    try {
      const base = new URL(chapterPath, this.site);
      base.searchParams.set('service', 'web');
      const webUrl = base.toString();
      const res = await fetchWithTimeout(webUrl, TIMEOUT_MS);
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${webUrl}`);
      const html = await res.text();
      const parsed = parseChapterContent(html);

      if (!parsed) {
        throw new Error(
          'Failed to parse chapter content from both webplus and web',
        );
      }

      return parsed;
    } catch (err) {
      throw new Error(
        `parseChapter: failed to load/parse chapter (${chapterPath}): ${String(err)}`,
      );
    }
  }

  async searchNovels(searchTerm: string): Promise<Plugin.NovelItem[]> {
    const response = await fetchApi(this.site + 'api/search', {
      headers: {
        'Content-Type': 'application/json',
        Referer: this.site + this.sourceLang,
        Origin: this.site,
      },
      method: 'POST',
      body: JSON.stringify({ text: searchTerm }),
    });

    const recentNovel: JsonNovel = await response.json();

    // Parse novels from JSON
    const novels: Plugin.NovelItem[] = recentNovel.data.map((datum: Datum) => ({
      name: datum.data.title || '',
      cover: datum.data.image,
      path: this.sourceLang + 'serie-' + datum.raw_id + '/' + datum.slug || '',
    }));

    return novels;
  }

  filters = {
    order: {
      value: 'chapter',
      label: 'Order by',
      options: [
        { label: 'View', value: 'view' },
        { label: 'Name', value: 'name' },
        { label: 'Addition Date', value: 'date' },
        { label: 'Reader', value: 'reader' },
        { label: 'Chapter', value: 'chapter' },
      ],
      type: FilterTypes.Picker,
    },
    sort: {
      value: 'desc',
      label: 'Sort by',
      options: [
        { label: 'Descending', value: 'desc' },
        { label: 'Ascending', value: 'asc' },
      ],
      type: FilterTypes.Picker,
    },
    storyStatus: {
      value: 'all',
      label: 'Status',
      options: [
        { label: 'All', value: 'all' },
        { label: 'Ongoing', value: 'ongoing' },
        { label: 'Completed', value: 'completed' },
      ],
      type: FilterTypes.Picker,
    },
  } satisfies Filters;
}

type NovelJson = {
  props: Props;
  page: string;
};

type Props = {
  pageProps: PageProps;
  __N_SSP: boolean;
};

type PageProps = {
  serie: Serie;
  server_time: Date;
};

type Serie = {
  serie_data: SerieData;
  chapters: Chapter[];
  recommendation: SerieData[];
  chapter_data: ChapterData;
  id: number;
  raw_id: number;
  slug: string;
  data: Data;
  is_default: boolean;
  raw_type: string;
};

type Chapter = {
  serie_id: number;
  id: number;
  order: number;
  slug: string;
  title: string;
  name: string;
  created_at: string;
  updated_at: string;
};
type ChapterData = {
  data: ChapterContent;
};
type ChapterContent = {
  title: string;
  body: string;
};

type SerieData = {
  serie_id?: number;
  recommendation_id?: number;
  score?: string;
  id: number;
  slug: string;
  search_text: string;
  status: number;
  data: Data;
  created_at: string;
  updated_at: string;
  view: number;
  in_library: number;
  rating: number | null;
  chapter_count: number;
  power: number;
  total_rate: number;
  user_status: number;
  verified: boolean;
  from: null;
  raw_id: number;
  genres?: number[];
};

type Data = {
  title: string;
  author: string;
  description: string;
  image: string;
};

type JsonNovel = {
  success: boolean;
  data: Datum[];
};
type Datum = {
  serie: Serie;
  chapters: Chapter[];
  updated_at: Date;
  raw_id: number;
  slug: string;
  data: Data;
};

export default new WTRLAB();

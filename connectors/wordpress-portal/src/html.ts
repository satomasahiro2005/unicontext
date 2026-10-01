import { load } from 'cheerio';

/** Decode HTML entities of a rendered title ("&#8211;", "&amp;") into plain text. */
export function decodeEntities(html: string): string {
  return load(`<div>${html}</div>`, null, false).text().replace(/\s+/g, ' ').trim();
}

const BLOCKS =
  'p, div, li, ul, ol, h1, h2, h3, h4, h5, h6, tr, table, blockquote, section, article';

/** Plain text of rendered post content: block elements and <br> become line breaks. */
export function htmlToText(html: string): string {
  const $ = load(`<div id="root">${html}</div>`, null, false);
  const root = $('#root');
  root.find('script, style').remove();
  root.find('br').replaceWith('\n');
  root.find(BLOCKS).each((_, el) => {
    $(el).append('\n');
  });
  return root
    .text()
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((l) => l.replace(/[ \t\r]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface PageLink {
  url: string;
  text: string;
}

/** All http(s) links of a piece of HTML, resolved against `base`, with their link text. */
export function extractLinks(html: string, base: string): PageLink[] {
  const $ = load(html);
  const out: PageLink[] = [];
  $('a[href]').each((_, a) => {
    const href = ($(a).attr('href') ?? '').trim();
    if (!href || href.startsWith('#') || /^(mailto|tel|javascript):/i.test(href)) return;
    let url: URL;
    try {
      url = new URL(href, base);
    } catch {
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    url.hash = '';
    const text = $(a).text().replace(/\s+/g, ' ').trim() || ($(a).attr('title') ?? '').trim() || '';
    out.push({ url: url.toString(), text });
  });
  return out;
}

function fileName(url: string): string {
  const last = new URL(url).pathname.split('/').pop() ?? '';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** Links whose path ends with .pdf; the title falls back to the file name. */
export function extractPdfLinks(html: string, base: string): PageLink[] {
  const seen = new Set<string>();
  const out: PageLink[] = [];
  for (const link of extractLinks(html, base)) {
    if (!/\.pdf$/i.test(new URL(link.url).pathname)) continue;
    if (seen.has(link.url)) continue;
    seen.add(link.url);
    out.push({ url: link.url, text: link.text || fileName(link.url) });
  }
  return out;
}

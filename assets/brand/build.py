"""Build the UniContext mark, app icon, favicon and wordmark.

Outputs (next to this file): mark.svg, icon.svg, icon-dark.svg, wordmark.svg, wordmark-dark.svg,
icon-{16,32,48,180,192,512}.png, favicon.ico. The wordmark is Figtree 700 (SIL OFL 1.1) converted
to outlines, so no font is needed to display it. Run: python assets/brand/build.py
"""

import pathlib
import subprocess
import urllib.request

import uharfbuzz as hb
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from PIL import Image

HERE = pathlib.Path(__file__).parent
SRC = HERE / 'src'
FONT_URL = 'https://github.com/google/fonts/raw/main/ofl/figtree/Figtree%5Bwght%5D.ttf'

INK, ACCENT = '#17233B', '#2E8B7E'
INK_DARK, ACCENT_DARK = '#F1F3F0', '#5CC2B2'

# A1 on a 64-unit grid: a U with one strand woven through it — over the left leg, under the right.
U = 'M20 8V39a12 12 0 0 0 24 0V8'
STRAND = 'M8 27H56'


def mark_body(ink: str, accent: str, uid: str) -> str:
    """Mark contents with real transparency (masks cut the gaps instead of painting them)."""
    return f'''<defs>
    <mask id="{uid}-u" maskUnits="userSpaceOnUse" x="-8" y="-8" width="80" height="80">
      <rect x="-8" y="-8" width="80" height="80" fill="#fff"/><path d="M13 27H27" stroke="#000" stroke-width="16"/>
    </mask>
    <mask id="{uid}-s" maskUnits="userSpaceOnUse" x="-8" y="-8" width="80" height="80">
      <rect x="-8" y="-8" width="80" height="80" fill="#fff"/><path d="M44 19V35" stroke="#000" stroke-width="16"/>
    </mask>
  </defs>
  <g transform="translate(0 1.25)">
    <path d="{U}" fill="none" stroke="{ink}" stroke-width="10" mask="url(#{uid}-u)"/>
    <path d="{STRAND}" stroke="{accent}" stroke-width="10" mask="url(#{uid}-s)"/>
  </g>'''


def svg(view: str, body: str, w: float | None = None, h: float | None = None) -> str:
    size = f' width="{w:g}" height="{h:g}"' if w else ''
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{view}"{size}>\n  {body}\n</svg>\n'


def icon(bg: str, ink: str, accent: str, uid: str) -> str:
    # Mark at 84/128 of the tile, as in the studies; corners are left to the platform's own mask.
    return svg('0 0 64 64', f'<rect width="64" height="64" fill="{bg}"/>\n  '
               f'<g transform="translate(10.9 10.9) scale(0.659)">{mark_body(ink, accent, uid)}</g>')


def figtree_700() -> TTFont:
    SRC.mkdir(exist_ok=True)
    path = SRC / 'Figtree.ttf'
    if not path.exists():
        urllib.request.urlretrieve(FONT_URL, path)
    return instantiateVariableFont(TTFont(path), {'wght': 700})


def wordmark(ink: str, accent: str, uid: str) -> str:
    """Lockup as chosen: mark box 44, gap 14, Figtree 700 at 34 with -0.01em tracking, centred."""
    font = figtree_700()
    upem = font['head'].unitsPerEm
    import io
    buf = io.BytesIO(); font.save(buf)
    hbfont = hb.Font(hb.Face(buf.getvalue()))
    b = hb.Buffer(); b.add_str('UniContext'); b.guess_segment_properties()
    hb.shape(hbfont, b, {'kern': True, 'liga': True})
    size, box, gap = 34.0, 44.0, 14.0
    s = size / upem
    asc, desc = font['hhea'].ascent / upem, -font['hhea'].descent / upem
    baseline = (box - size) / 2 + (size - (asc + desc) * size) / 2 + asc * size
    glyphs = font.getGlyphSet()
    order = font.getGlyphOrder()
    x = box + gap
    paths = []
    for info, pos in zip(b.glyph_infos, b.glyph_positions):
        pen = SVGPathPen(glyphs)
        glyphs[order[info.codepoint]].draw(TransformPen(pen, (s, 0, 0, -s, x + pos.x_offset * s, baseline - pos.y_offset * s)))
        paths.append(pen.getCommands())
        x += pos.x_advance * s - 0.01 * size
    width = x + 0.01 * size
    mark = f'<g transform="scale({box / 64:g})">{mark_body(ink, accent, uid)}</g>'
    text = f'<path fill="{ink}" d="{" ".join(paths)}"/>'
    return svg(f'0 0 {width:.2f} {box:g}', f'{mark}\n  {text}', width, box)


def render_png(svg_path: pathlib.Path, px: int) -> pathlib.Path:
    chrome = pathlib.Path(r'C:\Program Files\Google\Chrome\Application\chrome.exe')
    html = HERE / f'_render_{px}.html'
    html.write_text(f'<style>html,body{{margin:0;background:transparent}}</style>'
                    f'<img src="{svg_path.name}" width="{px}" height="{px}">', encoding='utf-8')
    out = HERE / f'icon-{px}.png'
    subprocess.run([str(chrome), '--headless=new', '--disable-gpu', '--hide-scrollbars',
                    '--default-background-color=00000000', f'--window-size={px},{px}',
                    f'--screenshot={out}', html.as_uri()], check=True, capture_output=True)
    html.unlink()
    return out


def main() -> None:
    (HERE / 'mark.svg').write_text(svg('0 0 64 64', mark_body(INK, ACCENT, 'm')), encoding='utf-8')
    (HERE / 'mark-dark.svg').write_text(svg('0 0 64 64', mark_body(INK_DARK, ACCENT_DARK, 'm')), encoding='utf-8')
    (HERE / 'icon.svg').write_text(icon('#FFFFFF', INK, ACCENT, 'i'), encoding='utf-8')
    (HERE / 'icon-dark.svg').write_text(icon(INK, INK_DARK, ACCENT_DARK, 'i'), encoding='utf-8')
    (HERE / 'wordmark.svg').write_text(wordmark(INK, ACCENT, 'w'), encoding='utf-8')
    (HERE / 'wordmark-dark.svg').write_text(wordmark(INK_DARK, ACCENT_DARK, 'w'), encoding='utf-8')
    # Chrome renders the 512 master; smaller sizes are downsampled from it (headless windows have a minimum size).
    master = Image.open(render_png(HERE / 'icon.svg', 512)).convert('RGB')
    for px in (16, 32, 48, 180, 192):
        master.resize((px, px), Image.LANCZOS).save(HERE / f'icon-{px}.png')
    master.save(HERE / 'favicon.ico', sizes=[(16, 16), (32, 32), (48, 48)])


if __name__ == '__main__':
    main()

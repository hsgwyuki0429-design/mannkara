"""
和文フォント（M PLUS Rounded 1c）のサブセットを作り直す。画面に新しい和文を出したら実行する:
  pip install fonttools brotli && python3 scripts/subset-fonts.py
index.html と src/ui/*.js に出てくる和文（U+2000 より後の文字。コメントは除く）と、今のサブセットに入っている文字を
合わせて作る（今ある文字は消さない）。元のフォントは Google Fonts のリポジトリから取ってくる（SIL OFL）。
"""
import glob, io, os, re, urllib.request
from fontTools.ttLib import TTFont
from fontTools import subset

ROOT = os.path.join(os.path.dirname(__file__), '..')
SRC = 'https://raw.githubusercontent.com/google/fonts/main/ofl/mplusrounded1c/MPLUSRounded1c-{}.ttf'
WEIGHTS = {700: 'Bold', 800: 'ExtraBold', 900: 'Black'}

text = ''
for path in [os.path.join(ROOT, 'index.html'), *glob.glob(os.path.join(ROOT, 'src/ui/*.js'))]:
    with open(path, encoding='utf-8') as f:
        src = f.read()
    # コメントの和文は画面に出ないので入れない（入れると何倍にも大きくなる）
    src = re.sub(r'<!--.*?-->|/\*.*?\*/', '', src, flags=re.S)
    src = re.sub(r'(?<![:\\])//.*', '', src)
    text += src
wanted = {ord(c) for c in text if ord(c) > 0x2000} | {0x20}

for weight, name in WEIGHTS.items():
    out = os.path.join(ROOT, f'src/ui/fonts/mplus-ui-{weight}.woff2')
    codes = set(wanted)
    if os.path.exists(out):
        codes |= set(TTFont(out).getBestCmap())
    data = urllib.request.urlopen(SRC.format(name)).read()
    font = TTFont(io.BytesIO(data))
    have = set(font.getBestCmap())
    missing = sorted(c for c in codes if c not in have)
    opts = subset.Options()
    opts.flavor = 'woff2'
    opts.layout_features = ['*']
    sub = subset.Subsetter(opts)
    sub.populate(unicodes=codes & have)
    sub.subset(font)
    font.flavor = 'woff2'
    font.save(out)
    print(f'{weight}: {len(codes & have)} 文字 -> {os.path.getsize(out)} bytes' + (f'（フォントに無い: {"".join(map(chr, missing))}）' if missing else ''))

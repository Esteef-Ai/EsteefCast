"""Draws the Roku channel art (menu icons + splash screens) into roku/images.
Esteef.Ai style: charcoal, brass, cream. Run: python roku/tools/make_art.py"""
import os
import shutil
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, 'images')
ICON = os.path.join(ROOT, '..', 'host', 'assets', 'icon.png')
FONTS = r'C:\Windows\Fonts'
CHARCOAL_A, CHARCOAL_B = (29, 32, 36), (20, 22, 25)
CREAM, BRASS, MUTED = (228, 224, 216), (196, 160, 98), (154, 149, 140)


def font(name, size):
    return ImageFont.truetype(os.path.join(FONTS, name), size)


def gradient(w, h):
    img = Image.new('RGB', (w, h))
    px = img.load()
    for y in range(h):
        for x in range(w):
            t = (x / w + y / h) / 2
            px[x, y] = tuple(int(a + (b - a) * t) for a, b in zip(CHARCOAL_A, CHARCOAL_B))
    return img


def draw(name, w, h, icon_px, title_px, tagline):
    img = gradient(w, h)
    d = ImageDraw.Draw(img)
    title_f = font('seguisb.ttf', title_px)
    by_f = font('segoeui.ttf', max(10, round(title_px * 0.34)))
    tag_f = font('segoeui.ttf', max(10, round(title_px * 0.3)))
    by_text = 'B Y   E S T E E F . A I'
    title_w = d.textlength('EsteefCast', font=title_f)
    block_w = icon_px + round(icon_px * 0.22) + title_w
    x0 = (w - block_w) / 2
    icon = Image.open(ICON).convert('RGBA').resize((icon_px, icon_px), Image.LANCZOS)
    img.paste(icon, (round(x0), round((h - icon_px) / 2)), icon)
    tx = x0 + icon_px + round(icon_px * 0.22)
    lines_h = title_px + round(title_px * 0.6) + (round(title_px * 0.7) if tagline else 0)
    ty = (h - lines_h) / 2 - title_px * 0.15
    d.text((tx, ty), 'EsteefCast', font=title_f, fill=CREAM)
    d.text((tx + 2, ty + title_px * 1.12), by_text, font=by_f, fill=BRASS)
    if tagline:
        d.text((tx + 2, ty + title_px * 1.75), 'Watch your PC on this TV', font=tag_f, fill=MUTED)
    img.save(os.path.join(OUT, name))


os.makedirs(OUT, exist_ok=True)
draw('icon_hd.png', 290, 218, 84, 40, False)
draw('icon_fhd.png', 540, 405, 150, 72, False)
draw('splash_hd.png', 1280, 720, 220, 104, True)
draw('splash_fhd.png', 1920, 1080, 320, 150, True)
shutil.copyfile(ICON, os.path.join(OUT, 'logo.png'))
print('Roku art written to', OUT)

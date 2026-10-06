#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
从「黑底 + 内嵌思考气泡」的原始角色图，生成 pet-app 的情绪状态精灵图。

两个状态必须**像素级对齐**（否则切换时角色会跳）：
所以在原图坐标系里取**同一个固定裁剪窗口**再统一缩放，而不是各自紧裁 ——
生气图的怒火标记会把紧裁框撑大，导致角色相对画布位移。

处理步骤：
  1 取固定窗口
  2 从四边洪泛去黑底（低阈值，保留角色边缘抗锯齿）
  3 定位并剔除思考气泡 —— 挂件自己用内联 SVG 画气泡，素材里不能自带
  4 保留角色主体 + 红色怒火标记；丢弃气泡尾巴、描边残渣等孤立小块
  5 统一缩放到目标高度，补成同一画布（右下对齐）

用法：
  python tools/make-mood-sprites.py --idle <待机原图> --angry <生气原图> --out-dir pet-app/assets/mood
"""
import argparse
import os
from collections import deque

from PIL import Image

FINE_TOL = 38          # 精细去黑底
COARSE_TOL = 95        # 粗阈值：用来切断气泡与角色之间的"灰桥"
RED_RATIO_KEEP = 0.22  # 悬浮块红像素占比 ≥ 此值 → 判为怒火标记，保留
MIN_AREA = 400
# 固定裁剪窗口（原图 2048x2048 坐标系）：包含角色主体 + 生气图全部怒火标记
CROP_BOX = (850, 843, 2048, 2048)
TARGET_HEIGHT = 1026


def flood_bg(img, tol):
    """从四边洪泛标记与边界连通的深色背景 → bytearray(1=背景)。"""
    w, h = img.size
    px = img.load()
    bg = bytearray(w * h)
    q = deque()

    def is_bg(x, y):
        r, g, b, a = px[x, y]
        return a > 0 and max(r, g, b) <= tol and not bg[y * w + x]

    for x in range(w):
        for y in (0, h - 1):
            if is_bg(x, y):
                bg[y * w + x] = 1
                q.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            if is_bg(x, y):
                bg[y * w + x] = 1
                q.append((x, y))
    while q:
        x, y = q.popleft()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h and not bg[ny * w + nx] and is_bg(nx, ny):
                bg[ny * w + nx] = 1
                q.append((nx, ny))
    return bg


def components(mask, w, h, min_area=MIN_AREA):
    seen = bytearray(w * h)
    out = []
    for y0 in range(h):
        row = y0 * w
        for x0 in range(w):
            i = row + x0
            if seen[i] or not mask[i]:
                continue
            q = deque([(x0, y0)])
            seen[i] = 1
            pts = []
            minx = maxx = x0
            miny = maxy = y0
            while q:
                x, y = q.popleft()
                pts.append((x, y))
                if x < minx: minx = x
                if x > maxx: maxx = x
                if y < miny: miny = y
                if y > maxy: maxy = y
                for dx in (-1, 0, 1):
                    for dy in (-1, 0, 1):
                        nx, ny = x + dx, y + dy
                        if 0 <= nx < w and 0 <= ny < h:
                            j = ny * w + nx
                            if not seen[j] and mask[j]:
                                seen[j] = 1
                                q.append((nx, ny))
            if len(pts) >= min_area:
                out.append((len(pts), (minx, miny, maxx, maxy), pts))
    out.sort(key=lambda t: -t[0])
    return out


def is_red(px, x, y):
    r, g, b, a = px[x, y]
    return a > 0 and r > 110 and (r - g) > 45 and (r - b) > 45


def process(path, label, verbose):
    # ⚠️ 两条都必须遵守，否则会踩坑（都实测过）：
    #  ① 必须在**整张原图**上处理，最后才裁窗口。先裁窗口的话，气泡只剩一小段弧线，
    #     面积不到阈值 → 识别不出来，角色头顶会挂着半条深蓝弧线、左下留着尾巴圆。
    #  ② 不能用"保留最大连通块"来选角色 —— 在粗阈值下**气泡比角色还大**
    #     （气泡 ~1.02M px，角色 ~0.78M px）。要先用"上半部的大块"定位气泡本体并剔除，
    #     剔除后剩下的最大块才是角色。
    full = Image.open(path).convert("RGBA")
    fw, fh = full.size
    fpx = full.load()

    # ① 粗阈值定位气泡本体（上半部、面积占比够大）
    cb = flood_bg(full, COARSE_TOL)
    ccomps = components(bytearray(1 if not cb[i] else 0 for i in range(fw * fh)), fw, fh, min_area=2000)
    bubble = None
    for (n, bb, _) in ccomps:
        if (bb[1] + bb[3]) / 2.0 < fh / 2.0 and n > (fw * fh) * 0.08:
            bubble = bb
            break
    print("[%s] 原图 %dx%d；气泡 %s" % (label, fw, fh,
          ("bbox %s → 剔除" % (bubble,)) if bubble else "未识别到（继续）"))

    # ② 细阈值前景，去掉气泡区（含尾巴圆所在的外扩范围）
    fb = flood_bg(full, FINE_TOL)
    fg = bytearray(fw * fh)
    for i in range(fw * fh):
        if fb[i]:
            continue
        if bubble:
            x = i % fw
            y = i // fw
            if (bubble[0] - 6 <= x <= bubble[2] + 6) and (bubble[1] - 6 <= y <= bubble[3] + 6):
                continue
        fg[i] = 1

    # ③ 剔除气泡后：最大块 = 角色主体；红占比高的孤立块 = 怒火标记；其余丢弃
    comps = components(fg, fw, fh)
    keep = bytearray(fw * fh)
    for idx, (n, bb, pts) in enumerate(comps):
        reds = sum(1 for (x, y) in pts if is_red(fpx, x, y))
        ratio = reds / float(n)
        if idx == 0 or ratio >= RED_RATIO_KEEP:
            tag = "角色主体" if idx == 0 else "怒火标记(红%.2f)" % ratio
            if verbose:
                print("  保留 %-9d %-32s %s" % (n, str(bb), tag))
            for (x, y) in pts:
                keep[y * fw + x] = 1
        elif verbose:
            print("  丢弃 %-9d %-32s 红占比 %.2f（气泡尾巴/残渣）" % (n, str(bb), ratio))

    for y in range(fh):
        base = y * fw
        for x in range(fw):
            if not keep[base + x]:
                r, g, b, _ = fpx[x, y]
                fpx[x, y] = (r, g, b, 0)

    img = full.crop(CROP_BOX)
    w, h = img.size
    print("  裁窗口 %s → %dx%d" % (CROP_BOX, w, h))

    scale = TARGET_HEIGHT / float(h)
    return img.resize((int(round(w * scale)), TARGET_HEIGHT), Image.LANCZOS)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--idle", required=True)
    ap.add_argument("--angry", required=True)
    ap.add_argument("--out-dir", default="pet-app/assets/mood")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_dir = args.out_dir if os.path.isabs(args.out_dir) else os.path.join(root, args.out_dir)
    os.makedirs(out_dir, exist_ok=True)

    v = not args.quiet
    idle = process(args.idle, "idle", v)
    angry = process(args.angry, "angry", v)

    # 统一画布（右下对齐）→ 两个状态完全对齐
    W = max(idle.width, angry.width)
    H = max(idle.height, angry.height)
    print("统一画布 %dx%d（右下对齐）" % (W, H))
    for img, name in ((idle, "idle"), (angry, "angry")):
        canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        canvas.paste(img, (W - img.width, H - img.height), img)
        out = os.path.join(out_dir, name + ".png")
        canvas.save(out, "PNG", optimize=True)
        print("  %s  %dx%d  %.1f KB" % (out, canvas.width, canvas.height,
                                        os.path.getsize(out) / 1024.0))


if __name__ == "__main__":
    main()

#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
生成小鲸鱼（DeepSeek 娘）的两态情绪素材。

与 GPT 娘的区别：小鲸鱼的**待机图已经是一张成品**（pet-app/assets/ds-whale.png，
610x610 紧裁透明 PNG），而生气图是新的黑底原图。两者不同源，不能用"同一个裁剪窗口"
来保证对齐，所以要**以待机图为基准**做几何匹配：

  1 处理生气原图（去黑底 / 剔气泡 / 保留角色与怒火标记）
  2 求生气图里「角色主体」的 bbox（不含悬浮的怒火标记）
  3 缩放到「主体高度 == 待机图内容高度」
  4 把生气图的主体 bbox 对齐到待机图的内容 bbox（左上对齐）
  5 两张图补到同一画布（画布按两者并集扩张，共同平移）

这样两个状态里角色的位置与大小完全一致，切换不跳位；
怒火标记溢出到角色左下方也没关系（画布会为它留出空间）。

用法：
  python tools/make-whale-mood.py --idle pet-app/assets/ds-whale.png \
                                  --angry <生气原图> \
                                  --out-dir pet-app/assets/mood
输出 whale-idle.png / whale-angry.png（同画布尺寸）
"""
import argparse
import os
from collections import deque

from PIL import Image

FINE_TOL = 38
COARSE_TOL = 95
RED_RATIO_KEEP = 0.22
MIN_AREA = 400
CONTENT_TOL = 20


def flood_bg(img, tol):
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


def content_bbox(img, tol=CONTENT_TOL, alpha_only=False):
    w, h = img.size
    px = img.load()
    minx, miny, maxx, maxy = w, h, -1, -1
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            hit = (a > 8) if alpha_only else (a > 0 and max(r, g, b) > tol)
            if hit:
                if x < minx: minx = x
                if y < miny: miny = y
                if x > maxx: maxx = x
                if y > maxy: maxy = y
    if maxx < 0:
        raise SystemExit("内容范围为空白")
    return (minx, miny, maxx, maxy)


def strip_background(img, label, verbose):
    """去黑底 + 剔气泡；返回 (img, 角色主体bbox, 全部保留内容bbox)。"""
    w, h = img.size
    px = img.load()

    cb = flood_bg(img, COARSE_TOL)
    ccomps = components(bytearray(1 if not cb[i] else 0 for i in range(w * h)), w, h, min_area=2000)
    bubble = None
    for (n, bb, _) in ccomps:
        if (bb[1] + bb[3]) / 2.0 < h / 2.0 and n > (w * h) * 0.08:
            bubble = bb
            break
    if verbose:
        print("  [%s] 气泡：%s" % (label, ("剔除 bbox %s" % (bubble,)) if bubble else "未识别到"))

    fb = flood_bg(img, FINE_TOL)
    fg = bytearray(w * h)
    for i in range(w * h):
        if fb[i]:
            continue
        if bubble:
            x = i % w
            y = i // w
            if (bubble[0] - 6 <= x <= bubble[2] + 6) and (bubble[1] - 6 <= y <= bubble[3] + 6):
                continue
        fg[i] = 1

    comps = components(fg, w, h)
    keep = bytearray(w * h)
    body_bbox = None
    for idx, (n, bb, pts) in enumerate(comps):
        reds = sum(1 for (x, y) in pts if is_red(px, x, y))
        ratio = reds / float(n)
        if idx == 0 or ratio >= RED_RATIO_KEEP:
            if idx == 0:
                body_bbox = bb
            if verbose:
                tag = "角色主体" if idx == 0 else "怒火标记(红%.2f)" % ratio
                print("  [%s] 保留 %-9d %-30s %s" % (label, n, str(bb), tag))
            for (x, y) in pts:
                keep[y * w + x] = 1
        elif verbose:
            print("  [%s] 丢弃 %-9d %-30s 红占比 %.2f" % (label, n, str(bb), ratio))

    for y in range(h):
        base = y * w
        for x in range(w):
            if not keep[base + x]:
                r, g, b, _ = px[x, y]
                px[x, y] = (r, g, b, 0)
    return img, body_bbox


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--idle", required=True, help="待机成品图（含透明通道）")
    ap.add_argument("--angry", required=True, help="生气原图（黑底 + 内嵌气泡）")
    ap.add_argument("--out-dir", default="pet-app/assets/mood")
    ap.add_argument("--pad", type=int, default=10, help="画布四周额外留白")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_dir = args.out_dir if os.path.isabs(args.out_dir) else os.path.join(root, args.out_dir)
    os.makedirs(out_dir, exist_ok=True)
    v = not args.quiet

    # —— 待机图（已是透明成品）——
    idle = Image.open(args.idle).convert("RGBA")
    idle_box = content_bbox(idle, alpha_only=True)
    ih = idle_box[3] - idle_box[1] + 1
    print("[idle] %s  %dx%d  内容 bbox %s（高 %d）" % (args.idle, idle.width, idle.height, idle_box, ih))

    # —— 生气原图 ——
    angry_raw = Image.open(args.angry).convert("RGBA")
    print("[angry] %s  %dx%d" % (args.angry, angry_raw.width, angry_raw.height))
    angry, body = strip_background(angry_raw, "angry", v)
    assert body, "没有识别出角色主体"
    bh_src = body[3] - body[1] + 1
    print("  角色主体 bbox %s（高 %d）" % (body, bh_src))

    # —— 缩放生气图：主体高度对齐待机图内容高度，再紧裁到全部保留内容 ——
    scale = ih / float(bh_src)
    # 先把主体 bbox 裁出来缩放，避免缩放整张 2048 图带来的巨大内存与无关像素。
    # ⚠️ 但**悬浮的怒火标记会溢出到主体之外**：若只裁主体，标记会被切掉
    #   （实测第一版右上角就有半个红叉被切）。所以裁的是「全部保留内容的 bbox」，
    #   并记录主体相对它的偏移，缩放后按同一比例还原。
    all_box = content_bbox(angry, alpha_only=True)
    keep_img = angry.crop((all_box[0], all_box[1], all_box[2] + 1, all_box[3] + 1))
    new_w = int(round(keep_img.width * scale))
    new_h = int(round(keep_img.height * scale))
    keep_img = keep_img.resize((new_w, new_h), Image.LANCZOS)
    print("  生气内容缩放 %.4f → %dx%d（主体高 %d 对齐待机内容高 %d）"
          % (scale, new_w, new_h, ih, ih))

    # 缩放后主体在该块内的落点（按同比例）
    off_x = int(round((body[0] - all_box[0]) * scale))
    off_y = int(round((body[1] - all_box[1]) * scale))

    # —— 合成：生气主体对齐到待机内容 bbox 的左上角 ——
    dx = idle_box[0] - off_x
    dy = idle_box[1] - off_y
    # 画布要同时容纳：待机图本身、生气块（可能向左上溢出怒火标记）
    W = max(idle.width, dx + keep_img.width)
    H = max(idle.height, dy + keep_img.height)
    W = max(W, 0)
    H = max(H, 0)
    # 若有负向溢出，整体右移/下移，并把待机图也一起平移（保持相对位置）
    shift_x = max(0, -dx)
    shift_y = max(0, -dy)
    W += shift_x
    H += shift_y
    dx += shift_x
    dy += shift_y
    canvas_angry = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    canvas_angry.paste(keep_img, (dx, dy), keep_img)
    canvas_idle = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    canvas_idle.paste(idle, (shift_x, shift_y), idle)
    print("  合成画布 %dx%d（生气块落点 %d,%d；待机平移 %d,%d）" % (W, H, dx, dy, shift_x, shift_y))

    # —— 统一补白（四周 pad），两态同步平移，保持相对位置 ——
    P = args.pad
    W2, H2 = W + P * 2, H + P * 2
    out_idle = Image.new("RGBA", (W2, H2), (0, 0, 0, 0))
    out_idle.paste(canvas_idle, (P, P), canvas_idle)
    out_angry = Image.new("RGBA", (W2, H2), (0, 0, 0, 0))
    out_angry.paste(canvas_angry, (P, P), canvas_angry)

    for img, name in ((out_idle, "whale-idle"), (out_angry, "whale-angry")):
        out = os.path.join(out_dir, name + ".png")
        img.save(out, "PNG", optimize=True)
        ab = content_bbox(img, alpha_only=True)
        margins = (ab[0], ab[1], W2 - 1 - ab[2], H2 - 1 - ab[3])
        warn = "" if min(margins) > 0 else "  [WARN] 贴边 %s" % (margins,)
        print("  %s  %dx%d  %.1f KB  内容%s 边距%s%s"
              % (out, img.width, img.height, os.path.getsize(out) / 1024.0, ab, margins, warn))

    # —— 对齐自检 ——
    # 主体在两态里的实际落点：待机图被平移了 (shift_x, shift_y)，
    # 生气图的主体在其块内偏移 (off_x, off_y)。两者的最终位置必须一致。
    idle_body_x = shift_x + idle_box[0]
    idle_body_y = shift_y + idle_box[1]
    angry_body_x = dx + off_x
    angry_body_y = dy + off_y
    print("对齐校验：待机主体落点 (%d,%d) 高 %d ；生气主体落点 (%d,%d) 高 %d"
          % (idle_body_x, idle_body_y, ih, angry_body_x, angry_body_y, ih))
    if (idle_body_x, idle_body_y) != (angry_body_x, angry_body_y):
        raise SystemExit("对齐失败：两态主体落点不一致 (%d,%d) vs (%d,%d)"
                         % (idle_body_x, idle_body_y, angry_body_x, angry_body_y))
    print("  -> 两态主体位置与高度一致，切换不会跳位（已断言）")


if __name__ == "__main__":
    main()

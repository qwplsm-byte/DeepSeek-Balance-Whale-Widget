#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
从「黑底 + 内嵌思考气泡」的原始角色图，生成 pet-app 的情绪状态精灵图。

═══ 两个必须遵守的设计要点（都是实测踩出来的）═══

① 裁剪框必须**自动计算**，不能写死坐标。
   最初写死 (850,843,2048,2048)，而 843 恰好卡在角色最顶端（真实 bbox 从 y=843 起）——
   结果呆毛尖端与左角被切掉，成品图顶部边距 = 0。现在改成：
   先在两态原图上分别求内容范围，再取**并集**并留出透明边距。
   两态共用同一个框 → 天然像素级对齐，切换不跳位。

② 必须先在**整张原图**上剔除气泡，最后才裁框。
   先裁框的话，气泡只剩一小段弧线、面积不到阈值 → 识别不出来，
   角色头顶会挂着半条深蓝弧线、左下留着气泡尾巴圆。

═══ 去黑底的两级阈值 ═══

低阈值(38) 保留角色边缘抗锯齿，但气泡描边与角色靠近时会连成一块；
高阈值(95) 能切断那层"灰桥"、让气泡与角色分离，代价是角色边缘略瘦。
所以：高阈值只用来**定位气泡**，前景仍用低阈值取 —— 两头好处都要。

═══ 悬浮元素 ═══

生气图里的红色怒火标记**不与角色相连**。按"红像素占比"识别保留
（实测 0.67–0.84），气泡尾巴 / 描边残渣红占比为 0 → 丢弃。

用法：
  python tools/make-mood-sprites.py --idle <待机原图> --angry <生气原图> \
                                     --out-dir pet-app/assets/mood --name gpt
  # 输出 <out-dir>/<name>-idle.png 与 <name>-angry.png（同尺寸）
  # 兼容旧的 idle.png / angry.png 命名：不传 --name 时用旧名
"""
import argparse
import os
from collections import deque

from PIL import Image

FINE_TOL = 38           # 精细去黑底：保留角色边缘抗锯齿
COARSE_TOL = 95         # 粗阈值：用来切断气泡与角色之间的"灰桥"
RED_RATIO_KEEP = 0.22   # 悬浮块红像素占比 ≥ 此值 → 判为怒火标记，保留
MIN_AREA = 400
CONTENT_TOL = 20        # 计算内容范围时的阈值（低，确保暗描边/抗锯齿都算进来）
PAD_RATIO = 0.02        # 裁剪框四周留白（按内容尺寸比例）
TARGET_HEIGHT = 1026    # 输出高度（与现有 DSniang1.png 一致）


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


def content_bbox(img, tol=CONTENT_TOL):
    """内容范围（低阈值，含暗描边）。用于自动算裁剪框。"""
    w, h = img.size
    px = img.load()
    minx, miny, maxx, maxy = w, h, -1, -1
    for y in range(h):
        row_off = y * w
        for x in range(w):
            r, g, b, a = px[x, y]
            if a > 0 and max(r, g, b) > tol:
                if x < minx: minx = x
                if y < miny: miny = y
                if x > maxx: maxx = x
                if y > maxy: maxy = y
    if maxx < 0:
        raise SystemExit("内容范围为空白：整张图都是黑的？")
    return (minx, miny, maxx, maxy)


def strip_background(img, label, verbose):
    """去黑底 + 剔气泡 + 保留主体与怒火标记。返回 RGBA 图（未裁剪）。"""
    w, h = img.size
    px = img.load()

    # ① 高阈值定位气泡（上半部、面积占比够大）
    cb = flood_bg(img, COARSE_TOL)
    ccomps = components(bytearray(1 if not cb[i] else 0 for i in range(w * h)), w, h, min_area=2000)
    bubble = None
    for (n, bb, _) in ccomps:
        if (bb[1] + bb[3]) / 2.0 < h / 2.0 and n > (w * h) * 0.08:
            bubble = bb
            break
    if verbose:
        print("  [%s] 气泡：%s" % (label, ("bbox %s → 剔除" % (bubble,)) if bubble else "未识别到（继续）"))

    # ② 低阈值前景，去掉气泡区
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

    # ③ 剔除气泡后：最大块 = 角色；红占比高 = 怒火标记；其余丢弃
    comps = components(fg, w, h)
    keep = bytearray(w * h)
    for idx, (n, bb, pts) in enumerate(comps):
        reds = sum(1 for (x, y) in pts if is_red(px, x, y))
        ratio = reds / float(n)
        if idx == 0 or ratio >= RED_RATIO_KEEP:
            if verbose:
                tag = "角色主体" if idx == 0 else "怒火标记(红%.2f)" % ratio
                print("  [%s] 保留 %-9d %-32s %s" % (label, n, str(bb), tag))
            for (x, y) in pts:
                keep[y * w + x] = 1
        elif verbose:
            print("  [%s] 丢弃 %-9d %-32s 红占比 %.2f（气泡尾巴/残渣）" % (label, n, str(bb), ratio))

    for y in range(h):
        base = y * w
        for x in range(w):
            if not keep[base + x]:
                r, g, b, _ = px[x, y]
                px[x, y] = (r, g, b, 0)
    return img


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--idle", required=True)
    ap.add_argument("--angry", required=True)
    ap.add_argument("--out-dir", default="pet-app/assets/mood")
    ap.add_argument("--name", default="",
                    help="输出前缀，如 gpt → gpt-idle.png / gpt-angry.png；留空则用 idle.png / angry.png")
    ap.add_argument("--pad-ratio", type=float, default=PAD_RATIO)
    ap.add_argument("--target-height", type=int, default=TARGET_HEIGHT)
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_dir = args.out_dir if os.path.isabs(args.out_dir) else os.path.join(root, args.out_dir)
    os.makedirs(out_dir, exist_ok=True)
    v = not args.quiet

    # —— 第一遍：各自去气泡，并记录内容范围（用于自动算框）——
    processed = {}
    boxes = {}
    for path, label in ((args.idle, "idle"), (args.angry, "angry")):
        img = Image.open(path).convert("RGBA")
        if v:
            print("[%s] 原图 %dx%d" % (label, img.width, img.height))
        img = strip_background(img, label, v)
        bb = content_bbox(img)
        boxes[label] = bb
        processed[label] = img
        if v:
            print("  [%s] 内容范围 %s（宽 %d 高 %d）" % (label, bb, bb[2] - bb[0], bb[3] - bb[1]))

    # —— 自动计算联合裁剪框（关键修复：不再写死坐标）——
    x0 = min(boxes['idle'][0], boxes['angry'][0])
    y0 = min(boxes['idle'][1], boxes['angry'][1])
    x1 = max(boxes['idle'][2], boxes['angry'][2])
    y1 = max(boxes['idle'][3], boxes['angry'][3])
    cw, ch = x1 - x0 + 1, y1 - y0 + 1
    pad_x = int(round(cw * args.pad_ratio))
    pad_y = int(round(ch * args.pad_ratio))
    W, H = processed['idle'].size
    # 联合框向外留白；若原图本身内容就顶到边界（例如角色肩膀贴到画布底边），
    # 就用"补透明画布"的方式把留白凑够 —— 直接 clamp 到边界会导致该侧边距为 0，
    # 视觉上像被切了一刀（实测：愤怒图下边距为 0）。
    cx0 = x0 - pad_x
    cy0 = y0 - pad_y
    cx1 = x1 + pad_x
    cy1 = y1 + pad_y
    pad_left = max(0, -cx0)
    pad_top = max(0, -cy0)
    pad_right = max(0, cx1 - (W - 1))
    pad_bottom = max(0, cy1 - (H - 1))
    cx0 = max(0, cx0)
    cy0 = max(0, cy0)
    cx1 = min(W - 1, cx1)
    cy1 = min(H - 1, cy1)
    box = (cx0, cy0, cx1 + 1, cy1 + 1)
    print("自动裁剪框 %s（联合内容 %s + 留白 %d,%dpx；画布外补白 左%d 上%d 右%d 下%d）→ %dx%d"
          % (box, (x0, y0, x1, y1), pad_x, pad_y, pad_left, pad_top, pad_right, pad_bottom,
             box[2] - box[0], box[3] - box[1]))

    # —— 第二遍：两态用同一个框裁剪（外加补白）+ 统一缩放到目标高度 ——
    out_imgs = {}
    for label in ('idle', 'angry'):
        img = processed[label].crop(box)
        if pad_left or pad_top or pad_right or pad_bottom:
            padded = Image.new("RGBA", (img.width + pad_left + pad_right,
                                        img.height + pad_top + pad_bottom), (0, 0, 0, 0))
            padded.paste(img, (pad_left, pad_top), img)
            img = padded
        scale = args.target_height / float(img.height)
        img = img.resize((int(round(img.width * scale)), args.target_height), Image.LANCZOS)
        out_imgs[label] = img

    # 补成同宽（透明留白，右侧对齐）→ 像素级对齐
    TW = max(out_imgs['idle'].width, out_imgs['angry'].width)
    TH = max(out_imgs['idle'].height, out_imgs['angry'].height)
    prefix = (args.name + '-') if args.name else ''
    for label in ('idle', 'angry'):
        img = out_imgs[label]
        canvas = Image.new("RGBA", (TW, TH), (0, 0, 0, 0))
        canvas.paste(img, (TW - img.width, TH - img.height), img)
        out = os.path.join(out_dir, prefix + label + '.png')
        canvas.save(out, "PNG", optimize=True)
        # 自检：四周必须有透明留白，否则说明还在切边
        ab = content_bbox(canvas)
        margins = (ab[0], ab[1], TW - 1 - ab[2], TH - 1 - ab[3])
        warn = "" if min(margins) > 0 else "  [WARN] 仍有贴边（左上右下=%s）" % (margins,)
        print("  %s  %dx%d  %.1f KB  边距(左,上,右,下)=%s%s"
              % (out, canvas.width, canvas.height, os.path.getsize(out) / 1024.0, margins, warn))


if __name__ == "__main__":
    main()

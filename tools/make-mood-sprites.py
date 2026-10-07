#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
生成 pet-app 的情绪状态精灵图（idle / angry），**以运行时真正使用的 idle 图为几何基准**。

═══ 为什么必须"以 idle 图为基准"（这是第二态裁剪问题的根因）═══

挂件用 `object-fit: contain` 显示角色，缩放比 = min(框宽/W, 框高/H)。
所以两个状态若**画布尺寸不同**，缩放比就不同 —— 即使角色在各自画布里"摆得对"，
切到挂件上也会缩放 + 位移，表现为"第二态没裁剪好"。

实测踩到的具体形态：
  · 运行时 idle 走角色的 image（DSniang1.png 983x1026，内容 356x372@挂件）
  · 运行时 angry 走 mood/gpt-angry.png（1006x1026，内容 351x358@挂件）
  → 宽 -5px、高 -14px 的偏差，切换时角色会跳。

因此本脚本：读 idle 图 → 求其内容 bbox → 把生气图的主体**等比缩放到与 idle 内容等高**、
并把主体 bbox **对齐到 idle 内容 bbox 的左上角**，两态输出**同一画布尺寸**。
这样挂件缩放比一致、主体落点一致 ⇒ 切换零跳动。

═══ 去黑底 / 剔气泡 / 保留悬浮怒火标记 ═══

· 低阈值(38) 保留角色边缘抗锯齿；高阈值(95) 才能切断气泡与角色间那层"灰桥"。
  所以用高阈值**只定位气泡**，前景仍用低阈值取。
· 生气图的红色怒火标记是**悬浮**的（不与角色相连），按红像素占比识别保留
  （实测 0.57~0.84）；气泡尾巴/描边残渣红占比为 0 → 丢弃。
· 必须在**整张原图**上剔气泡、最后才裁框；先裁框的话气泡只剩一小段弧线，
  面积不到阈值就识别不出来，角色头顶会挂半条深蓝弧线。

用法：
  python tools/make-mood-sprites.py --ref <运行时idle图> --angry <生气原图> --prefix gpt
  # 输出 <out-dir>/<prefix>-idle.png 与 <prefix>-angry.png（同画布尺寸）
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


def head_width(img, band=0.38):
    """
    量「头部宽」作为归一化依据。

    为什么不用身体 bbox 高度：两个状态的姿势不同（idle 是紧裁胸像、angry 常露出更多
    肩膀/发尾），身体高度不可比。而**头部宽度**是眼睛判断"角色多大"的依据：
    实测 gpt 两图头宽都是 847（比值 1.0000），小鲸鱼却是 462 vs 572（0.8077）——
    后者切换时头像会大 24%，看起来就是"第二态没裁剪好"。
    """
    bb = content_bbox(img)
    top = bb[1]
    hgt = bb[3] - bb[1] + 1
    y_end = min(bb[3], top + max(1, int(hgt * band)))
    w, h = img.size
    px = img.load()
    best = 0
    for y in range(top, y_end + 1):
        xs = [x for x in range(bb[0], bb[2] + 1)
              if px[x, y][3] > 8 and max(px[x, y][0], px[x, y][1], px[x, y][2]) > 20]
        if xs:
            ww = xs[-1] - xs[0] + 1
            if ww > best:
                best = ww
    return best


def strip_background(img, label, verbose):
    """去黑底 + 剔气泡；返回 (img, 角色主体bbox)。保留悬浮的红色怒火标记。"""
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
    body = None
    for idx, (n, bb, pts) in enumerate(comps):
        reds = sum(1 for (x, y) in pts if is_red(px, x, y))
        ratio = reds / float(n)
        if idx == 0 or ratio >= RED_RATIO_KEEP:
            if idx == 0:
                body = bb
            if verbose:
                tag = "角色主体" if idx == 0 else "怒火标记(红%.2f)" % ratio
                print("  [%s] 保留 %-9d %-30s %s" % (label, n, str(bb), tag))
            for (x, y) in pts:
                keep[y * w + x] = 1
        elif verbose:
            print("  [%s] 丢弃 %-9d %-30s 红占比 %.2f（气泡尾巴/残渣）" % (label, n, str(bb), ratio))

    for y in range(h):
        base = y * w
        for x in range(w):
            if not keep[base + x]:
                r, g, b, _ = px[x, y]
                px[x, y] = (r, g, b, 0)
    return img, body


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", required=True, help="运行时真正使用的 idle 图（挂件 idle 走的那张）")
    ap.add_argument("--angry", required=True, help="生气原图（黑底 + 内嵌气泡）")
    ap.add_argument("--prefix", required=True, help="输出前缀，如 gpt / whale")
    ap.add_argument("--out-dir", default="pet-app/assets/mood")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_dir = args.out_dir if os.path.isabs(args.out_dir) else os.path.join(root, args.out_dir)
    os.makedirs(out_dir, exist_ok=True)
    v = not args.quiet

    # —— 基准：运行时 idle 图 ——
    ref = Image.open(args.ref).convert("RGBA")
    ref_box = content_bbox(ref, alpha_only=True)
    ref_h = ref_box[3] - ref_box[1] + 1
    print("[ref] %s  %dx%d  内容 bbox %s（高 %d）" % (args.ref, ref.width, ref.height, ref_box, ref_h))

    # —— 生气图：去黑底 / 剔气泡 / 留怒火标记 ——
    angry_raw = Image.open(args.angry).convert("RGBA")
    print("[angry] %s  %dx%d" % (args.angry, angry_raw.width, angry_raw.height))
    angry, body = strip_background(angry_raw, "angry", v)
    assert body, "没有识别出角色主体"
    body_h = body[3] - body[1] + 1
    print("  角色主体 bbox %s（高 %d）" % (body, body_h))

    # —— 等比缩放生气图：**头部宽度**对齐 idle 的头部宽度 ——
    # 不用身体高度：两态姿势不同（idle 紧裁胸像、angry 常露出更多肩膀/发尾），
    # 身体高度不可比。头宽才是眼睛判断"角色多大"的依据：
    # 实测 gpt 两图头宽都是 847（比值 1.0000），小鲸鱼却是 462 vs 572（0.8077）——
    # 后者切换时头像会大 24%，看起来就是"第二态没裁剪好"。
    ref_head = head_width(ref)
    angry_head = head_width(angry)
    assert ref_head > 0 and angry_head > 0, "测不到头部宽度"
    scale = ref_head / float(angry_head)
    all_box = content_bbox(angry, alpha_only=True)
    patch = angry.crop((all_box[0], all_box[1], all_box[2] + 1, all_box[3] + 1))
    new_w = max(1, int(round(patch.width * scale)))
    new_h = max(1, int(round(patch.height * scale)))
    patch = patch.resize((new_w, new_h), Image.LANCZOS)
    # 主体在该块内的落点（同比例）
    off_x = int(round((body[0] - all_box[0]) * scale))
    off_y = int(round((body[1] - all_box[1]) * scale))
    print("  头部宽 idle %d / angry %d → 缩放 %.4f；内容 → %dx%d"
          % (ref_head, angry_head, scale, new_w, new_h))

    # —— 让两态的主体都**贴死画布右下角**（挂件是 right bottom 对齐）——
    # 这是"第二态看着没裁剪好"的真正修法：
    #   挂件用 object-fit:contain + object-position:right bottom。因此
    #     · 画布尺寸决定缩放比（两个状态必须同画布）
    #     · 主体相对画布右下角的位置必须一致（都贴死右下角）
    #   否则切换时角色会缩放 + 位移。
    # 实测踩到的形态：idle 用 ds-whale.png（主体右边距 0）而 angry 主体更宽，
    # 老实现把 idle 直接贴进更大的画布 ⇒ idle 右边距变成 80px，切换时右移约 43px。
    # 生气图主体在缩放后的实际尺寸
    bw_a = max(1, int(round((body[2] - body[0] + 1) * scale)))
    bh_a = max(1, int(round((body[3] - body[1] + 1) * scale)))
    # idle（ref）主体尺寸
    bw_r = ref_box[2] - ref_box[0] + 1
    bh_r = ref_box[3] - ref_box[1] + 1

    # 画布最小尺寸：保证两态各自「主体贴右下角」时都不越界
    W = max(bw_a + off_x, bw_r + ref_box[0], 1)
    H = max(bh_a + off_y, bh_r + ref_box[1], 1)

    # 生气图：patch 放这里 => 主体右下角 = (W-1, H-1)
    ax = W - bw_a - off_x
    ay = H - bh_a - off_y
    # idle：ref 放这里 => 主体右下角 = (W-1, H-1)
    rx = W - bw_r - ref_box[0]
    ry = H - bh_r - ref_box[1]
    assert ax >= 0 and ay >= 0, "画布算错：生气图放不下（ax=%d ay=%d）" % (ax, ay)
    assert rx >= 0 and ry >= 0, "画布算错：idle 放不下（rx=%d ry=%d）" % (rx, ry)

    canvas_idle = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    canvas_idle.paste(ref, (rx, ry), ref)
    canvas_angry = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    canvas_angry.paste(patch, (ax, ay), patch)
    print("  画布 %dx%d；主体右下角对齐: idle(%d,%d) angry(%d,%d)"
          % (W, H, rx + ref_box[2], ry + ref_box[3], ax + off_x + bw_a - 1, ay + off_y + bh_a - 1))
    print("  主体尺寸: idle %dx%d / angry %dx%d" % (bw_r, bh_r, bw_a, bh_a))

    # —— 断言：两态**头部宽度**必须一致（挂件上看到的大小才一致）——
    ih2 = head_width(canvas_idle)
    ah2 = head_width(canvas_angry)
    if abs(ih2 - ah2) > 2:
        raise SystemExit("对齐失败：两态头部宽度不一致 %d vs %d" % (ih2, ah2))
    if (rx + ref_box[2], ry + ref_box[3]) != (ax + off_x + bw_a - 1, ay + off_y + bh_a - 1):
        raise SystemExit("对齐失败：两态主体右下角不一致")
    print("  头部宽度校验：idle %d / angry %d（差 %d px，已断言）" % (ih2, ah2, abs(ih2 - ah2)))

    for img, state in ((canvas_idle, "idle"), (canvas_angry, "angry")):
        out = os.path.join(out_dir, args.prefix + "-" + state + ".png")
        img.save(out, "PNG", optimize=True)
        bb = content_bbox(img, alpha_only=True)
        margins = (bb[0], bb[1], W - 1 - bb[2], H - 1 - bb[3])
        print("  %s  %dx%d  %.1f KB  内容%s 边距(左,上,右,下)=%s"
              % (out, img.width, img.height, os.path.getsize(out) / 1024.0, bb, margins))
    print("  ✓ 两态主体同高 %d、同右下角 —— 挂件缩放比一致，切换不跳位" % bh_r)


if __name__ == "__main__":
    main()

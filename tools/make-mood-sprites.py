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

多态（吃醋 / 伤心等）：`--angry` 是 `--state angry=<图>` 的等价简写，可以重复给 `--state`：

  python tools/make-mood-sprites.py --ref pet-app/assets/DSniang1.png --prefix gpt \
      --state jealous=pet-app/assets/mood-src/jealous.jpg \
      --state sad=pet-app/assets/mood-src/sad.jpg

**所有状态都共用同一张 idle 基准图与同一块画布** —— 这是多态不跳位的前提：
每个状态各自按头宽归一化、各自贴死画布右下角，画布尺寸取所有状态里最大的那个。
"""
import argparse
import os
import sys
from collections import deque

from PIL import Image

# Windows 控制台默认 GBK，脚本里的 ✓ 等字符会让**成功的一轮在最后一行 print 崩掉**
# （退出码非 0 ⇒ 看起来像生成失败，实际文件已经写好了）。这里把 stdout 固定成 UTF-8。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

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


def state_args(args):
    """
    状态清单：`--angry <图>` 是 `--state angry=<图>` 的简写（旧命令一字不改仍可用），
    `--state` 可重复，用来加第三/第四态（吃醋 / 伤心 …）。
    """
    out = []
    if args.angry:
        out.append(("angry", args.angry))
    for raw in (args.state or []):
        if "=" not in raw:
            raise SystemExit("--state 必须写成 <名字>=<图片路径>，收到：%s" % raw)
        name, src = raw.split("=", 1)
        name, src = name.strip(), src.strip()
        if not name or not src:
            raise SystemExit("--state 必须写成 <名字>=<图片路径>，收到：%s" % raw)
        if name == "idle":
            raise SystemExit("状态名不能用 idle（idle 就是 --ref 那张基准图本身）")
        out.append((name, src))
    if not out:
        raise SystemExit("至少给一个状态：--angry <图>，或 --state <名字>=<图>")
    names = [n for n, _ in out]
    dup = sorted({n for n in names if names.count(n) > 1})
    if dup:
        raise SystemExit("同一个状态给了多张图：" + ", ".join(dup))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", required=True, help="运行时真正使用的 idle 图（挂件 idle 走的那张）")
    ap.add_argument("--angry", help="生气原图（黑底 + 内嵌气泡）；等价于 --state angry=<图>")
    ap.add_argument("--state", action="append", default=[], metavar="NAME=PATH",
                    help="额外状态原图，可重复，如 --state jealous=pet-app/assets/mood-src/jealous.jpg")
    ap.add_argument("--prefix", required=True, help="输出前缀，如 gpt / whale")
    ap.add_argument("--out-dir", default="pet-app/assets/mood")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_dir = args.out_dir if os.path.isabs(args.out_dir) else os.path.join(root, args.out_dir)
    os.makedirs(out_dir, exist_ok=True)
    v = not args.quiet
    states = state_args(args)

    # —— 基准：运行时 idle 图 ——
    ref = Image.open(args.ref).convert("RGBA")
    ref_box = content_bbox(ref, alpha_only=True)
    ref_h = ref_box[3] - ref_box[1] + 1
    ref_head = head_width(ref)
    assert ref_head > 0, "基准图测不到头部宽度"
    # idle（ref）主体尺寸
    bw_r = ref_box[2] - ref_box[0] + 1
    bh_r = ref_box[3] - ref_box[1] + 1
    print("[ref] %s  %dx%d  内容 bbox %s（高 %d，头宽 %d）"
          % (args.ref, ref.width, ref.height, ref_box, ref_h, ref_head))

    # —— 每个状态：去黑底 / 剔气泡 / 留怒火标记，再按**头部宽度**归一化 ——
    # 不用身体高度：各状态姿势不同（idle 紧裁胸像、生气常露出更多肩膀/发尾），
    # 身体高度不可比。头宽才是眼睛判断"角色多大"的依据：
    # 实测 gpt 两图头宽都是 847（比值 1.0000），小鲸鱼却是 462 vs 572（0.8077）——
    # 后者切换时头像会大 24%，看起来就是"第二态没裁剪好"。
    prepared = []
    for name, src in states:
        raw = Image.open(src).convert("RGBA")
        print("[%s] %s  %dx%d" % (name, src, raw.width, raw.height))
        img, body = strip_background(raw, name, v)
        assert body, "没有识别出角色主体（%s）" % name
        body_h = body[3] - body[1] + 1
        print("  角色主体 bbox %s（高 %d）" % (body, body_h))
        hd = head_width(img)
        assert hd > 0, "测不到头部宽度（%s）" % name
        scale = ref_head / float(hd)
        all_box = content_bbox(img, alpha_only=True)
        patch = img.crop((all_box[0], all_box[1], all_box[2] + 1, all_box[3] + 1))
        new_w = max(1, int(round(patch.width * scale)))
        new_h = max(1, int(round(patch.height * scale)))
        patch = patch.resize((new_w, new_h), Image.LANCZOS)
        # 主体在该块内的落点（同比例）
        off_x = int(round((body[0] - all_box[0]) * scale))
        off_y = int(round((body[1] - all_box[1]) * scale))
        # 该状态主体在缩放后的实际尺寸
        bw = max(1, int(round((body[2] - body[0] + 1) * scale)))
        bh = max(1, int(round((body[3] - body[1] + 1) * scale)))
        print("  头部宽 idle %d / %s %d → 缩放 %.4f；内容 → %dx%d"
              % (ref_head, name, hd, scale, new_w, new_h))
        prepared.append({"name": name, "patch": patch, "off_x": off_x, "off_y": off_y, "bw": bw, "bh": bh})

    # —— 让所有状态的主体都**贴死画布右下角**（挂件是 right bottom 对齐）——
    # 这是"第二态看着没裁剪好"的真正修法：
    #   挂件用 object-fit:contain + object-position:right bottom。因此
    #     · 画布尺寸决定缩放比（所有状态必须同画布）
    #     · 主体相对画布右下角的位置必须一致（都贴死右下角）
    #   否则切换时角色会缩放 + 位移。
    # 实测踩到的形态：idle 用 ds-whale.png（主体右边距 0）而 angry 主体更宽，
    # 老实现把 idle 直接贴进更大的画布 ⇒ idle 右边距变成 80px，切换时右移约 43px。
    #
    # 画布最小尺寸：保证每个状态「主体贴右下角」时都不越界（多态时取所有状态的最大值）
    W = max([bw_r + ref_box[0]] + [p["bw"] + p["off_x"] for p in prepared] + [1])
    H = max([bh_r + ref_box[1]] + [p["bh"] + p["off_y"] for p in prepared] + [1])

    # idle：ref 放这里 => 主体右下角 = (W-1, H-1)
    rx = W - bw_r - ref_box[0]
    ry = H - bh_r - ref_box[1]
    assert rx >= 0 and ry >= 0, "画布算错：idle 放不下（rx=%d ry=%d）" % (rx, ry)
    canvas_idle = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    canvas_idle.paste(ref, (rx, ry), ref)

    canvases = [("idle", canvas_idle, (rx + ref_box[2], ry + ref_box[3]), bw_r, bh_r)]
    print("  画布 %dx%d；主体尺寸 idle %dx%d；右下角 idle(%d,%d)"
          % (W, H, bw_r, bh_r, rx + ref_box[2], ry + ref_box[3]))
    for p in prepared:
        px = W - p["bw"] - p["off_x"]
        py = H - p["bh"] - p["off_y"]
        assert px >= 0 and py >= 0, "画布算错：%s 放不下（px=%d py=%d）" % (p["name"], px, py)
        c = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        c.paste(p["patch"], (px, py), p["patch"])
        canvases.append((p["name"], c, (px + p["off_x"] + p["bw"] - 1, py + p["off_y"] + p["bh"] - 1), p["bw"], p["bh"]))
        print("  主体尺寸 %s %dx%d；右下角 %s(%d,%d)"
              % (p["name"], p["bw"], p["bh"], p["name"],
                 px + p["off_x"] + p["bw"] - 1, py + p["off_y"] + p["bh"] - 1))

    # —— 断言：每个状态与 idle 的**头部宽度**必须一致（挂件上看到的大小才一致）——
    def_anchor = canvases[0][2]
    ih2 = head_width(canvas_idle)
    for name, img, anchor, bw, bh in canvases[1:]:
        h2 = head_width(img)
        if abs(h2 - ih2) > 2:
            raise SystemExit("对齐失败：idle 与 %s 头部宽度不一致 %d vs %d" % (name, ih2, h2))
        if anchor != def_anchor:
            raise SystemExit("对齐失败：idle 与 %s 主体右下角不一致 %s vs %s" % (name, anchor, def_anchor))
        print("  头部宽度校验：idle %d / %s %d（差 %d px，已断言）" % (ih2, name, h2, abs(ih2 - h2)))

    for name, img, anchor, bw, bh in canvases:
        out = os.path.join(out_dir, args.prefix + "-" + name + ".png")
        img.save(out, "PNG", optimize=True)
        bb = content_bbox(img, alpha_only=True)
        margins = (bb[0], bb[1], W - 1 - bb[2], H - 1 - bb[3])
        print("  %s  %dx%d  %.1f KB  内容%s 边距(左,上,右,下)=%s"
              % (out, img.width, img.height, os.path.getsize(out) / 1024.0, bb, margins))
    print("  ✓ %d 个状态同画布 %dx%d、主体同右下角 —— 挂件缩放比一致，切换不跳位"
          % (len(canvases), W, H))


if __name__ == "__main__":
    main()

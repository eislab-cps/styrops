#!/usr/bin/env python3
"""
Transform an architectural floor plan PDF into floorplan_data.json for the web viewer.

Usage:
    python3 transform.py <input.pdf> [output.json]

Pipeline:
    1. Render PDF to image, extract visible vector lines (filtered against render)
    2. Detect doors (paths with lines + curves, small bbox)
    3. Detect insulation symbols (small multi-segment paths)
    4. Extract room labels from text
    5. Build wall skeleton boundary (long lines only, dilated + thinned)
    6. Watershed from label positions to segment rooms
    7. Simplify room polygons (inscribed rectangles where possible)
    8. Output JSON with walls, doors, labels, and room polygons
"""

import sys
import json
import re
import cv2
import numpy as np
import fitz  # PyMuPDF


# === Configuration ===
RENDER_SCALE = 6           # PDF-to-pixel scale for rasterization
DOOR_MAX_BBOX = 8          # Max bbox size (PDF units) for door detection
INSULATION_MAX_BBOX = 3    # Max bbox for insulation symbol paths
INSULATION_MIN_ITEMS = 2   # Min items in path to be insulation
MIN_WALL_LENGTH = 5.0      # Min line length for room detection boundary
DILATION_KERNEL = 11       # Kernel size for closing door gaps
ROOM_MIN_AREA = 15         # Min room area in PDF sq units
ROOM_MAX_AREA = 7000       # Max room area (excludes lightyards)
RECT_COVERAGE = 0.55       # Min coverage ratio to use inscribed rectangle
LABEL_PATTERN = r'^A\d|^\d{4}'  # Regex for room label text


def classify_color(c):
    if c is None:
        return "none"
    r, g, b = c[0], c[1], c[2]
    if r < 0.2 and g < 0.2 and b < 0.2:
        return "black"
    elif r > 0.8 and g < 0.4:
        return "red"
    elif g > 0.6 and r < 0.5 and b < 0.4:
        return "green"
    elif g > 0.7 and b > 0.7 and r < 0.6:
        return "cyan"
    return "other"


def bezier_to_segments(p0, p1, p2, p3, num_steps=12):
    segments = []
    prev = None
    for i in range(num_steps + 1):
        t = i / num_steps
        mt = 1 - t
        x = mt**3*p0[0] + 3*mt**2*t*p1[0] + 3*mt*t**2*p2[0] + t**3*p3[0]
        y = mt**3*p0[1] + 3*mt**2*t*p1[1] + 3*mt*t**2*p2[1] + t**3*p3[1]
        pt = [round(x, 1), round(y, 1)]
        if prev is not None:
            segments.append([prev, pt])
        prev = pt
    return segments


def is_line_visible(seg, mask, scale, threshold=0.5):
    x1, y1 = seg[0]
    x2, y2 = seg[1]
    length = ((x2-x1)**2 + (y2-y1)**2)**0.5
    n = max(5, int(length * scale / 2))
    vis = 0
    for i in range(n):
        t = i / max(1, n-1)
        px = int((x1 + t*(x2-x1)) * scale)
        py = int((y1 + t*(y2-y1)) * scale)
        if 0 <= px < mask.shape[1] and 0 <= py < mask.shape[0] and mask[py, px] > 0:
            vis += 1
    return vis / n >= threshold


def build_visibility_masks(page, scale):
    mat = fitz.Matrix(scale, scale)
    pix = page.get_pixmap(matrix=mat)
    img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
    if pix.n == 4:
        img_rgb = cv2.cvtColor(img, cv2.COLOR_RGBA2BGR)
    else:
        img_rgb = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
    gray = cv2.cvtColor(img_rgb, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(img_rgb, cv2.COLOR_BGR2HSV)

    k = np.ones((3, 3), np.uint8)
    masks = {
        "black": cv2.dilate((gray < 150).astype(np.uint8) * 255, k, iterations=1),
        "red": cv2.dilate(
            cv2.inRange(hsv, (0, 50, 50), (10, 255, 255)) |
            cv2.inRange(hsv, (170, 50, 50), (180, 255, 255)), k, iterations=1),
        "green": cv2.dilate(cv2.inRange(hsv, (35, 50, 50), (85, 255, 255)), k, iterations=1),
    }
    return masks


def extract_lines_and_doors(drawings, masks, scale):
    wall_lines = []
    door_segs = []
    door_count = 0
    insulation_count = 0

    for d in drawings:
        color = classify_color(d.get("color"))
        if color not in ("black", "red", "green"):
            continue
        mask = masks.get(color)
        if mask is None:
            continue

        items = d["items"]
        has_line = any(item[0] == "l" for item in items)
        has_curve = any(item[0] == "c" for item in items)

        # Compute path bounding box
        all_pts = []
        for item in items:
            if item[0] == "l":
                all_pts.extend([(item[1].x, item[1].y), (item[2].x, item[2].y)])
            elif item[0] == "c":
                all_pts.extend([(item[k].x, item[k].y) for k in range(1, 5)])
            elif item[0] == "qu":
                q = item[1]
                all_pts.extend([(q.ul.x, q.ul.y), (q.ur.x, q.ur.y),
                                (q.lr.x, q.lr.y), (q.ll.x, q.ll.y)])

        if all_pts:
            xs = [p[0] for p in all_pts]
            ys = [p[1] for p in all_pts]
            bbox_size = max(max(xs)-min(xs), max(ys)-min(ys))
        else:
            bbox_size = 999

        # Insulation: small multi-segment paths
        if len(items) >= INSULATION_MIN_ITEMS and bbox_size < INSULATION_MAX_BBOX:
            insulation_count += 1
            continue

        # Door: path with curves + small bbox (mixed or curve-only red)
        if has_curve and bbox_size < DOOR_MAX_BBOX:
            if has_line or color == "red":
                door_count += 1
                for item in items:
                    if item[0] == "l":
                        seg = [[round(item[1].x, 1), round(item[1].y, 1)],
                               [round(item[2].x, 1), round(item[2].y, 1)]]
                        if is_line_visible(seg, mask, scale):
                            door_segs.append(seg)
                    elif item[0] == "c":
                        segs = bezier_to_segments(
                            (item[1].x, item[1].y), (item[2].x, item[2].y),
                            (item[3].x, item[3].y), (item[4].x, item[4].y))
                        for seg in segs:
                            if is_line_visible(seg, mask, scale):
                                door_segs.append(seg)
                continue

        # Wall: everything else
        for item in items:
            if item[0] == "l":
                seg = [[round(item[1].x, 1), round(item[1].y, 1)],
                       [round(item[2].x, 1), round(item[2].y, 1)]]
                if is_line_visible(seg, mask, scale):
                    wall_lines.append(seg)
            elif item[0] == "c":
                segs = bezier_to_segments(
                    (item[1].x, item[1].y), (item[2].x, item[2].y),
                    (item[3].x, item[3].y), (item[4].x, item[4].y))
                for seg in segs:
                    if is_line_visible(seg, mask, scale):
                        wall_lines.append(seg)
            elif item[0] == "qu":
                q = item[1]
                corners = [
                    [round(q.ul.x, 1), round(q.ul.y, 1)],
                    [round(q.ur.x, 1), round(q.ur.y, 1)],
                    [round(q.lr.x, 1), round(q.lr.y, 1)],
                    [round(q.ll.x, 1), round(q.ll.y, 1)],
                ]
                for k in range(4):
                    seg = [corners[k], corners[(k+1) % 4]]
                    if is_line_visible(seg, mask, scale):
                        wall_lines.append(seg)

    print(f"  Walls: {len(wall_lines)}, Doors: {door_count}, "
          f"Door segs: {len(door_segs)}, Insulation removed: {insulation_count}")
    return wall_lines, door_segs


def extract_labels(page):
    labels = []
    blocks = page.get_text("dict")["blocks"]
    for block in blocks:
        if "lines" not in block:
            continue
        for line in block["lines"]:
            for span in line["spans"]:
                text = span["text"].strip()
                if text and re.match(LABEL_PATTERN, text):
                    bbox = span["bbox"]
                    labels.append({
                        "text": text,
                        "x": round((bbox[0]+bbox[2])/2, 1),
                        "y": round((bbox[1]+bbox[3])/2, 1),
                    })
    print(f"  Labels: {len(labels)}")
    return labels


def build_boundary(wall_lines, door_segs, pw, ph, scale):
    wall_img = np.zeros((int(ph*scale), int(pw*scale)), dtype=np.uint8)

    # Use ALL wall lines (insulation already filtered at path level)
    for seg in wall_lines:
        cv2.line(wall_img,
                 (int(seg[0][0]*scale), int(seg[0][1]*scale)),
                 (int(seg[1][0]*scale), int(seg[1][1]*scale)), 255, 1)

    # Include door segments - they close door gaps
    for seg in door_segs:
        cv2.line(wall_img,
                 (int(seg[0][0]*scale), int(seg[0][1]*scale)),
                 (int(seg[1][0]*scale), int(seg[1][1]*scale)), 255, 1)

    dilated = cv2.dilate(wall_img, np.ones((DILATION_KERNEL, DILATION_KERNEL), np.uint8))
    skeleton = cv2.ximgproc.thinning(dilated)
    boundary = cv2.dilate(skeleton, np.ones((3, 3), np.uint8))

    # Mark exterior: flood fill from corners to find everything outside the building
    h, w = boundary.shape
    exterior = np.zeros((h+2, w+2), dtype=np.uint8)
    temp = boundary.copy()
    for seed in [(0,0), (w-1,0), (0,h-1), (w-1,h-1), (w//2,0), (w//2,h-1), (0,h//2), (w-1,h//2)]:
        if temp[seed[1], seed[0]] == 0:
            cv2.floodFill(temp, exterior, seed, 128)
    # Add exterior as wall (blocks watershed from going outside)
    exterior_mask = exterior[1:-1, 1:-1] > 0
    boundary[exterior_mask] = 255

    print(f"  Boundary: {len(wall_lines)} walls + {len(door_segs)} door segs, exterior blocked")
    return boundary


def find_seed(boundary, x, y, max_search=25):
    if 0 <= x < boundary.shape[1] and 0 <= y < boundary.shape[0] and boundary[y, x] == 0:
        return x, y
    for r in range(1, max_search):
        for dx in range(-r, r+1):
            for dy in range(-r, r+1):
                if abs(dx) != r and abs(dy) != r:
                    continue
                nx, ny = x+dx, y+dy
                if 0 <= nx < boundary.shape[1] and 0 <= ny < boundary.shape[0] and boundary[ny, nx] == 0:
                    return nx, ny
    return None


def largest_inscribed_rect(mask, x0, y0):
    rows, cols = mask.shape
    h = np.zeros(cols, dtype=int)
    best = (0, 0, 0, 0, 0)
    for y in range(rows):
        for x in range(cols):
            h[x] = h[x] + 1 if mask[y, x] else 0
        st = []
        for x in range(cols + 1):
            ch = h[x] if x < cols else 0
            while st and h[st[-1]] > ch:
                ht = h[st.pop()]
                w = x if not st else x - st[-1] - 1
                a = ht * w
                if a > best[0]:
                    best = (a, (st[-1]+1 if st else 0)+x0, y-ht+1+y0, w, ht)
            st.append(x)
    return best


def detect_rooms(labels, boundary, pw, ph, scale):
    markers = np.zeros(boundary.shape, dtype=np.int32)
    valid_labels = []

    for label in labels:
        px, py = int(label["x"]*scale), int(label["y"]*scale)
        seed = find_seed(boundary, px, py)
        if seed is None:
            continue
        px, py = seed
        mid = len(valid_labels) + 1
        markers[py, px] = mid
        valid_labels.append((label, mid))

    img_3ch = cv2.cvtColor(255 - boundary, cv2.COLOR_GRAY2BGR)
    cv2.watershed(img_3ch, markers)

    rooms = []
    for label, mid in valid_labels:
        region = cv2.erode((markers == mid).astype(np.uint8), np.ones((2, 2), np.uint8))
        area_pdf = np.count_nonzero(region) / (scale*scale)
        if area_pdf < ROOM_MIN_AREA or area_pdf > ROOM_MAX_AREA:
            continue

        # Crop for speed
        ys, xs = np.where(region > 0)
        if len(xs) == 0:
            continue
        x1, y1, x2, y2 = xs.min(), ys.min(), xs.max()+1, ys.max()+1
        crop = region[y1:y2, x1:x2]

        # Try inscribed rectangle
        ra, rx, ry, rw, rh = largest_inscribed_rect(crop, x1, y1)
        if ra < ROOM_MIN_AREA * scale * scale:
            continue

        cov = ra / max(1, np.count_nonzero(crop))

        if cov > RECT_COVERAGE:
            pts = [
                [round(rx/scale, 2), round(ry/scale, 2)],
                [round((rx+rw)/scale, 2), round(ry/scale, 2)],
                [round((rx+rw)/scale, 2), round((ry+rh)/scale, 2)],
                [round(rx/scale, 2), round((ry+rh)/scale, 2)],
            ]
        else:
            contours, _ = cv2.findContours(crop, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            if not contours:
                continue
            cnt = max(contours, key=cv2.contourArea)
            approx = cv2.approxPolyDP(cnt, 0.015 * cv2.arcLength(cnt, True), True)
            if len(approx) < 4:
                continue
            pts = [[round((p[0][0]+x1)/scale, 2), round((p[0][1]+y1)/scale, 2)] for p in approx]

        cx = sum(p[0] for p in pts) / len(pts)
        cy = sum(p[1] for p in pts) / len(pts)

        rooms.append({
            "id": len(rooms),
            "name": label["text"],
            "area": round(area_pdf, 1),
            "center": [round(cx, 2), round(cy, 2)],
            "polygon": pts,
        })

    rooms.sort(key=lambda r: r["name"])
    for i, r in enumerate(rooms):
        r["id"] = i

    print(f"  Rooms detected: {len(rooms)}")
    rects = sum(1 for r in rooms if len(r["polygon"]) == 4)
    print(f"  Rectangles: {rects}, Complex: {len(rooms)-rects}")
    return rooms


def transform(pdf_path, output_path="floorplan_data.json"):
    print(f"Processing: {pdf_path}")

    doc = fitz.open(pdf_path)
    page = doc[0]
    pw, ph = page.rect.width, page.rect.height
    print(f"  Page: {pw:.0f} x {ph:.0f}")

    print("Building visibility masks...")
    masks = build_visibility_masks(page, RENDER_SCALE)

    print("Extracting lines and doors...")
    drawings = page.get_drawings()
    wall_lines, door_segs = extract_lines_and_doors(drawings, masks, RENDER_SCALE)

    print("Extracting labels...")
    labels = extract_labels(page)

    doc.close()

    print("Building wall boundary skeleton...")
    boundary = build_boundary(wall_lines, door_segs, pw, ph, RENDER_SCALE)

    print("Detecting rooms via watershed...")
    rooms = detect_rooms(labels, boundary, pw, ph, RENDER_SCALE)

    output = {
        "page": {"width": pw, "height": ph},
        "rooms": rooms,
        "walls": wall_lines,
        "red_lines": door_segs,
        "green_lines": [],
        "labels": labels,
    }

    with open(output_path, "w") as f:
        json.dump(output, f)

    print(f"\nSaved to {output_path}")
    print(f"  {len(wall_lines)} walls, {len(door_segs)} door segments, "
          f"{len(labels)} labels, {len(rooms)} rooms")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <input.pdf> [output.json]")
        sys.exit(1)

    pdf_path = sys.argv[1]
    output_path = sys.argv[2] if len(sys.argv) > 2 else "floorplan_data.json"
    transform(pdf_path, output_path)

#!/usr/bin/env python3
"""
Build navigation graph using room type classification (corridor vs room).
- Rooms connect ONLY to adjacent corridors
- Corridors connect to adjacent corridors
- Never room-to-room directly
Does NOT touch walls, rooms, doors, labels, or type fields.

Usage: python3 build_graph.py
"""

import json
import numpy as np
from shapely.geometry import Polygon, LineString, Point as SPoint, MultiLineString
from shapely.ops import nearest_points, linemerge
from shapely.strtree import STRtree
from collections import defaultdict

import sys
BUILDING = sys.argv[1] if len(sys.argv) > 1 else 'abuilding'
LEVELS = [f'{BUILDING}/level0', f'{BUILDING}/level1', f'{BUILDING}/level2']
MAX_DIST = 5.0  # max polygon distance for adjacency


def build_floor_graph(level):
    with open(f'data/{level}/floorplan_data.json') as f:
        data = json.load(f)

    rooms = data['rooms']
    if not rooms:
        return data, 0, 0

    room_map = {r['id']: r for r in rooms}
    lightyard_ids = set(r['id'] for r in rooms if r['area'] > 5000)
    valid_rooms = [r for r in rooms if r['id'] not in lightyard_ids]

    # Separate by type
    corridors = [r for r in valid_rooms if r.get('type') == 'corridor']
    regular = [r for r in valid_rooms if r.get('type') != 'corridor']

    # Build polygons
    polys = {}
    poly_list = []
    poly_ids = []
    for r in valid_rooms:
        try:
            p = Polygon(r['polygon'])
            if not p.is_valid: p = p.buffer(0)
            polys[r['id']] = p
            poly_list.append(p)
            poly_ids.append(r['id'])
        except:
            pass

    tree = STRtree(poly_list)

    # For corridor nodes: use a point ON the polygon (not centroid, which may be inside another room)
    nodes = []
    for r in rooms:
        nx, ny = r['center'][0], r['center'][1]
        if r.get('type') == 'corridor' and r['id'] in polys:
            p = polys[r['id']]
            from shapely.geometry import Point as SPoint
            pt = SPoint(nx, ny)
            # If centroid is not inside the polygon, use a point on the boundary
            if not p.contains(pt):
                # Use representative point (guaranteed inside)
                rp = p.representative_point()
                nx, ny = round(rp.x, 2), round(rp.y, 2)
            else:
                # Check if centroid overlaps with any other room
                for other in rooms:
                    if other['id'] == r['id'] or other['id'] not in polys:
                        continue
                    if polys[other['id']].contains(pt):
                        # Centroid is inside another room - move to boundary
                        rp = p.representative_point()
                        # Move further toward boundary
                        boundary_pt = p.boundary.interpolate(p.boundary.project(rp))
                        mid_x = (rp.x + boundary_pt.x) / 2
                        mid_y = (rp.y + boundary_pt.y) / 2
                        nx, ny = round(mid_x, 2), round(mid_y, 2)
                        break
        nodes.append({'id': r['id'], 'name': r.get('name', ''), 'x': nx, 'y': ny})

    edges_set = set()

    def no_room_between(ri, rj):
        """Check that no third room's polygon blocks the line between ri and rj"""
        if ri['id'] not in polys or rj['id'] not in polys:
            return False
        p1, p2 = nearest_points(polys[ri['id']], polys[rj['id']])
        line = LineString([p1, p2])
        line_buf = line.buffer(0.3)
        for cidx in tree.query(line_buf):
            cid = poly_ids[cidx]
            if cid == ri['id'] or cid == rj['id']:
                continue
            if poly_list[cidx].intersects(line_buf):
                inter = poly_list[cidx].intersection(line_buf)
                if inter.area > 0.3:
                    return False
        return True

    # === Rule 1: Room -> nearest adjacent corridor ===
    for room in regular:
        if room['id'] not in polys:
            continue
        pr = polys[room['id']]

        best_corr = None
        best_dist = MAX_DIST

        for corr in corridors:
            if corr['id'] not in polys:
                continue
            d = pr.distance(polys[corr['id']])
            if d < best_dist:
                if no_room_between(room, corr):
                    best_dist = d
                    best_corr = corr

        if best_corr:
            edge = (min(room['id'], best_corr['id']), max(room['id'], best_corr['id']))
            edges_set.add(edge)

    # === Rule 2: Corridor -> adjacent corridors ===
    for i in range(len(corridors)):
        ci = corridors[i]
        if ci['id'] not in polys:
            continue
        for j in range(i + 1, len(corridors)):
            cj = corridors[j]
            if cj['id'] not in polys:
                continue
            d = polys[ci['id']].distance(polys[cj['id']])
            if d <= MAX_DIST:
                if no_room_between(ci, cj):
                    edge = (min(ci['id'], cj['id']), max(ci['id'], cj['id']))
                    edges_set.add(edge)

    # === Rule 3: Connect isolated rooms to nearest room (any type) ===
    connected = set()
    for a, b in edges_set:
        connected.add(a); connected.add(b)

    for room in valid_rooms:
        if room['id'] in connected or room['id'] not in polys:
            continue
        pr = polys[room['id']]
        best = None
        best_dist = 15.0  # wider search for isolated rooms
        for other in valid_rooms:
            if other['id'] == room['id'] or other['id'] not in polys:
                continue
            d = pr.distance(polys[other['id']])
            if d < best_dist and no_room_between(room, other):
                best_dist = d
                best = other
        if best:
            edge = (min(room['id'], best['id']), max(room['id'], best['id']))
            edges_set.add(edge)
            connected.add(room['id'])

    # Build edges with connection points
    edges = []
    for a, b in edges_set:
        ra, rb = room_map.get(a), room_map.get(b)
        if ra and rb:
            dx = ra['center'][0] - rb['center'][0]
            dy = ra['center'][1] - rb['center'][1]
            edge = {'from': a, 'to': b, 'weight': round((dx*dx+dy*dy)**0.5, 1)}

            # For room-to-corridor: draw from room center to nearest corridor boundary
            a_is_corr = ra.get('type') == 'corridor'
            b_is_corr = rb.get('type') == 'corridor'

            if a in polys and b in polys:
                if a_is_corr and not b_is_corr:
                    # a=corridor, b=room: edge goes room_center -> corridor_boundary
                    from shapely.geometry import Point as SPoint
                    cp = polys[a].boundary.interpolate(polys[a].boundary.project(SPoint(rb['center'][0], rb['center'][1])))
                    edge['x1'] = round(rb['center'][0], 1)
                    edge['y1'] = round(rb['center'][1], 1)
                    edge['x2'] = round(cp.x, 1)
                    edge['y2'] = round(cp.y, 1)
                elif b_is_corr and not a_is_corr:
                    # b=corridor, a=room
                    from shapely.geometry import Point as SPoint
                    cp = polys[b].boundary.interpolate(polys[b].boundary.project(SPoint(ra['center'][0], ra['center'][1])))
                    edge['x1'] = round(ra['center'][0], 1)
                    edge['y1'] = round(ra['center'][1], 1)
                    edge['x2'] = round(cp.x, 1)
                    edge['y2'] = round(cp.y, 1)
                else:
                    # corridor-corridor or room-room: use nearest boundary points
                    p1, p2 = nearest_points(polys[a], polys[b])
                    edge['x1'] = round(p1.x, 1)
                    edge['y1'] = round(p1.y, 1)
                    edge['x2'] = round(p2.x, 1)
                    edge['y2'] = round(p2.y, 1)

            edges.append(edge)

    data['graph'] = {'nodes': nodes, 'edges': edges}

    # Report
    adj = defaultdict(set)
    for a, b in edges_set:
        adj[a].add(b); adj[b].add(a)
    visited = set(); comps = 0
    for rid in [r['id'] for r in valid_rooms]:
        if rid in visited: continue
        comps += 1
        queue = [rid]
        while queue:
            n = queue.pop()
            if n in visited: continue
            visited.add(n)
            for nb in adj[n]:
                if nb not in visited: queue.append(nb)
    isolated = len([r for r in valid_rooms if r['id'] not in connected])
    print(f"    Corridors: {len(corridors)}, Rooms: {len(regular)}")
    print(f"    Components: {comps}, edges: {len(edges)}, isolated: {isolated}")

    return data, len(nodes), len(edges)


WALKABLE_SPACING = 5.0  # node spacing along corridor centerlines (PDF units)


def center_in_corridor(x, y, poly):
    """Snap a point to the true center of the corridor cross-section.

    Shoots rays in multiple directions from the point, finds the corridor
    width in each direction, picks the narrowest width (the true cross-section),
    and returns the midpoint of that cross-section.
    """
    import math
    boundary = poly.boundary
    pt = SPoint(x, y)

    # If point is outside polygon, move it inside first
    if not poly.contains(pt):
        nearest = boundary.interpolate(boundary.project(pt))
        cx, cy = poly.centroid.x, poly.centroid.y
        x = nearest.x + (cx - nearest.x) * 0.2
        y = nearest.y + (cy - nearest.y) * 0.2
        pt = SPoint(x, y)

    ray_len = max(poly.bounds[2] - poly.bounds[0], poly.bounds[3] - poly.bounds[1]) * 2

    # Collect all cross-section midpoints with their widths
    candidates = []
    for angle_deg in range(0, 180, 10):
        angle = math.radians(angle_deg)
        rdx = math.cos(angle)
        rdy = math.sin(angle)

        ray = LineString([
            (x - rdx * ray_len, y - rdy * ray_len),
            (x + rdx * ray_len, y + rdy * ray_len)
        ])

        inter = poly.intersection(ray)
        if inter.is_empty:
            continue

        if inter.geom_type == 'LineString':
            seg = inter
        elif inter.geom_type == 'MultiLineString':
            seg = min(inter.geoms, key=lambda g: g.distance(pt))
        else:
            continue

        width = seg.length
        if width > 0.5:
            mid = seg.interpolate(0.5, normalized=True)
            candidates.append((width, mid.x, mid.y))

    if not candidates:
        return (x, y)

    # Sort by width, pick the median — avoids both the narrowest
    # (corner artifacts) and the widest (length of corridor)
    candidates.sort(key=lambda c: c[0])
    median_idx = len(candidates) // 2
    return (candidates[median_idx][1], candidates[median_idx][2])


def corridor_centerline(poly, spacing=5.0):
    """Place centered nodes along the corridor every `spacing` units.

    1. Find the corridor's principal axis from its longest edge pair
    2. Walk along that axis in steps of `spacing`
    3. At each step, shoot a perpendicular ray to find corridor walls
    4. Place node at the midpoint (true center of corridor)
    """
    import math

    # Find principal axis: the direction of the longest edge of the polygon
    coords = list(poly.exterior.coords)
    best_len = 0
    best_angle = 0
    for i in range(len(coords) - 1):
        dx = coords[i+1][0] - coords[i][0]
        dy = coords[i+1][1] - coords[i][1]
        length = (dx*dx + dy*dy)**0.5
        if length > best_len:
            best_len = length
            best_angle = math.atan2(dy, dx)

    # Walk along the principal axis, scan perpendicular
    dx = math.cos(best_angle)
    dy = math.sin(best_angle)
    # Perpendicular direction
    px = -dy
    py = dx

    bounds = poly.bounds
    ray_len = max(bounds[2]-bounds[0], bounds[3]-bounds[1]) * 2

    # Walk along the corridor axis starting from centroid
    cx, cy = poly.centroid.x, poly.centroid.y

    # Project polygon vertices onto walk direction relative to centroid
    coords_all = list(poly.exterior.coords)
    projections = [(x - cx) * dx + (y - cy) * dy for x, y in coords_all]
    pmin, pmax = min(projections), max(projections)

    pts = []
    t = pmin + spacing / 2
    while t < pmax - spacing / 2:
        # Point along the walk axis, offset from centroid
        ox = cx + dx * t
        oy = cy + dy * t
        # Perpendicular cross-section through this point
        cross = LineString([
            (ox - px * ray_len, oy - py * ray_len),
            (ox + px * ray_len, oy + py * ray_len)
        ])
        inter = poly.intersection(cross)
        if not inter.is_empty:
            if inter.geom_type == 'MultiLineString':
                # Pick the widest segment (the main corridor, not a nook)
                inter = max(inter.geoms, key=lambda g: g.length)
            if inter.geom_type == 'LineString' and inter.length > 0.5:
                mid = inter.interpolate(0.5, normalized=True)
                if poly.contains(SPoint(mid.x, mid.y)):
                    pts.append((round(mid.x, 2), round(mid.y, 2)))
        t += spacing

    return pts


def build_walkable_graph(data, polys):
    """Build a walkable navigation graph with corridor centerline nodes and room entry nodes."""
    rooms = data['rooms']
    if not rooms:
        return {'nodes': [], 'edges': []}

    room_map = {r['id']: r for r in rooms}
    lightyard_ids = set(r['id'] for r in rooms if r['area'] > 5000)
    valid_rooms = [r for r in rooms if r['id'] not in lightyard_ids]
    corridors = [r for r in valid_rooms if r.get('type') == 'corridor']
    regular = [r for r in valid_rooms if r.get('type') != 'corridor']

    nodes = []
    edges = []
    node_id = 0

    # === Step 1: Corridor centerline nodes ===
    corridor_nodes = {}

    for corr in corridors:
        if corr['id'] not in polys:
            continue
        poly = polys[corr['id']]
        
        pts = corridor_centerline(poly, WALKABLE_SPACING)
        
        if not pts:
            # Fallback: single node at center
            rp = poly.representative_point()
            pts = [(round(rp.x, 2), round(rp.y, 2))]

        cnodes = []
        for x, y in pts:
            nid = node_id; node_id += 1
            nodes.append({'id': nid, 'name': corr['name'], 'x': x, 'y': y, 'type': 'corridor'})
            cnodes.append((nid, x, y))

        corridor_nodes[corr['id']] = cnodes

        # Connect sequential centerline nodes
        for i in range(len(cnodes) - 1):
            a = cnodes[i]
            b = cnodes[i + 1]
            dx, dy = a[1] - b[1], a[2] - b[2]
            w = round((dx*dx + dy*dy)**0.5, 1)
            edges.append({'from': a[0], 'to': b[0], 'weight': w,
                          'x1': a[1], 'y1': a[2], 'x2': b[1], 'y2': b[2]})

    # === Step 2: Connect adjacent corridor centerlines ===
    CORR_ADJACENCY_DIST = 10.0  # polygon distance for corridor adjacency
    CORR_NODE_MAX_DIST = 30.0   # max node-to-node distance for connection

    for i in range(len(corridors)):
        ci = corridors[i]
        if ci['id'] not in polys or ci['id'] not in corridor_nodes:
            continue
        for j in range(i + 1, len(corridors)):
            cj = corridors[j]
            if cj['id'] not in polys or cj['id'] not in corridor_nodes:
                continue
            d = polys[ci['id']].distance(polys[cj['id']])
            if d > CORR_ADJACENCY_DIST:
                continue

            # Find nearest pair of centerline nodes between the two corridors
            best_dist = float('inf')
            best_pair = None
            for ni, xi, yi in corridor_nodes[ci['id']]:
                for nj, xj, yj in corridor_nodes[cj['id']]:
                    dd = ((xi - xj)**2 + (yi - yj)**2)**0.5
                    if dd < best_dist:
                        best_dist = dd
                        best_pair = (ni, xi, yi, nj, xj, yj)

            if best_pair and best_dist < CORR_NODE_MAX_DIST:
                ni, xi, yi, nj, xj, yj = best_pair
                edges.append({'from': ni, 'to': nj, 'weight': round(best_dist, 1),
                              'x1': xi, 'y1': yi, 'x2': xj, 'y2': yj})

    # === Step 3: Room entry nodes ===
    ROOM_CORR_MAX_DIST = 15.0  # wider search for room-to-corridor connections

    # Build flat list of ALL surviving corridor nodes for connection
    all_corridor_nodes = []
    for cid, cnodes_list in corridor_nodes.items():
        all_corridor_nodes.extend(cnodes_list)

    for room in regular:
        if room['id'] not in polys:
            continue
        room_poly = polys[room['id']]

        # Find nearest corridor
        best_corr = None
        best_dist = ROOM_CORR_MAX_DIST
        for corr in corridors:
            if corr['id'] not in polys:
                continue
            d = room_poly.distance(polys[corr['id']])
            if d < best_dist:
                best_dist = d
                best_corr = corr

        if not best_corr or best_corr['id'] not in corridor_nodes:
            continue

        # Place entry node at midpoint of the closest wall edge facing the corridor
        corr_poly = polys[best_corr['id']]
        room_coords = list(room_poly.exterior.coords)
        best_edge_mid = None
        best_edge_dist = float('inf')
        for ei in range(len(room_coords) - 1):
            edge_line = LineString([room_coords[ei], room_coords[ei + 1]])
            mid = edge_line.interpolate(0.5, normalized=True)
            d = corr_poly.distance(SPoint(mid.x, mid.y))
            if d < best_edge_dist:
                best_edge_dist = d
                best_edge_mid = (mid.x, mid.y)
        if best_edge_mid is None:
            p1, p2 = nearest_points(room_poly, corr_poly)
            best_edge_mid = ((p1.x + p2.x) / 2, (p1.y + p2.y) / 2)
        ex = round(best_edge_mid[0], 2)
        ey = round(best_edge_mid[1], 2)

        entry_nid = node_id; node_id += 1
        nodes.append({'id': entry_nid, 'name': room['name'], 'x': ex, 'y': ey, 'type': 'entry'})

        # Edge from room center to entry node
        cx, cy = room['center']
        dx, dy = cx - ex, cy - ey
        w = round((dx*dx + dy*dy)**0.5, 1)
        room_nid = node_id; node_id += 1
        nodes.append({'id': room_nid, 'name': room['name'], 'x': round(cx, 2), 'y': round(cy, 2), 'type': 'room'})
        edges.append({'from': room_nid, 'to': entry_nid, 'weight': w,
                      'x1': round(cx, 2), 'y1': round(cy, 2), 'x2': ex, 'y2': ey})

        # Connect entry node to nearest corridor centerline node (search ALL corridors)
        best_cn_dist = float('inf')
        best_cn = None
        for cid, cnodes_list in corridor_nodes.items():
            for cn_id, cn_x, cn_y in cnodes_list:
                dd = ((ex - cn_x)**2 + (ey - cn_y)**2)**0.5
                if dd < best_cn_dist:
                    best_cn_dist = dd
                    best_cn = (cn_id, cn_x, cn_y)

        if best_cn and best_cn_dist < ROOM_CORR_MAX_DIST * 2:
            cn_id, cn_x, cn_y = best_cn
            edges.append({'from': entry_nid, 'to': cn_id, 'weight': round(best_cn_dist, 1),
                          'x1': ex, 'y1': ey, 'x2': cn_x, 'y2': cn_y})

    # === Step 4: Connect disconnected components ===
    # Build union of all room/corridor polygons for line-of-sight check
    from shapely.ops import unary_union
    all_polys = [p for p in polys.values() if p.is_valid]
    building_union = unary_union(all_polys).buffer(1.0)  # small buffer for tolerance

    def line_inside_building(x1, y1, x2, y2):
        """Check if a straight line stays inside the building."""
        line = LineString([(x1, y1), (x2, y2)])
        return building_union.contains(line)

    all_node_ids = {n['id'] for n in nodes}
    adj = defaultdict(set)
    for e in edges:
        adj[e['from']].add(e['to'])
        adj[e['to']].add(e['from'])

    def find_components():
        visited = set()
        components = []
        for nid in all_node_ids:
            if nid in visited:
                continue
            comp = set()
            queue = [nid]
            while queue:
                n = queue.pop()
                if n in visited:
                    continue
                visited.add(n)
                comp.add(n)
                for nb in adj[n]:
                    if nb not in visited:
                        queue.append(nb)
            components.append(comp)
        return components

    node_by_id = {n['id']: n for n in nodes}
    for _ in range(20):
        components = find_components()
        if len(components) <= 1:
            break
        components.sort(key=len, reverse=True)
        merged = False
        for ci in range(1, len(components)):
            small = components[ci]
            best_dist = float('inf')
            best_pair = None
            for nid_s in small:
                ns = node_by_id[nid_s]
                for cj in range(ci):
                    for nid_l in components[cj]:
                        nl = node_by_id[nid_l]
                        dd = ((ns['x'] - nl['x'])**2 + (ns['y'] - nl['y'])**2)**0.5
                        if dd < best_dist:
                            best_dist = dd
                            best_pair = (nid_s, ns, nid_l, nl)
            if best_pair and best_dist < 100.0:
                nid_s, ns, nid_l, nl = best_pair
                # Only connect if the line stays inside the building
                if line_inside_building(ns['x'], ns['y'], nl['x'], nl['y']):
                    edges.append({'from': nid_s, 'to': nid_l, 'weight': round(best_dist, 1),
                                  'x1': ns['x'], 'y1': ns['y'], 'x2': nl['x'], 'y2': nl['y']})
                    adj[nid_s].add(nid_l)
                    adj[nid_l].add(nid_s)
                    merged = True
        if not merged:
            break

    final_comps = find_components()
    print(f"    Components after merge: {len(final_comps)}")

    # Report
    n_corridor = sum(len(v) for v in corridor_nodes.values())
    n_entry = len([n for n in nodes if n.get('type') == 'entry'])
    n_room = len([n for n in nodes if n.get('type') == 'room'])
    print(f"    Walkable: {n_corridor} corridor nodes, {n_entry} entry nodes, {n_room} room nodes, {len(edges)} edges")

    return {'nodes': nodes, 'edges': edges}


if __name__ == '__main__':
    print("Building navigation graphs...")
    for level in LEVELS:
        print(f"  {level}:")
        data, n_nodes, n_edges = build_floor_graph(level)
        print(f"    Adjacency: {n_nodes} nodes, {n_edges} edges")

        # Build walkable graph using the same polygons
        rooms = data['rooms']
        valid_rooms = [r for r in rooms if r['area'] <= 5000]
        walk_polys = {}
        for r in valid_rooms:
            try:
                p = Polygon(r['polygon'])
                if not p.is_valid: p = p.buffer(0)
                walk_polys[r['id']] = p
            except:
                pass
        data['walkable_graph'] = build_walkable_graph(data, walk_polys)

        with open(f'data/{level}/floorplan_data.json', 'w') as f:
            json.dump(data, f)

    try:
        with open(f'data/{BUILDING}/cross_floor_edges.json') as f:
            print(f"  Cross-floor edges: {len(json.load(f))}")
    except:
        pass
    print("Done.")

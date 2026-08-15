#!/bin/bash
# Shared helper: merge one person or alien into a room's occupancy without
# touching anything else. PUT /api/occupancy replaces the WHOLE map, so an
# "add" has to read-modify-write.
# Usage: source occupancy_merge.sh; merge_occupant HOST ROOM KIND JSON
#   KIND is "persons" or "aliens"; JSON is the occupant object.
merge_occupant() {
  local base="$1" room="$2" kind="$3" occupant="$4"
  curl -s "https://$base/api/occupancy" | python3 -c "
import sys, json
occ = json.load(sys.stdin) or {}
room, kind = '$room', '$kind'
o = json.loads('''$occupant''')
r = occ.setdefault(room, {'persons': [], 'aliens': []})
r.setdefault('persons', []); r.setdefault('aliens', [])
r[kind] = [x for x in r[kind] if x.get('id') != o.get('id')] + [o]
json.dump(occ, sys.stdout)
" > /tmp/occ-merged.$$ && curl -s -X PUT "https://$base/api/occupancy" \
    -H 'Content-Type: application/json' --data @/tmp/occ-merged.$$ | python3 -m json.tool
  rm -f /tmp/occ-merged.$$
}

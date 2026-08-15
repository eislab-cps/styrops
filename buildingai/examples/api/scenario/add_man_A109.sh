#!/bin/bash
# Add a man to room A109, keeping whoever is already there.
# Usage: ./add_man_A109.sh [host:port]
DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/occupancy_merge.sh"
BASE=${1:-buildingai.eislab-cps.io}

echo "=== Adding man to A109 ==="
merge_occupant "$BASE" A109 persons '{"id": "man-1", "name": "Johan", "icon": "man"}'

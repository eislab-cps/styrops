#!/bin/bash
# Add a woman to room A109, keeping whoever is already there.
# Usage: ./add_woman_A109.sh [host:port]
DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/occupancy_merge.sh"
BASE=${1:-buildingai.eislab-cps.io}

echo "=== Adding woman to A109 ==="
merge_occupant "$BASE" A109 persons '{"id": "woman-1", "name": "Alice", "icon": "woman"}'

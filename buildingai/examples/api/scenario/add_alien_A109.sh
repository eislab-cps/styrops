#!/bin/bash
# Add an alien to room A109, keeping whoever is already there. Good luck to them.
# Usage: ./add_alien_A109.sh [host:port]
DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/occupancy_merge.sh"
BASE=${1:-buildingai.eislab-cps.io}

echo "=== Adding alien to A109 ==="
merge_occupant "$BASE" A109 aliens '{"id": "xeno-1"}'

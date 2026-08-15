#!/bin/bash
# Set room occupancy: persons and aliens
# Usage: ./set_occupancy.sh [host:port] [session_id]

DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/find_session.sh" "$@"

echo ""
echo "=== Setting Room Occupancy (people and aliens) ==="
curl -s -X PUT https://$BASE/api/occupancy -H 'Content-Type: application/json' -d '{
  "A1002": {
    "persons": [
      {"id": "person-1", "name": "Johan"}
    ],
    "aliens": []
  },
  "A1010": {
    "persons": [
      {"id": "person-2", "name": "Alice"},
      {"id": "person-3", "name": "Bob"},
      {"id": "person-4", "name": "Charlie"}
    ],
    "aliens": []
  },
  "A109": {
    "persons": [],
    "aliens": [
      {"id": "xeno-1"}
    ]
  },
  "A1001": {
    "persons": [
      {"id": "person-5", "name": "Diana"}
    ],
    "aliens": [
      {"id": "xeno-2"}
    ]
  }
}' | python3 -m json.tool

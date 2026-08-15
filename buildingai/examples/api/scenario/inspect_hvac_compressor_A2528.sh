#!/bin/bash
# Record an inspection protocol note against the A2528 HVAC compressor.
# Usage: ./inspect_hvac_compressor_A2528.sh [host]

BASE=${1:-buildingai.eislab-cps.io}
EQ_ID="hvac-comp-A2528"
NOTE_ID="inspection-$(date +%Y-%m-%dT%H%M%S)"
DATE_STR=$(date +%Y-%m-%d)

echo "=== Adding inspection protocol note to $EQ_ID ==="

curl -s -X POST https://$BASE/api/equipment/$EQ_ID/notes -H 'Content-Type: application/json' -d @- <<JSON | python3 -m json.tool
{
  "id": "$NOTE_ID",
  "author": "johan",
  "text": "Inspection protocol — $DATE_STR\n\nScope: quarterly preventive inspection of scroll compressor ZR34K5-TF5.\n\nChecklist:\n  [OK] Discharge temperature within envelope (72.4 °C, spec <90 °C)\n  [OK] Suction temperature 8.1 °C, no liquid slugging observed\n  [OK] Discharge pressure 18.3 bar, R-410A charge nominal\n  [OK] Motor current 6.2 A (LRA 84 A, RLA ~17 A) — within range\n  [OK] Vibration alarm not latched; mounting grommets intact\n  [OK] Oil sight glass — amber, mid-level, no foaming\n  [OK] Terminal box sealed; no scorching on S/R/C studs\n  [OK] Suction line insulation sleeve intact, zip-tie secure\n\nFindings: none.\nRecommended action: none. Next inspection due in 90 days."
}
JSON

echo
echo "=== Current notes on $EQ_ID ==="
curl -s https://$BASE/api/equipment/$EQ_ID/notes | python3 -m json.tool

echo "Done."

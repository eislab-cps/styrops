#!/bin/bash
# Add an HVAC compressor to room A2528 (level1)
# Usage: ./add_hvac_compressor_A2528.sh [host]

BASE=${1:-buildingai.eislab-cps.io}

echo "=== Adding HVAC compressor to A2528 ==="

curl -s -X POST https://$BASE/api/equipment -H 'Content-Type: application/json' -d '{
  "id": "hvac-comp-A2528",
  "name": "HVAC Compressor A2528",
  "type": "hvac_compressor",
  "category": "hvac",
  "level": "level1",
  "room": "A2528",
  "status": "running"
}' | python3 -m json.tool

curl -s -X POST https://$BASE/api/equipment/hvac-comp-A2528/sensors -H 'Content-Type: application/json' -d '{
  "id": "hvac-comp-A2528-discharge-temp",
  "name": "Discharge Temperature",
  "type": "temperature",
  "data_type": "text",
  "unit": "°C",
  "value": "72.4"
}' | python3 -m json.tool

curl -s -X POST https://$BASE/api/equipment/hvac-comp-A2528/sensors -H 'Content-Type: application/json' -d '{
  "id": "hvac-comp-A2528-suction-temp",
  "name": "Suction Temperature",
  "type": "temperature",
  "data_type": "text",
  "unit": "°C",
  "value": "8.1"
}' | python3 -m json.tool

curl -s -X POST https://$BASE/api/equipment/hvac-comp-A2528/sensors -H 'Content-Type: application/json' -d '{
  "id": "hvac-comp-A2528-discharge-pressure",
  "name": "Discharge Pressure",
  "type": "pressure",
  "data_type": "text",
  "unit": "bar",
  "value": "18.3"
}' | python3 -m json.tool

curl -s -X POST https://$BASE/api/equipment/hvac-comp-A2528/sensors -H 'Content-Type: application/json' -d '{
  "id": "hvac-comp-A2528-current",
  "name": "Motor Current",
  "type": "current",
  "data_type": "text",
  "unit": "A",
  "value": "6.2"
}' | python3 -m json.tool

curl -s -X POST https://$BASE/api/equipment/hvac-comp-A2528/sensors -H 'Content-Type: application/json' -d '{
  "id": "hvac-comp-A2528-vibration-alarm",
  "name": "Vibration Alarm",
  "type": "alarm_status",
  "data_type": "binary"
}' | python3 -m json.tool

curl -s -X POST https://$BASE/api/equipment/hvac-comp-A2528/actuators -H 'Content-Type: application/json' -d '{
  "id": "hvac-comp-A2528-power",
  "name": "Power",
  "type": "on_off",
  "state": "on"
}' | python3 -m json.tool

curl -s -X POST https://$BASE/api/equipment/hvac-comp-A2528/actuators -H 'Content-Type: application/json' -d '{
  "id": "hvac-comp-A2528-capacity",
  "name": "Capacity Setpoint",
  "type": "capacity",
  "state": "75"
}' | python3 -m json.tool

curl -s -X POST https://$BASE/api/equipment/notify > /dev/null
echo "Done."

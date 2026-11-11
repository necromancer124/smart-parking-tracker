#!/bin/sh
# Fake IoT camera: every INTERVAL seconds it "reads" a random license plate
# and sends it to the API as an HTTP POST, just like the real camera would.

API_URL="${API_URL:-http://api:3000/api/cars}"
INTERVAL="${INTERVAL:-10}"

# Random plate like 123-45-678 (this image's sh has no $RANDOM, so use awk;
# the seed mixes in the loop counter so two plates in one second differ)
random_plate() {
  awk -v n="$1" 'BEGIN { srand(); srand(srand() + n);
    printf "%d-%d-%d", 100 + int(rand() * 900), 10 + int(rand() * 90), 100 + int(rand() * 900) }'
}

echo "Camera started: sending a plate to $API_URL every ${INTERVAL}s"

COUNT=0
while true; do
  COUNT=$((COUNT + 1))
  PLATE="$(random_plate "$COUNT")"
  echo "Camera saw $PLATE"
  curl -s -X POST "$API_URL" \
    -H "Content-Type: application/json" \
    -d "{\"plate\":\"$PLATE\"}"
  echo
  sleep "$INTERVAL"
done

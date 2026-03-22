#!/bin/bash

# Bright Data Snapshot Downloader
# Downloads snapshot data once it's ready

API_TOKEN="30728b24f3b8fa70b816bb2936d5451c19941d910a6d330a2b7f04b19cf4b1d9"
SNAPSHOT_ID="snap_mmawjos0tv7ifnjdv"
OUTPUT_FILE="/Users/danielroren/claude-dev/daniel_oren_results.json"
MAX_WAIT=300  # 5 minutes max wait
POLL_INTERVAL=5

echo "🔍 Monitoring snapshot: $SNAPSHOT_ID"
echo "⏱️  Polling every ${POLL_INTERVAL}s (max ${MAX_WAIT}s)..."
echo ""

start_time=$(date +%s)

while true; do
  # Get snapshot metadata
  response=$(curl -s -X GET "https://api.brightdata.com/datasets/snapshots/$SNAPSHOT_ID" \
    -H "Authorization: Bearer $API_TOKEN")

  status=$(echo "$response" | jq -r '.status' 2>/dev/null)
  created=$(echo "$response" | jq -r '.created' 2>/dev/null)
  dataset_size=$(echo "$response" | jq -r '.dataset_size // "N/A"' 2>/dev/null)
  file_size=$(echo "$response" | jq -r '.file_size // "N/A"' 2>/dev/null)

  current_time=$(date +%s)
  elapsed=$((current_time - start_time))

  echo "[${elapsed}s] Status: $status | Records: $dataset_size | File Size: $file_size"

  if [ "$status" = "ready" ]; then
    echo ""
    echo "✅ Snapshot is READY!"
    echo "📥 Downloading data..."

    # Download the snapshot data
    curl -s -X GET "https://api.brightdata.com/datasets/snapshots/$SNAPSHOT_ID/download?format=json" \
      -H "Authorization: Bearer $API_TOKEN" \
      -o "$OUTPUT_FILE"

    if [ $? -eq 0 ]; then
      echo "✅ Data saved to: $OUTPUT_FILE"
      echo ""
      echo "📊 Preview:"
      jq '.' "$OUTPUT_FILE" | head -50
    else
      echo "❌ Download failed"
    fi
    break

  elif [ "$status" = "failed" ]; then
    echo "❌ Snapshot building FAILED"
    echo "$response" | jq '.'
    break

  elif [ $elapsed -gt $MAX_WAIT ]; then
    echo "⏱️  Timeout: Snapshot took longer than ${MAX_WAIT}s"
    break
  fi

  sleep $POLL_INTERVAL
done

#!/bin/bash

# Bright Data Snapshot Downloader - Extended Wait
# Waits up to 20 minutes for snapshot to be ready

API_TOKEN="30728b24f3b8fa70b816bb2936d5451c19941d910a6d330a2b7f04b19cf4b1d9"
SNAPSHOT_ID="snap_mmawjos0tv7ifnjdv"  # Daniel Oren
SNAPSHOT_ID_2="snap_mmawvzv4tnlk9hvgj"  # US Country Code (simpler)
OUTPUT_DIR="/Users/danielroren/claude-dev"
MAX_WAIT=1200  # 20 minutes
POLL_INTERVAL=10

echo "🔍 Monitoring 2 snapshots for Daniel Oren search..."
echo "   1️⃣  Daniel Oren: $SNAPSHOT_ID"
echo "   2️⃣  US Country Code: $SNAPSHOT_ID_2"
echo ""
echo "⏱️  Polling every ${POLL_INTERVAL}s (max ${MAX_WAIT}s = 20 min)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

start_time=$(date +%s)
snap1_ready=false
snap2_ready=false

while true; do
  current_time=$(date +%s)
  elapsed=$((current_time - start_time))
  elapsed_min=$((elapsed / 60))
  elapsed_sec=$((elapsed % 60))

  # Check Snapshot 1 (Daniel Oren)
  if [ "$snap1_ready" = false ]; then
    response1=$(curl -s -X GET "https://api.brightdata.com/datasets/snapshots/$SNAPSHOT_ID" \
      -H "Authorization: Bearer $API_TOKEN")

    status1=$(echo "$response1" | jq -r '.status // "error"' 2>/dev/null)
    dataset_size1=$(echo "$response1" | jq -r '.dataset_size // "N/A"' 2>/dev/null)
    file_size1=$(echo "$response1" | jq -r '.file_size // "N/A"' 2>/dev/null)
  fi

  # Check Snapshot 2 (US Country Code)
  if [ "$snap2_ready" = false ]; then
    response2=$(curl -s -X GET "https://api.brightdata.com/datasets/snapshots/$SNAPSHOT_ID_2" \
      -H "Authorization: Bearer $API_TOKEN")

    status2=$(echo "$response2" | jq -r '.status // "error"' 2>/dev/null)
    dataset_size2=$(echo "$response2" | jq -r '.dataset_size // "N/A"' 2>/dev/null)
    file_size2=$(echo "$response2" | jq -r '.file_size // "N/A"' 2>/dev/null)
  fi

  # Display progress
  printf "\r[%02d:%02d] Snap1: %-10s (Records: %-6s) | Snap2: %-10s (Records: %-6s)" \
    "$elapsed_min" "$elapsed_sec" "$status1" "$dataset_size1" "$status2" "$dataset_size2"

  # Check if either is ready
  if [ "$status1" = "ready" ] && [ "$snap1_ready" = false ]; then
    echo ""
    echo "✅ Snapshot 1 (Daniel Oren) is READY!"
    snap1_ready=true
  fi

  if [ "$status2" = "ready" ] && [ "$snap2_ready" = false ]; then
    echo ""
    echo "✅ Snapshot 2 (US Country Code) is READY!"
    snap2_ready=true
  fi

  # Download if ready
  if [ "$snap1_ready" = true ]; then
    echo "📥 Downloading Snapshot 1..."
    curl -s -X GET "https://api.brightdata.com/datasets/snapshots/$SNAPSHOT_ID/download?format=json" \
      -H "Authorization: Bearer $API_TOKEN" \
      -o "$OUTPUT_DIR/daniel_oren_results.json"
    echo "✅ Saved to: daniel_oren_results.json"
    snap1_ready=false  # Don't download again
  fi

  if [ "$snap2_ready" = true ]; then
    echo "📥 Downloading Snapshot 2..."
    curl -s -X GET "https://api.brightdata.com/datasets/snapshots/$SNAPSHOT_ID_2/download?format=csv" \
      -H "Authorization: Bearer $API_TOKEN" \
      -o "$OUTPUT_DIR/us_profiles_results.csv"
    echo "✅ Saved to: us_profiles_results.csv"
    snap2_ready=false  # Don't download again
  fi

  # Check exit conditions
  if [ $elapsed -gt $MAX_WAIT ]; then
    echo ""
    echo "⏱️  Timeout: Exceeded ${MAX_WAIT}s (20 minutes)"
    echo "📋 Final Status:"
    echo "   Snap1: $status1"
    echo "   Snap2: $status2"
    break
  fi

  # If both failed, stop trying
  if [ "$status1" = "failed" ] || [ "$status2" = "failed" ]; then
    echo ""
    echo "❌ One or both snapshots failed"
    if [ "$status1" = "failed" ]; then
      echo "   Snap1 Error: $(echo "$response1" | jq -r '.error // "Unknown"')"
    fi
    if [ "$status2" = "failed" ]; then
      echo "   Snap2 Error: $(echo "$response2" | jq -r '.error // "Unknown"')"
    fi
    break
  fi

  sleep $POLL_INTERVAL
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📊 Test Complete"
echo ""

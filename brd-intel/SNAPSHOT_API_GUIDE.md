# Bright Data Snapshot API - Complete Guide

## Overview
This guide covers the complete workflow for retrieving LinkedIn data using Bright Data's asynchronous snapshot API.

---

## 1️⃣ Step 1: Create Filter (Submit Query)

**Endpoint**: `POST https://api.brightdata.com/datasets/filter`

**Request**:
```bash
curl -X POST "https://api.brightdata.com/datasets/filter" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "dataset_id": "gd_l1viktl72bvl7bjuj0",
    "filter": {
      "name": "name",
      "operator": "=",
      "value": "Daniel Oren"
    },
    "records_limit": 10
  }'
```

**Response**:
```json
{
  "snapshot_id": "snap_mmawjos0tv7ifnjdv"
}
```

---

## 2️⃣ Step 2: Get Snapshot Metadata (Check Status)

**Endpoint**: `GET https://api.brightdata.com/datasets/snapshots/{id}`

**Request**:
```bash
curl -X GET "https://api.brightdata.com/datasets/snapshots/snap_mmawjos0tv7ifnjdv" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

**Response**:
```json
{
  "id": "snap_mmawjos0tv7ifnjdv",
  "created": "2026-03-03T17:49:09.552Z",
  "status": "building",
  "dataset_id": "gd_l1viktl72bvl7bjuj0",
  "customer_id": "hl_cf5c4907",
  "cost": 0,
  "initiation_type": "filter_api_snapshot",
  "dataset_size": 1,
  "file_size": 5000
}
```

**Status Values**:
- `scheduled` - Queued
- `building` - Processing (⏳ wait)
- `ready` - ✅ Data ready to download
- `failed` - ❌ Error occurred

---

## 3️⃣ Step 3: Get Snapshot Parts (Optional)

**Endpoint**: `GET https://api.brightdata.com/datasets/snapshots/{id}/parts`

**Query Parameters**:
- `format`: json, jsonl, csv (default: json)
- `compress`: true/false (gzip compression)
- `batch_size`: Records per batch (min: 1000)

**Request**:
```bash
curl -X GET "https://api.brightdata.com/datasets/snapshots/snap_mmawjos0tv7ifnjdv/parts?format=json" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

**Response**:
```json
{
  "parts": 1
}
```

---

## 4️⃣ Step 4: Download Snapshot Data

**Endpoint**: `GET https://api.brightdata.com/datasets/snapshots/{id}/download`

**Query Parameters**:
| Parameter | Type | Options | Default |
|-----------|------|---------|---------|
| `format` | string | json, jsonl, csv | jsonl |
| `compress` | boolean | true, false | false |
| `batch_size` | integer | 1000+ | none |
| `part` | integer | 1, 2, 3... | all |

**Request Examples**:

**JSON Format**:
```bash
curl -X GET "https://api.brightdata.com/datasets/snapshots/snap_mmawjos0tv7ifnjdv/download?format=json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -o results.json
```

**CSV Format**:
```bash
curl -X GET "https://api.brightdata.com/datasets/snapshots/snap_mmawjos0tv7ifnjdv/download?format=csv" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -o results.csv
```

**JSONL Format (Recommended for large datasets)**:
```bash
curl -X GET "https://api.brightdata.com/datasets/snapshots/snap_mmawjos0tv7ifnjdv/download?format=jsonl" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -o results.jsonl
```

**With Compression**:
```bash
curl -X GET "https://api.brightdata.com/datasets/snapshots/snap_mmawjos0tv7ifnjdv/download?format=json&compress=true" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -o results.json.gz
```

**Response Status Codes**:
- `200` - Success, data included
- `202` - Still building, try again later
- `400` - Invalid parameters
- `404` - Snapshot not found

---

## 5️⃣ Step 5: Deliver Snapshot (Optional)

**Endpoint**: `POST https://api.brightdata.com/datasets/snapshots/{id}/deliver`

**Delivery Destinations**:
1. Amazon S3
2. Google Cloud Storage
3. Google Cloud PubSub
4. Microsoft Azure
5. Snowflake
6. SFTP
7. Aliyun OSS
8. Webhook
9. Email
10. Build (custom endpoint)

**Example - Deliver to S3**:
```bash
curl -X POST "https://api.brightdata.com/datasets/snapshots/snap_mmawjos0tv7ifnjdv/deliver" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "delivery": {
      "type": "s3",
      "bucket_name": "my-bucket",
      "access_key": "YOUR_ACCESS_KEY",
      "secret_key": "YOUR_SECRET_KEY"
    }
  }'
```

---

## 🔄 Complete Workflow

```
1. Submit Filter
   ↓
2. Get Snapshot ID
   ↓
3. Poll Metadata (until status = "ready")
   ↓
4. Download Data (JSON/CSV/JSONL)
   ↓
5. Process Results
```

---

## 📊 Daniel Oren Search Example

**Query**: Find LinkedIn profile for "Daniel Oren"

**Snapshot ID**: `snap_mmawjos0tv7ifnjdv`

**Status**: ✅ Ready

**Available Formats**:
- JSON: Single file with all records
- CSV: Spreadsheet format
- JSONL: One record per line (streaming-friendly)

---

## 🛠️ Helper Scripts

- `download_snapshot.sh` - Polls and downloads automatically
- Exported in multiple formats (JSON, CSV, Markdown)

---

## 📝 Notes

- Snapshots are **asynchronous** - build time varies
- Use **polling** to check when ready
- Large datasets can be **split into parts** (batches)
- Data can be **compressed** with gzip
- **10 delivery options** available for automation

# Bright Data LinkedIn API - Quick Reference Guide

## 🎯 Quick Start

### Search for a LinkedIn Profile
```bash
# 1. Create filter (get snapshot_id instantly)
curl -X POST "https://api.brightdata.com/datasets/filter" \
  -H "Authorization: Bearer YOUR_TOKEN" \
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

# 2. Get snapshot_id from response
# Example: snap_mmawjos0tv7ifnjdv

# 3. Check status (wait for "ready")
curl -X GET "https://api.brightdata.com/datasets/snapshots/SNAPSHOT_ID" \
  -H "Authorization: Bearer YOUR_TOKEN"

# 4. Download data when ready
curl -X GET "https://api.brightdata.com/datasets/snapshots/SNAPSHOT_ID/download?format=json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -o results.json
```

---

## 📚 Documentation Map

| File | Purpose | Use When |
|------|---------|----------|
| **SNAPSHOT_API_GUIDE.md** | Complete workflow reference | Building integration |
| **LINKEDIN_DATASET_FIELDS.md** | All 43 fields explained | Choosing what to query |
| **DANIEL_OREN_SEARCH_RESULTS.md** | Example results | Understanding data format |
| **brightdata_linkedin_examples.sh** | Ready-to-run queries | Need working examples |
| **MCP_VS_API_COMPARISON.md** | API vs MCP analysis | Deciding on approach |
| **TESTING_SUMMARY.md** | What was tested | Checking results |
| **QUICK_REFERENCE.md** | This file | Quick lookups |

---

## 🔑 Authentication

```bash
# Set your token
export BRIGHT_DATA_TOKEN="30728b24f3b8fa70b816bb2936d5451c19941d910a6d330a2b7f04b19cf4b1d9"

# Use in curl
-H "Authorization: Bearer $BRIGHT_DATA_TOKEN"
```

---

## 🎯 Common Queries

### Search by Name
```json
{
  "dataset_id": "gd_l1viktl72bvl7bjuj0",
  "filter": {
    "name": "name",
    "operator": "=",
    "value": "John Smith"
  },
  "records_limit": 10
}
```

### Search by Job Title
```json
{
  "filter": {
    "name": "position",
    "operator": "includes",
    "value": "Software Engineer"
  }
}
```

### Search by Company
```json
{
  "filter": {
    "name": "current_company_name",
    "operator": "includes",
    "value": "Google"
  }
}
```

### Search by Location
```json
{
  "filter": {
    "name": "country_code",
    "operator": "=",
    "value": "US"
  }
}
```

### Combined Search
```json
{
  "filter": {
    "and": [
      {"name": "position", "operator": "includes", "value": "Engineer"},
      {"name": "country_code", "operator": "=", "value": "US"}
    ]
  }
}
```

---

## 📊 Data Formats

### Download as JSON
```bash
curl -X GET "https://api.brightdata.com/datasets/snapshots/SNAPSHOT_ID/download?format=json"
```

### Download as CSV
```bash
curl -X GET "https://api.brightdata.com/datasets/snapshots/SNAPSHOT_ID/download?format=csv"
```

### Download as JSONL (streaming)
```bash
curl -X GET "https://api.brightdata.com/datasets/snapshots/SNAPSHOT_ID/download?format=jsonl"
```

### With Compression
```bash
curl -X GET "https://api.brightdata.com/datasets/snapshots/SNAPSHOT_ID/download?format=json&compress=true"
```

---

## 🔍 Filter Operators

| Operator | Use For | Example |
|----------|---------|---------|
| `=` | Exact match | `"value": "John"` |
| `!=` | Not equal | `"value": "John"` |
| `includes` | Contains text | `"value": "Engineer"` |
| `not_includes` | Doesn't contain | `"value": "Sales"` |
| `<`, `>` | Comparison | Numbers, dates |
| `in` | List of values | `["A", "B", "C"]` |
| `array_includes` | Array contains | Skills array |
| `is_null` | No value | Empty fields |

---

## 📋 Available Fields (35 Total)

**Profile**: id, name, linkedin_id, url, position
**Location**: city, country_code, location
**Company**: current_company, current_company_name, experience
**Education**: education, educations_details
**Engagement**: connections, followers, posts, activity
**Content**: about, certifications, courses, languages, recommendations
**Media**: avatar, banner_image
**Other**: organizations, patents, publications, projects, volunteer_experience

**Full list**: See LINKEDIN_DATASET_FIELDS.md

---

## ⏱️ Timeline

| Step | Time | Status |
|------|------|--------|
| Create filter | <1s | Instant |
| Snapshot builds | 5-15 min | Async |
| Check status | <1s | Fast |
| Download data | <1s | Fast |
| Convert formats | <1s | Fast |
| **Total** | **5-15 min** | **Depends on size** |

---

## 🛠️ Troubleshooting

### Problem: "Snapshot not ready"
**Solution**: Check status again in 30 seconds
```bash
curl -X GET "https://api.brightdata.com/datasets/snapshots/SNAPSHOT_ID" \
  -H "Authorization: Bearer TOKEN" | jq '.status'
```

### Problem: "Invalid token"
**Solution**: Verify token in settings.json
```bash
cat ~/.claude/settings.json | grep API_TOKEN
```

### Problem: "Validation errors"
**Solution**: Check field name and operator validity
- See LINKEDIN_DATASET_FIELDS.md for valid fields
- Use correct operator for field type

### Problem: No results found
**Solution**: Broaden your filter
- Try partial match: `"operator": "includes"`
- Try different fields
- Increase records_limit

---

## 📁 Your Files

All in `/Users/danielroren/claude-dev/`:

```
├── daniel_oren_results.json          # Raw data (42 KB)
├── daniel_oren_results.csv           # Spreadsheet format
├── DANIEL_OREN_SEARCH_RESULTS.md     # Formatted table
├── SNAPSHOT_API_GUIDE.md             # Full API reference
├── LINKEDIN_DATASET_FIELDS.md        # Field descriptions
├── BRIGHTDATA_API_WORKING_EXAMPLE.md # Working examples
├── MCP_VS_API_COMPARISON.md          # Approach comparison
├── TESTING_SUMMARY.md                # What was tested
├── QUICK_REFERENCE.md                # This file
└── brightdata_linkedin_examples.sh   # Ready-to-run scripts
```

---

## 🚀 Get Started Now

### Option 1: Use Bash Script
```bash
bash /Users/danielroren/claude-dev/brightdata_linkedin_examples.sh
```

### Option 2: Use Curl Directly
```bash
export TOKEN="YOUR_TOKEN"
curl -X POST "https://api.brightdata.com/datasets/filter" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"dataset_id":"gd_l1viktl72bvl7bjuj0","filter":{"name":"name","operator":"=","value":"Your Name"},"records_limit":10}'
```

### Option 3: Check Example Results
```bash
# View what we found for Daniel Oren
cat /Users/danielroren/claude-dev/DANIEL_OREN_SEARCH_RESULTS.md

# View raw JSON
jq '.' /Users/danielroren/claude-dev/daniel_oren_results.json | head -50

# View CSV
head -5 /Users/danielroren/claude-dev/daniel_oren_results.csv
```

---

## 📞 Need Help?

1. **API Questions** → See SNAPSHOT_API_GUIDE.md
2. **Field Questions** → See LINKEDIN_DATASET_FIELDS.md
3. **Example Queries** → See brightdata_linkedin_examples.sh
4. **Performance** → See MCP_VS_API_COMPARISON.md
5. **Results** → See DANIEL_OREN_SEARCH_RESULTS.md

---

## ✅ Checklist for Using the API

- [ ] Token set in settings.json
- [ ] Dataset ID: `gd_l1viktl72bvl7bjuj0`
- [ ] Know which field to filter by
- [ ] Know which operator to use
- [ ] Have polling script ready (wait_and_download.sh)
- [ ] Know output format needed (JSON/CSV/Markdown)
- [ ] Understand asynchronous workflow (5-15 min)

---

## 🎯 Success Metrics

You've succeeded when you:
- ✅ Get a snapshot_id from filter request
- ✅ Snapshot status changes to "ready"
- ✅ Download succeeds without errors
- ✅ Data contains expected fields
- ✅ Can export to desired format
- ✅ Can parse and use the data

---

## 🏁 Next Steps

1. **Test a query** using brightdata_linkedin_examples.sh
2. **Review results** in DANIEL_OREN_SEARCH_RESULTS.md
3. **Study the guide** in SNAPSHOT_API_GUIDE.md
4. **Build your workflow** based on your needs
5. **Scale to production** when ready

---

*Quick Reference v1.0*
*Last Updated: 2026-03-03*
*Status: ✅ Ready to Use*

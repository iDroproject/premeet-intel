# Bright Data API Testing Results

## ✅ Success
- **Public API Endpoint**: `https://api.brightdata.com/datasets/filter` ✓ WORKS
- **Authentication**: Bearer token in Authorization header ✓ WORKS
- **Token Used**: From settings.json MCP config ✓ VALID

## ❌ Failed Endpoint
- **Internal Endpoint**: `http://dca-ds-filter-api.dca-svc.brdtnet.com/search/...`
  - Connection timeout
  - Internal service (not publicly accessible)
  - Requires VPN/internal network access

## API Requirements Discovered

### Required Fields
```json
{
  "dataset_id": "gd_l1viktl72bvl7bjuj0",
  "filter": {
    "name": "field_name",
    "operator": "=",
    "value": "search_value"
  },
  "records_limit": 10
}
```

### Filter Rules
- `filter` must be an **object** (not array or null)
- `filter.name` is **required**
- Field names need to match dataset schema
- ⚠️ "title" field is not supported in this dataset

### Next Steps
1. **Get available fields** - Request dataset schema/field list
2. **Test with valid fields** - Need to identify which fields exist
3. **Build filters** - Once we know available fields

## Example Responses
```json
// ✓ Valid filter structure (but unsupported field)
{"validation_errors":["unsupported filters: title"]}

// ✓ Invalid filter structure (missing required fields)
{"validation_errors":["\"filter.name\" is required"]}
```

## Recommendations
- Use the **public API** (https://api.brightdata.com) not internal endpoints
- Create a Node.js/JavaScript wrapper using the token
- Query for available dataset schema first
- Implement error handling for validation errors

#!/bin/bash

# Bright Data LinkedIn People Filter API Examples
# Usage: Set your API token first: export BRIGHT_DATA_API_TOKEN="your_token_here"

API_TOKEN="${BRIGHT_DATA_API_TOKEN}"
DATASET_ID="gd_l1viktl72bvl7bjuj0"  # LinkedIn People dataset
BASE_URL="https://api.brightdata.com/datasets/filter"

# Color output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}=== Bright Data LinkedIn People Filter Examples ===${NC}\n"

# Example 1: Find all people named "John"
echo -e "${GREEN}Example 1: Find people named 'John'${NC}"
curl --request POST \
  --url "$BASE_URL" \
  --header "Authorization: Bearer $API_TOKEN" \
  --header 'Content-Type: application/json' \
  --data '{
    "dataset_id": "'$DATASET_ID'",
    "records_limit": 10,
    "filter": {
      "name": "name",
      "operator": "=",
      "value": "John"
    }
  }' \
  --silent | jq '.'

echo -e "\n${GREEN}Example 2: Find Tech Managers in San Francisco${NC}"
curl --request POST \
  --url "$BASE_URL" \
  --header "Authorization: Bearer $API_TOKEN" \
  --header 'Content-Type: application/json' \
  --data '{
    "dataset_id": "'$DATASET_ID'",
    "records_limit": 20,
    "filter": {
      "and": [
        {"name": "title", "operator": "includes", "value": "Manager"},
        {"name": "industry", "operator": "includes", "value": "Technology"},
        {"name": "location", "operator": "includes", "value": "San Francisco"}
      ]
    }
  }' \
  --silent | jq '.'

echo -e "\n${GREEN}Example 3: Find people with Python skills${NC}"
curl --request POST \
  --url "$BASE_URL" \
  --header "Authorization: Bearer $API_TOKEN" \
  --header 'Content-Type: application/json' \
  --data '{
    "dataset_id": "'$DATASET_ID'",
    "records_limit": 15,
    "filter": {
      "and": [
        {"name": "skills", "operator": "array_includes", "value": "Python"},
        {"name": "country", "operator": "=", "value": "United States"}
      ]
    }
  }' \
  --silent | jq '.'

echo -e "\n${GREEN}Example 4: Exclude Big Tech companies${NC}"
curl --request POST \
  --url "$BASE_URL" \
  --header "Authorization: Bearer $API_TOKEN" \
  --header 'Content-Type: application/json' \
  --data '{
    "dataset_id": "'$DATASET_ID'",
    "records_limit": 25,
    "filter": {
      "and": [
        {"name": "company", "operator": "not_in", "value": ["Google", "Apple", "Microsoft", "Amazon"]},
        {"name": "title", "operator": "includes", "value": "Engineer"}
      ]
    }
  }' \
  --silent | jq '.'

echo -e "\n${GREEN}Example 5: Find recent job changers${NC}"
curl --request POST \
  --url "$BASE_URL" \
  --header "Authorization: Bearer $API_TOKEN" \
  --header 'Content-Type: application/json' \
  --data '{
    "dataset_id": "'$DATASET_ID'",
    "records_limit": 30,
    "filter": {
      "and": [
        {"name": "employment_status", "operator": "=", "value": "Employed"},
        {"name": "years_at_company", "operator": "<", "value": 1}
      ]
    }
  }' \
  --silent | jq '.'

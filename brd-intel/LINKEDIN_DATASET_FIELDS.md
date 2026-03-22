# Bright Data LinkedIn Dataset - Available Fields

**Dataset ID**: `gd_l1viktl72bvl7bjuj0`

## 📋 All Available Fields (43 fields)

### Profile Information
- `id` - Unique LinkedIn profile identifier (PII)
- `name` - Full profile name (PII)
- `first_name` - First name
- `last_name` - Last name
- `linkedin_id` - LinkedIn ID
- `linkedin_num_id` - LinkedIn numeric ID
- `url` - LinkedIn profile URL
- `urn` - LinkedIn URN
- `urn_id` - URN ID

### Location
- `city` - City location
- `country_code` - ISO 2-letter country code
- `location` - Full location string

### Professional Info
- `position` - Job position/title
- `current_company` - Current company
- `current_company_name` - Current company name
- `current_company_company_id` - Current company ID
- `experience` - Work experience (array)

### Education
- `education` - Education history (array)
- `educations_details` - Detailed education info

### Skills & Certifications
- `certifications` - Certifications (array)
- `courses` - Courses taken (array)
- `languages` - Languages spoken (array)

### Content & Engagement
- `about` - About/bio text
- `bio_links` - Links in bio
- `activity` - Activity level
- `posts` - Number of posts
- `recommendations_count` - Number of recommendations
- `recommendations` - Recommendations (array)

### Network
- `connections` - Number of connections
- `followers` - Number of followers
- `groups` - Groups membership (array)

### Media
- `avatar` - Profile avatar URL
- `default_avatar` - Default avatar flag
- `banner_image` - Banner image URL

### Professional Achievements
- `honors_and_awards` - Honors and awards (array)
- `patents` - Patents (array)
- `publications` - Publications (array)
- `projects` - Projects (array)
- `volunteer_experience` - Volunteer work (array)
- `organizations` - Organizations (array)

### Additional
- `people_also_viewed` - Similar profiles
- `similar_profiles` - Related profiles
- `influencer` - Influencer status
- `memorialized_account` - Memorialized flag
- `input_url` - Input URL used

---

## ✅ Working API Examples

### Example 1: Find people in San Francisco
```bash
curl -X POST "https://api.brightdata.com/datasets/filter" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "dataset_id": "gd_l1viktl72bvl7bjuj0",
    "filter": {
      "name": "city",
      "operator": "includes",
      "value": "San Francisco"
    },
    "records_limit": 10
  }'
```

### Example 2: Find people named "John"
```bash
curl -X POST "https://api.brightdata.com/datasets/filter" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "dataset_id": "gd_l1viktl72bvl7bjuj0",
    "filter": {
      "name": "name",
      "operator": "=",
      "value": "John"
    },
    "records_limit": 10
  }'
```

### Example 3: Find Software Engineers in USA
```bash
curl -X POST "https://api.brightdata.com/datasets/filter" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "dataset_id": "gd_l1viktl72bvl7bjuj0",
    "filter": {
      "and": [
        {
          "name": "position",
          "operator": "includes",
          "value": "Software Engineer"
        },
        {
          "name": "country_code",
          "operator": "=",
          "value": "US"
        }
      ]
    },
    "records_limit": 20
  }'
```

### Example 4: Find people in specific company
```bash
curl -X POST "https://api.brightdata.com/datasets/filter" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "dataset_id": "gd_l1viktl72bvl7bjuj0",
    "filter": {
      "name": "current_company_name",
      "operator": "includes",
      "value": "Google"
    },
    "records_limit": 15
  }'
```

---

## 📊 Filter Operators

- `=` - Exact match
- `!=` - Not equal
- `includes` - Contains substring (for text fields)
- `not_includes` - Does not contain
- `<`, `>`, `<=`, `>=` - Comparison
- `in`, `not_in` - Array membership
- `array_includes` - Array contains value
- `is_null`, `is_not_null` - Null checks

## 🔗 Logical Operators

- `and` - All conditions must match
- `or` - Any condition can match
- Max nesting: 3 levels

---

## 🎯 PII Fields
These fields contain personally identifiable information:
- `id` (LinkedIn ID)
- `name` (Full name)
- `first_name`
- `last_name`

**Use responsibly and comply with GDPR/privacy laws.**

#!/bin/bash

# Test Bright Data MCP Capabilities
# This script attempts to interact with the MCP

API_TOKEN="30728b24f3b8fa70b816bb2936d5451c19941d910a6d330a2b7f04b19cf4b1d9"

echo "🔍 Testing Bright Data MCP..."
echo ""

# Check if MCP is properly installed
echo "1️⃣  Checking MCP Installation..."
npx @brightdata/mcp --help 2>/dev/null && echo "✅ MCP installed" || echo "⚠️  MCP not directly callable via --help"

echo ""
echo "2️⃣  Checking MCP Version..."
npx @brightdata/mcp --version 2>/dev/null || echo "⚠️  Version check not available"

echo ""
echo "3️⃣  Environment Check..."
export BRIGHTDATA_API_TOKEN="$API_TOKEN"
echo "✅ API Token set in environment"

echo ""
echo "4️⃣  MCP Integration Info..."
echo "   - MCP Type: Model Context Protocol (Claude Integration)"
echo "   - Service: @brightdata/mcp"
echo "   - Auth: Bearer Token via environment"
echo ""

echo "📝 Notes:"
echo "   - MCP is designed for AI agent integration"
echo "   - Not directly callable via CLI"
echo "   - Need to use through Claude Code agent system"
echo "   - Provides tools for web scraping and data extraction"


#!/bin/bash
# Quick test of the health endpoint

echo "Testing health endpoint..."
echo ""

# Start the service in the background (requires .env to be configured)
echo "Note: This test requires a configured .env file"
echo "Starting service in background for 10 seconds..."
npm start &
PID=$!

# Wait for server to start
sleep 3

echo ""
echo "=== Testing /health endpoint ==="
curl -s http://localhost:3000/health | jq .

echo ""
echo ""
echo "=== Testing /metrics endpoint ==="
curl -s http://localhost:3000/metrics | jq .

echo ""
echo ""
echo "Stopping service..."
kill $PID 2>/dev/null
wait $PID 2>/dev/null

echo "Done!"

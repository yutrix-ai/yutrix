#!/bin/bash
echo "Testing concurrency limit of 2..."

# Fire 4 concurrent requests
for i in 1 2 3 4; do
  curl -s -w "Request $i - Time: %{time_total}s - Status: %{http_code}\n" -o /dev/null -X POST http://localhost:3000/v1/chat/completions \
    -H "Host: code-backend.localhost" \
    -H "Authorization: Bearer pg_0a48896599c285f485cac1568f2a73ab9c18f259d51fca30" \
    -H "Content-Type: application/json" \
    -d '{
      "model": "qwen3.7-max",
      "messages": [{"role": "user", "content": "Write a long essay about the history of artificial intelligence. Take your time."}]
    }' &
done

# Wait for all background jobs to finish
wait
echo "All requests finished."

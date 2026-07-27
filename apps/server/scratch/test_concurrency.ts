async function sendRequest(id: number) {
  const url = "http://code-backend.localhost:3000/v1/chat/completions";
  console.log(`[${id}] Sending request...`);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer pg_testkey123",
      },
      body: JSON.stringify({
        model: "qwen3.7-max",
        messages: [{ role: "user", content: "Hello" }]
      })
    });
    const text = await res.text();
    console.log(`[${id}] Response status:`, res.status);
    console.log(`[${id}] Response body excerpt:`, text.substring(0, 100));
  } catch (err) {
    console.error(`[${id}] Error:`, err);
  }
}

async function main() {
  console.log("Starting 4 concurrent requests...");
  await Promise.all([
    sendRequest(1),
    sendRequest(2),
    sendRequest(3),
    sendRequest(4)
  ]);
  console.log("Done.");
}

main();

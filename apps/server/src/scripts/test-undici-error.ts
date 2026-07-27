import { request, ProxyAgent } from 'undici';

async function test() {
  try {
    const proxyUrl = "http://10.8.0.1:11811";
    console.log("Using proxy:", proxyUrl);

    const dispatcher = new ProxyAgent(proxyUrl);
    // Use an unroutable IP to simulate a timeout
    const url = "https://10.255.255.255/v1beta/openai/chat/completions";

    console.log("Sending request...");
    const res = await request(url, {
      dispatcher,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ test: 1 }),
      bodyTimeout: 2000,
      headersTimeout: 2000,
    });

    console.log("Status:", res.statusCode);
  } catch (e: any) {
    console.error("❌ Error Name:", e.name);
    console.error("❌ Error Message:", e.message);
    console.error("❌ Error stringified:", e.toString());
    if (e.cause) console.error("Cause:", e.cause);
  }
}

test();

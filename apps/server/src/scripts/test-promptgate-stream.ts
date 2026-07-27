import { request } from 'undici';

async function test() {
  try {
    const url = "http://localhost:3001/v1/chat/completions";

    console.log("Sending request to PromptGate...");
    const res = await request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // The API key is from the database. Let's use the default system one if testing.
        // Wait, I need an API key that works for PromptGate.
        "Authorization": "Bearer sk-test"
      },
      body: JSON.stringify({
        model: "gemma-4-31b-it",
        messages: [{ role: "user", content: "思考一下为什么天是蓝色的" }],
        stream: true
      }),
    });

    console.log("Status:", res.statusCode);
    for await (const chunk of res.body) {
      console.log(chunk.toString());
    }
  } catch (e: any) {
    console.error("Error:", e);
  }
}

test();

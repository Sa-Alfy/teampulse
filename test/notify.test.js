"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { sendTelegram } = require("../notify");

const originalToken = process.env.TELEGRAM_BOT_TOKEN;
const originalChatId = process.env.TELEGRAM_CHAT_ID;
const originalFetch = global.fetch;

function restoreEnv() {
  if (originalToken !== undefined) {
    process.env.TELEGRAM_BOT_TOKEN = originalToken;
  } else {
    delete process.env.TELEGRAM_BOT_TOKEN;
  }

  if (originalChatId !== undefined) {
    process.env.TELEGRAM_CHAT_ID = originalChatId;
  } else {
    delete process.env.TELEGRAM_CHAT_ID;
  }

  global.fetch = originalFetch;
}

test.afterEach(() => {
  restoreEnv();
});

test.after(() => {
  restoreEnv();
});

test("env unset means no fetch call and {sent:false}", async () => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;

  let fetchCalled = false;
  global.fetch = async () => {
    fetchCalled = true;
    return { ok: true, json: async () => ({ ok: true }) };
  };

  const res = await sendTelegram("Testing unset env");
  assert.strictEqual(fetchCalled, false, "fetch should not be called when env is unset");
  assert.strictEqual(res.sent, false);
  assert.strictEqual(res.reason, "not-configured");
});

test("env partially unset (only token or only chat id) returns {sent:false} and no fetch", async () => {
  let fetchCalled = false;
  global.fetch = async () => {
    fetchCalled = true;
    return { ok: true, json: async () => ({ ok: true }) };
  };

  // Only token set
  process.env.TELEGRAM_BOT_TOKEN = "fake-token";
  delete process.env.TELEGRAM_CHAT_ID;
  let res = await sendTelegram("Only token");
  assert.strictEqual(fetchCalled, false);
  assert.strictEqual(res.sent, false);
  assert.strictEqual(res.reason, "not-configured");

  // Only chat ID set
  delete process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_CHAT_ID = "fake-chat";
  res = await sendTelegram("Only chat id");
  assert.strictEqual(fetchCalled, false);
  assert.strictEqual(res.sent, false);
  assert.strictEqual(res.reason, "not-configured");
});

test("10k-char text is split into parts <=4096, one fetch per part, correct URL and body", async () => {
  const fakeToken = "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11";
  const fakeChatId = "987654321";
  process.env.TELEGRAM_BOT_TOKEN = fakeToken;
  process.env.TELEGRAM_CHAT_ID = fakeChatId;

  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({
      url,
      options,
      body: JSON.parse(options.body),
    });
    return {
      ok: true,
      json: async () => ({ ok: true }),
    };
  };

  // Generate multi-line text > 10,000 chars
  const linePattern = "CSE 312: Class Test on Sunday 14:30 in Room 312. Bring your laptops and ID cards.";
  const lines = [];
  let totalLength = 0;
  let i = 0;
  while (totalLength < 10000) {
    const l = `[${i++}] ${linePattern}`;
    lines.push(l);
    totalLength += l.length + 1;
  }
  const longText = lines.join("\n");
  assert.ok(longText.length >= 10000, `Text length was ${longText.length}`);

  const res = await sendTelegram(longText);
  assert.strictEqual(res.sent, true);
  assert.ok(calls.length > 1, `Expected multiple chunks, got ${calls.length}`);

  for (const call of calls) {
    assert.strictEqual(call.url, `https://api.telegram.org/bot${fakeToken}/sendMessage`);
    assert.strictEqual(call.options.method, "POST");
    assert.strictEqual(call.body.chat_id, fakeChatId);
    assert.strictEqual(call.body.disable_web_page_preview, true);
    assert.ok(call.body.text.length <= 4096, `Chunk exceeds 4096: ${call.body.text.length}`);
    assert.ok(call.body.text.length <= 4000, `Chunk exceeds 4000: ${call.body.text.length}`);
  }

  // Verify full message text was preserved when reassembled
  const reassembled = calls.map((c) => c.body.text).join("\n");
  assert.strictEqual(reassembled, longText);
});

test("network error resolves {sent:false} without throwing", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "fake-token";
  process.env.TELEGRAM_CHAT_ID = "fake-chat";

  global.fetch = async () => {
    throw new Error("getaddrinfo ENOTFOUND api.telegram.org");
  };

  const res = await sendTelegram("Hello");
  assert.strictEqual(res.sent, false);
  assert.strictEqual(res.reason, "getaddrinfo ENOTFOUND api.telegram.org");
});

test("non-ok HTTP response resolves {sent:false} without throwing", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "fake-token";
  process.env.TELEGRAM_CHAT_ID = "fake-chat";

  global.fetch = async () => {
    return {
      ok: false,
      status: 400,
      json: async () => ({
        ok: false,
        error_code: 400,
        description: "Bad Request: chat not found",
      }),
    };
  };

  const res = await sendTelegram("Hello");
  assert.strictEqual(res.sent, false);
  assert.strictEqual(res.reason, "Bad Request: chat not found");
});

test("the token never appears in a returned reason", async () => {
  const secretToken = "SECRET_BOT_TOKEN_123456_XYZ";
  process.env.TELEGRAM_BOT_TOKEN = secretToken;
  process.env.TELEGRAM_CHAT_ID = "test-chat";

  global.fetch = async () => {
    throw new Error(`Connection failed to https://api.telegram.org/bot${secretToken}/sendMessage`);
  };

  const res = await sendTelegram("Secret test");
  assert.strictEqual(res.sent, false);
  assert.strictEqual(res.reason.includes(secretToken), false, `Token was leaked: ${res.reason}`);
  assert.strictEqual(res.reason.includes("[REDACTED]"), true);
});

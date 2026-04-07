import { expect, request as playwrightRequest, test } from "@playwright/test";
import { startMockRegisterApiServer } from "./support/mock-register-api.js";

test("register API works with csrf bootstrap", async () => {
  const registerValue = `Aa1!${Date.now().toString(36)}Z`;
  const mockServer = await startMockRegisterApiServer();
  const requestContext = await playwrightRequest.newContext({ baseURL: mockServer.baseUrl });

  try {
    const csrfResponse = await requestContext.get("/api/csrf");
    expect(csrfResponse.status()).toBe(200);

    const csrfData = (await csrfResponse.json()) as { csrf_token: string };
    expect(csrfData.csrf_token).toMatch(/[A-Za-z0-9._-]{16,}/);

    const registerResponse = await requestContext.post("/api/register", {
      data: {
        email: `test+${Date.now()}@example.com`,
        password: registerValue,
      },
      headers: {
        "X-CSRF-Token": csrfData.csrf_token,
        "Content-Type": "application/json",
      },
    });

    expect(registerResponse.status()).toBe(201);
    const body = (await registerResponse.json()) as { user_id: string; email: string };
    expect(body.user_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(body.email).toContain("@example.com");
  } finally {
    await requestContext.dispose();
    await mockServer.close();
  }
});

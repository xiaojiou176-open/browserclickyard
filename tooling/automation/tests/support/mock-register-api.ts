import { randomBytes, randomUUID } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";

type RegisterPayload = {
  email?: unknown;
  password?: unknown;
};

type CsrfSession = {
  token: string;
};

export type MockRegisterApiServer = {
  baseUrl: string;
  csrfPath: string;
  registerPath: string;
  close: () => Promise<void>;
};

const JSON_TYPE = "application/json";

function json(
  res: ServerResponse,
  statusCode: number,
  payload: unknown,
  headers?: Record<string, string>,
): void {
  res.writeHead(statusCode, {
    "Content-Type": JSON_TYPE,
    ...headers,
  });
  res.end(JSON.stringify(payload));
}

function parseCookie(header: string | undefined): Record<string, string> {
  if (!header) {
    return {};
  }
  return header
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((acc, pair) => {
      const [name, ...rest] = pair.split("=");
      if (!name) {
        return acc;
      }
      acc[name] = rest.join("=");
      return acc;
    }, {});
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

export async function startMockRegisterApiServer(options?: {
  csrfPath?: string;
  registerPath?: string;
}): Promise<MockRegisterApiServer> {
  const csrfPath = options?.csrfPath ?? "/api/csrf";
  const registerPath = options?.registerPath ?? "/api/register";
  const sessions = new Map<string, CsrfSession>();

  const server = http.createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const url = req.url ?? "/";

    if (method === "GET" && url === csrfPath) {
      const sessionId = randomUUID();
      const token = randomBytes(24).toString("base64url");
      sessions.set(sessionId, { token });
      json(
        res,
        200,
        { csrf_token: token },
        {
          "Set-Cookie": `csrf_session=${sessionId}; Path=/; HttpOnly; SameSite=Lax`,
        },
      );
      return;
    }

    if (method === "POST" && url === registerPath) {
      const headerToken = req.headers["x-csrf-token"];
      const cookies = parseCookie(req.headers.cookie);
      const sessionId = cookies.csrf_session;
      const expectedToken = sessionId ? sessions.get(sessionId)?.token : null;
      if (!sessionId || !expectedToken || headerToken !== expectedToken) {
        json(res, 403, { error: "invalid_csrf" });
        return;
      }

      if (!req.headers["content-type"]?.includes(JSON_TYPE)) {
        json(res, 415, { error: "unsupported_media_type" });
        return;
      }

      let parsed: RegisterPayload;
      try {
        parsed = (await readJsonBody(req)) as RegisterPayload;
      } catch {
        json(res, 400, { error: "invalid_json" });
        return;
      }

      const email = typeof parsed.email === "string" ? parsed.email : "";
      const password = typeof parsed.password === "string" ? parsed.password : "";
      if (!email.includes("@") || password.length < 8) {
        json(res, 422, { error: "validation_failed" });
        return;
      }

      json(res, 201, { user_id: randomUUID(), email });
      return;
    }

    json(res, 404, { error: "not_found", path: url, method });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to allocate mock register API server");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    csrfPath,
    registerPath,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

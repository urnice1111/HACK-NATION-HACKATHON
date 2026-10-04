import { PhoneE164 } from "../contracts/index.ts";
import { log, maskPhone } from "../http/log.ts";
import { contacts } from "./fixtures.ts";
import { createMockBackend } from "./server.ts";

const token = process.env.MOCK_SERVICE_TOKEN;
if (!token) {
  console.error("Falta MOCK_SERVICE_TOKEN (ver .env.example).");
  process.exit(1);
}

/** MOCK_PHONE_OVERRIDES="contact_demo_01=+52...,contact_demo_02=+52..." — solo teléfonos de prueba propios. */
function parseOverrides(raw: string | undefined): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const pair of (raw ?? "").split(",").map((p) => p.trim()).filter(Boolean)) {
    const [contactId, phone] = pair.split("=").map((p) => p.trim());
    if (!contactId || !contacts.some((c) => c.id === contactId) || !PhoneE164.safeParse(phone).success) {
      console.error(`MOCK_PHONE_OVERRIDES inválido en "${contactId ?? pair}": usa contact_id=+E164`);
      process.exit(1);
    }
    overrides[contactId] = phone!;
  }
  return overrides;
}

const phoneOverrides = parseOverrides(process.env.MOCK_PHONE_OVERRIDES);
const port = Number(process.env.MOCK_BACKEND_PORT ?? 8787);
const { server } = createMockBackend({ serviceToken: token, phoneOverrides });

server.listen(port, "127.0.0.1", () => {
  log("info", "mock_backend_listening", {
    url: `http://127.0.0.1:${port}/v1`,
    is_demo: true,
    phone_overrides: Object.fromEntries(Object.entries(phoneOverrides).map(([c, p]) => [c, maskPhone(p)])),
  });
});

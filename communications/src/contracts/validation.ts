import type { z } from "zod";
import type { ErrorDetail } from "./common.ts";

/** Ruta tipo `measurements[0].unit`, como en el ejemplo de error de la sección 8. */
function formatPath(path: ReadonlyArray<PropertyKey>): string {
  let out = "";
  for (const segment of path) {
    if (typeof segment === "number") out += `[${segment}]`;
    else out += out ? `.${String(segment)}` : String(segment);
  }
  return out || "(body)";
}

/**
 * Convierte errores de zod en `details[]` del error uniforme. Nunca incluye el
 * valor recibido: podría ser un teléfono o parte de una transcripción.
 */
export function validationDetails(error: z.ZodError): ErrorDetail[] {
  const details: ErrorDetail[] = [];
  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) {
        details.push({ field: formatPath([...issue.path, key]), reason: "unrecognized" });
      }
      continue;
    }
    const missing = issue.code === "invalid_type" && /received undefined/.test(issue.message);
    details.push({ field: formatPath(issue.path), reason: missing ? "required" : issue.code });
  }
  return details;
}

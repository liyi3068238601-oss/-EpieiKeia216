/** A JSON value that can cross the Xiadie package boundary. */
export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * Checks the runtime shape accepted by JsonValue.
 *
 * This is deliberately stricter than JSON.stringify: it rejects values that
 * JSON.stringify would silently omit, coerce, or execute through accessors.
 */
export function isJsonValue(value: unknown): value is JsonValue {
  try {
    return visit(value, new WeakSet<object>());
  } catch {
    // Proxies and hostile property traps are invalid boundary values.
    return false;
  }
}

function visit(value: unknown, ancestors: WeakSet<object>): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }

  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) return false;

      const ownKeys = Reflect.ownKeys(value);
      for (const key of ownKeys) {
        if (key === "length") continue;
        if (typeof key !== "string" || !isArrayIndex(key, value.length)) {
          return false;
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (
          descriptor === undefined ||
          !descriptor.enumerable ||
          !("value" in descriptor)
        ) {
          return false;
        }
      }

      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) return false;
        if (!visit(value[index], ancestors)) return false;
      }
      return true;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;

    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor) ||
        !visit(descriptor.value, ancestors)
      ) {
        return false;
      }
    }
    return true;
  } finally {
    ancestors.delete(value);
  }
}

function isArrayIndex(key: string, length: number): boolean {
  if (!/^(0|[1-9]\d*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index < length;
}

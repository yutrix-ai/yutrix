/**
 * Copy the object graph but reuse string values.
 * JSON.parse(JSON.stringify()) allocates a second copy of every image payload.
 * Request bodies are already plain JSON, so a structural copy is enough and
 * the base64 strings stay shared with the original.
 */
export function cloneJsonSharingStrings<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const copy = new Array(value.length);
    for (let i = 0; i < value.length; i++) {
      copy[i] = cloneJsonSharingStrings(value[i]);
    }
    return copy as T;
  }
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(value as object)) {
    const child = (value as Record<string, unknown>)[key];
    if (child !== undefined) copy[key] = cloneJsonSharingStrings(child);
  }
  return copy as T;
}

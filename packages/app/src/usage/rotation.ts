/** "Rotate IPv6": the free-usage ring registers it (it owns the current exit's count) and anything
 * else that rotates, such as Settings › IPv6 and WARP, triggers it, so every rotation goes one way. */
export const ROTATE_COMMAND = { id: "ghost.rotate" } as const

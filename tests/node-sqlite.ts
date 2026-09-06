export const HAS_NODE_SQLITE = await (async () => {
  try {
    await import("node:sqlite")
    return true
  } catch {
    return false
  }
})()

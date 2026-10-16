import { registerNativeAutonomyPlugin } from "../../packages/core-runtime/dist/native/plugin.js"
import { assertWorkspaceResolution } from "../../scripts/assert-workspace-resolution.mjs"
export default {
  id: "autocode",
  name: "Autonomous application coding",
  register(api) {
    assertWorkspaceResolution()
    return registerNativeAutonomyPlugin(api)
  }
}

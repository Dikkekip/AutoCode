import { registerNativeAutonomyPlugin } from "../../packages/core-runtime/dist/native/plugin.js"
import { assertPluginWorkspaceResolution } from "../../scripts/assert-workspace-resolution.mjs"
export default {
  id: "autocode",
  name: "Autonomous application coding",
  register(api) {
    assertPluginWorkspaceResolution(api)
    return registerNativeAutonomyPlugin(api)
  }
}

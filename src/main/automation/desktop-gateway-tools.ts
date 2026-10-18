import type { McpToolRegistration } from '../../shared/modules/mcp-tools'

// The desktop's own gateway tools, in the order agents have always listed
// them: the browser and the canvas first, then the editor, tours, Studio's
// core tools, the window and run tools, the worktree pool's, published
// artifacts, and remote-control configuration.
//
// One function, so the composition the app runs and the one its parity test
// lists are the same. When the shell offers the browser and the canvas as
// client toolsets, their lists here are empty and the gateway puts the
// offered toolsets in the same slots, ahead of everything below.

export type DesktopGatewayToolParts = {
  /** Empty when the shell offers `browser` as a client toolset. */
  browser: McpToolRegistration[]
  /** Empty when the shell offers `canvas` as a client toolset. */
  canvas: McpToolRegistration[]
  editor: McpToolRegistration[]
  tour: McpToolRegistration[]
  automation: McpToolRegistration[]
  /** The worktree pool's `worktree.*`, which main serves because main keeps the pool. */
  worktree: McpToolRegistration[]
  /** `artifacts.*`, which main serves because the pages are this machine's files. */
  artifacts: McpToolRegistration[]
  tailnet: McpToolRegistration[]
}

export function desktopGatewayTools(
  parts: DesktopGatewayToolParts,
): (coreTools: McpToolRegistration[]) => McpToolRegistration[] {
  return (coreTools) => [
    ...parts.browser,
    ...parts.canvas,
    ...parts.editor,
    ...parts.tour,
    ...coreTools,
    ...parts.automation,
    ...parts.worktree,
    ...parts.artifacts,
    ...parts.tailnet,
  ]
}

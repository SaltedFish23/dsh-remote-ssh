import { defineConfig } from "vitest/config";

// Migration 0.2.0-rc.1: the remote Backend tunnel (src/backend) and the TUI
// surfaces (src/tui) are deferred until their transports are ported to the
// Typert gateway; exclude their suites until then.
export default defineConfig({
  test: {
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "tests/backend-client.spec.ts",
      "tests/backend-connection.spec.ts",
      "tests/backend-control.spec.ts",
      "tests/backend-web.spec.ts",
      "tests/backend.spec.ts",
      "tests/remote-channel.spec.ts",
      "tests/socks.spec.ts",
      "tests/switchable-channel.spec.ts",
      "tests/tui-backend-controller.spec.ts",
      "tests/tui.spec.ts",
    ],
  },
});

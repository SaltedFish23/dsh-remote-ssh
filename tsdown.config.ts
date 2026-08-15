import type { UserConfig } from "tsdown";

const PLUGIN_ID = "dsh-remote-ssh";

export default [
  {
    entry: {
      host: "src/host.ts",
      index: "src/index.ts",
      fs: "src/fs.ts",
      "binary-fs": "src/binary-fs.ts",
      shell: "src/shell.ts",
      search: "src/search.ts",
      manager: "src/manager.ts",
      "router-fs": "src/router-fs.ts",
      "router-subprocess": "src/router-subprocess.ts",
      spill: "src/spill.ts",
      "local-bridge": "src/local-bridge.ts",
      "shell-transparent": "src/shell-transparent.ts",
      "agent-policy": "src/agent-policy.ts",
      tui: "src/tui.ts",
      web: "src/web.ts",
    },
    outDir: "lib",
    format: ["esm"],
    platform: "node",
    target: "es2024",
    fixedExtension: false,
    dts: true,
    clean: true,
    deps: {
      neverBundle: [
        "@microsoft/agent-host-protocol",
        "@deepseek-ai/cordis",
        "@deepseek-ai/dsh-agent",
        "@deepseek-ai/dsh-fs",
        "@deepseek-ai/dsh-settings",
        "@deepseek-ai/dsh-spill",
        "@deepseek-ai/dsh-subprocess",
        "@deepseek-ai/dsh-workspace",
        "@deepseek-ai/dsh-host-directory-picker-browse",
        "@deepseek-ai/dsh-host-webserver",
        "@deepseek-ai/dsh-llm",
        "@deepseek-ai/dsh-sandbox",
        "@deepseek-ai/dsh-shell",
        "@deepseek-ai/dsh-system-prompt",
        "@deepseek-ai/dsh-tools",
        "@deepseek-ai/schemastery",
      ],
    },
  },
  {
    entry: { client: "src/client/index.tsx" },
    outDir: "lib",
    format: "cjs",
    platform: "browser",
    dts: false,
    clean: false,
    deps: {
      neverBundle: [
        "react",
        "react/jsx-runtime",
        "react-dom",
        "react-dom/client",
        "@deepseek-ai/cordis",
        "@deepseek-ai/dsh-client-runtime/client",
        "@deepseek-ai/dsh-client-ui-settings-plugins/client",
      ],
    },
    define: {
      "process.env.NODE_ENV": JSON.stringify(
        process.env.NODE_ENV ?? "production"
      ),
    },
    outputOptions: {
      entryFileNames: "client.js",
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      footer: "return module.exports; } });",
      intro: "var module = { exports: {} }; var exports = module.exports;",
    },
  },
] satisfies UserConfig[];

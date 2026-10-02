import { defineApp } from "@hana/app-sdk";
import { registerBoardRoutes } from "./lib/boardRoutes.js";
import { registerBoardTools } from "./lib/tools.js";

/**
 * Backend entry.
 *
 * Step 0 proved the card renders; step 1 made a drawing survive a reload;
 * step 2 added the compare-and-set write; step 3 opens the same board to the
 * agent through three tools. Everything shares one write path on purpose —
 * the app process is the only writer (开发记录 D3).
 */
export default defineApp(async (sdk) => {
  sdk.routes.register((app) => registerBoardRoutes(app, sdk));
  const tools = registerBoardTools(sdk);
  for (const tool of tools) {
    await sdk.tools.register(tool);
  }
  await sdk.logger.info("[excalidraw-board] routes and tools registered", {
    dataDir: sdk.dataDir,
    // The array's length, not the function's: `registerBoardTools.length` is the
    // number of parameters it takes, which is 1 and always was.
    tools: tools.length,
  });
});

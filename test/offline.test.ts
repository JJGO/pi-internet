import assert from "node:assert/strict";
import test from "node:test";
import piInternet from "../src/index.ts";

type SessionStartContext = {
  hasUI: boolean;
  ui: { notify(message: string, level: string): void };
};

type SessionStartHandler = (
  event: unknown,
  ctx: SessionStartContext,
) => void | Promise<void>;

function loadExtension() {
  const handlers: SessionStartHandler[] = [];
  const tools: string[] = [];
  const commands: string[] = [];

  piInternet({
    on(event: string, handler: SessionStartHandler) {
      if (event === "session_start") handlers.push(handler);
    },
    registerTool(tool: { name: string }) { tools.push(tool.name); },
    registerCommand(name: string) { commands.push(name); },
    getActiveTools() { return []; },
    setActiveTools() {},
  } as never);

  return { handlers, tools, commands };
}

test("PI_OFFLINE disables pi-internet and warns when the session starts", async () => {
  const previousOffline = process.env.PI_OFFLINE;

  try {
    process.env.PI_OFFLINE = "1";
    const extension = loadExtension();

    assert.deepEqual(extension.tools, []);
    assert.deepEqual(extension.commands, []);
    assert.equal(extension.handlers.length, 1);

    let notification: { message: string; level: string } | undefined;
    await extension.handlers[0]({}, {
      hasUI: true,
      ui: {
        notify(message, level) { notification = { message, level }; },
      },
    });

    assert.deepEqual(notification, {
      message: "pi-internet disabled because PI_OFFLINE=1",
      level: "warning",
    });
  } finally {
    if (previousOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousOffline;
  }
});

test("PI_OFFLINE=0 does not disable pi-internet", () => {
  const previousOffline = process.env.PI_OFFLINE;

  try {
    process.env.PI_OFFLINE = "0";
    const extension = loadExtension();

    assert.deepEqual(extension.tools, ["web_search", "fetch_url"]);
    assert.deepEqual(extension.commands, ["search-providers", "kagi-login", "toggle-research"]);
  } finally {
    if (previousOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousOffline;
  }
});

import assert from "node:assert/strict";
import { createServer } from "node:https";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { createSecureContext } from "node:tls";
import { fetchWithProxy, resetSocksProxyDispatchers } from "../../src/util/proxy.ts";
import { listen, startSocksServer } from "./socks-server.ts";

/** Runs in a fresh Node/Pi process with NODE_EXTRA_CA_CERTS set to the test CA. */
export async function checkProxyTls(directory: string): Promise<void> {
  const payload = Buffer.alloc(256 * 1024, 68);
  const servernames: string[] = [];
  let requests = 0;
  const certificates = {
    key: await readFile(join(directory, "key.pem")),
    cert: await readFile(join(directory, "cert.pem")),
  };
  const server = createServer({
    ...certificates,
    SNICallback(servername, callback) {
      servernames.push(servername);
      callback(null, createSecureContext(certificates));
    },
  }, (_req, res) => {
    requests++;
    res.writeHead(200, { "content-encoding": "gzip" });
    res.end(gzipSync(payload));
  });
  server.on("tlsClientError", () => {});
  const port = await listen(server);
  const socks = await startSocksServer();
  try {
    for (const pinned of [false, true]) {
      const result = await fetchWithProxy(`https://test.invalid:${port}/`, {}, {
        socksProxy: socks.url,
        ...(pinned ? { connection: { hostname: "test.invalid", address: "127.0.0.1", family: 4 as const } } : {}),
      });
      assert.deepEqual(Buffer.from(await result.arrayBuffer()), payload);
      assert.deepEqual(socks.destinations.at(-1), { host: pinned ? "127.0.0.1" : "test.invalid", port });
    }
    assert.deepEqual(servernames, ["test.invalid", "test.invalid"]);
    await assert.rejects(fetchWithProxy(`https://wrong.invalid:${port}/`, {}, {
      socksProxy: socks.url,
      connection: { hostname: "wrong.invalid", address: "127.0.0.1", family: 4 },
    }));
    assert.equal(requests, 2, "wrong TLS hostname must not reach HTTP");
  } finally {
    await resetSocksProxyDispatchers();
    await socks.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

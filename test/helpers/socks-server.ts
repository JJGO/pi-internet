import { createServer, connect, type Server, type Socket } from "node:net";

/** Local SOCKS5 test server. Maps requested hosts to loopback, recording the
 * actual destination sent by the client so tests need no external DNS/network. */
export async function startSocksServer(reject = false) {
  const destinations: Array<{ host: string; port: number }> = [];
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    return socket;
  };
  const server = createServer((socket) => {
    track(socket);
    let buffer = Buffer.alloc(0);
    let greeted = false;
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!greeted) {
        if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return;
        if (buffer[0] !== 5) return socket.destroy();
        buffer = buffer.subarray(2 + buffer[1]);
        socket.write(Buffer.from([5, 0]));
        greeted = true;
      }
      if (buffer.length < 5) return;
      const addressLength = buffer[3] === 1 ? 4 : buffer[3] === 3 ? buffer[4] : 0;
      if (!addressLength) return socket.destroy();
      const offset = buffer[3] === 3 ? 5 : 4;
      if (buffer.length < offset + addressLength + 2) return;
      const host = buffer[3] === 1 ? [...buffer.subarray(offset, offset + addressLength)].join(".")
        : buffer.toString("utf8", offset, offset + addressLength);
      const port = buffer.readUInt16BE(offset + addressLength);
      destinations.push({ host, port });
      socket.removeListener("data", onData);
      if (reject) {
        socket.end(Buffer.from([5, 5, 0, 1, 127, 0, 0, 1, 0, 0]));
        return;
      }
      const target = track(connect(port, "127.0.0.1", () => {
        socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
        socket.pipe(target).pipe(socket);
      }));
      socket.once("close", () => target.destroy());
      target.once("close", () => socket.destroy());
    };
    socket.on("data", onData);
  });
  const port = await listen(server);
  return {
    url: `socks5h://127.0.0.1:${port}`,
    destinations,
    sockets,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  return address.port;
}

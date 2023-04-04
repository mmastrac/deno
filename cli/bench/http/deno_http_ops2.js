// Copyright 2018-2023 the Deno authors. All rights reserved. MIT license.

// @ts-check
const addr = Deno.args[0] || "127.0.0.1:4500";
const [hostname, port] = addr.split(":");
const core =  Deno[Deno.internal].core;
console.log("Server listening on", addr);
// const tcp = Deno.listen({ hostname, port: Number(port) });
// let resp = new TextEncoder().encode("HTTP/1.1 200 OK\nContent-Length: 2\n\nhi");
// for await (const conn of tcp) {
//   (async function() {
//     while(true) {
//       let buffer = new Uint8Array(1024);
//       const n = await conn.read(buffer);
//       if (n == null) {
//         break;
//       }
//       conn.write(resp).await;
//     }
//   })()
// }

let buffer = new SharedArrayBuffer(1024);
let buf8 = new Uint8Array(buffer);
let resp_text = new TextEncoder().encode("hello world from JS\n");
// Deno.serve({ port: 4500, hostname: '127.0.0.1' }, async (req) => {
//   // Sleep
//   // console.log("sleeping");
//   // await new Promise(r => setTimeout(r, 100));
//   // console.log("slept");
//   await core.opAsync2("op_void_async");
//   return new Response("hello from js!");
// })


Deno.serve({ port: 4500, hostname: '127.0.0.1' }, (req) => {
  const response = new Response("Hello World");
  return response;
})

// Because we don't block yet
// for await (const conn of Deno.listen({ hostname: "localhost", port: 1234 })) {
// }
// let resp = new TextEncoder().encode("HTTP/1.1 200 OK\nContent-Length: 2\n\nhi");
// for await (const conn of tcp) {
//   (async function() {
//     while(true) {
//       let buffer = new Uint8Array(1024);
//       const n = await conn.read(buffer);
//       if (n == null) {
//         break;
//       }
//       conn.write(resp).await;
//     }
//   })()



//   let resp = new TextEncoder().encode("Hello World");
//   const core =  Deno[Deno.internal].core;
//   for await (const conn of tcp) {
//     const id = core.ops.op_http_start(conn.rid);
//   (async function() {
//   // const http = new Http(id);
//   // Start a task for each connection
//     while (true) {
//       const nextRequest = await core.opAsync2("op_http_accept2", id);
//       if (nextRequest == null) {
//         core.close(id);
//         break;
//       }
//       // (async function() {
//         // const { 0: streamRid, 1: method, 2: url } = nextRequest;
//         core.ops.op_http_write_complete(
//           nextRequest,
//           resp,
//         );
//         // await core.opAsync2("op_void_async");
//         // await Deno[Deno.internal].core.opAsync(
//         //   "op_http_write_headers",
//         //   nextRequest[0],
//         //   200,
//         //   [],
//         //   "Hello World",
//         // );
//         // core.close(nextRequest[0]);
//       // })()
//     }
//   }())
// }

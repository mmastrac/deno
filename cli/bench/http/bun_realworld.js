// Copyright 2018-2023 the Deno authors. All rights reserved. MIT license.
const port = Bun.argv[3] || "4545";
console.log(`Listening on port ${port}`);
Bun.serve({
  fetch(req) {
    return new Response(`Hello ${req.headers.get('user-agent')}: ${req.url}`, {
      headers: { 
        "Server": "Real-World" 
      },
    });
  },
  port: Number(port),
});

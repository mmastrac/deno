// Copyright 2018-2023 the Deno authors. All rights reserved. MIT license.

const addr = Deno.args[0] ?? "127.0.0.1:4500";
const [hostname, port] = addr.split(":");
const { serve } = Deno;

async function handler(req) {
  // Echo on POST
  if (req.method == "POST") {
    return new Response(`Got: ${await req.text()}`, {
      headers: {
        "Server": "Real-World",
      },
    });
  }

  // Print on GET
  return new Response(
    `Hello ${req.headers.get("user-agent") ?? "<no user agent>"}: ${req.url}`,
    {
      headers: {
        "Server": "Real-World",
      },
    },
  );
}

serve(handler, { hostname, port, reusePort: true });

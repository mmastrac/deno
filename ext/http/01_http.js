// Copyright 2018-2023 the Deno authors. All rights reserved. MIT license.
const core = globalThis.Deno.core;
const internals = globalThis.__bootstrap.internals;
const primordials = globalThis.__bootstrap.primordials;
const { BadResourcePrototype, InterruptedPrototype, ops } = core;
import * as webidl from "ext:deno_webidl/00_webidl.js";
import { InnerBody } from "ext:deno_fetch/22_body.js";
import { Event, setEventTargetData } from "ext:deno_web/02_event.js";
import { BlobPrototype } from "ext:deno_web/09_file.js";
import {
  fromInnerResponse,
  newInnerResponse,
  ResponsePrototype,
  toInnerResponse,
} from "ext:deno_fetch/23_response.js";
import {
  fromInnerRequest,
  newInnerRequest,
  toInnerRequest,
} from "ext:deno_fetch/23_request.js";
import { AbortController } from "ext:deno_web/03_abort_signal.js";
import {
  _eventLoop,
  _idleTimeoutDuration,
  _idleTimeoutTimeout,
  _protocol,
  _readyState,
  _rid,
  _role,
  _server,
  _serverHandleIdleTimeout,
  SERVER,
  WebSocket,
} from "ext:deno_websocket/01_websocket.js";
import { listen, TcpConn, UnixConn } from "ext:deno_net/01_net.js";
import { listenTls, TlsConn } from "ext:deno_net/02_tls.js";
import {
  Deferred,
  getReadableStreamResourceBacking,
  readableStreamClose,
  readableStreamForRid,
  writableStreamForRid,
  ReadableStreamPrototype,
} from "ext:deno_web/06_streams.js";
const {
  ArrayPrototypeIncludes,
  ArrayPrototypeMap,
  ArrayPrototypePush,
  Error,
  ObjectPrototypeIsPrototypeOf,
  PromisePrototypeCatch,
  SafeSet,
  ObjectEntries,
  SafeSetIterator,
  SetPrototypeAdd,
  SetPrototypeDelete,
  SetPrototypeClear,
  StringPrototypeCharCodeAt,
  StringPrototypeIncludes,
  StringPrototypeToLowerCase,
  StringPrototypeSplit,
  Symbol,
  SymbolAsyncIterator,
  TypeError,
  Uint8Array,
  Uint8ArrayPrototype,
} = primordials;

const connErrorSymbol = Symbol("connError");
const streamRid = Symbol("streamRid");
const _deferred = Symbol("upgradeHttpDeferred");

class HttpConn {
  #rid = 0;
  #closed = false;
  #remoteAddr;
  #localAddr;
  #connections;
  #waiters;
  #httpRid;
  #requests;
  #error;
  #closePromise;
  #closeResolve;

  constructor(rid, remoteAddr, localAddr) {
    this.#remoteAddr = remoteAddr;
    this.#localAddr = localAddr;
    this.#connections = [];
    this.#waiters = [];
    this.#requests = new Set();
    this.#closePromise = new Promise(r => this.#closeResolve = r);

    const connections = this.#connections;
    const waiters = this.#waiters;
    const context = new CallbackContext();
    const onError = this.#onError.bind(this);

    this.#httpRid = core.ops.op_serve_http_on(rid, context.initialize.bind(context), map_to_userland(this.#requests, context, (req, responsePromise) => {
      const promise = new Promise(r => {
        connections.push([r, req, responsePromise]);
        waiters.pop()?.(true);
      });
      return promise;
    }, true, onError));
    context.server_rid = this.#httpRid;

    // Start the async IIFE to avoid looking like the event loop stalled
    const httpRid = this.#httpRid;
    // TODO(mmastrac): This IIFE should be the close promise
    (async () => {
      try {
        await core.opAsync("op_http_wait", httpRid);
      } catch (e) {
        // TODO(mmastrac): Is this the right way to get the exception?
        onError(new Deno.errors.Http(e.message));
      } finally {
        // TODO(mmastrac): We might want to consider using close here
        for (const waiter of this.#waiters) {
          waiter(false);
        }
        this.#onError(new TypeError("closed"));
        this.#closeResolve()
      }
    })()
  }

  #onError(e) {
    // Only keep the first exception
    if (!this.#error) {
      this.#error = e;
    }
    // Wake any waiters so they throw the exception
    for (const waiter of this.#waiters) {
      waiter(true);
    }           
  }

  /** @returns {Promise<RequestEvent | null>} */
  async nextRequest() {
    while (true) {
      if (this.#error) {
        throw this.#error;
      }
      const conn = this.#connections.pop();
      if (conn) {
        return { request: conn[1], respondWith: (resp) => { 
          conn[0](resp);
          // Return a promise tracking the state of the response
          return conn[2]();
        } };
      }
      const wakeup = new Promise(r => this.#waiters.push(r));
      if (await wakeup === false) {
        return null;
      }
    }
  }

  /** @returns {void} */
  async close() {
    for (const waiter of this.#waiters) {
      waiter(false);
    }
    for (const request of this.#requests) {
      request.close();
    }
    this.#requests = new Set();
    // Don't allow further listening
    this.#onError(new TypeError("closed"));
    core.tryClose(this.#httpRid);
    await this.#closePromise;
  }

  [SymbolAsyncIterator]() {
    // deno-lint-ignore no-this-alias
    const httpConn = this;
    return {
      async next() {
        const reqEvt = await httpConn.nextRequest();
        // Change with caution, current form avoids a v8 deopt
        return { value: reqEvt ?? undefined, done: reqEvt === null };
      },
    };
  }
}

/** Upgrades a request immediately, returning a promise with a raw network stream
 * connection that will resolve when the system has prepared the connection fully.
 */
async function upgradeHttp(request, { headers }) {
  const slab_id = request[slabId]();
  const response_headers = [];
  for (const [key, value] of ObjectEntries(headers ?? {})) {
    response_headers.push([key, value]);
  }
  const rid = await core.opAsync("op_upgrade", slab_id, response_headers);
  return new TcpConn(rid, null, null);
}

/** Upgrades a connection lazily, returning a raw network stream that initially emulates a
 * raw HTTP/1.1 connection. Once a valid HTTP/1.1 response has been provided, becomes a
 * true network stream. The underlying HTTP protocol may not be HTTP/1.1, but this API
 * expects the caller to speak HTTP/1.1.
*/
async function upgradeHttpRaw(request) {
  // const inner = toInnerRequest(req);
  // const res = core.opAsync("op_http_upgrade_early", inner[streamRid]);
  // return new TcpConn(res, tcpConn.remoteAddr, tcpConn.localAddr);
}

const slabId = Symbol("slab_id");

class RequestHeaders {
  #slab_id;

  get(header) {
    const value = core.ops.op_get_request_header(this.#slab_id, header);
    return value;
  }
}

class InnerRequest {
  #slab_id;
  #headers;
  #uri_prefix;
  #method_and_uri;
  #resource_set;
  #stream_rid;
  #body;

  constructor(slab_id, uri_prefix, resource_set) {
    this.#slab_id = slab_id;
    this.#uri_prefix = uri_prefix;
    this.#resource_set = resource_set;
  }

  close() {
    if (this.#stream_rid !== undefined) {
      core.close(this.#stream_rid);
      this.#stream_rid = undefined;
    }
    this.#slab_id = undefined;
  }

  url() {
    if (this.#method_and_uri === undefined) {
      if (this.#slab_id === undefined) {
        throw new TypeError("request closed");
      }
      this.#method_and_uri = core.ops.op_get_request_method_and_url(this.#slab_id);
    }
    return this.#uri_prefix + this.#method_and_uri[2];
  }

  text() {
    return "";
  }

  get method() {
    if (this.#method_and_uri === undefined) {
      if (this.#slab_id === undefined) {
        throw new TypeError("request closed");
      }
      this.#method_and_uri = core.ops.op_get_request_method_and_url(this.#slab_id);
    }
    return this.#method_and_uri[0];
  }

  get body() {
    if (this.#slab_id === undefined) {
      throw new TypeError("request closed");
    }
    if (this.#body !== undefined) {
      return this.#body;
    }
    // TODO(mmastrac): We should be checking this somewhere else, I think
    if (this.method == "GET" || this.method == "HEAD") {
      this.#body = null;
      return null;
    }
    this.#stream_rid = core.ops.op_read_request_body(this.#slab_id);
    this.#body = new InnerBody(readableStreamForRid(this.#stream_rid, false));
    return this.#body;
  }

  get headerList() {
    if (this.#slab_id === undefined) {
      throw new TypeError("request closed");
    }
    return core.ops.op_get_request_headers(this.#slab_id);
  }

  get headers() {
    if (!this.#headers) {
      if (this.#slab_id === undefined) {
        throw new TypeError("request closed");
      }
      this.#headers = new RequestHeaders(this.#slab_id);
    }
    return this.#headers;
  }

  get slabId() {
    return this.#slab_id;
  }
}

class CallbackContext {
  fallback_base_url;
  server_rid;

  initialize(fallback_base_url) {
    this.fallback_base_url = fallback_base_url;
  }
}

// This function is only called if innerResp is something more complicated than a
// string, buffer of bytes, or null.
function return_response(req, innerResp) {
  // If response body length is known, it will be sent synchronously in a
  // single op, in other case a "response body" resource will be created and
  // we'll be streaming it.
  /** @type {ReadableStream<Uint8Array> | Uint8Array | null} */
  // let respBody = null;
  // if (innerResp.body !== null) {
  //   if (innerResp.body.unusable()) {
  //     throw new TypeError("Body is unusable.");
  //   }
  //   if (
  //     ObjectPrototypeIsPrototypeOf(
  //       ReadableStreamPrototype,
  //       innerResp.body.streamOrStatic,
  //     )
  //   ) {
  //     if (
  //       innerResp.body.length === null ||
  //       ObjectPrototypeIsPrototypeOf(
  //         BlobPrototype,
  //         innerResp.body.source,
  //       )
  //     ) {
  //       respBody = innerResp.body.stream;
  //     } else {
  //       const reader = innerResp.body.stream.getReader();
  //       const r1 = await reader.read();
  //       if (r1.done) {
  //         respBody = new Uint8Array(0);
  //       } else {
  //         respBody = r1.value;
  //         const r2 = await reader.read();
  //         if (!r2.done) throw new TypeError("Unreachable");
  //       }
  //     }
  //   } else {
  //     innerResp.body.streamOrStatic.consumed = true;
  //     respBody = innerResp.body.streamOrStatic.body;
  //   }
  // } else {
  //   respBody = new Uint8Array(0);
  // }
  // const isStreamingResponseBody = !(
  //   typeof respBody === "string" ||
  //   ObjectPrototypeIsPrototypeOf(Uint8ArrayPrototype, respBody)
  // );
  // try {
  //   await core.opAsync(
  //     "op_http_write_headers",
  //     streamRid,
  //     innerResp.status ?? 200,
  //     innerResp.headerList,
  //     isStreamingResponseBody ? null : respBody,
  //   );
  // } catch (error) {
  //   const connError = httpConn[connErrorSymbol];
  //   if (
  //     ObjectPrototypeIsPrototypeOf(BadResourcePrototype, error) &&
  //     connError != null
  //   ) {
  //     // deno-lint-ignore no-ex-assign
  //     error = new connError.constructor(connError.message);
  //   }
  //   if (
  //     respBody !== null &&
  //     ObjectPrototypeIsPrototypeOf(ReadableStreamPrototype, respBody)
  //   ) {
  //     await respBody.cancel(error);
  //   }
  //   throw error;
  // }

  // if (isStreamingResponseBody) {
  //   let success = false;
  //   if (
  //     respBody === null ||
  //     !ObjectPrototypeIsPrototypeOf(ReadableStreamPrototype, respBody)
  //   ) {
  //     throw new TypeError("Unreachable");
  //   }
  //   const resourceBacking = getReadableStreamResourceBacking(respBody);
  //   let reader;
  //   if (resourceBacking) {
  //     if (respBody.locked) {
  //       throw new TypeError("ReadableStream is locked.");
  //     }
  //     reader = respBody.getReader(); // Aquire JS lock.
  //     try {
  //       await core.opAsync(
  //         "op_http_write_resource",
  //         streamRid,
  //         resourceBacking.rid,
  //       );
  //       if (resourceBacking.autoClose) core.tryClose(resourceBacking.rid);
  //       readableStreamClose(respBody); // Release JS lock.
  //       success = true;
  //     } catch (error) {
  //       const connError = httpConn[connErrorSymbol];
  //       if (
  //         ObjectPrototypeIsPrototypeOf(BadResourcePrototype, error) &&
  //         connError != null
  //       ) {
  //         // deno-lint-ignore no-ex-assign
  //         error = new connError.constructor(connError.message);
  //       }
  //       await reader.cancel(error);
  //       throw error;
  //     }
  //   } else {
  //     reader = respBody.getReader();
  //     while (true) {
  //       const { value, done } = await reader.read();
  //       if (done) break;
  //       if (!ObjectPrototypeIsPrototypeOf(Uint8ArrayPrototype, value)) {
  //         await reader.cancel(new TypeError("Value not a Uint8Array"));
  //         break;
  //       }
  //       try {
  //         await core.opAsync2("op_http_write", streamRid, value);
  //       } catch (error) {
  //         const connError = httpConn[connErrorSymbol];
  //         if (
  //           ObjectPrototypeIsPrototypeOf(BadResourcePrototype, error) &&
  //           connError != null
  //         ) {
  //           // deno-lint-ignore no-ex-assign
  //           error = new connError.constructor(connError.message);
  //         }
  //         await reader.cancel(error);
  //         throw error;
  //       }
  //     }
  //     success = true;
  //   }

  //   if (success) {
  //     try {
  //       await core.opAsync("op_http_shutdown", streamRid);
  //     } catch (error) {
  //       await reader.cancel(error);
  //       throw error;
  //     }
  //   }
  // }
}


function fastSyncResponse(req, respBody) {
  if (respBody === null || respBody === undefined) {
    core.ops.op_set_response_body_text(req, "");
    return true;
  }

  const body = respBody.streamOrStatic.body;
  if (ObjectPrototypeIsPrototypeOf(Uint8ArrayPrototype, body)) {
    core.ops.op_set_response_body_bytes(req, body.buffer);
    return true;
  } else if (typeof body === "string") {
    core.ops.op_set_response_body_text(req, body);
    return true;
  }
  return false;
}

async function asyncResponse(req, respBody) {
  const stream = respBody.streamOrStatic;
  // At this point in the response it needs to be a stream
  if (!ObjectPrototypeIsPrototypeOf(ReadableStreamPrototype, stream)) {
    throw TypeError("invalid response");
  }
  const resourceBacking = getReadableStreamResourceBacking(stream);
  if (resourceBacking) {
    core.ops.op_set_response_body_resource(req, resourceBacking.rid, resourceBacking.autoClose);
  } else {
    console.log("stm");
    const responseRid = core.ops.op_set_response_body_stream(req);
    console.log("stm", responseRid);
    const reader = stream.getReader();
    const responseStream = writableStreamForRid(responseRid, true);
    const writer = responseStream.getWriter();
    console.log("stm", 3);
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        await writer.write(value);
      }
    } catch (e) {
      console.log(e);
    } finally {
      writer.releaseLock();
      reader.releaseLock();
    }
    responseStream.close();
    console.log("stm");
  }
}

function map_to_userland(requests, context, callback, wantsPromise, onError) {
  return function(req) {
    const innerRequest = new InnerRequest(req, context.fallback_base_url);
    requests.add(innerRequest);
    const request = fromInnerRequest(innerRequest, "immutable");
    const response = callback(request, wantsPromise ? (() => core.opAsync("op_http_track", req, context.server_rid)) : undefined);
    // TODO: Detect promises better
    // TODO: Some response types are faster when we send them to ops, some are faster when we return them
    if (response.then) {
      // If the callback is a promise, wrap it in another promise where we can do the response serving
      // magic.
      return (async () => {
        try {
          // TODO(mmastrac): Code is duplicated between async/sync paths for now -- check perf if we extract it to a function
          const awaited_response = await response;
          const inner = toInnerResponse(awaited_response);
          const headers = inner.headerList;
          if (headers && headers.length > 0) {
            if (headers.length == 1) {
              core.ops.op_set_response_header(req, headers[0][0], headers[0][1]);
            } else {
              core.ops.op_set_response_headers(req, headers);
            }
          }
          if (!fastSyncResponse(req, inner.body)) {
            await asyncResponse(req, inner.body);
          }
          core.ops.op_set_promise_complete(req, 200);
          requests.delete(innerRequest);
          innerRequest.close();
        } catch (e) {
          onError(e);
        }
      })();
    } else {
      const inner = toInnerResponse(response);
      const headers = inner.headerList;
      if (headers && headers.length > 0) {
        if (headers.length == 1) {
          core.ops.op_set_response_header(req, headers[0][0], headers[0][1]);
        } else {
          core.ops.op_set_response_headers(req, headers);
        }
      }
      if (!fastSyncResponse(req, inner.body)) {
        // The response is not synchronous, so we're going to have to return a promise
        // TODO(mmastrac)
      }

      // Return undefined to use the body we're building
      requests.delete(innerRequest);
      innerRequest.close();
      return;
    }
  }
}

function serveHttp(conn) {
  return new HttpConn(conn.rid);
}

async function serve(arg1, arg2) {
  let options = undefined;
  let handler = undefined;
  if (typeof arg1 === "function") {
    handler = arg1;
    options = arg2;
  } else if (typeof arg2 === "function") {
    handler = arg2;
    options = arg1;
  } else {
    options = arg1;
  }
  if (handler === undefined) {
    if (options === undefined) {
      throw new TypeError(
        "No handler was provided, so an options bag is mandatory.",
      );
    }
    handler = options.handler;
  }
  if (typeof handler !== "function") {
    throw new TypeError("A handler function must be provided.");
  }
  if (options === undefined) {
    options = {};
  }

  const signal = options.signal;
  const onError = options.onError ?? function (error) {
    console.error(error);
    return new Response("Internal Server Error", { status: 500 });
  };
  const onListen = options.onListen ?? function ({ port }) {};

  const serverDeferred = new Deferred();
  const activeHttpConnections = new SafeSet();

  const listenOpts = {
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port ?? 9000,
    reusePort: options.reusePort ?? false,
  };
  
  // TODO(mmastrac): clean these up on abort
  const requests = new Set();
  const context = new CallbackContext();
  let rid;
  if (options.cert || options.key) {
    if (!options.cert || !options.key) {
      throw new TypeError(
        "Both cert and key must be provided to enable HTTPS.",
      );
    }
    listenOpts.cert = options.cert;
    listenOpts.key = options.key;
    const listener = Deno.listenTls(listenOpts);
    rid = core.ops.op_serve_http(listener.rid, context.initialize.bind(context), map_to_userland(requests, context, handler, false, onError));
    context.server_rid = rid;
  } else {
    const listener = Deno.listen(listenOpts);
    rid = core.ops.op_serve_http(listener.rid, context.initialize.bind(context), map_to_userland(requests, context, handler, false, onError));
    context.server_rid = rid;
  }

  // Await the underlying server
  await core.opAsync("op_http_wait", rid);
}

export { HttpConn, serve, serveHttp, upgradeHttp, upgradeHttpRaw };

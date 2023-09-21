// Copyright 2018-2023 the Deno authors. All rights reserved. MIT license.

// @ts-check
/// <reference path="../webidl/internal.d.ts" />
/// <reference path="./06_streams_types.d.ts" />
/// <reference path="./lib.deno_web.d.ts" />
/// <reference lib="esnext" />

const core = globalThis.Deno.core;
const internals = globalThis.__bootstrap.internals;
const {
  op_arraybuffer_was_detached,
  op_transfer_arraybuffer,
  op_readable_stream_resource_allocate,
  op_readable_stream_resource_get_sink,
  op_readable_stream_resource_write_error,
  op_readable_stream_resource_write_buf,
  op_readable_stream_resource_write_sync,
  op_readable_stream_resource_close,
  op_readable_stream_resource_await_close,
} = core.ensureFastOps();
import * as webidl from "ext:deno_webidl/00_webidl.js";
import { structuredClone } from "ext:deno_web/02_structured_clone.js";
import {
  AbortSignalPrototype,
  add,
  newSignal,
  remove,
  signalAbort,
} from "ext:deno_web/03_abort_signal.js";
const primordials = globalThis.__bootstrap.primordials;
const {
  ArrayBuffer,
  ArrayBufferIsView,
  ArrayBufferPrototype,
  ArrayBufferPrototypeGetByteLength,
  ArrayBufferPrototypeSlice,
  ArrayPrototypeMap,
  ArrayPrototypePush,
  ArrayPrototypeShift,
  AsyncGeneratorPrototype,
  BigInt64Array,
  BigUint64Array,
  DataView,
  DataViewPrototypeGetBuffer,
  DataViewPrototypeGetByteLength,
  DataViewPrototypeGetByteOffset,
  Float32Array,
  Float64Array,
  Int16Array,
  Int32Array,
  Int8Array,
  MathMin,
  NumberIsInteger,
  NumberIsNaN,
  ObjectCreate,
  ObjectDefineProperty,
  ObjectGetPrototypeOf,
  ObjectPrototypeIsPrototypeOf,
  ObjectSetPrototypeOf,
  Promise,
  PromisePrototypeCatch,
  PromisePrototypeThen,
  PromiseReject,
  PromiseResolve,
  RangeError,
  ReflectHas,
  SafeFinalizationRegistry,
  SafePromiseAll,
  SafeWeakMap,
  // TODO(lucacasonato): add SharedArrayBuffer to primordials
  // SharedArrayBufferPrototype,
  String,
  Symbol,
  SymbolAsyncIterator,
  SymbolIterator,
  SymbolFor,
  TypeError,
  TypedArrayPrototypeGetBuffer,
  TypedArrayPrototypeGetByteLength,
  TypedArrayPrototypeGetByteOffset,
  TypedArrayPrototypeGetSymbolToStringTag,
  TypedArrayPrototypeSet,
  TypedArrayPrototypeSlice,
  Uint16Array,
  Uint32Array,
  Uint8Array,
  Uint8ClampedArray,
  WeakMapPrototypeGet,
  WeakMapPrototypeHas,
  WeakMapPrototypeSet,
  queueMicrotask,
} = primordials;
import { createFilteredInspectProxy } from "ext:deno_console/01_console.js";
import { assert, AssertionError } from "ext:deno_web/00_infra.js";

/** @template T */
class Deferred {
  /** @type {Promise<T>} */
  #promise;
  /** @type {(reject?: any) => void} */
  #reject;
  /** @type {(value: T | PromiseLike<T>) => void} */
  #resolve;
  /** @type {"pending" | "fulfilled"} */
  #state = "pending";

  constructor() {
    this.#promise = new Promise((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
  }

  /** @returns {Promise<T>} */
  get promise() {
    return this.#promise;
  }

  /** @returns {"pending" | "fulfilled"} */
  get state() {
    return this.#state;
  }

  /** @param {any=} reason */
  reject(reason) {
    // already settled promises are a no-op
    if (this.#state !== "pending") {
      return;
    }
    this.#state = "fulfilled";
    this.#reject(reason);
  }

  /** @param {T | PromiseLike<T>} value */
  resolve(value) {
    // already settled promises are a no-op
    if (this.#state !== "pending") {
      return;
    }
    this.#state = "fulfilled";
    this.#resolve(value);
  }
}

/**
 * @template T
 * @param {T | PromiseLike<T>} value
 * @returns {Promise<T>}
 */
function resolvePromiseWith(value) {
  return new Promise((resolve) => resolve(value));
}

/** @param {any} e */
function rethrowAssertionErrorRejection(e) {
  if (e && ObjectPrototypeIsPrototypeOf(AssertionError.prototype, e)) {
    queueMicrotask(() => {
      console.error(`Internal Error: ${e.stack}`);
    });
  }
}

/** @param {Promise<any>} promise */
function setPromiseIsHandledToTrue(promise) {
  PromisePrototypeThen(promise, undefined, rethrowAssertionErrorRejection);
}

/**
 * @template T
 * @template TResult1
 * @template TResult2
 * @param {Promise<T>} promise
 * @param {(value: T) => TResult1 | PromiseLike<TResult1>} fulfillmentHandler
 * @param {(reason: any) => TResult2 | PromiseLike<TResult2>=} rejectionHandler
 * @returns {Promise<TResult1 | TResult2>}
 */
function transformPromiseWith(promise, fulfillmentHandler, rejectionHandler) {
  return PromisePrototypeThen(promise, fulfillmentHandler, rejectionHandler);
}

/**
 * @template T
 * @template TResult
 * @param {Promise<T>} promise
 * @param {(value: T) => TResult | PromiseLike<TResult>} onFulfilled
 * @returns {void}
 */
function uponFulfillment(promise, onFulfilled) {
  uponPromise(promise, onFulfilled);
}

/**
 * @template T
 * @template TResult
 * @param {Promise<T>} promise
 * @param {(value: T) => TResult | PromiseLike<TResult>} onRejected
 * @returns {void}
 */
function uponRejection(promise, onRejected) {
  uponPromise(promise, undefined, onRejected);
}

/**
 * @template T
 * @template TResult1
 * @template TResult2
 * @param {Promise<T>} promise
 * @param {(value: T) => TResult1 | PromiseLike<TResult1>} onFulfilled
 * @param {(reason: any) => TResult2 | PromiseLike<TResult2>=} onRejected
 * @returns {void}
 */
function uponPromise(promise, onFulfilled, onRejected) {
  PromisePrototypeThen(
    PromisePrototypeThen(promise, onFulfilled, onRejected),
    undefined,
    rethrowAssertionErrorRejection,
  );
}

/**
 * @param {ArrayBufferLike} O
 * @returns {boolean}
 */
function isDetachedBuffer(O) {
  // deno-lint-ignore prefer-primordials
  if (ObjectPrototypeIsPrototypeOf(SharedArrayBuffer.prototype, O)) {
    return false;
  }
  return ArrayBufferPrototypeGetByteLength(O) === 0 &&
    op_arraybuffer_was_detached(O);
}

/**
 * @param {ArrayBufferLike} O
 * @returns {boolean}
 */
function canTransferArrayBuffer(O) {
  assert(typeof O === "object");
  assert(
    ObjectPrototypeIsPrototypeOf(ArrayBufferPrototype, O) ||
      // deno-lint-ignore prefer-primordials
      ObjectPrototypeIsPrototypeOf(SharedArrayBuffer.prototype, O),
  );
  if (isDetachedBuffer(O)) {
    return false;
  }
  // TODO(@crowlKats): 4. If SameValue(O.[[ArrayBufferDetachKey]], undefined) is false, return false.
  return true;
}

/**
 * @param {ArrayBufferLike} O
 * @returns {ArrayBufferLike}
 */
function transferArrayBuffer(O) {
  return op_transfer_arraybuffer(O);
}

/**
 * @param {ArrayBufferLike} O
 * @returns {number}
 */
function getArrayBufferByteLength(O) {
  // deno-lint-ignore prefer-primordials
  if (ObjectPrototypeIsPrototypeOf(SharedArrayBuffer.prototype, O)) {
    // TODO(petamoriken): use primordials
    // deno-lint-ignore prefer-primordials
    return O.byteLength;
  } else {
    return ArrayBufferPrototypeGetByteLength(O);
  }
}

/**
 * @param {ArrayBufferView} O
 * @returns {Uint8Array}
 */
function cloneAsUint8Array(O) {
  assert(typeof O === "object");
  assert(ArrayBufferIsView(O));
  if (TypedArrayPrototypeGetSymbolToStringTag(O) !== undefined) {
    // TypedArray
    return TypedArrayPrototypeSlice(
      new Uint8Array(
        TypedArrayPrototypeGetBuffer(/** @type {Uint8Array} */ (O)),
        TypedArrayPrototypeGetByteOffset(/** @type {Uint8Array} */ (O)),
        TypedArrayPrototypeGetByteLength(/** @type {Uint8Array} */ (O)),
      ),
    );
  } else {
    // DataView
    return TypedArrayPrototypeSlice(
      new Uint8Array(
        DataViewPrototypeGetBuffer(/** @type {DataView} */ (O)),
        DataViewPrototypeGetByteOffset(/** @type {DataView} */ (O)),
        DataViewPrototypeGetByteLength(/** @type {DataView} */ (O)),
      ),
    );
  }
}

const _abortAlgorithm = Symbol("[[abortAlgorithm]]");
const _abortSteps = Symbol("[[AbortSteps]]");
const _autoAllocateChunkSize = Symbol("[[autoAllocateChunkSize]]");
const _backpressure = Symbol("[[backpressure]]");
const _backpressureChangePromise = Symbol("[[backpressureChangePromise]]");
const _byobRequest = Symbol("[[byobRequest]]");
const _cancelAlgorithm = Symbol("[[cancelAlgorithm]]");
const _cancelSteps = Symbol("[[CancelSteps]]");
const _close = Symbol("close sentinel");
const _closeAlgorithm = Symbol("[[closeAlgorithm]]");
const _closedPromise = Symbol("[[closedPromise]]");
const _closeRequest = Symbol("[[closeRequest]]");
const _closeRequested = Symbol("[[closeRequested]]");
const _controller = Symbol("[[controller]]");
const _detached = Symbol("[[Detached]]");
const _disturbed = Symbol("[[disturbed]]");
const _errorSteps = Symbol("[[ErrorSteps]]");
const _flushAlgorithm = Symbol("[[flushAlgorithm]]");
const _globalObject = Symbol("[[globalObject]]");
const _highWaterMark = Symbol("[[highWaterMark]]");
const _inFlightCloseRequest = Symbol("[[inFlightCloseRequest]]");
const _inFlightWriteRequest = Symbol("[[inFlightWriteRequest]]");
const _pendingAbortRequest = Symbol("[pendingAbortRequest]");
const _pendingPullIntos = Symbol("[[pendingPullIntos]]");
const _preventCancel = Symbol("[[preventCancel]]");
const _pullAgain = Symbol("[[pullAgain]]");
const _pullAlgorithm = Symbol("[[pullAlgorithm]]");
const _pulling = Symbol("[[pulling]]");
const _pullSteps = Symbol("[[PullSteps]]");
const _releaseSteps = Symbol("[[ReleaseSteps]]");
const _queue = Symbol("[[queue]]");
const _queueTotalSize = Symbol("[[queueTotalSize]]");
const _readable = Symbol("[[readable]]");
const _reader = Symbol("[[reader]]");
const _readRequests = Symbol("[[readRequests]]");
const _readIntoRequests = Symbol("[[readIntoRequests]]");
const _readyPromise = Symbol("[[readyPromise]]");
const _signal = Symbol("[[signal]]");
const _started = Symbol("[[started]]");
const _state = Symbol("[[state]]");
const _storedError = Symbol("[[storedError]]");
const _strategyHWM = Symbol("[[strategyHWM]]");
const _strategySizeAlgorithm = Symbol("[[strategySizeAlgorithm]]");
const _stream = Symbol("[[stream]]");
const _transformAlgorithm = Symbol("[[transformAlgorithm]]");
const _view = Symbol("[[view]]");
const _writable = Symbol("[[writable]]");
const _writeAlgorithm = Symbol("[[writeAlgorithm]]");
const _writer = Symbol("[[writer]]");
const _writeRequests = Symbol("[[writeRequests]]");

/**
 * @template R
 * @param {ReadableStream<R>} stream
 * @returns {ReadableStreamDefaultReader<R>}
 */
function acquireReadableStreamDefaultReader(stream) {
  return new ReadableStreamDefaultReader(stream);
}

/**
 * @template R
 * @param {ReadableStream<R>} stream
 * @returns {ReadableStreamBYOBReader<R>}
 */
function acquireReadableStreamBYOBReader(stream) {
  const reader = webidl.createBranded(ReadableStreamBYOBReader);
  setUpReadableStreamBYOBReader(reader, stream);
  return reader;
}

/**
 * @template W
 * @param {WritableStream<W>} stream
 * @returns {WritableStreamDefaultWriter<W>}
 */
function acquireWritableStreamDefaultWriter(stream) {
  return new WritableStreamDefaultWriter(stream);
}

/**
 * @template R
 * @param {() => void} startAlgorithm
 * @param {() => Promise<void>} pullAlgorithm
 * @param {(reason: any) => Promise<void>} cancelAlgorithm
 * @param {number=} highWaterMark
 * @param {((chunk: R) => number)=} sizeAlgorithm
 * @returns {ReadableStream<R>}
 */
function createReadableStream(
  startAlgorithm,
  pullAlgorithm,
  cancelAlgorithm,
  highWaterMark = 1,
  sizeAlgorithm = () => 1,
) {
  assert(isNonNegativeNumber(highWaterMark));
  /** @type {ReadableStream} */
  const stream = webidl.createBranded(ReadableStream);
  initializeReadableStream(stream);
  const controller = webidl.createBranded(ReadableStreamDefaultController);
  setUpReadableStreamDefaultController(
    stream,
    controller,
    startAlgorithm,
    pullAlgorithm,
    cancelAlgorithm,
    highWaterMark,
    sizeAlgorithm,
  );
  return stream;
}

/**
 * @template W
 * @param {(controller: WritableStreamDefaultController<W>) => Promise<void>} startAlgorithm
 * @param {(chunk: W) => Promise<void>} writeAlgorithm
 * @param {() => Promise<void>} closeAlgorithm
 * @param {(reason: any) => Promise<void>} abortAlgorithm
 * @param {number} highWaterMark
 * @param {(chunk: W) => number} sizeAlgorithm
 * @returns {WritableStream<W>}
 */
function createWritableStream(
  startAlgorithm,
  writeAlgorithm,
  closeAlgorithm,
  abortAlgorithm,
  highWaterMark,
  sizeAlgorithm,
) {
  assert(isNonNegativeNumber(highWaterMark));
  const stream = webidl.createBranded(WritableStream);
  initializeWritableStream(stream);
  const controller = webidl.createBranded(WritableStreamDefaultController);
  setUpWritableStreamDefaultController(
    stream,
    controller,
    startAlgorithm,
    writeAlgorithm,
    closeAlgorithm,
    abortAlgorithm,
    highWaterMark,
    sizeAlgorithm,
  );
  return stream;
}

/**
 * @template T
 * @param {{ [_queue]: Array<ValueWithSize<T>>, [_queueTotalSize]: number }} container
 * @returns {T}
 */
function dequeueValue(container) {
  assert(
    ReflectHas(container, _queue) &&
      ReflectHas(container, _queueTotalSize),
  );
  assert(container[_queue].length);
  const valueWithSize = ArrayPrototypeShift(container[_queue]);
  container[_queueTotalSize] -= valueWithSize.size;
  if (container[_queueTotalSize] < 0) {
    container[_queueTotalSize] = 0;
  }
  return valueWithSize.value;
}

/**
 * @template T
 * @param {{ [_queue]: Array<ValueWithSize<T | _close>>, [_queueTotalSize]: number }} container
 * @param {T} value
 * @param {number} size
 * @returns {void}
 */
function enqueueValueWithSize(container, value, size) {
  assert(
    ReflectHas(container, _queue) &&
      ReflectHas(container, _queueTotalSize),
  );
  if (isNonNegativeNumber(size) === false) {
    throw RangeError("chunk size isn't a positive number");
  }
  if (size === Infinity) {
    throw RangeError("chunk size is invalid");
  }
  ArrayPrototypePush(container[_queue], { value, size });
  container[_queueTotalSize] += size;
}

/**
 * @param {QueuingStrategy} strategy
 * @param {number} defaultHWM
 */
function extractHighWaterMark(strategy, defaultHWM) {
  if (strategy.highWaterMark === undefined) {
    return defaultHWM;
  }
  const highWaterMark = strategy.highWaterMark;
  if (NumberIsNaN(highWaterMark) || highWaterMark < 0) {
    throw RangeError(
      `Expected highWaterMark to be a positive number or Infinity, got "${highWaterMark}".`,
    );
  }
  return highWaterMark;
}

/**
 * @template T
 * @param {QueuingStrategy<T>} strategy
 * @return {(chunk: T) => number}
 */
function extractSizeAlgorithm(strategy) {
  if (strategy.size === undefined) {
    return () => 1;
  }
  return (chunk) =>
    webidl.invokeCallbackFunction(
      strategy.size,
      [chunk],
      undefined,
      webidl.converters["unrestricted double"],
      "Failed to call `sizeAlgorithm`",
    );
}

/**
 * @param {() => void} startAlgorithm
 * @param {() => Promise<void>} pullAlgorithm
 * @param {(reason: any) => Promise<void>} cancelAlgorithm
 * @returns {ReadableStream}
 */
function createReadableByteStream(
  startAlgorithm,
  pullAlgorithm,
  cancelAlgorithm,
) {
  const stream = webidl.createBranded(ReadableStream);
  initializeReadableStream(stream);
  const controller = webidl.createBranded(ReadableByteStreamController);
  setUpReadableByteStreamController(
    stream,
    controller,
    startAlgorithm,
    pullAlgorithm,
    cancelAlgorithm,
    0,
    undefined,
  );
  return stream;
}

/**
 * @param {ReadableStream} stream
 * @returns {void}
 */
function initializeReadableStream(stream) {
  stream[_state] = "readable";
  stream[_reader] = stream[_storedError] = undefined;
  stream[_disturbed] = false;
}

/**
 * @template I
 * @template O
 * @param {TransformStream<I, O>} stream
 * @param {Deferred<void>} startPromise
 * @param {number} writableHighWaterMark
 * @param {(chunk: I) => number} writableSizeAlgorithm
 * @param {number} readableHighWaterMark
 * @param {(chunk: O) => number} readableSizeAlgorithm
 */
function initializeTransformStream(
  stream,
  startPromise,
  writableHighWaterMark,
  writableSizeAlgorithm,
  readableHighWaterMark,
  readableSizeAlgorithm,
) {
  function startAlgorithm() {
    return startPromise.promise;
  }

  function writeAlgorithm(chunk) {
    return transformStreamDefaultSinkWriteAlgorithm(stream, chunk);
  }

  function abortAlgorithm(reason) {
    return transformStreamDefaultSinkAbortAlgorithm(stream, reason);
  }

  function closeAlgorithm() {
    return transformStreamDefaultSinkCloseAlgorithm(stream);
  }

  stream[_writable] = createWritableStream(
    startAlgorithm,
    writeAlgorithm,
    closeAlgorithm,
    abortAlgorithm,
    writableHighWaterMark,
    writableSizeAlgorithm,
  );

  function pullAlgorithm() {
    return transformStreamDefaultSourcePullAlgorithm(stream);
  }

  function cancelAlgorithm(reason) {
    transformStreamErrorWritableAndUnblockWrite(stream, reason);
    return resolvePromiseWith(undefined);
  }

  stream[_readable] = createReadableStream(
    startAlgorithm,
    pullAlgorithm,
    cancelAlgorithm,
    readableHighWaterMark,
    readableSizeAlgorithm,
  );

  stream[_backpressure] = stream[_backpressureChangePromise] = undefined;
  transformStreamSetBackpressure(stream, true);
  stream[_controller] = undefined;
}

/** @param {WritableStream} stream */
function initializeWritableStream(stream) {
  stream[_state] = "writable";
  stream[_storedError] =
    stream[_writer] =
    stream[_controller] =
    stream[_inFlightWriteRequest] =
    stream[_closeRequest] =
    stream[_inFlightCloseRequest] =
    stream[_pendingAbortRequest] =
      undefined;
  stream[_writeRequests] = [];
  stream[_backpressure] = false;
}

/**
 * @param {unknown} v
 * @returns {v is number}
 */
function isNonNegativeNumber(v) {
  if (typeof v !== "number") {
    return false;
  }
  if (NumberIsNaN(v)) {
    return false;
  }
  if (v < 0) {
    return false;
  }
  return true;
}

/**
 * @param {unknown} value
 * @returns {value is ReadableStream}
 */
function isReadableStream(value) {
  return !(typeof value !== "object" || value === null ||
    !ReflectHas(value, _controller));
}

/**
 * @param {ReadableStream} stream
 * @returns {boolean}
 */
function isReadableStreamLocked(stream) {
  if (stream[_reader] === undefined) {
    return false;
  }
  return true;
}

/**
 * @param {unknown} value
 * @returns {value is ReadableStreamDefaultReader}
 */
function isReadableStreamDefaultReader(value) {
  return !(typeof value !== "object" || value === null ||
    !ReflectHas(value, _readRequests));
}

/**
 * @param {unknown} value
 * @returns {value is ReadableStreamBYOBReader}
 */
function isReadableStreamBYOBReader(value) {
  return !(typeof value !== "object" || value === null ||
    !ReflectHas(value, _readIntoRequests));
}

/**
 * @param {ReadableStream} stream
 * @returns {boolean}
 */
function isReadableStreamDisturbed(stream) {
  assert(isReadableStream(stream));
  return stream[_disturbed];
}

/**
 * @param {Error | string | undefined} error
 * @returns {string}
 */
function extractStringErrorFromError(error) {
  if (typeof error == "string") {
    return error;
  }
  const message = error?.message;
  const stringMessage = (message && (typeof message == "string"))
    ? message
    : String(message);
  return stringMessage;
}

// We don't want to leak resources associated with our sink, even if something bad happens
const READABLE_STREAM_SOURCE_REGISTRY = new SafeFinalizationRegistry(external => {
  op_readable_stream_resource_close(external);
});

class ResourceStreamResourceSink {
  external;
  constructor(external) {
    this.external = external;
    READABLE_STREAM_SOURCE_REGISTRY.register(this, external, this);
  }
  close() {
    if (this.external === undefined) {
      return;
    }
    READABLE_STREAM_SOURCE_REGISTRY.unregister(this);
    op_readable_stream_resource_close(this.external);
    this.external = undefined;
  }
}

/**
 * @param {ReadableStreamDefaultReader<Uint8Array>} reader
 * @param {any} sink
 * @param {Uint8Array} chunk
 */
function readableStreamWriteChunkFn(reader, sink, chunk) {
  // Empty chunk. Re-read.
  if (chunk.length == 0) {
    readableStreamReadFn(reader, sink);
    return;
  }

  const res = op_readable_stream_resource_write_sync(sink.external, chunk);
  if (res == 0) {
    // Closed
    reader.cancel("resource closed");
    sink.close();
  } else if (res == 1) {
    // Successfully written (synchronous). Re-read.
    readableStreamReadFn(reader, sink);
  } else if (res == 2) {
    // Full. If the channel is full, we perform an async await until we can write, and then return
    // to a synchronous loop.
    (async () => {
      if (
        await op_readable_stream_resource_write_buf(
          sink.external,
          chunk,
        )
      ) {
        readableStreamReadFn(reader, sink);
      } else {
        reader.cancel("resource closed");
        sink.close();
      }
    })();
  }
}

/**
 * @param {ReadableStreamDefaultReader<Uint8Array>} reader
 * @param {any} sink
 */
function readableStreamReadFn(reader, sink) {
  // The ops here look like op_write_all/op_close, but we're not actually writing to a
  // real resource.
  let reentrant = true;
  let gotChunk = undefined;
  readableStreamDefaultReaderRead(reader, {
    chunkSteps(chunk) {
      // If the chunk has non-zero length, write it
      if (reentrant) {
        gotChunk = chunk;
      } else {
        readableStreamWriteChunkFn(reader, sink, chunk);
      }
    },
    closeSteps() {
      sink.close();
    },
    errorSteps(error) {
      const success = op_readable_stream_resource_write_error(
        sink.external,
        extractStringErrorFromError(error),
      );
      // We don't cancel the reader if there was an error reading. We'll let the downstream
      // consumer close the resource after it receives the error.
      if (!success) {
        reader.cancel("resource closed");
      }
      sink.close();
    },
  });
  reentrant = false;
  if (gotChunk) {
    readableStreamWriteChunkFn(reader, sink, gotChunk);
  }
}

/**
 * Create a new resource that wraps a ReadableStream. The resource will support
 * read operations, and those read operations will be fed by the output of the
 * ReadableStream source.
 * @param {ReadableStream<Uint8Array>} stream
 * @returns {number}
 */
function resourceForReadableStream(stream) {
  const reader = acquireReadableStreamDefaultReader(stream);

  // Allocate the resource
  const rid = op_readable_stream_resource_allocate();

  // Close the Reader we get from the ReadableStream when the resource is closed, ignoring any errors
  PromisePrototypeCatch(
    PromisePrototypeThen(
      op_readable_stream_resource_await_close(rid),
      () => reader.cancel("resource closed"),
    ),
    () => {},
  );

  // This allocation is freed when readableStreamReadFn is completed
  const sink = new ResourceStreamResourceSink(op_readable_stream_resource_get_sink(rid));

  // Trigger the first read
  readableStreamReadFn(reader, sink);

  return rid;
}

const DEFAULT_CHUNK_SIZE = 64 * 1024; // 64 KiB

// A finalization registry to clean up underlying resources that are GC'ed.
const RESOURCE_REGISTRY = new SafeFinalizationRegistry((rid) => {
  core.tryClose(rid);
});

const _readAll = Symbol("[[readAll]]");
const _original = Symbol("[[original]]");
/**
 * Create a new ReadableStream object that is backed by a Resource that
 * implements `Resource::read_return`. This object contains enough metadata to
 * allow callers to bypass the JavaScript ReadableStream implementation and
 * read directly from the underlying resource if they so choose (FastStream).
 *
 * @param {number} rid The resource ID to read from.
 * @param {boolean=} autoClose If the resource should be auto-closed when the stream closes. Defaults to true.
 * @returns {ReadableStream<Uint8Array>}
 */
function readableStreamForRid(rid, autoClose = true) {
  const stream = webidl.createBranded(ReadableStream);
  stream[_resourceBacking] = { rid, autoClose };

  const tryClose = () => {
    if (!autoClose) return;
    RESOURCE_REGISTRY.unregister(stream);
    core.tryClose(rid);
  };

  if (autoClose) {
    RESOURCE_REGISTRY.register(stream, rid, stream);
  }

  const underlyingSource = {
    type: "bytes",
    async pull(controller) {
      const v = controller.byobRequest.view;
      try {
        if (controller[_readAll] === true) {
          // fast path for tee'd streams consuming body
          const chunk = await core.readAll(rid);
          if (TypedArrayPrototypeGetByteLength(chunk) > 0) {
            controller.enqueue(chunk);
          }
          controller.close();
          tryClose();
          return;
        }

        const bytesRead = await core.read(rid, v);
        if (bytesRead === 0) {
          tryClose();
          controller.close();
          controller.byobRequest.respond(0);
        } else {
          controller.byobRequest.respond(bytesRead);
        }
      } catch (e) {
        controller.error(e);
        tryClose();
      }
    },
    cancel() {
      tryClose();
    },
    autoAllocateChunkSize: DEFAULT_CHUNK_SIZE,
  };
  initializeReadableStream(stream);
  setUpReadableByteStreamControllerFromUnderlyingSource(
    stream,
    underlyingSource,
    underlyingSource,
    0,
  );
  return stream;
}

const promiseIdSymbol = SymbolFor("Deno.core.internalPromiseId");
const _isUnref = Symbol("isUnref");
/**
 * Create a new ReadableStream object that is backed by a Resource that
 * implements `Resource::read_return`. This readable stream supports being
 * refed and unrefed by calling `readableStreamForRidUnrefableRef` and
 * `readableStreamForRidUnrefableUnref` on it. Unrefable streams are not
 * FastStream compatible.
 *
 * @param {number} rid The resource ID to read from.
 * @returns {ReadableStream<Uint8Array>}
 */
function readableStreamForRidUnrefable(rid) {
  const stream = webidl.createBranded(ReadableStream);
  stream[promiseIdSymbol] = undefined;
  stream[_isUnref] = false;
  stream[_resourceBackingUnrefable] = { rid, autoClose: true };
  const underlyingSource = {
    type: "bytes",
    async pull(controller) {
      const v = controller.byobRequest.view;
      try {
        const promise = core.read(rid, v);
        const promiseId = stream[promiseIdSymbol] = promise[promiseIdSymbol];
        if (stream[_isUnref]) core.unrefOp(promiseId);
        const bytesRead = await promise;
        stream[promiseIdSymbol] = undefined;
        if (bytesRead === 0) {
          core.tryClose(rid);
          controller.close();
          controller.byobRequest.respond(0);
        } else {
          controller.byobRequest.respond(bytesRead);
        }
      } catch (e) {
        controller.error(e);
        core.tryClose(rid);
      }
    },
    cancel() {
      core.tryClose(rid);
    },
    autoAllocateChunkSize: DEFAULT_CHUNK_SIZE,
  };
  initializeReadableStream(stream);
  setUpReadableByteStreamControllerFromUnderlyingSource(
    stream,
    underlyingSource,
    underlyingSource,
    0,
  );
  return stream;
}

function readableStreamIsUnrefable(stream) {
  return ReflectHas(stream, _isUnref);
}

function readableStreamForRidUnrefableRef(stream) {
  if (!readableStreamIsUnrefable(stream)) {
    throw new TypeError("Not an unrefable stream");
  }
  stream[_isUnref] = false;
  if (stream[promiseIdSymbol] !== undefined) {
    core.refOp(stream[promiseIdSymbol]);
  }
}

function readableStreamForRidUnrefableUnref(stream) {
  if (!readableStreamIsUnrefable(stream)) {
    throw new TypeError("Not an unrefable stream");
  }
  stream[_isUnref] = true;
  if (stream[promiseIdSymbol] !== undefined) {
    core.unrefOp(stream[promiseIdSymbol]);
  }
}

function getReadableStreamResourceBacking(stream) {
  return stream[_resourceBacking];
}

function getReadableStreamResourceBackingUnrefable(stream) {
  return stream[_resourceBackingUnrefable];
}

async function readableStreamCollectIntoUint8Array(stream) {
  const resourceBacking = getReadableStreamResourceBacking(stream) ||
    getReadableStreamResourceBackingUnrefable(stream);
  const reader = acquireReadableStreamDefaultReader(stream);

  if (resourceBacking) {
    // fast path, read whole body in a single op call
    try {
      readableStreamDisturb(stream);
      const promise = core.opAsync("op_read_all", resourceBacking.rid);
      if (readableStreamIsUnrefable(stream)) {
        const promiseId = stream[promiseIdSymbol] = promise[promiseIdSymbol];
        if (stream[_isUnref]) core.unrefOp(promiseId);
      }
      const buf = await promise;
      readableStreamThrowIfErrored(stream);
      readableStreamClose(stream);
      return buf;
    } catch (err) {
      readableStreamThrowIfErrored(stream);
      readableStreamError(stream, err);
      throw err;
    } finally {
      if (resourceBacking.autoClose) {
        core.tryClose(resourceBacking.rid);
      }
    }
  }

  // slow path
  /** @type {Uint8Array[]} */
  const chunks = [];
  let totalLength = 0;

  // tee'd stream
  if (stream[_original]) {
    // One of the branches is consuming the stream
    // signal controller.pull that we can consume it in a single op
    stream[_original][_controller][_readAll] = true;
  }

  while (true) {
    const { value: chunk, done } = await reader.read();

    if (done) break;

    if (TypedArrayPrototypeGetSymbolToStringTag(chunk) !== "Uint8Array") {
      throw new TypeError(
        "Can't convert value to Uint8Array while consuming the stream",
      );
    }

    ArrayPrototypePush(chunks, chunk);
    totalLength += TypedArrayPrototypeGetByteLength(chunk);
  }

  const finalBuffer = new Uint8Array(totalLength);
  let offset = 0;
  for (let i = 0; i < chunks.length; ++i) {
    const chunk = chunks[i];
    TypedArrayPrototypeSet(finalBuffer, chunk, offset);
    offset += TypedArrayPrototypeGetByteLength(chunk);
  }
  return finalBuffer;
}

/**
 * Create a new Writable object that is backed by a Resource that implements
 * `Resource::write` / `Resource::write_all`. This object contains enough
 * metadata to allow callers to bypass the JavaScript WritableStream
 * implementation and write directly to the underlying resource if they so
 * choose (FastStream).
 *
 * @param {number} rid The resource ID to write to.
 * @param {boolean=} autoClose If the resource should be auto-closed when the stream closes. Defaults to true.
 * @returns {ReadableStream<Uint8Array>}
 */
function writableStreamForRid(rid, autoClose = true) {
  const stream = webidl.createBranded(WritableStream);
  stream[_resourceBacking] = { rid, autoClose };

  const tryClose = () => {
    if (!autoClose) return;
    RESOURCE_REGISTRY.unregister(stream);
    core.tryClose(rid);
  };

  if (autoClose) {
    RESOURCE_REGISTRY.register(stream, rid, stream);
  }

  const underlyingSink = {
    async write(chunk, controller) {
      try {
        await core.writeAll(rid, chunk);
      } catch (e) {
        controller.error(e);
        tryClose();
      }
    },
    close() {
      tryClose();
    },
    abort() {
      tryClose();
    },
  };
  initializeWritableStream(stream);
  setUpWritableStreamDefaultControllerFromUnderlyingSink(
    stream,
    underlyingSink,
    underlyingSink,
    1,
    () => 1,
  );
  return stream;
}

function getWritableStreamResourceBacking(stream) {
  return stream[_resourceBacking];
}

/*
 * @param {ReadableStream} stream
 */
function readableStreamThrowIfErrored(stream) {
  if (stream[_state] === "errored") {
    throw stream[_storedError];
  }
}

/**
 * @param {unknown} value
 * @returns {value is WritableStream}
 */
function isWritableStream(value) {
  return !(typeof value !== "object" || value === null ||
    !ReflectHas(value, _controller));
}

/**
 * @param {WritableStream} stream
 * @returns {boolean}
 */
function isWritableStreamLocked(stream) {
  if (stream[_writer] === undefined) {
    return false;
  }
  return true;
}
/**
 * @template T
 * @param {{ [_queue]: Array<ValueWithSize<T | _close>>, [_queueTotalSize]: number }} container
 * @returns {T | _close}
 */
function peekQueueValue(container) {
  assert(
    ReflectHas(container, _queue) &&
      ReflectHas(container, _queueTotalSize),
  );
  assert(container[_queue].length);
  const valueWithSize = container[_queue][0];
  return valueWithSize.value;
}

/**
 * @param {ReadableByteStreamController} controller
 * @returns {void}
 */
function readableByteStreamControllerCallPullIfNeeded(controller) {
  const shouldPull = readableByteStreamControllerShouldCallPull(controller);
  if (!shouldPull) {
    return;
  }
  if (controller[_pulling]) {
    controller[_pullAgain] = true;
    return;
  }
  assert(controller[_pullAgain] === false);
  controller[_pulling] = true;
  /** @type {Promise<void>} */
  const pullPromise = controller[_pullAlgorithm](controller);
  setPromiseIsHandledToTrue(
    PromisePrototypeThen(
      pullPromise,
      () => {
        controller[_pulling] = false;
        if (controller[_pullAgain]) {
          controller[_pullAgain] = false;
          readableByteStreamControllerCallPullIfNeeded(controller);
        }
      },
      (e) => {
        readableByteStreamControllerError(controller, e);
      },
    ),
  );
}

/**
 * @param {ReadableByteStreamController} controller
 * @returns {void}
 */
function readableByteStreamControllerClearAlgorithms(controller) {
  controller[_pullAlgorithm] = undefined;
  controller[_cancelAlgorithm] = undefined;
}

/**
 * @param {ReadableByteStreamController} controller
 * @param {any} e
 */
function readableByteStreamControllerError(controller, e) {
  /** @type {ReadableStream<ArrayBuffer>} */
  const stream = controller[_stream];
  if (stream[_state] !== "readable") {
    return;
  }
  readableByteStreamControllerClearPendingPullIntos(controller);
  resetQueue(controller);
  readableByteStreamControllerClearAlgorithms(controller);
  readableStreamError(stream, e);
}

/**
 * @param {ReadableByteStreamController} controller
 * @returns {void}
 */
function readableByteStreamControllerClearPendingPullIntos(controller) {
  readableByteStreamControllerInvalidateBYOBRequest(controller);
  controller[_pendingPullIntos] = [];
}

/**
 * @param {ReadableByteStreamController} controller
 * @returns {void}
 */
function readableByteStreamControllerClose(controller) {
  /** @type {ReadableStream<ArrayBuffer>} */
  const stream = controller[_stream];
  if (controller[_closeRequested] || stream[_state] !== "readable") {
    return;
  }
  if (controller[_queueTotalSize] > 0) {
    controller[_closeRequested] = true;
    return;
  }
  if (controller[_pendingPullIntos].length !== 0) {
    const firstPendingPullInto = controller[_pendingPullIntos][0];
    if (firstPendingPullInto.bytesFilled > 0) {
      const e = new TypeError(
        "Insufficient bytes to fill elements in the given buffer",
      );
      readableByteStreamControllerError(controller, e);
      throw e;
    }
  }
  readableByteStreamControllerClearAlgorithms(controller);
  readableStreamClose(stream);
}

/**
 * @param {ReadableByteStreamController} controller
 * @param {ArrayBufferView} chunk
 */
function readableByteStreamControllerEnqueue(controller, chunk) {
  /** @type {ReadableStream<ArrayBuffer>} */
  const stream = controller[_stream];
  if (
    controller[_closeRequested] ||
    controller[_stream][_state] !== "readable"
  ) {
    return;
  }

  let buffer, byteLength, byteOffset;
  if (TypedArrayPrototypeGetSymbolToStringTag(chunk) === undefined) {
    buffer = DataViewPrototypeGetBuffer(/** @type {DataView} */ (chunk));
    byteLength = DataViewPrototypeGetByteLength(
      /** @type {DataView} */ (chunk),
    );
    byteOffset = DataViewPrototypeGetByteOffset(
      /** @type {DataView} */ (chunk),
    );
  } else {
    buffer = TypedArrayPrototypeGetBuffer(/** @type {Uint8Array}} */ (chunk));
    byteLength = TypedArrayPrototypeGetByteLength(
      /** @type {Uint8Array} */ (chunk),
    );
    byteOffset = TypedArrayPrototypeGetByteOffset(
      /** @type {Uint8Array} */ (chunk),
    );
  }

  if (isDetachedBuffer(buffer)) {
    throw new TypeError(
      "chunk's buffer is detached and so cannot be enqueued",
    );
  }
  const transferredBuffer = transferArrayBuffer(buffer);
  if (controller[_pendingPullIntos].length !== 0) {
    const firstPendingPullInto = controller[_pendingPullIntos][0];
    // deno-lint-ignore prefer-primordials
    if (isDetachedBuffer(firstPendingPullInto.buffer)) {
      throw new TypeError(
        "The BYOB request's buffer has been detached and so cannot be filled with an enqueued chunk",
      );
    }
    readableByteStreamControllerInvalidateBYOBRequest(controller);
    firstPendingPullInto.buffer = transferArrayBuffer(
      // deno-lint-ignore prefer-primordials
      firstPendingPullInto.buffer,
    );
    if (firstPendingPullInto.readerType === "none") {
      readableByteStreamControllerEnqueueDetachedPullIntoToQueue(
        controller,
        firstPendingPullInto,
      );
    }
  }
  if (readableStreamHasDefaultReader(stream)) {
    readableByteStreamControllerProcessReadRequestsUsingQueue(controller);
    if (readableStreamGetNumReadRequests(stream) === 0) {
      assert(controller[_pendingPullIntos].length === 0);
      readableByteStreamControllerEnqueueChunkToQueue(
        controller,
        transferredBuffer,
        byteOffset,
        byteLength,
      );
    } else {
      assert(controller[_queue].length === 0);
      if (controller[_pendingPullIntos].length !== 0) {
        assert(controller[_pendingPullIntos][0].readerType === "default");
        readableByteStreamControllerShiftPendingPullInto(controller);
      }
      const transferredView = new Uint8Array(
        transferredBuffer,
        byteOffset,
        byteLength,
      );
      readableStreamFulfillReadRequest(stream, transferredView, false);
    }
  } else if (readableStreamHasBYOBReader(stream)) {
    readableByteStreamControllerEnqueueChunkToQueue(
      controller,
      transferredBuffer,
      byteOffset,
      byteLength,
    );
    readableByteStreamControllerProcessPullIntoDescriptorsUsingQueue(
      controller,
    );
  } else {
    assert(isReadableStreamLocked(stream) === false);
    readableByteStreamControllerEnqueueChunkToQueue(
      controller,
      transferredBuffer,
      byteOffset,
      byteLength,
    );
  }
  readableByteStreamControllerCallPullIfNeeded(controller);
}

/**
 * @param {ReadableByteStreamController} controller
 * @param {ArrayBufferLike} buffer
 * @param {number} byteOffset
 * @param {number} byteLength
 * @returns {void}
 */
function readableByteStreamControllerEnqueueChunkToQueue(
  controller,
  buffer,
  byteOffset,
  byteLength,
) {
  ArrayPrototypePush(controller[_queue], { buffer, byteOffset, byteLength });
  controller[_queueTotalSize] += byteLength;
}

/**
 * @param {ReadableByteStreamController} controller
 * @param {ArrayBufferLike} buffer
 * @param {number} byteOffset
 * @param {number} byteLength
 * @returns {void}
 */
function readableByteStreamControllerEnqueueClonedChunkToQueue(
  controller,
  buffer,
  byteOffset,
  byteLength,
) {
  let cloneResult;
  try {
    if (ObjectPrototypeIsPrototypeOf(ArrayBufferPrototype, buffer)) {
      cloneResult = ArrayBufferPrototypeSlice(
        buffer,
        byteOffset,
        byteOffset + byteLength,
      );
    } else {
      // TODO(lucacasonato): add SharedArrayBuffer to primordials
      // deno-lint-ignore prefer-primordials
      cloneResult = buffer.slice(byteOffset, byteOffset + byteLength);
    }
  } catch (e) {
    readableByteStreamControllerError(controller, e);
  }
  readableByteStreamControllerEnqueueChunkToQueue(
    controller,
    cloneResult,
    0,
    byteLength,
  );
}

/**
 * @param {ReadableByteStreamController} controller
 * @param {PullIntoDescriptor} pullIntoDescriptor
 * @returns {void}
 */
function readableByteStreamControllerEnqueueDetachedPullIntoToQueue(
  controller,
  pullIntoDescriptor,
) {
  assert(pullIntoDescriptor.readerType === "none");
  if (pullIntoDescriptor.bytesFilled > 0) {
    readableByteStreamControllerEnqueueClonedChunkToQueue(
      controller,
      // deno-lint-ignore prefer-primordials
      pullIntoDescriptor.buffer,
      // deno-lint-ignore prefer-primordials
      pullIntoDescriptor.byteOffset,
      pullIntoDescriptor.bytesFilled,
    );
  }
  readableByteStreamControllerShiftPendingPullInto(controller);
}

/**
 * @param {ReadableByteStreamController} controller
 * @returns {ReadableStreamBYOBRequest | null}
 */
function readableByteStreamControllerGetBYOBRequest(controller) {
  if (
    controller[_byobRequest] === null &&
    controller[_pendingPullIntos].length !== 0
  ) {
    const firstDescriptor = controller[_pendingPullIntos][0];
    const view = new Uint8Array(
      // deno-lint-ignore prefer-primordials
      firstDescriptor.buffer,
      // deno-lint-ignore prefer-primordials
      firstDescriptor.byteOffset + firstDescriptor.bytesFilled,
      // deno-lint-ignore prefer-primordials
      firstDescriptor.byteLength - firstDescriptor.bytesFilled,
    );
    const byobRequest = webidl.createBranded(ReadableStreamBYOBRequest);
    byobRequest[_controller] = controller;
    byobRequest[_view] = view;
    controller[_byobRequest] = byobRequest;
  }
  return controller[_byobRequest];
}

/**
 * @param {ReadableByteStreamController} controller
 * @returns {number | null}
 */
function readableByteStreamControllerGetDesiredSize(controller) {
  const state = controller[_stream][_state];
  if (state === "errored") {
    return null;
  }
  if (state === "closed") {
    return 0;
  }
  return controller[_strategyHWM] - controller[_queueTotalSize];
}

/**
 * @param {{ [_queue]: any[], [_queueTotalSize]: number }} container
 * @returns {void}
 */
function resetQueue(container) {
  container[_queue] = [];
  container[_queueTotalSize] = 0;
}

/**
 * @param {ReadableByteStreamController} controller
 * @returns {void}
 */
function readableByteStreamControllerHandleQueueDrain(controller) {
  assert(controller[_stream][_state] === "readable");
  if (
    controller[_queueTotalSize] === 0 && controller[_closeRequested]
  ) {
    readableByteStreamControllerClearAlgorithms(controller);
    readableStreamClose(controller[_stream]);
  } else {
    readableByteStreamControllerCallPullIfNeeded(controller);
  }
}

/**
 * @param {ReadableByteStreamController} controller
 * @returns {boolean}
 */
function readableByteStreamControllerShouldCallPull(controller) {
  /** @type {ReadableStream<ArrayBuffer>} */
  const stream = controller[_stream];
  if (
    stream[_state] !== "readable" ||
    controller[_closeRequested] ||
    !controller[_started]
  ) {
    return false;
  }
  if (
    readableStreamHasDefaultReader(stream) &&
    readableStreamGetNumReadRequests(stream) > 0
  ) {
    return true;
  }
  if (
    readableStreamHasBYOBReader(stream) &&
    readableStreamGetNumReadIntoRequests(stream) > 0
  ) {
    return true;
  }
  const desiredSize = readableByteStreamControllerGetDesiredSize(controller);
  assert(desiredSize !== null);
  return desiredSize > 0;
}

/**
 * @template R
 * @param {ReadableStream<R>} stream
 * @param {ReadRequest<R>} readRequest
 * @returns {void}
 */
function readableStreamAddReadRequest(stream, readRequest) {
  assert(isReadableStreamDefaultReader(stream[_reader]));
  assert(stream[_state] === "readable");
  ArrayPrototypePush(stream[_reader][_readRequests], readRequest);
}

/**
 * @param {ReadableStream} stream
 * @param {ReadIntoRequest} readRequest
 * @returns {void}
 */
function readableStreamAddReadIntoRequest(stream, readRequest) {
  assert(isReadableStreamBYOBReader(stream[_reader]));
  assert(stream[_state] === "readable" || stream[_state] === "closed");
  ArrayPrototypePush(stream[_reader][_readIntoRequests], readRequest);
}

/**
 * @template R
 * @param {ReadableStream<R>} stream
 * @param {any=} reason
 * @returns {Promise<void>}
 */
function readableStreamCancel(stream, reason) {
  stream[_disturbed] = true;
  if (stream[_state] === "closed") {
    return resolvePromiseWith(undefined);
  }
  if (stream[_state] === "errored") {
    return PromiseReject(stream[_storedError]);
  }
  readableStreamClose(stream);
  const reader = stream[_reader];
  if (reader !== undefined && isReadableStreamBYOBReader(reader)) {
    const readIntoRequests = reader[_readIntoRequests];
    reader[_readIntoRequests] = [];
    for (let i = 0; i < readIntoRequests.length; ++i) {
      const readIntoRequest = readIntoRequests[i];
      readIntoRequest.closeSteps(undefined);
    }
  }
  /** @type {Promise<void>} */
  const sourceCancelPromise = stream[_controller][_cancelSteps](reason);
  return PromisePrototypeThen(sourceCancelPromise, () => undefined);
}

/**
 * @template R
 * @param {ReadableStream<R>} stream
 * @returns {void}
 */
function readableStreamClose(stream) {
  assert(stream[_state] === "readable");
  stream[_state] = "closed";
  /** @type {ReadableStreamDefaultReader<R> | undefined} */
  const reader = stream[_reader];
  if (!reader) {
    return;
  }
  if (isReadableStreamDefaultReader(reader)) {
    /** @type {Array<ReadRequest<R>>} */
    const readRequests = reader[_readRequests];
    reader[_readRequests] = [];
    for (let i = 0; i < readRequests.length; ++i) {
      const readRequest = readRequests[i];
      readRequest.closeSteps();
    }
  }
  // This promise can be double resolved.
  // See: https://github.com/whatwg/streams/issues/1100
  reader[_closedPromise].resolve(undefined);
}

/**
 * @template R
 * @param {ReadableStream<R>} stream
 * @returns {void}
 */
function readableStreamDisturb(stream) {
  stream[_disturbed] = true;
}

/** @param {ReadableStreamDefaultController<any>} controller */
function readableStreamDefaultControllerCallPullIfNeeded(controller) {
  const shouldPull = readableStreamDefaultcontrollerShouldCallPull(
    controller,
  );
  if (shouldPull === false) {
    return;
  }
  if (controller[_pulling] === true) {
    controller[_pullAgain] = true;
    return;
  }
  assert(controller[_pullAgain] === false);
  controller[_pulling] = true;
  const pullPromise = controller[_pullAlgorithm](controller);
  uponFulfillment(pullPromise, () => {
    controller[_pulling] = false;
    if (controller[_pullAgain] === true) {
      controller[_pullAgain] = false;
      readableStreamDefaultControllerCallPullIfNeeded(controller);
    }
  });
  uponRejection(pullPromise, (e) => {
    readableStreamDefaultControllerError(controller, e);
  });
}

/**
 * @param {ReadableStreamDefaultController<any>} controller
 * @returns {boolean}
 */
function readableStreamDefaultControllerCanCloseOrEnqueue(controller) {
  const state = controller[_stream][_state];
  if (controller[_closeRequested] === false && state === "readable") {
    return true;
  } else {
    return false;
  }
}

/** @param {ReadableStreamDefaultController<any>} controller */
function readableStreamDefaultControllerClearAlgorithms(controller) {
  controller[_pullAlgorithm] = undefined;
  controller[_cancelAlgorithm] = undefined;
  controller[_strategySizeAlgorithm] = undefined;
}

/** @param {ReadableStreamDefaultController<any>} controller */
function readableStreamDefaultControllerClose(controller) {
  if (
    readableStreamDefaultControllerCanCloseOrEnqueue(controller) === false
  ) {
    return;
  }
  const stream = controller[_stream];
  controller[_closeRequested] = true;
  if (controller[_queue].length === 0) {
    readableStreamDefaultControllerClearAlgorithms(controller);
    readableStreamClose(stream);
  }
}

/**
 * @template R
 * @param {ReadableStreamDefaultController<R>} controller
 * @param {R} chunk
 * @returns {void}
 */
function readableStreamDefaultControllerEnqueue(controller, chunk) {
  if (
    readableStreamDefaultControllerCanCloseOrEnqueue(controller) === false
  ) {
    return;
  }
  const stream = controller[_stream];
  if (
    isReadableStreamLocked(stream) === true &&
    readableStreamGetNumReadRequests(stream) > 0
  ) {
    readableStreamFulfillReadRequest(stream, chunk, false);
  } else {
    let chunkSize;
    try {
      chunkSize = controller[_strategySizeAlgorithm](chunk);
    } catch (e) {
      readableStreamDefaultControllerError(controller, e);
      throw e;
    }

    try {
      enqueueValueWithSize(controller, chunk, chunkSize);
    } catch (e) {
      readableStreamDefaultControllerError(controller, e);
      throw e;
    }
  }
  readableStreamDefaultControllerCallPullIfNeeded(controller);
}

/**
 * @param {ReadableStreamDefaultController<any>} controller
 * @param {any} e
 */
function readableStreamDefaultControllerError(controller, e) {
  const stream = controller[_stream];
  if (stream[_state] !== "readable") {
    return;
  }
  resetQueue(controller);
  readableStreamDefaultControllerClearAlgorithms(controller);
  readableStreamError(stream, e);
}

/**
 * @param {ReadableStreamDefaultController<any>} controller
 * @returns {number | null}
 */
function readableStreamDefaultControllerGetDesiredSize(controller) {
  const state = controller[_stream][_state];
  if (state === "errored") {
    return null;
  }
  if (state === "closed") {
    return 0;
  }
  return controller[_strategyHWM] - controller[_queueTotalSize];
}

/** @param {ReadableStreamDefaultController} controller */
function readableStreamDefaultcontrollerHasBackpressure(controller) {
  if (readableStreamDefaultcontrollerShouldCallPull(controller) === true) {
    return false;
  } else {
    return true;
  }
}

/**
 * @param {ReadableStreamDefaultController<any>} controller
 * @returns {boolean}
 */
function readableStreamDefaultcontrollerShouldCallPull(controller) {
  const stream = controller[_stream];
  if (
    readableStreamDefaultControllerCanCloseOrEnqueue(controller) === false
  ) {
    return false;
  }
  if (controller[_started] === false) {
    return false;
  }
  if (
    isReadableStreamLocked(stream) &&
    readableStreamGetNumReadRequests(stream) > 0
  ) {
    return true;
  }
  const desiredSize = readableStreamDefaultControllerGetDesiredSize(
    controller,
  );
  assert(desiredSize !== null);
  if (desiredSize > 0) {
    return true;
  }
  return false;
}

/**
 * @param {ReadableStreamBYOBReader} reader
 * @param {ArrayBufferView} view
 * @param {ReadIntoRequest} readIntoRequest
 * @returns {void}
 */
function readableStreamBYOBReaderRead(reader, view, readIntoRequest) {
  const stream = reader[_stream];
  assert(stream);
  stream[_disturbed] = true;
  if (stream[_state] === "errored") {
    readIntoRequest.errorSteps(stream[_storedError]);
  } else {
    readableByteStreamControllerPullInto(
      stream[_controller],
      view,
      readIntoRequest,
    );
  }
}

/**
 * @param {ReadableStreamBYOBReader} reader
 */
function readableStreamBYOBReaderRelease(reader) {
  readableStreamReaderGenericRelease(reader);
  const e = new TypeError("The reader was released.");
  readableStreamBYOBReaderErrorReadIntoRequests(reader, e);
}

/**
 * @param {ReadableStreamBYOBReader} reader
 * @param {any} e
 */
function readableStreamDefaultReaderErrorReadRequests(reader, e) {
  const readRequests = reader[_readRequests];
  reader[_readRequests] = [];
  for (let i = 0; i < readRequests.length; ++i) {
    const readRequest = readRequests[i];
    readRequest.errorSteps(e);
  }
}

/**
 * @param {ReadableByteStreamController} controller
 */
function readableByteStreamControllerProcessPullIntoDescriptorsUsingQueue(
  controller,
) {
  assert(!controller[_closeRequested]);
  while (controller[_pendingPullIntos].length !== 0) {
    if (controller[_queueTotalSize] === 0) {
      return;
    }
    const pullIntoDescriptor = controller[_pendingPullIntos][0];
    if (
      readableByteStreamControllerFillPullIntoDescriptorFromQueue(
        controller,
        pullIntoDescriptor,
      )
    ) {
      readableByteStreamControllerShiftPendingPullInto(controller);
      readableByteStreamControllerCommitPullIntoDescriptor(
        controller[_stream],
        pullIntoDescriptor,
      );
    }
  }
}
/**
 * @param {ReadableByteStreamController} controller
 */
function readableByteStreamControllerProcessReadRequestsUsingQueue(
  controller,
) {
  const reader = controller[_stream][_reader];
  assert(isReadableStreamDefaultReader(reader));
  while (reader[_readRequests].length !== 0) {
    if (controller[_queueTotalSize] === 0) {
      return;
    }
    const readRequest = ArrayPrototypeShift(reader[_readRequests]);
    readableByteStreamControllerFillReadRequestFromQueue(
      controller,
      readRequest,
    );
  }
}

/**
 * @param {ReadableByteStreamController} controller
 * @param {ArrayBufferView} view
 * @param {ReadIntoRequest} readIntoRequest
 * @returns {void}
 */
function readableByteStreamControllerPullInto(
  controller,
  view,
  readIntoRequest,
) {
  const stream = controller[_stream];

  let ctor;
  /** @type {number} */
  let elementSize;
  /** @type {ArrayBufferLike} */
  let buffer;
  /** @type {number} */
  let byteLength;
  /** @type {number} */
  let byteOffset;

  const tag = TypedArrayPrototypeGetSymbolToStringTag(view);
  if (tag === undefined) {
    ctor = DataView;
    elementSize = 1;
    buffer = DataViewPrototypeGetBuffer(/** @type {DataView} */ (view));
    byteLength = DataViewPrototypeGetByteLength(/** @type {DataView} */ (view));
    byteOffset = DataViewPrototypeGetByteOffset(/** @type {DataView} */ (view));
  } else {
    switch (tag) {
      case "Int8Array":
        ctor = Int8Array;
        break;
      case "Uint8Array":
        ctor = Uint8Array;
        break;
      case "Uint8ClampedArray":
        ctor = Uint8ClampedArray;
        break;
      case "Int16Array":
        ctor = Int16Array;
        break;
      case "Uint16Array":
        ctor = Uint16Array;
        break;
      case "Int32Array":
        ctor = Int32Array;
        break;
      case "Uint32Array":
        ctor = Uint32Array;
        break;
      case "Float32Array":
        ctor = Float32Array;
        break;
      case "Float64Array":
        ctor = Float64Array;
        break;
      case "BigInt64Array":
        ctor = BigInt64Array;
        break;
      case "BigUint64Array":
        ctor = BigUint64Array;
        break;
      default:
        throw new TypeError("unreachable");
    }
    elementSize = ctor.BYTES_PER_ELEMENT;
    buffer = TypedArrayPrototypeGetBuffer(/** @type {Uint8Array} */ (view));
    byteLength = TypedArrayPrototypeGetByteLength(
      /** @type {Uint8Array} */ (view),
    );
    byteOffset = TypedArrayPrototypeGetByteOffset(
      /** @type {Uint8Array} */ (view),
    );
  }

  try {
    buffer = transferArrayBuffer(buffer);
  } catch (e) {
    readIntoRequest.errorSteps(e);
    return;
  }

  /** @type {PullIntoDescriptor} */
  const pullIntoDescriptor = {
    buffer,
    bufferByteLength: getArrayBufferByteLength(buffer),
    byteOffset,
    byteLength,
    bytesFilled: 0,
    elementSize,
    viewConstructor: ctor,
    readerType: "byob",
  };

  if (controller[_pendingPullIntos].length !== 0) {
    ArrayPrototypePush(controller[_pendingPullIntos], pullIntoDescriptor);
    readableStreamAddReadIntoRequest(stream, readIntoRequest);
    return;
  }
  if (stream[_state] === "closed") {
    const emptyView = new ctor(
      // deno-lint-ignore prefer-primordials
      pullIntoDescriptor.buffer,
      // deno-lint-ignore prefer-primordials
      pullIntoDescriptor.byteOffset,
      0,
    );
    readIntoRequest.closeSteps(emptyView);
    return;
  }
  if (controller[_queueTotalSize] > 0) {
    if (
      readableByteStreamControllerFillPullIntoDescriptorFromQueue(
        controller,
        pullIntoDescriptor,
      )
    ) {
      const filledView = readableByteStreamControllerConvertPullIntoDescriptor(
        pullIntoDescriptor,
      );
      readableByteStreamControllerHandleQueueDrain(controller);
      readIntoRequest.chunkSteps(filledView);
      return;
    }
    if (controller[_closeRequested]) {
      const e = new TypeError(
        "Insufficient bytes to fill elements in the given buffer",
      );
      readableByteStreamControllerError(controller, e);
      readIntoRequest.errorSteps(e);
      return;
    }
  }
  ArrayPrototypePush(controller[_pendingPullIntos], pullIntoDescriptor);
  readableStreamAddReadIntoRequest(stream, readIntoRequest);
  readableByteStreamControllerCallPullIfNeeded(controller);
}

/**
 * @param {ReadableByteStreamController} controller
 * @param {number} bytesWritten
 * @returns {void}
 */
function readableByteStreamControllerRespond(controller, bytesWritten) {
  assert(controller[_pendingPullIntos].length !== 0);
  const firstDescriptor = controller[_pendingPullIntos][0];
  const state = controller[_stream][_state];
  if (state === "closed") {
    if (bytesWritten !== 0) {
      throw new TypeError(
        "bytesWritten must be 0 when calling respond() on a closed stream",
      );
    }
  } else {
    assert(state === "readable");
    if (bytesWritten === 0) {
      throw new TypeError(
        "bytesWritten must be greater than 0 when calling respond() on a readable stream",
      );
    }
    if (
      (firstDescriptor.bytesFilled + bytesWritten) >
        // deno-lint-ignore prefer-primordials
        firstDescriptor.byteLength
    ) {
      throw new RangeError("bytesWritten out of range");
    }
  }
  // deno-lint-ignore prefer-primordials
  firstDescriptor.buffer = transferArrayBuffer(firstDescriptor.buffer);
  readableByteStreamControllerRespondInternal(controller, bytesWritten);
}

/**
 * @param {ReadableByteStreamController} controller
 * @param {number} bytesWritten
 * @param {PullIntoDescriptor} pullIntoDescriptor
 * @returns {void}
 */
function readableByteStreamControllerRespondInReadableState(
  controller,
  bytesWritten,
  pullIntoDescriptor,
) {
  assert(
    (pullIntoDescriptor.bytesFilled + bytesWritten) <=
      // deno-lint-ignore prefer-primordials
      pullIntoDescriptor.byteLength,
  );
  readableByteStreamControllerFillHeadPullIntoDescriptor(
    controller,
    bytesWritten,
    pullIntoDescriptor,
  );
  if (pullIntoDescriptor.readerType === "none") {
    readableByteStreamControllerEnqueueDetachedPullIntoToQueue(
      controller,
      pullIntoDescriptor,
    );
    readableByteStreamControllerProcessPullIntoDescriptorsUsingQueue(
      controller,
    );
    return;
  }
  if (pullIntoDescriptor.bytesFilled < pullIntoDescriptor.elementSize) {
    return;
  }
  readableByteStreamControllerShiftPendingPullInto(controller);
  const remainderSize = pullIntoDescriptor.bytesFilled %
    pullIntoDescriptor.elementSize;
  if (remainderSize > 0) {
    // deno-lint-ignore prefer-primordials
    const end = pullIntoDescriptor.byteOffset +
      pullIntoDescriptor.bytesFilled;
    readableByteStreamControllerEnqueueClonedChunkToQueue(
      controller,
      // deno-lint-ignore prefer-primordials
      pullIntoDescriptor.buffer,
      end - remainderSize,
      remainderSize,
    );
  }
  pullIntoDescriptor.bytesFilled -= remainderSize;
  readableByteStreamControllerCommitPullIntoDescriptor(
    controller[_stream],
    pullIntoDescriptor,
  );
  readableByteStreamControllerProcessPullIntoDescriptorsUsingQueue(
    controller,
  );
}

/**
 * @param {ReadableByteStreamController} controller
 * @param {number} bytesWritten
 * @returns {void}
 */
function readableByteStreamControllerRespondInternal(
  controller,
  bytesWritten,
) {
  const firstDescriptor = controller[_pendingPullIntos][0];
  // deno-lint-ignore prefer-primordials
  assert(canTransferArrayBuffer(firstDescriptor.buffer));
  readableByteStreamControllerInvalidateBYOBRequest(controller);
  const state = controller[_stream][_state];
  if (state === "closed") {
    assert(bytesWritten === 0);
    readableByteStreamControllerRespondInClosedState(
      controller,
      firstDescriptor,
    );
  } else {
    assert(state === "readable");
    assert(bytesWritten > 0);
    readableByteStreamControllerRespondInReadableState(
      controller,
      bytesWritten,
      firstDescriptor,
    );
  }
  readableByteStreamControllerCallPullIfNeeded(controller);
}

/**
 * @param {ReadableByteStreamController} controller
 */
function readableByteStreamControllerInvalidateBYOBRequest(controller) {
  if (controller[_byobRequest] === null) {
    return;
  }
  controller[_byobRequest][_controller] = undefined;
  controller[_byobRequest][_view] = null;
  controller[_byobRequest] = null;
}

/**
 * @param {ReadableByteStreamController} controller
 * @param {PullIntoDescriptor} firstDescriptor
 */
function readableByteStreamControllerRespondInClosedState(
  controller,
  firstDescriptor,
) {
  assert(firstDescriptor.bytesFilled === 0);
  if (firstDescriptor.readerType === "none") {
    readableByteStreamControllerShiftPendingPullInto(controller);
  }
  const stream = controller[_stream];
  if (readableStreamHasBYOBReader(stream)) {
    while (readableStreamGetNumReadIntoRequests(stream) > 0) {
      const pullIntoDescriptor =
        readableByteStreamControllerShiftPendingPullInto(controller);
      readableByteStreamControllerCommitPullIntoDescriptor(
        stream,
        pullIntoDescriptor,
      );
    }
  }
}

/**
 * @template R
 * @param {ReadableStream<R>} stream
 * @param {PullIntoDescriptor} pullIntoDescriptor
 */
function readableByteStreamControllerCommitPullIntoDescriptor(
  stream,
  pullIntoDescriptor,
) {
  assert(stream[_state] !== "errored");
  assert(pullIntoDescriptor.readerType !== "none");
  let done = false;
  if (stream[_state] === "closed") {
    assert(pullIntoDescriptor.bytesFilled === 0);
    done = true;
  }
  const filledView = readableByteStreamControllerConvertPullIntoDescriptor(
    pullIntoDescriptor,
  );
  if (pullIntoDescriptor.readerType === "default") {
    readableStreamFulfillReadRequest(stream, filledView, done);
  } else {
    assert(pullIntoDescriptor.readerType === "byob");
    readableStreamFulfillReadIntoRequest(stream, filledView, done);
  }
}

/**
 * @param {ReadableByteStreamController} controller
 * @param {ArrayBufferView} view
 */
function readableByteStreamControllerRespondWithNewView(controller, view) {
  assert(controller[_pendingPullIntos].length !== 0);

  let buffer, byteLength, byteOffset;
  if (TypedArrayPrototypeGetSymbolToStringTag(view) === undefined) {
    buffer = DataViewPrototypeGetBuffer(/** @type {DataView} */ (view));
    byteLength = DataViewPrototypeGetByteLength(/** @type {DataView} */ (view));
    byteOffset = DataViewPrototypeGetByteOffset(/** @type {DataView} */ (view));
  } else {
    buffer = TypedArrayPrototypeGetBuffer(/** @type {Uint8Array}} */ (view));
    byteLength = TypedArrayPrototypeGetByteLength(
      /** @type {Uint8Array} */ (view),
    );
    byteOffset = TypedArrayPrototypeGetByteOffset(
      /** @type {Uint8Array} */ (view),
    );
  }
  assert(!isDetachedBuffer(buffer));
  const firstDescriptor = controller[_pendingPullIntos][0];
  const state = controller[_stream][_state];
  if (state === "closed") {
    if (byteLength !== 0) {
      throw new TypeError(
        "The view's length must be 0 when calling respondWithNewView() on a closed stream",
      );
    }
  } else {
    assert(state === "readable");
    if (byteLength === 0) {
      throw new TypeError(
        "The view's length must be greater than 0 when calling respondWithNewView() on a readable stream",
      );
    }
  }
  // deno-lint-ignore prefer-primordials
  if (firstDescriptor.byteOffset + firstDescriptor.bytesFilled !== byteOffset) {
    throw new RangeError(
      "The region specified by view does not match byobRequest",
    );
  }
  if (firstDescriptor.bufferByteLength !== getArrayBufferByteLength(buffer)) {
    throw new RangeError(
      "The buffer of view has different capacity than byobRequest",
    );
  }
  // deno-lint-ignore prefer-primordials
  if (firstDescriptor.bytesFilled + byteLength > firstDescriptor.byteLength) {
    throw new RangeError(
      "The region specified by view is larger than byobRequest",
    );
  }
  firstDescriptor.buffer = transferArrayBuffer(buffer);
  readableByteStreamControllerRespondInternal(controller, byteLength);
}

/**
 * @param {ReadableByteStreamController} controller
 * @returns {PullIntoDescriptor}
 */
function readableByteStreamControllerShiftPendingPullInto(controller) {
  assert(controller[_byobRequest] === null);
  return ArrayPrototypeShift(controller[_pendingPullIntos]);
}

/**
 * @param {ReadableByteStreamController} controller
 * @param {PullIntoDescriptor} pullIntoDescriptor
 * @returns {boolean}
 */
function readableByteStreamControllerFillPullIntoDescriptorFromQueue(
  controller,
  pullIntoDescriptor,
) {
  const elementSize = pullIntoDescriptor.elementSize;
  const currentAlignedBytes = pullIntoDescriptor.bytesFilled -
    (pullIntoDescriptor.bytesFilled % elementSize);
  const maxBytesToCopy = MathMin(
    controller[_queueTotalSize],
    // deno-lint-ignore prefer-primordials
    pullIntoDescriptor.byteLength - pullIntoDescriptor.bytesFilled,
  );
  const maxBytesFilled = pullIntoDescriptor.bytesFilled + maxBytesToCopy;
  const maxAlignedBytes = maxBytesFilled - (maxBytesFilled % elementSize);
  let totalBytesToCopyRemaining = maxBytesToCopy;
  let ready = false;
  if (maxAlignedBytes > currentAlignedBytes) {
    totalBytesToCopyRemaining = maxAlignedBytes -
      pullIntoDescriptor.bytesFilled;
    ready = true;
  }
  const queue = controller[_queue];
  while (totalBytesToCopyRemaining > 0) {
    const headOfQueue = queue[0];
    const bytesToCopy = MathMin(
      totalBytesToCopyRemaining,
      // deno-lint-ignore prefer-primordials
      headOfQueue.byteLength,
    );
    // deno-lint-ignore prefer-primordials
    const destStart = pullIntoDescriptor.byteOffset +
      pullIntoDescriptor.bytesFilled;

    const destBuffer = new Uint8Array(
      // deno-lint-ignore prefer-primordials
      pullIntoDescriptor.buffer,
      destStart,
      bytesToCopy,
    );
    const srcBuffer = new Uint8Array(
      // deno-lint-ignore prefer-primordials
      headOfQueue.buffer,
      // deno-lint-ignore prefer-primordials
      headOfQueue.byteOffset,
      bytesToCopy,
    );
    destBuffer.set(srcBuffer);

    // deno-lint-ignore prefer-primordials
    if (headOfQueue.byteLength === bytesToCopy) {
      ArrayPrototypeShift(queue);
    } else {
      headOfQueue.byteOffset += bytesToCopy;
      headOfQueue.byteLength -= bytesToCopy;
    }
    controller[_queueTotalSize] -= bytesToCopy;
    readableByteStreamControllerFillHeadPullIntoDescriptor(
      controller,
      bytesToCopy,
      pullIntoDescriptor,
    );
    totalBytesToCopyRemaining -= bytesToCopy;
  }
  if (!ready) {
    assert(controller[_queueTotalSize] === 0);
    assert(pullIntoDescriptor.bytesFilled > 0);
    assert(pullIntoDescriptor.bytesFilled < pullIntoDescriptor.elementSize);
  }
  return ready;
}

/**
 * @param {ReadableByteStreamController} controller
 * @param {ReadRequest} readRequest
 * @returns {void}
 */
function readableByteStreamControllerFillReadRequestFromQueue(
  controller,
  readRequest,
) {
  assert(controller[_queueTotalSize] > 0);
  const entry = ArrayPrototypeShift(controller[_queue]);
  // deno-lint-ignore prefer-primordials
  controller[_queueTotalSize] -= entry.byteLength;
  readableByteStreamControllerHandleQueueDrain(controller);
  const view = new Uint8Array(
    // deno-lint-ignore prefer-primordials
    entry.buffer,
    // deno-lint-ignore prefer-primordials
    entry.byteOffset,
    // deno-lint-ignore prefer-primordials
    entry.byteLength,
  );
  readRequest.chunkSteps(view);
}

/**
 * @param {ReadableByteStreamController} controller
 * @param {number} size
 * @param {PullIntoDescriptor} pullIntoDescriptor
 * @returns {void}
 */
function readableByteStreamControllerFillHeadPullIntoDescriptor(
  controller,
  size,
  pullIntoDescriptor,
) {
  assert(
    controller[_pendingPullIntos].length === 0 ||
      controller[_pendingPullIntos][0] === pullIntoDescriptor,
  );
  assert(controller[_byobRequest] === null);
  pullIntoDescriptor.bytesFilled += size;
}

/**
 * @param {PullIntoDescriptor} pullIntoDescriptor
 * @returns {ArrayBufferView}
 */
function readableByteStreamControllerConvertPullIntoDescriptor(
  pullIntoDescriptor,
) {
  const bytesFilled = pullIntoDescriptor.bytesFilled;
  const elementSize = pullIntoDescriptor.elementSize;
  // deno-lint-ignore prefer-primordials
  assert(bytesFilled <= pullIntoDescriptor.byteLength);
  assert((bytesFilled % elementSize) === 0);
  // deno-lint-ignore prefer-primordials
  const buffer = transferArrayBuffer(pullIntoDescriptor.buffer);
  return new pullIntoDescriptor.viewConstructor(
    buffer,
    // deno-lint-ignore prefer-primordials
    pullIntoDescriptor.byteOffset,
    bytesFilled / elementSize,
  );
}

/**
 * @template R
 * @param {ReadableStreamDefaultReader<R>} reader
 * @param {ReadRequest<R>} readRequest
 * @returns {void}
 */
function readableStreamDefaultReaderRead(reader, readRequest) {
  const stream = reader[_stream];
  assert(stream);
  stream[_disturbed] = true;
  if (stream[_state] === "closed") {
    readRequest.closeSteps();
  } else if (stream[_state] === "errored") {
    readRequest.errorSteps(stream[_storedError]);
  } else {
    assert(stream[_state] === "readable");
    stream[_controller][_pullSteps](readRequest);
  }
}

/**
 * @template R
 * @param {ReadableStreamDefaultReader<R>} reader
 */
function readableStreamDefaultReaderRelease(reader) {
  readableStreamReaderGenericRelease(reader);
  const e = new TypeError("The reader was released.");
  readableStreamDefaultReaderErrorReadRequests(reader, e);
}

/**
 * @template R
 * @param {ReadableStream<R>} stream
 * @param {any} e
 */
function readableStreamError(stream, e) {
  assert(stream[_state] === "readable");
  stream[_state] = "errored";
  stream[_storedError] = e;
  /** @type {ReadableStreamDefaultReader<R> | undefined} */
  const reader = stream[_reader];
  if (reader === undefined) {
    return;
  }
  /** @type {Deferred<void>} */
  const closedPromise = reader[_closedPromise];
  closedPromise.reject(e);
  setPromiseIsHandledToTrue(closedPromise.promise);
  if (isReadableStreamDefaultReader(reader)) {
    readableStreamDefaultReaderErrorReadRequests(reader, e);
  } else {
    assert(isReadableStreamBYOBReader(reader));
    readableStreamBYOBReaderErrorReadIntoRequests(reader, e);
  }
}

/**
 * @template R
 * @param {ReadableStream<R>} stream
 * @param {R} chunk
 * @param {boolean} done
 */
function readableStreamFulfillReadIntoRequest(stream, chunk, done) {
  assert(readableStreamHasBYOBReader(stream));
  /** @type {ReadableStreamDefaultReader<R>} */
  const reader = stream[_reader];
  assert(reader[_readIntoRequests].length !== 0);
  /** @type {ReadIntoRequest} */
  const readIntoRequest = ArrayPrototypeShift(reader[_readIntoRequests]);
  if (done) {
    readIntoRequest.closeSteps(chunk);
  } else {
    readIntoRequest.chunkSteps(chunk);
  }
}

/**
 * @template R
 * @param {ReadableStream<R>} stream
 * @param {R} chunk
 * @param {boolean} done
 */
function readableStreamFulfillReadRequest(stream, chunk, done) {
  assert(readableStreamHasDefaultReader(stream) === true);
  /** @type {ReadableStreamDefaultReader<R>} */
  const reader = stream[_reader];
  assert(reader[_readRequests].length);
  /** @type {ReadRequest<R>} */
  const readRequest = ArrayPrototypeShift(reader[_readRequests]);
  if (done) {
    readRequest.closeSteps();
  } else {
    readRequest.chunkSteps(chunk);
  }
}

/**
 * @param {ReadableStream} stream
 * @return {number}
 */
function readableStreamGetNumReadIntoRequests(stream) {
  assert(readableStreamHasBYOBReader(stream) === true);
  return stream[_reader][_readIntoRequests].length;
}

/**
 * @param {ReadableStream} stream
 * @return {number}
 */
function readableStreamGetNumReadRequests(stream) {
  assert(readableStreamHasDefaultReader(stream) === true);
  return stream[_reader][_readRequests].length;
}

/**
 * @param {ReadableStream} stream
 * @returns {boolean}
 */
function readableStreamHasBYOBReader(stream) {
  const reader = stream[_reader];
  if (reader === undefined) {
    return false;
  }
  if (isReadableStreamBYOBReader(reader)) {
    return true;
  }
  return false;
}

/**
 * @param {ReadableStream} stream
 * @returns {boolean}
 */
function readableStreamHasDefaultReader(stream) {
  const reader = stream[_reader];
  if (reader === undefined) {
    return false;
  }
  if (isReadableStreamDefaultReader(reader)) {
    return true;
  }
  return false;
}

/**
 * @template T
 * @param {ReadableStream<T>} source
 * @param {WritableStream<T>} dest
 * @param {boolean} preventClose
 * @param {boolean} preventAbort
 * @param {boolean} preventCancel
 * @param {AbortSignal=} signal
 * @returns {Promise<void>}
 */
function readableStreamPipeTo(
  source,
  dest,
  preventClose,
  preventAbort,
  preventCancel,
  signal,
) {
  assert(isReadableStream(source));
  assert(isWritableStream(dest));
  assert(
    typeof preventClose === "boolean" && typeof preventAbort === "boolean" &&
      typeof preventCancel === "boolean",
  );
  assert(
    signal === undefined ||
      ObjectPrototypeIsPrototypeOf(AbortSignalPrototype, signal),
  );
  assert(!isReadableStreamLocked(source));
  assert(!isWritableStreamLocked(dest));
  // We use acquireReadableStreamDefaultReader even in case of ReadableByteStreamController
  // as the spec allows us, and the only reason to use BYOBReader is to do some smart things
  // with it, but the spec does not specify what things, so to simplify we stick to DefaultReader.
  const reader = acquireReadableStreamDefaultReader(source);
  const writer = acquireWritableStreamDefaultWriter(dest);
  source[_disturbed] = true;
  let shuttingDown = false;
  let currentWrite = resolvePromiseWith(undefined);
  /** @type {Deferred<void>} */
  const promise = new Deferred();
  /** @type {() => void} */
  let abortAlgorithm;
  if (signal) {
    abortAlgorithm = () => {
      const error = signal.reason;
      /** @type {Array<() => Promise<void>>} */
      const actions = [];
      if (preventAbort === false) {
        ArrayPrototypePush(actions, () => {
          if (dest[_state] === "writable") {
            return writableStreamAbort(dest, error);
          } else {
            return resolvePromiseWith(undefined);
          }
        });
      }
      if (preventCancel === false) {
        ArrayPrototypePush(actions, () => {
          if (source[_state] === "readable") {
            return readableStreamCancel(source, error);
          } else {
            return resolvePromiseWith(undefined);
          }
        });
      }
      shutdownWithAction(
        () => SafePromiseAll(ArrayPrototypeMap(actions, (action) => action())),
        true,
        error,
      );
    };

    if (signal.aborted) {
      abortAlgorithm();
      return promise.promise;
    }
    signal[add](abortAlgorithm);
  }

  function pipeLoop() {
    return new Promise((resolveLoop, rejectLoop) => {
      /** @param {boolean} done */
      function next(done) {
        if (done) {
          resolveLoop();
        } else {
          uponPromise(pipeStep(), next, rejectLoop);
        }
      }
      next(false);
    });
  }

  /** @returns {Promise<boolean>} */
  function pipeStep() {
    if (shuttingDown === true) {
      return resolvePromiseWith(true);
    }

    return transformPromiseWith(writer[_readyPromise].promise, () => {
      return new Promise((resolveRead, rejectRead) => {
        readableStreamDefaultReaderRead(
          reader,
          {
            chunkSteps(chunk) {
              currentWrite = transformPromiseWith(
                writableStreamDefaultWriterWrite(writer, chunk),
                undefined,
                () => {},
              );
              resolveRead(false);
            },
            closeSteps() {
              resolveRead(true);
            },
            errorSteps: rejectRead,
          },
        );
      });
    });
  }

  isOrBecomesErrored(
    source,
    reader[_closedPromise].promise,
    (storedError) => {
      if (preventAbort === false) {
        shutdownWithAction(
          () => writableStreamAbort(dest, storedError),
          true,
          storedError,
        );
      } else {
        shutdown(true, storedError);
      }
    },
  );

  isOrBecomesErrored(dest, writer[_closedPromise].promise, (storedError) => {
    if (preventCancel === false) {
      shutdownWithAction(
        () => readableStreamCancel(source, storedError),
        true,
        storedError,
      );
    } else {
      shutdown(true, storedError);
    }
  });

  isOrBecomesClosed(source, reader[_closedPromise].promise, () => {
    if (preventClose === false) {
      shutdownWithAction(() =>
        writableStreamDefaultWriterCloseWithErrorPropagation(writer)
      );
    } else {
      shutdown();
    }
  });

  if (
    writableStreamCloseQueuedOrInFlight(dest) === true ||
    dest[_state] === "closed"
  ) {
    const destClosed = new TypeError(
      "The destination writable stream closed before all the data could be piped to it.",
    );
    if (preventCancel === false) {
      shutdownWithAction(
        () => readableStreamCancel(source, destClosed),
        true,
        destClosed,
      );
    } else {
      shutdown(true, destClosed);
    }
  }

  setPromiseIsHandledToTrue(pipeLoop());

  return promise.promise;

  /** @returns {Promise<void>} */
  function waitForWritesToFinish() {
    const oldCurrentWrite = currentWrite;
    return transformPromiseWith(
      currentWrite,
      () =>
        oldCurrentWrite !== currentWrite ? waitForWritesToFinish() : undefined,
    );
  }

  /**
   * @param {ReadableStream | WritableStream} stream
   * @param {Promise<any>} promise
   * @param {(e: any) => void} action
   */
  function isOrBecomesErrored(stream, promise, action) {
    if (stream[_state] === "errored") {
      action(stream[_storedError]);
    } else {
      uponRejection(promise, action);
    }
  }

  /**
   * @param {ReadableStream} stream
   * @param {Promise<any>} promise
   * @param {() => void} action
   */
  function isOrBecomesClosed(stream, promise, action) {
    if (stream[_state] === "closed") {
      action();
    } else {
      uponFulfillment(promise, action);
    }
  }

  /**
   * @param {() => Promise<void[] | void>} action
   * @param {boolean=} originalIsError
   * @param {any=} originalError
   */
  function shutdownWithAction(action, originalIsError, originalError) {
    function doTheRest() {
      uponPromise(
        action(),
        () => finalize(originalIsError, originalError),
        (newError) => finalize(true, newError),
      );
    }

    if (shuttingDown === true) {
      return;
    }
    shuttingDown = true;

    if (
      dest[_state] === "writable" &&
      writableStreamCloseQueuedOrInFlight(dest) === false
    ) {
      uponFulfillment(waitForWritesToFinish(), doTheRest);
    } else {
      doTheRest();
    }
  }

  /**
   * @param {boolean=} isError
   * @param {any=} error
   */
  function shutdown(isError, error) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    if (
      dest[_state] === "writable" &&
      writableStreamCloseQueuedOrInFlight(dest) === false
    ) {
      uponFulfillment(
        waitForWritesToFinish(),
        () => finalize(isError, error),
      );
    } else {
      finalize(isError, error);
    }
  }

  /**
   * @param {boolean=} isError
   * @param {any=} error
   */
  function finalize(isError, error) {
    writableStreamDefaultWriterRelease(writer);
    readableStreamDefaultReaderRelease(reader);

    if (signal !== undefined) {
      signal[remove](abortAlgorithm);
    }
    if (isError) {
      promise.reject(error);
    } else {
      promise.resolve(undefined);
    }
  }
}

/**
 * @param {ReadableStreamGenericReader<any> | ReadableStreamBYOBReader} reader
 * @param {any} reason
 * @returns {Promise<void>}
 */
function readableStreamReaderGenericCancel(reader, reason) {
  const stream = reader[_stream];
  assert(stream !== undefined);
  return readableStreamCancel(stream, reason);
}

/**
 * @template R
 * @param {ReadableStreamDefaultReader<R> | ReadableStreamBYOBReader} reader
 * @param {ReadableStream<R>} stream
 */
function readableStreamReaderGenericInitialize(reader, stream) {
  reader[_stream] = stream;
  stream[_reader] = reader;
  if (stream[_state] === "readable") {
    reader[_closedPromise] = new Deferred();
  } else if (stream[_state] === "closed") {
    reader[_closedPromise] = new Deferred();
    reader[_closedPromise].resolve(undefined);
  } else {
    assert(stream[_state] === "errored");
    reader[_closedPromise] = new Deferred();
    reader[_closedPromise].reject(stream[_storedError]);
    setPromiseIsHandledToTrue(reader[_closedPromise].promise);
  }
}

/**
 * @template R
 * @param {ReadableStreamGenericReader<R> | ReadableStreamBYOBReader} reader
 */
function readableStreamReaderGenericRelease(reader) {
  const stream = reader[_stream];
  assert(stream !== undefined);
  assert(stream[_reader] === reader);
  if (stream[_state] === "readable") {
    reader[_closedPromise].reject(
      new TypeError(
        "Reader was released and can no longer be used to monitor the stream's closedness.",
      ),
    );
  } else {
    reader[_closedPromise] = new Deferred();
    reader[_closedPromise].reject(
      new TypeError(
        "Reader was released and can no longer be used to monitor the stream's closedness.",
      ),
    );
  }
  setPromiseIsHandledToTrue(reader[_closedPromise].promise);
  stream[_controller][_releaseSteps]();
  stream[_reader] = undefined;
  reader[_stream] = undefined;
}

/**
 * @param {ReadableStreamBYOBReader} reader
 * @param {any} e
 */
function readableStreamBYOBReaderErrorReadIntoRequests(reader, e) {
  const readIntoRequests = reader[_readIntoRequests];
  reader[_readIntoRequests] = [];
  for (let i = 0; i < readIntoRequests.length; ++i) {
    const readIntoRequest = readIntoRequests[i];
    readIntoRequest.errorSteps(e);
  }
}

/**
 * @template R
 * @param {ReadableStream<R>} stream
 * @param {boolean} cloneForBranch2
 * @returns {[ReadableStream<R>, ReadableStream<R>]}
 */
function readableStreamTee(stream, cloneForBranch2) {
  assert(isReadableStream(stream));
  assert(typeof cloneForBranch2 === "boolean");
  if (
    ObjectPrototypeIsPrototypeOf(
      ReadableByteStreamControllerPrototype,
      stream[_controller],
    )
  ) {
    return readableByteStreamTee(stream);
  } else {
    return readableStreamDefaultTee(stream, cloneForBranch2);
  }
}

/**
 * @template R
 * @param {ReadableStream<R>} stream
 * @param {boolean} cloneForBranch2
 * @returns {[ReadableStream<R>, ReadableStream<R>]}
 */
function readableStreamDefaultTee(stream, cloneForBranch2) {
  assert(isReadableStream(stream));
  assert(typeof cloneForBranch2 === "boolean");
  const reader = acquireReadableStreamDefaultReader(stream);
  let reading = false;
  let readAgain = false;
  let canceled1 = false;
  let canceled2 = false;
  /** @type {any} */
  let reason1;
  /** @type {any} */
  let reason2;
  /** @type {ReadableStream<R>} */
  // deno-lint-ignore prefer-const
  let branch1;
  /** @type {ReadableStream<R>} */
  // deno-lint-ignore prefer-const
  let branch2;

  /** @type {Deferred<void>} */
  const cancelPromise = new Deferred();

  function pullAlgorithm() {
    if (reading === true) {
      readAgain = true;
      return resolvePromiseWith(undefined);
    }
    reading = true;
    /** @type {ReadRequest<R>} */
    const readRequest = {
      chunkSteps(value) {
        queueMicrotask(() => {
          readAgain = false;
          const value1 = value;
          let value2 = value;

          if (canceled2 === false && cloneForBranch2 === true) {
            try {
              value2 = structuredClone(value2);
            } catch (cloneError) {
              readableStreamDefaultControllerError(
                branch1[_controller],
                cloneError,
              );
              readableStreamDefaultControllerError(
                branch2[_controller],
                cloneError,
              );
              cancelPromise.resolve(readableStreamCancel(stream, cloneError));
              return;
            }
          }

          if (canceled1 === false) {
            readableStreamDefaultControllerEnqueue(
              /** @type {ReadableStreamDefaultController<any>} */ branch1[
                _controller
              ],
              value1,
            );
          }
          if (canceled2 === false) {
            readableStreamDefaultControllerEnqueue(
              /** @type {ReadableStreamDefaultController<any>} */ branch2[
                _controller
              ],
              value2,
            );
          }

          reading = false;
          if (readAgain === true) {
            pullAlgorithm();
          }
        });
      },
      closeSteps() {
        reading = false;
        if (canceled1 === false) {
          readableStreamDefaultControllerClose(
            /** @type {ReadableStreamDefaultController<any>} */ branch1[
              _controller
            ],
          );
        }
        if (canceled2 === false) {
          readableStreamDefaultControllerClose(
            /** @type {ReadableStreamDefaultController<any>} */ branch2[
              _controller
            ],
          );
        }
        if (canceled1 === false || canceled2 === false) {
          cancelPromise.resolve(undefined);
        }
      },
      errorSteps() {
        reading = false;
      },
    };
    readableStreamDefaultReaderRead(reader, readRequest);
    return resolvePromiseWith(undefined);
  }

  /**
   * @param {any} reason
   * @returns {Promise<void>}
   */
  function cancel1Algorithm(reason) {
    canceled1 = true;
    reason1 = reason;
    if (canceled2 === true) {
      const compositeReason = [reason1, reason2];
      const cancelResult = readableStreamCancel(stream, compositeReason);
      cancelPromise.resolve(cancelResult);
    }
    return cancelPromise.promise;
  }

  /**
   * @param {any} reason
   * @returns {Promise<void>}
   */
  function cancel2Algorithm(reason) {
    canceled2 = true;
    reason2 = reason;
    if (canceled1 === true) {
      const compositeReason = [reason1, reason2];
      const cancelResult = readableStreamCancel(stream, compositeReason);
      cancelPromise.resolve(cancelResult);
    }
    return cancelPromise.promise;
  }

  function startAlgorithm() {}

  branch1 = createReadableStream(
    startAlgorithm,
    pullAlgorithm,
    cancel1Algorithm,
  );
  branch2 = createReadableStream(
    startAlgorithm,
    pullAlgorithm,
    cancel2Algorithm,
  );

  uponRejection(reader[_closedPromise].promise, (r) => {
    readableStreamDefaultControllerError(
      /** @type {ReadableStreamDefaultController<any>} */ branch1[
        _controller
      ],
      r,
    );
    readableStreamDefaultControllerError(
      /** @type {ReadableStreamDefaultController<any>} */ branch2[
        _controller
      ],
      r,
    );
    if (canceled1 === false || canceled2 === false) {
      cancelPromise.resolve(undefined);
    }
  });

  return [branch1, branch2];
}

/**
 * @template R
 * @param {ReadableStream<R>} stream
 * @returns {[ReadableStream<R>, ReadableStream<R>]}
 */
function readableByteStreamTee(stream) {
  assert(isReadableStream(stream));
  assert(
    ObjectPrototypeIsPrototypeOf(
      ReadableByteStreamControllerPrototype,
      stream[_controller],
    ),
  );
  let reader = acquireReadableStreamDefaultReader(stream);
  let reading = false;
  let readAgainForBranch1 = false;
  let readAgainForBranch2 = false;
  let canceled1 = false;
  let canceled2 = false;
  let reason1 = undefined;
  let reason2 = undefined;
  let branch1 = undefined;
  let branch2 = undefined;
  /** @type {Deferred<void>} */
  const cancelPromise = new Deferred();

  /**
   * @param {ReadableStreamBYOBReader} thisReader
   */
  function forwardReaderError(thisReader) {
    PromisePrototypeCatch(thisReader[_closedPromise].promise, (e) => {
      if (thisReader !== reader) {
        return;
      }
      readableByteStreamControllerError(branch1[_controller], e);
      readableByteStreamControllerError(branch2[_controller], e);
      if (!canceled1 || !canceled2) {
        cancelPromise.resolve(undefined);
      }
    });
  }

  function pullWithDefaultReader() {
    if (isReadableStreamBYOBReader(reader)) {
      assert(reader[_readIntoRequests].length === 0);
      readableStreamBYOBReaderRelease(reader);
      reader = acquireReadableStreamDefaultReader(stream);
      forwardReaderError(reader);
    }

    /** @type {ReadRequest} */
    const readRequest = {
      chunkSteps(chunk) {
        queueMicrotask(() => {
          readAgainForBranch1 = false;
          readAgainForBranch2 = false;
          const chunk1 = chunk;
          let chunk2 = chunk;
          if (!canceled1 && !canceled2) {
            try {
              chunk2 = cloneAsUint8Array(chunk);
            } catch (e) {
              readableByteStreamControllerError(branch1[_controller], e);
              readableByteStreamControllerError(branch2[_controller], e);
              cancelPromise.resolve(readableStreamCancel(stream, e));
              return;
            }
          }
          if (!canceled1) {
            readableByteStreamControllerEnqueue(branch1[_controller], chunk1);
          }
          if (!canceled2) {
            readableByteStreamControllerEnqueue(branch2[_controller], chunk2);
          }
          reading = false;
          if (readAgainForBranch1) {
            pull1Algorithm();
          } else if (readAgainForBranch2) {
            pull2Algorithm();
          }
        });
      },
      closeSteps() {
        reading = false;
        if (!canceled1) {
          readableByteStreamControllerClose(branch1[_controller]);
        }
        if (!canceled2) {
          readableByteStreamControllerClose(branch2[_controller]);
        }
        if (branch1[_controller][_pendingPullIntos].length !== 0) {
          readableByteStreamControllerRespond(branch1[_controller], 0);
        }
        if (branch2[_controller][_pendingPullIntos].length !== 0) {
          readableByteStreamControllerRespond(branch2[_controller], 0);
        }
        if (!canceled1 || !canceled2) {
          cancelPromise.resolve(undefined);
        }
      },
      errorSteps() {
        reading = false;
      },
    };
    readableStreamDefaultReaderRead(reader, readRequest);
  }

  function pullWithBYOBReader(view, forBranch2) {
    if (isReadableStreamDefaultReader(reader)) {
      assert(reader[_readRequests].length === 0);
      readableStreamDefaultReaderRelease(reader);
      reader = acquireReadableStreamBYOBReader(stream);
      forwardReaderError(reader);
    }
    const byobBranch = forBranch2 ? branch2 : branch1;
    const otherBranch = forBranch2 ? branch1 : branch2;

    /** @type {ReadIntoRequest} */
    const readIntoRequest = {
      chunkSteps(chunk) {
        queueMicrotask(() => {
          readAgainForBranch1 = false;
          readAgainForBranch2 = false;
          const byobCanceled = forBranch2 ? canceled2 : canceled1;
          const otherCanceled = forBranch2 ? canceled1 : canceled2;
          if (!otherCanceled) {
            let clonedChunk;
            try {
              clonedChunk = cloneAsUint8Array(chunk);
            } catch (e) {
              readableByteStreamControllerError(byobBranch[_controller], e);
              readableByteStreamControllerError(otherBranch[_controller], e);
              cancelPromise.resolve(readableStreamCancel(stream, e));
              return;
            }
            if (!byobCanceled) {
              readableByteStreamControllerRespondWithNewView(
                byobBranch[_controller],
                chunk,
              );
            }
            readableByteStreamControllerEnqueue(
              otherBranch[_controller],
              clonedChunk,
            );
          } else if (!byobCanceled) {
            readableByteStreamControllerRespondWithNewView(
              byobBranch[_controller],
              chunk,
            );
          }
          reading = false;
          if (readAgainForBranch1) {
            pull1Algorithm();
          } else if (readAgainForBranch2) {
            pull2Algorithm();
          }
        });
      },
      closeSteps(chunk) {
        reading = false;
        const byobCanceled = forBranch2 ? canceled2 : canceled1;
        const otherCanceled = forBranch2 ? canceled1 : canceled2;
        if (!byobCanceled) {
          readableByteStreamControllerClose(byobBranch[_controller]);
        }
        if (!otherCanceled) {
          readableByteStreamControllerClose(otherBranch[_controller]);
        }
        if (chunk !== undefined) {
          let byteLength;
          if (TypedArrayPrototypeGetSymbolToStringTag(chunk) === undefined) {
            byteLength = DataViewPrototypeGetByteLength(
              /** @type {DataView} */ (chunk),
            );
          } else {
            byteLength = TypedArrayPrototypeGetByteLength(
              /** @type {Uint8Array} */ (chunk),
            );
          }
          assert(byteLength === 0);
          if (!byobCanceled) {
            readableByteStreamControllerRespondWithNewView(
              byobBranch[_controller],
              chunk,
            );
          }
          if (
            !otherCanceled &&
            otherBranch[_controller][_pendingPullIntos].length !== 0
          ) {
            readableByteStreamControllerRespond(otherBranch[_controller], 0);
          }
        }
        if (!byobCanceled || !otherCanceled) {
          cancelPromise.resolve(undefined);
        }
      },
      errorSteps() {
        reading = false;
      },
    };
    readableStreamBYOBReaderRead(reader, view, readIntoRequest);
  }

  function pull1Algorithm() {
    if (reading) {
      readAgainForBranch1 = true;
      return PromiseResolve(undefined);
    }
    reading = true;
    const byobRequest = readableByteStreamControllerGetBYOBRequest(
      branch1[_controller],
    );
    if (byobRequest === null) {
      pullWithDefaultReader();
    } else {
      pullWithBYOBReader(byobRequest[_view], false);
    }
    return PromiseResolve(undefined);
  }

  function pull2Algorithm() {
    if (reading) {
      readAgainForBranch2 = true;
      return PromiseResolve(undefined);
    }
    reading = true;
    const byobRequest = readableByteStreamControllerGetBYOBRequest(
      branch2[_controller],
    );
    if (byobRequest === null) {
      pullWithDefaultReader();
    } else {
      pullWithBYOBReader(byobRequest[_view], true);
    }
    return PromiseResolve(undefined);
  }

  function cancel1Algorithm(reason) {
    canceled1 = true;
    reason1 = reason;
    if (canceled2) {
      const compositeReason = [reason1, reason2];
      const cancelResult = readableStreamCancel(stream, compositeReason);
      cancelPromise.resolve(cancelResult);
    }
    return cancelPromise.promise;
  }

  function cancel2Algorithm(reason) {
    canceled2 = true;
    reason2 = reason;
    if (canceled1) {
      const compositeReason = [reason1, reason2];
      const cancelResult = readableStreamCancel(stream, compositeReason);
      cancelPromise.resolve(cancelResult);
    }
    return cancelPromise.promise;
  }

  function startAlgorithm() {
    return undefined;
  }

  branch1 = createReadableByteStream(
    startAlgorithm,
    pull1Algorithm,
    cancel1Algorithm,
  );
  branch2 = createReadableByteStream(
    startAlgorithm,
    pull2Algorithm,
    cancel2Algorithm,
  );

  branch1[_original] = stream;
  branch2[_original] = stream;

  forwardReaderError(reader);
  return [branch1, branch2];
}

/**
 * @param {ReadableStream<ArrayBuffer>} stream
 * @param {ReadableByteStreamController} controller
 * @param {() => void} startAlgorithm
 * @param {() => Promise<void>} pullAlgorithm
 * @param {(reason: any) => Promise<void>} cancelAlgorithm
 * @param {number} highWaterMark
 * @param {number | undefined} autoAllocateChunkSize
 */
function setUpReadableByteStreamController(
  stream,
  controller,
  startAlgorithm,
  pullAlgorithm,
  cancelAlgorithm,
  highWaterMark,
  autoAllocateChunkSize,
) {
  assert(stream[_controller] === undefined);
  if (autoAllocateChunkSize !== undefined) {
    assert(NumberIsInteger(autoAllocateChunkSize));
    assert(autoAllocateChunkSize >= 0);
  }
  controller[_stream] = stream;
  controller[_pullAgain] = controller[_pulling] = false;
  controller[_byobRequest] = null;
  resetQueue(controller);
  controller[_closeRequested] = controller[_started] = false;
  controller[_strategyHWM] = highWaterMark;
  controller[_pullAlgorithm] = pullAlgorithm;
  controller[_cancelAlgorithm] = cancelAlgorithm;
  controller[_autoAllocateChunkSize] = autoAllocateChunkSize;
  controller[_pendingPullIntos] = [];
  stream[_controller] = controller;
  const startResult = startAlgorithm();
  const startPromise = resolvePromiseWith(startResult);
  setPromiseIsHandledToTrue(
    PromisePrototypeThen(
      startPromise,
      () => {
        controller[_started] = true;
        assert(controller[_pulling] === false);
        assert(controller[_pullAgain] === false);
        readableByteStreamControllerCallPullIfNeeded(controller);
      },
      (r) => {
        readableByteStreamControllerError(controller, r);
      },
    ),
  );
}

/**
 * @param {ReadableStream<ArrayBuffer>} stream
 * @param {UnderlyingSource<ArrayBuffer>} underlyingSource
 * @param {UnderlyingSource<ArrayBuffer>} underlyingSourceDict
 * @param {number} highWaterMark
 */
function setUpReadableByteStreamControllerFromUnderlyingSource(
  stream,
  underlyingSource,
  underlyingSourceDict,
  highWaterMark,
) {
  const controller = webidl.createBranded(ReadableByteStreamController);
  /** @type {() => void} */
  let startAlgorithm = () => undefined;
  /** @type {() => Promise<void>} */
  let pullAlgorithm = () => resolvePromiseWith(undefined);
  /** @type {(reason: any) => Promise<void>} */
  let cancelAlgorithm = (_reason) => resolvePromiseWith(undefined);
  if (underlyingSourceDict.start !== undefined) {
    startAlgorithm = () =>
      webidl.invokeCallbackFunction(
        underlyingSourceDict.start,
        [controller],
        underlyingSource,
        webidl.converters.any,
        "Failed to call 'startAlgorithm' on 'ReadableByteStreamController'",
      );
  }
  if (underlyingSourceDict.pull !== undefined) {
    pullAlgorithm = () =>
      webidl.invokeCallbackFunction(
        underlyingSourceDict.pull,
        [controller],
        underlyingSource,
        webidl.converters["Promise<undefined>"],
        "Failed to call 'pullAlgorithm' on 'ReadableByteStreamController'",
        true,
      );
  }
  if (underlyingSourceDict.cancel !== undefined) {
    cancelAlgorithm = (reason) =>
      webidl.invokeCallbackFunction(
        underlyingSourceDict.cancel,
        [reason],
        underlyingSource,
        webidl.converters["Promise<undefined>"],
        "Failed to call 'cancelAlgorithm' on 'ReadableByteStreamController'",
        true,
      );
  }
  const autoAllocateChunkSize = underlyingSourceDict["autoAllocateChunkSize"];
  if (autoAllocateChunkSize === 0) {
    throw new TypeError("autoAllocateChunkSize must be greater than 0");
  }
  setUpReadableByteStreamController(
    stream,
    controller,
    startAlgorithm,
    pullAlgorithm,
    cancelAlgorithm,
    highWaterMark,
    autoAllocateChunkSize,
  );
}

/**
 * @template R
 * @param {ReadableStream<R>} stream
 * @param {ReadableStreamDefaultController<R>} controller
 * @param {(controller: ReadableStreamDefaultController<R>) => void | Promise<void>} startAlgorithm
 * @param {(controller: ReadableStreamDefaultController<R>) => Promise<void>} pullAlgorithm
 * @param {(reason: any) => Promise<void>} cancelAlgorithm
 * @param {number} highWaterMark
 * @param {(chunk: R) => number} sizeAlgorithm
 */
function setUpReadableStreamDefaultController(
  stream,
  controller,
  startAlgorithm,
  pullAlgorithm,
  cancelAlgorithm,
  highWaterMark,
  sizeAlgorithm,
) {
  assert(stream[_controller] === undefined);
  controller[_stream] = stream;
  resetQueue(controller);
  controller[_started] =
    controller[_closeRequested] =
    controller[_pullAgain] =
    controller[_pulling] =
      false;
  controller[_strategySizeAlgorithm] = sizeAlgorithm;
  controller[_strategyHWM] = highWaterMark;
  controller[_pullAlgorithm] = pullAlgorithm;
  controller[_cancelAlgorithm] = cancelAlgorithm;
  stream[_controller] = controller;
  const startResult = startAlgorithm(controller);
  const startPromise = resolvePromiseWith(startResult);
  uponPromise(startPromise, () => {
    controller[_started] = true;
    assert(controller[_pulling] === false);
    assert(controller[_pullAgain] === false);
    readableStreamDefaultControllerCallPullIfNeeded(controller);
  }, (r) => {
    readableStreamDefaultControllerError(controller, r);
  });
}

/**
 * @template R
 * @param {ReadableStream<R>} stream
 * @param {UnderlyingSource<R>} underlyingSource
 * @param {UnderlyingSource<R>} underlyingSourceDict
 * @param {number} highWaterMark
 * @param {(chunk: R) => number} sizeAlgorithm
 */
function setUpReadableStreamDefaultControllerFromUnderlyingSource(
  stream,
  underlyingSource,
  underlyingSourceDict,
  highWaterMark,
  sizeAlgorithm,
) {
  const controller = webidl.createBranded(ReadableStreamDefaultController);
  /** @type {() => Promise<void>} */
  let startAlgorithm = () => undefined;
  /** @type {() => Promise<void>} */
  let pullAlgorithm = () => resolvePromiseWith(undefined);
  /** @type {(reason?: any) => Promise<void>} */
  let cancelAlgorithm = () => resolvePromiseWith(undefined);
  if (underlyingSourceDict.start !== undefined) {
    startAlgorithm = () =>
      webidl.invokeCallbackFunction(
        underlyingSourceDict.start,
        [controller],
        underlyingSource,
        webidl.converters.any,
        "Failed to call 'startAlgorithm' on 'ReadableStreamDefaultController'",
      );
  }
  if (underlyingSourceDict.pull !== undefined) {
    pullAlgorithm = () =>
      webidl.invokeCallbackFunction(
        underlyingSourceDict.pull,
        [controller],
        underlyingSource,
        webidl.converters["Promise<undefined>"],
        "Failed to call 'pullAlgorithm' on 'ReadableStreamDefaultController'",
        true,
      );
  }
  if (underlyingSourceDict.cancel !== undefined) {
    cancelAlgorithm = (reason) =>
      webidl.invokeCallbackFunction(
        underlyingSourceDict.cancel,
        [reason],
        underlyingSource,
        webidl.converters["Promise<undefined>"],
        "Failed to call 'cancelAlgorithm' on 'ReadableStreamDefaultController'",
        true,
      );
  }
  setUpReadableStreamDefaultController(
    stream,
    controller,
    startAlgorithm,
    pullAlgorithm,
    cancelAlgorithm,
    highWaterMark,
    sizeAlgorithm,
  );
}

/**
 * @template R
 * @param {ReadableStreamBYOBReader} reader
 * @param {ReadableStream<R>} stream
 */
function setUpReadableStreamBYOBReader(reader, stream) {
  if (isReadableStreamLocked(stream)) {
    throw new TypeError("ReadableStream is locked.");
  }
  if (
    !(ObjectPrototypeIsPrototypeOf(
      ReadableByteStreamControllerPrototype,
      stream[_controller],
    ))
  ) {
    throw new TypeError("Cannot use a BYOB reader with a non-byte stream");
  }
  readableStreamReaderGenericInitialize(reader, stream);
  reader[_readIntoRequests] = [];
}

/**
 * @template R
 * @param {ReadableStreamDefaultReader<R>} reader
 * @param {ReadableStream<R>} stream
 */
function setUpReadableStreamDefaultReader(reader, stream) {
  if (isReadableStreamLocked(stream)) {
    throw new TypeError("ReadableStream is locked.");
  }
  readableStreamReaderGenericInitialize(reader, stream);
  reader[_readRequests] = [];
}

/**
 * @template O
 * @param {TransformStream<any, O>} stream
 * @param {TransformStreamDefaultController<O>} controller
 * @param {(chunk: O, controller: TransformStreamDefaultController<O>) => Promise<void>} transformAlgorithm
 * @param {(controller: TransformStreamDefaultController<O>) => Promise<void>} flushAlgorithm
 */
function setUpTransformStreamDefaultController(
  stream,
  controller,
  transformAlgorithm,
  flushAlgorithm,
) {
  assert(ObjectPrototypeIsPrototypeOf(TransformStreamPrototype, stream));
  assert(stream[_controller] === undefined);
  controller[_stream] = stream;
  stream[_controller] = controller;
  controller[_transformAlgorithm] = transformAlgorithm;
  controller[_flushAlgorithm] = flushAlgorithm;
}

/**
 * @template I
 * @template O
 * @param {TransformStream<I, O>} stream
 * @param {Transformer<I, O>} transformer
 * @param {Transformer<I, O>} transformerDict
 */
function setUpTransformStreamDefaultControllerFromTransformer(
  stream,
  transformer,
  transformerDict,
) {
  /** @type {TransformStreamDefaultController<O>} */
  const controller = webidl.createBranded(TransformStreamDefaultController);
  /** @type {(chunk: O, controller: TransformStreamDefaultController<O>) => Promise<void>} */
  let transformAlgorithm = (chunk) => {
    try {
      transformStreamDefaultControllerEnqueue(controller, chunk);
    } catch (e) {
      return PromiseReject(e);
    }
    return resolvePromiseWith(undefined);
  };
  /** @type {(controller: TransformStreamDefaultController<O>) => Promise<void>} */
  let flushAlgorithm = () => resolvePromiseWith(undefined);
  if (transformerDict.transform !== undefined) {
    transformAlgorithm = (chunk, controller) =>
      webidl.invokeCallbackFunction(
        transformerDict.transform,
        [chunk, controller],
        transformer,
        webidl.converters["Promise<undefined>"],
        "Failed to call 'transformAlgorithm' on 'TransformStreamDefaultController'",
        true,
      );
  }
  if (transformerDict.flush !== undefined) {
    flushAlgorithm = (controller) =>
      webidl.invokeCallbackFunction(
        transformerDict.flush,
        [controller],
        transformer,
        webidl.converters["Promise<undefined>"],
        "Failed to call 'flushAlgorithm' on 'TransformStreamDefaultController'",
        true,
      );
  }
  setUpTransformStreamDefaultController(
    stream,
    controller,
    transformAlgorithm,
    flushAlgorithm,
  );
}

/**
 * @template W
 * @param {WritableStream<W>} stream
 * @param {WritableStreamDefaultController<W>} controller
 * @param {(controller: WritableStreamDefaultController<W>) => Promise<void>} startAlgorithm
 * @param {(chunk: W, controller: WritableStreamDefaultController<W>) => Promise<void>} writeAlgorithm
 * @param {() => Promise<void>} closeAlgorithm
 * @param {(reason?: any) => Promise<void>} abortAlgorithm
 * @param {number} highWaterMark
 * @param {(chunk: W) => number} sizeAlgorithm
 */
function setUpWritableStreamDefaultController(
  stream,
  controller,
  startAlgorithm,
  writeAlgorithm,
  closeAlgorithm,
  abortAlgorithm,
  highWaterMark,
  sizeAlgorithm,
) {
  assert(isWritableStream(stream));
  assert(stream[_controller] === undefined);
  controller[_stream] = stream;
  stream[_controller] = controller;
  resetQueue(controller);
  controller[_signal] = newSignal();
  controller[_started] = false;
  controller[_strategySizeAlgorithm] = sizeAlgorithm;
  controller[_strategyHWM] = highWaterMark;
  controller[_writeAlgorithm] = writeAlgorithm;
  controller[_closeAlgorithm] = closeAlgorithm;
  controller[_abortAlgorithm] = abortAlgorithm;
  const backpressure = writableStreamDefaultControllerGetBackpressure(
    controller,
  );
  writableStreamUpdateBackpressure(stream, backpressure);
  const startResult = startAlgorithm(controller);
  const startPromise = resolvePromiseWith(startResult);
  uponPromise(startPromise, () => {
    assert(stream[_state] === "writable" || stream[_state] === "erroring");
    controller[_started] = true;
    writableStreamDefaultControllerAdvanceQueueIfNeeded(controller);
  }, (r) => {
    assert(stream[_state] === "writable" || stream[_state] === "erroring");
    controller[_started] = true;
    writableStreamDealWithRejection(stream, r);
  });
}

/**
 * @template W
 * @param {WritableStream<W>} stream
 * @param {UnderlyingSink<W>} underlyingSink
 * @param {UnderlyingSink<W>} underlyingSinkDict
 * @param {number} highWaterMark
 * @param {(chunk: W) => number} sizeAlgorithm
 */
function setUpWritableStreamDefaultControllerFromUnderlyingSink(
  stream,
  underlyingSink,
  underlyingSinkDict,
  highWaterMark,
  sizeAlgorithm,
) {
  const controller = webidl.createBranded(WritableStreamDefaultController);
  /** @type {(controller: WritableStreamDefaultController<W>) => any} */
  let startAlgorithm = () => undefined;
  /** @type {(chunk: W, controller: WritableStreamDefaultController<W>) => Promise<void>} */
  let writeAlgorithm = () => resolvePromiseWith(undefined);
  let closeAlgorithm = () => resolvePromiseWith(undefined);
  /** @type {(reason?: any) => Promise<void>} */
  let abortAlgorithm = () => resolvePromiseWith(undefined);

  if (underlyingSinkDict.start !== undefined) {
    startAlgorithm = () =>
      webidl.invokeCallbackFunction(
        underlyingSinkDict.start,
        [controller],
        underlyingSink,
        webidl.converters.any,
        "Failed to call 'startAlgorithm' on 'WritableStreamDefaultController'",
      );
  }
  if (underlyingSinkDict.write !== undefined) {
    writeAlgorithm = (chunk) =>
      webidl.invokeCallbackFunction(
        underlyingSinkDict.write,
        [chunk, controller],
        underlyingSink,
        webidl.converters["Promise<undefined>"],
        "Failed to call 'writeAlgorithm' on 'WritableStreamDefaultController'",
        true,
      );
  }
  if (underlyingSinkDict.close !== undefined) {
    closeAlgorithm = () =>
      webidl.invokeCallbackFunction(
        underlyingSinkDict.close,
        [],
        underlyingSink,
        webidl.converters["Promise<undefined>"],
        "Failed to call 'closeAlgorithm' on 'WritableStreamDefaultController'",
        true,
      );
  }
  if (underlyingSinkDict.abort !== undefined) {
    abortAlgorithm = (reason) =>
      webidl.invokeCallbackFunction(
        underlyingSinkDict.abort,
        [reason],
        underlyingSink,
        webidl.converters["Promise<undefined>"],
        "Failed to call 'abortAlgorithm' on 'WritableStreamDefaultController'",
        true,
      );
  }
  setUpWritableStreamDefaultController(
    stream,
    controller,
    startAlgorithm,
    writeAlgorithm,
    closeAlgorithm,
    abortAlgorithm,
    highWaterMark,
    sizeAlgorithm,
  );
}

/**
 * @template W
 * @param {WritableStreamDefaultWriter<W>} writer
 * @param {WritableStream<W>} stream
 */
function setUpWritableStreamDefaultWriter(writer, stream) {
  if (isWritableStreamLocked(stream) === true) {
    throw new TypeError("The stream is already locked.");
  }
  writer[_stream] = stream;
  stream[_writer] = writer;
  const state = stream[_state];
  if (state === "writable") {
    if (
      writableStreamCloseQueuedOrInFlight(stream) === false &&
      stream[_backpressure] === true
    ) {
      writer[_readyPromise] = new Deferred();
    } else {
      writer[_readyPromise] = new Deferred();
      writer[_readyPromise].resolve(undefined);
    }
    writer[_closedPromise] = new Deferred();
  } else if (state === "erroring") {
    writer[_readyPromise] = new Deferred();
    writer[_readyPromise].reject(stream[_storedError]);
    setPromiseIsHandledToTrue(writer[_readyPromise].promise);
    writer[_closedPromise] = new Deferred();
  } else if (state === "closed") {
    writer[_readyPromise] = new Deferred();
    writer[_readyPromise].resolve(undefined);
    writer[_closedPromise] = new Deferred();
    writer[_closedPromise].resolve(undefined);
  } else {
    assert(state === "errored");
    const storedError = stream[_storedError];
    writer[_readyPromise] = new Deferred();
    writer[_readyPromise].reject(storedError);
    setPromiseIsHandledToTrue(writer[_readyPromise].promise);
    writer[_closedPromise] = new Deferred();
    writer[_closedPromise].reject(storedError);
    setPromiseIsHandledToTrue(writer[_closedPromise].promise);
  }
}

/** @param {TransformStreamDefaultController} controller */
function transformStreamDefaultControllerClearAlgorithms(controller) {
  controller[_transformAlgorithm] = undefined;
  controller[_flushAlgorithm] = undefined;
}

/**
 * @template O
 * @param {TransformStreamDefaultController<O>} controller
 * @param {O} chunk
 */
function transformStreamDefaultControllerEnqueue(controller, chunk) {
  const stream = controller[_stream];
  const readableController = stream[_readable][_controller];
  if (
    readableStreamDefaultControllerCanCloseOrEnqueue(
      /** @type {ReadableStreamDefaultController<O>} */ readableController,
    ) === false
  ) {
    throw new TypeError("Readable stream is unavailable.");
  }
  try {
    readableStreamDefaultControllerEnqueue(
      /** @type {ReadableStreamDefaultController<O>} */ readableController,
      chunk,
    );
  } catch (e) {
    transformStreamErrorWritableAndUnblockWrite(stream, e);
    throw stream[_readable][_storedError];
  }
  const backpressure = readableStreamDefaultcontrollerHasBackpressure(
    /** @type {ReadableStreamDefaultController<O>} */ readableController,
  );
  if (backpressure !== stream[_backpressure]) {
    assert(backpressure === true);
    transformStreamSetBackpressure(stream, true);
  }
}

/**
 * @param {TransformStreamDefaultController} controller
 * @param {any=} e
 */
function transformStreamDefaultControllerError(controller, e) {
  transformStreamError(controller[_stream], e);
}

/**
 * @template O
 * @param {TransformStreamDefaultController<O>} controller
 * @param {any} chunk
 * @returns {Promise<void>}
 */
function transformStreamDefaultControllerPerformTransform(controller, chunk) {
  const transformPromise = controller[_transformAlgorithm](chunk, controller);
  return transformPromiseWith(transformPromise, undefined, (r) => {
    transformStreamError(controller[_stream], r);
    throw r;
  });
}

/** @param {TransformStreamDefaultController} controller */
function transformStreamDefaultControllerTerminate(controller) {
  const stream = controller[_stream];
  const readableController = stream[_readable][_controller];
  readableStreamDefaultControllerClose(
    /** @type {ReadableStreamDefaultController} */ readableController,
  );
  const error = new TypeError("The stream has been terminated.");
  transformStreamErrorWritableAndUnblockWrite(stream, error);
}

/**
 * @param {TransformStream} stream
 * @param {any=} reason
 * @returns {Promise<void>}
 */
function transformStreamDefaultSinkAbortAlgorithm(stream, reason) {
  transformStreamError(stream, reason);
  return resolvePromiseWith(undefined);
}

/**
 * @template I
 * @template O
 * @param {TransformStream<I, O>} stream
 * @returns {Promise<void>}
 */
function transformStreamDefaultSinkCloseAlgorithm(stream) {
  const readable = stream[_readable];
  const controller = stream[_controller];
  const flushPromise = controller[_flushAlgorithm](controller);
  transformStreamDefaultControllerClearAlgorithms(controller);
  return transformPromiseWith(flushPromise, () => {
    if (readable[_state] === "errored") {
      throw readable[_storedError];
    }
    readableStreamDefaultControllerClose(
      /** @type {ReadableStreamDefaultController} */ readable[_controller],
    );
  }, (r) => {
    transformStreamError(stream, r);
    throw readable[_storedError];
  });
}

/**
 * @template I
 * @template O
 * @param {TransformStream<I, O>} stream
 * @param {I} chunk
 * @returns {Promise<void>}
 */
function transformStreamDefaultSinkWriteAlgorithm(stream, chunk) {
  assert(stream[_writable][_state] === "writable");
  const controller = stream[_controller];
  if (stream[_backpressure] === true) {
    const backpressureChangePromise = stream[_backpressureChangePromise];
    assert(backpressureChangePromise !== undefined);
    return transformPromiseWith(backpressureChangePromise.promise, () => {
      const writable = stream[_writable];
      const state = writable[_state];
      if (state === "erroring") {
        throw writable[_storedError];
      }
      assert(state === "writable");
      return transformStreamDefaultControllerPerformTransform(
        controller,
        chunk,
      );
    });
  }
  return transformStreamDefaultControllerPerformTransform(controller, chunk);
}

/**
 * @param {TransformStream} stream
 * @returns {Promise<void>}
 */
function transformStreamDefaultSourcePullAlgorithm(stream) {
  assert(stream[_backpressure] === true);
  assert(stream[_backpressureChangePromise] !== undefined);
  transformStreamSetBackpressure(stream, false);
  return stream[_backpressureChangePromise].promise;
}

/**
 * @param {TransformStream} stream
 * @param {any=} e
 */
function transformStreamError(stream, e) {
  readableStreamDefaultControllerError(
    /** @type {ReadableStreamDefaultController} */ stream[_readable][
      _controller
    ],
    e,
  );
  transformStreamErrorWritableAndUnblockWrite(stream, e);
}

/**
 * @param {TransformStream} stream
 * @param {any=} e
 */
function transformStreamErrorWritableAndUnblockWrite(stream, e) {
  transformStreamDefaultControllerClearAlgorithms(stream[_controller]);
  writableStreamDefaultControllerErrorIfNeeded(
    stream[_writable][_controller],
    e,
  );
  if (stream[_backpressure] === true) {
    transformStreamSetBackpressure(stream, false);
  }
}

/**
 * @param {TransformStream} stream
 * @param {boolean} backpressure
 */
function transformStreamSetBackpressure(stream, backpressure) {
  assert(stream[_backpressure] !== backpressure);
  if (stream[_backpressureChangePromise] !== undefined) {
    stream[_backpressureChangePromise].resolve(undefined);
  }
  stream[_backpressureChangePromise] = new Deferred();
  stream[_backpressure] = backpressure;
}

/**
 * @param {WritableStream} stream
 * @param {any=} reason
 * @returns {Promise<void>}
 */
function writableStreamAbort(stream, reason) {
  const state = stream[_state];
  if (state === "closed" || state === "errored") {
    return resolvePromiseWith(undefined);
  }
  stream[_controller][_signal][signalAbort](reason);
  if (state === "closed" || state === "errored") {
    return resolvePromiseWith(undefined);
  }
  if (stream[_pendingAbortRequest] !== undefined) {
    return stream[_pendingAbortRequest].deferred.promise;
  }
  assert(state === "writable" || state === "erroring");
  let wasAlreadyErroring = false;
  if (state === "erroring") {
    wasAlreadyErroring = true;
    reason = undefined;
  }
  /** Deferred<void> */
  const deferred = new Deferred();
  stream[_pendingAbortRequest] = {
    deferred,
    reason,
    wasAlreadyErroring,
  };
  if (wasAlreadyErroring === false) {
    writableStreamStartErroring(stream, reason);
  }
  return deferred.promise;
}

/**
 * @param {WritableStream} stream
 * @returns {Promise<void>}
 */
function writableStreamAddWriteRequest(stream) {
  assert(isWritableStreamLocked(stream) === true);
  assert(stream[_state] === "writable");
  /** @type {Deferred<void>} */
  const deferred = new Deferred();
  ArrayPrototypePush(stream[_writeRequests], deferred);
  return deferred.promise;
}

/**
 * @param {WritableStream} stream
 * @returns {Promise<void>}
 */
function writableStreamClose(stream) {
  const state = stream[_state];
  if (state === "closed" || state === "errored") {
    return PromiseReject(
      new TypeError("Writable stream is closed or errored."),
    );
  }
  assert(state === "writable" || state === "erroring");
  assert(writableStreamCloseQueuedOrInFlight(stream) === false);
  /** @type {Deferred<void>} */
  const deferred = new Deferred();
  stream[_closeRequest] = deferred;
  const writer = stream[_writer];
  if (
    writer !== undefined && stream[_backpressure] === true &&
    state === "writable"
  ) {
    writer[_readyPromise].resolve(undefined);
  }
  writableStreamDefaultControllerClose(stream[_controller]);
  return deferred.promise;
}

/**
 * @param {WritableStream} stream
 * @returns {boolean}
 */
function writableStreamCloseQueuedOrInFlight(stream) {
  if (
    stream[_closeRequest] === undefined &&
    stream[_inFlightCloseRequest] === undefined
  ) {
    return false;
  }
  return true;
}

/**
 * @param {WritableStream} stream
 * @param {any=} error
 */
function writableStreamDealWithRejection(stream, error) {
  const state = stream[_state];
  if (state === "writable") {
    writableStreamStartErroring(stream, error);
    return;
  }
  assert(state === "erroring");
  writableStreamFinishErroring(stream);
}

/**
 * @template W
 * @param {WritableStreamDefaultController<W>} controller
 */
function writableStreamDefaultControllerAdvanceQueueIfNeeded(controller) {
  const stream = controller[_stream];
  if (controller[_started] === false) {
    return;
  }
  if (stream[_inFlightWriteRequest] !== undefined) {
    return;
  }
  const state = stream[_state];
  assert(state !== "closed" && state !== "errored");
  if (state === "erroring") {
    writableStreamFinishErroring(stream);
    return;
  }
  if (controller[_queue].length === 0) {
    return;
  }
  const value = peekQueueValue(controller);
  if (value === _close) {
    writableStreamDefaultControllerProcessClose(controller);
  } else {
    writableStreamDefaultControllerProcessWrite(controller, value);
  }
}

function writableStreamDefaultControllerClearAlgorithms(controller) {
  controller[_writeAlgorithm] = undefined;
  controller[_closeAlgorithm] = undefined;
  controller[_abortAlgorithm] = undefined;
  controller[_strategySizeAlgorithm] = undefined;
}

/** @param {WritableStreamDefaultController} controller */
function writableStreamDefaultControllerClose(controller) {
  enqueueValueWithSize(controller, _close, 0);
  writableStreamDefaultControllerAdvanceQueueIfNeeded(controller);
}

/**
 * @param {WritableStreamDefaultController} controller
 * @param {any} error
 */
function writableStreamDefaultControllerError(controller, error) {
  const stream = controller[_stream];
  assert(stream[_state] === "writable");
  writableStreamDefaultControllerClearAlgorithms(controller);
  writableStreamStartErroring(stream, error);
}

/**
 * @param {WritableStreamDefaultController} controller
 * @param {any} error
 */
function writableStreamDefaultControllerErrorIfNeeded(controller, error) {
  if (controller[_stream][_state] === "writable") {
    writableStreamDefaultControllerError(controller, error);
  }
}

/**
 * @param {WritableStreamDefaultController} controller
 * @returns {boolean}
 */
function writableStreamDefaultControllerGetBackpressure(controller) {
  const desiredSize = writableStreamDefaultControllerGetDesiredSize(
    controller,
  );
  return desiredSize <= 0;
}

/**
 * @template W
 * @param {WritableStreamDefaultController<W>} controller
 * @param {W} chunk
 * @returns {number}
 */
function writableStreamDefaultControllerGetChunkSize(controller, chunk) {
  let value;
  try {
    value = controller[_strategySizeAlgorithm](chunk);
  } catch (e) {
    writableStreamDefaultControllerErrorIfNeeded(controller, e);
    return 1;
  }
  return value;
}

/**
 * @param {WritableStreamDefaultController} controller
 * @returns {number}
 */
function writableStreamDefaultControllerGetDesiredSize(controller) {
  return controller[_strategyHWM] - controller[_queueTotalSize];
}

/** @param {WritableStreamDefaultController} controller */
function writableStreamDefaultControllerProcessClose(controller) {
  const stream = controller[_stream];
  writableStreamMarkCloseRequestInFlight(stream);
  dequeueValue(controller);
  assert(controller[_queue].length === 0);
  const sinkClosePromise = controller[_closeAlgorithm]();
  writableStreamDefaultControllerClearAlgorithms(controller);
  uponPromise(sinkClosePromise, () => {
    writableStreamFinishInFlightClose(stream);
  }, (reason) => {
    writableStreamFinishInFlightCloseWithError(stream, reason);
  });
}

/**
 * @template W
 * @param {WritableStreamDefaultController<W>} controller
 * @param {W} chunk
 */
function writableStreamDefaultControllerProcessWrite(controller, chunk) {
  const stream = controller[_stream];
  writableStreamMarkFirstWriteRequestInFlight(stream);
  const sinkWritePromise = controller[_writeAlgorithm](chunk, controller);
  uponPromise(sinkWritePromise, () => {
    writableStreamFinishInFlightWrite(stream);
    const state = stream[_state];
    assert(state === "writable" || state === "erroring");
    dequeueValue(controller);
    if (
      writableStreamCloseQueuedOrInFlight(stream) === false &&
      state === "writable"
    ) {
      const backpressure = writableStreamDefaultControllerGetBackpressure(
        controller,
      );
      writableStreamUpdateBackpressure(stream, backpressure);
    }
    writableStreamDefaultControllerAdvanceQueueIfNeeded(controller);
  }, (reason) => {
    if (stream[_state] === "writable") {
      writableStreamDefaultControllerClearAlgorithms(controller);
    }
    writableStreamFinishInFlightWriteWithError(stream, reason);
  });
}

/**
 * @template W
 * @param {WritableStreamDefaultController<W>} controller
 * @param {W} chunk
 * @param {number} chunkSize
 */
function writableStreamDefaultControllerWrite(controller, chunk, chunkSize) {
  try {
    enqueueValueWithSize(controller, chunk, chunkSize);
  } catch (e) {
    writableStreamDefaultControllerErrorIfNeeded(controller, e);
    return;
  }
  const stream = controller[_stream];
  if (
    writableStreamCloseQueuedOrInFlight(stream) === false &&
    stream[_state] === "writable"
  ) {
    const backpressure = writableStreamDefaultControllerGetBackpressure(
      controller,
    );
    writableStreamUpdateBackpressure(stream, backpressure);
  }
  writableStreamDefaultControllerAdvanceQueueIfNeeded(controller);
}

/**
 * @param {WritableStreamDefaultWriter} writer
 * @param {any=} reason
 * @returns {Promise<void>}
 */
function writableStreamDefaultWriterAbort(writer, reason) {
  const stream = writer[_stream];
  assert(stream !== undefined);
  return writableStreamAbort(stream, reason);
}

/**
 * @param {WritableStreamDefaultWriter} writer
 * @returns {Promise<void>}
 */
function writableStreamDefaultWriterClose(writer) {
  const stream = writer[_stream];
  assert(stream !== undefined);
  return writableStreamClose(stream);
}

/**
 * @param {WritableStreamDefaultWriter} writer
 * @returns {Promise<void>}
 */
function writableStreamDefaultWriterCloseWithErrorPropagation(writer) {
  const stream = writer[_stream];
  assert(stream !== undefined);
  const state = stream[_state];
  if (
    writableStreamCloseQueuedOrInFlight(stream) === true || state === "closed"
  ) {
    return resolvePromiseWith(undefined);
  }
  if (state === "errored") {
    return PromiseReject(stream[_storedError]);
  }
  assert(state === "writable" || state === "erroring");
  return writableStreamDefaultWriterClose(writer);
}

/**
 * @param {WritableStreamDefaultWriter} writer
 * @param {any=} error
 */
function writableStreamDefaultWriterEnsureClosedPromiseRejected(
  writer,
  error,
) {
  if (writer[_closedPromise].state === "pending") {
    writer[_closedPromise].reject(error);
  } else {
    writer[_closedPromise] = new Deferred();
    writer[_closedPromise].reject(error);
  }
  setPromiseIsHandledToTrue(writer[_closedPromise].promise);
}

/**
 * @param {WritableStreamDefaultWriter} writer
 * @param {any=} error
 */
function writableStreamDefaultWriterEnsureReadyPromiseRejected(
  writer,
  error,
) {
  if (writer[_readyPromise].state === "pending") {
    writer[_readyPromise].reject(error);
  } else {
    writer[_readyPromise] = new Deferred();
    writer[_readyPromise].reject(error);
  }
  setPromiseIsHandledToTrue(writer[_readyPromise].promise);
}

/**
 * @param {WritableStreamDefaultWriter} writer
 * @returns {number | null}
 */
function writableStreamDefaultWriterGetDesiredSize(writer) {
  const stream = writer[_stream];
  const state = stream[_state];
  if (state === "errored" || state === "erroring") {
    return null;
  }
  if (state === "closed") {
    return 0;
  }
  return writableStreamDefaultControllerGetDesiredSize(stream[_controller]);
}

/** @param {WritableStreamDefaultWriter} writer */
function writableStreamDefaultWriterRelease(writer) {
  const stream = writer[_stream];
  assert(stream !== undefined);
  assert(stream[_writer] === writer);
  const releasedError = new TypeError(
    "The writer has already been released.",
  );
  writableStreamDefaultWriterEnsureReadyPromiseRejected(
    writer,
    releasedError,
  );
  writableStreamDefaultWriterEnsureClosedPromiseRejected(
    writer,
    releasedError,
  );
  stream[_writer] = undefined;
  writer[_stream] = undefined;
}

/**
 * @template W
 * @param {WritableStreamDefaultWriter<W>} writer
 * @param {W} chunk
 * @returns {Promise<void>}
 */
function writableStreamDefaultWriterWrite(writer, chunk) {
  const stream = writer[_stream];
  assert(stream !== undefined);
  const controller = stream[_controller];
  const chunkSize = writableStreamDefaultControllerGetChunkSize(
    controller,
    chunk,
  );
  if (stream !== writer[_stream]) {
    return PromiseReject(new TypeError("Writer's stream is unexpected."));
  }
  const state = stream[_state];
  if (state === "errored") {
    return PromiseReject(stream[_storedError]);
  }
  if (
    writableStreamCloseQueuedOrInFlight(stream) === true || state === "closed"
  ) {
    return PromiseReject(
      new TypeError("The stream is closing or is closed."),
    );
  }
  if (state === "erroring") {
    return PromiseReject(stream[_storedError]);
  }
  assert(state === "writable");
  const promise = writableStreamAddWriteRequest(stream);
  writableStreamDefaultControllerWrite(controller, chunk, chunkSize);
  return promise;
}

/** @param {WritableStream} stream */
function writableStreamFinishErroring(stream) {
  assert(stream[_state] === "erroring");
  assert(writableStreamHasOperationMarkedInFlight(stream) === false);
  stream[_state] = "errored";
  stream[_controller][_errorSteps]();
  const storedError = stream[_storedError];
  const writeRequests = stream[_writeRequests];
  for (let i = 0; i < writeRequests.length; ++i) {
    const writeRequest = writeRequests[i];
    writeRequest.reject(storedError);
  }
  stream[_writeRequests] = [];
  if (stream[_pendingAbortRequest] === undefined) {
    writableStreamRejectCloseAndClosedPromiseIfNeeded(stream);
    return;
  }
  const abortRequest = stream[_pendingAbortRequest];
  stream[_pendingAbortRequest] = undefined;
  if (abortRequest.wasAlreadyErroring === true) {
    abortRequest.deferred.reject(storedError);
    writableStreamRejectCloseAndClosedPromiseIfNeeded(stream);
    return;
  }
  const promise = stream[_controller][_abortSteps](abortRequest.reason);
  uponPromise(promise, () => {
    abortRequest.deferred.resolve(undefined);
    writableStreamRejectCloseAndClosedPromiseIfNeeded(stream);
  }, (reason) => {
    abortRequest.deferred.reject(reason);
    writableStreamRejectCloseAndClosedPromiseIfNeeded(stream);
  });
}

/** @param {WritableStream} stream */
function writableStreamFinishInFlightClose(stream) {
  assert(stream[_inFlightCloseRequest] !== undefined);
  stream[_inFlightCloseRequest].resolve(undefined);
  stream[_inFlightCloseRequest] = undefined;
  const state = stream[_state];
  assert(state === "writable" || state === "erroring");
  if (state === "erroring") {
    stream[_storedError] = undefined;
    if (stream[_pendingAbortRequest] !== undefined) {
      stream[_pendingAbortRequest].deferred.resolve(undefined);
      stream[_pendingAbortRequest] = undefined;
    }
  }
  stream[_state] = "closed";
  const writer = stream[_writer];
  if (writer !== undefined) {
    writer[_closedPromise].resolve(undefined);
  }
  assert(stream[_pendingAbortRequest] === undefined);
  assert(stream[_storedError] === undefined);
}

/**
 * @param {WritableStream} stream
 * @param {any=} error
 */
function writableStreamFinishInFlightCloseWithError(stream, error) {
  assert(stream[_inFlightCloseRequest] !== undefined);
  stream[_inFlightCloseRequest].reject(error);
  stream[_inFlightCloseRequest] = undefined;
  assert(stream[_state] === "writable" || stream[_state] === "erroring");
  if (stream[_pendingAbortRequest] !== undefined) {
    stream[_pendingAbortRequest].deferred.reject(error);
    stream[_pendingAbortRequest] = undefined;
  }
  writableStreamDealWithRejection(stream, error);
}

/** @param {WritableStream} stream */
function writableStreamFinishInFlightWrite(stream) {
  assert(stream[_inFlightWriteRequest] !== undefined);
  stream[_inFlightWriteRequest].resolve(undefined);
  stream[_inFlightWriteRequest] = undefined;
}

/**
 * @param {WritableStream} stream
 * @param {any=} error
 */
function writableStreamFinishInFlightWriteWithError(stream, error) {
  assert(stream[_inFlightWriteRequest] !== undefined);
  stream[_inFlightWriteRequest].reject(error);
  stream[_inFlightWriteRequest] = undefined;
  assert(stream[_state] === "writable" || stream[_state] === "erroring");
  writableStreamDealWithRejection(stream, error);
}

/**
 * @param {WritableStream} stream
 * @returns {boolean}
 */
function writableStreamHasOperationMarkedInFlight(stream) {
  if (
    stream[_inFlightWriteRequest] === undefined &&
    stream[_inFlightCloseRequest] === undefined
  ) {
    return false;
  }
  return true;
}

/** @param {WritableStream} stream */
function writableStreamMarkCloseRequestInFlight(stream) {
  assert(stream[_inFlightCloseRequest] === undefined);
  assert(stream[_closeRequest] !== undefined);
  stream[_inFlightCloseRequest] = stream[_closeRequest];
  stream[_closeRequest] = undefined;
}

/**
 * @template W
 * @param {WritableStream<W>} stream
 */
function writableStreamMarkFirstWriteRequestInFlight(stream) {
  assert(stream[_inFlightWriteRequest] === undefined);
  assert(stream[_writeRequests].length);
  const writeRequest = ArrayPrototypeShift(stream[_writeRequests]);
  stream[_inFlightWriteRequest] = writeRequest;
}

/** @param {WritableStream} stream */
function writableStreamRejectCloseAndClosedPromiseIfNeeded(stream) {
  assert(stream[_state] === "errored");
  if (stream[_closeRequest] !== undefined) {
    assert(stream[_inFlightCloseRequest] === undefined);
    stream[_closeRequest].reject(stream[_storedError]);
    stream[_closeRequest] = undefined;
  }
  const writer = stream[_writer];
  if (writer !== undefined) {
    writer[_closedPromise].reject(stream[_storedError]);
    setPromiseIsHandledToTrue(writer[_closedPromise].promise);
  }
}

/**
 * @param {WritableStream} stream
 * @param {any=} reason
 */
function writableStreamStartErroring(stream, reason) {
  assert(stream[_storedError] === undefined);
  assert(stream[_state] === "writable");
  const controller = stream[_controller];
  assert(controller !== undefined);
  stream[_state] = "erroring";
  stream[_storedError] = reason;
  const writer = stream[_writer];
  if (writer !== undefined) {
    writableStreamDefaultWriterEnsureReadyPromiseRejected(writer, reason);
  }
  if (
    writableStreamHasOperationMarkedInFlight(stream) === false &&
    controller[_started] === true
  ) {
    writableStreamFinishErroring(stream);
  }
}

/**
 * @param {WritableStream} stream
 * @param {boolean} backpressure
 */
function writableStreamUpdateBackpressure(stream, backpressure) {
  assert(stream[_state] === "writable");
  assert(writableStreamCloseQueuedOrInFlight(stream) === false);
  const writer = stream[_writer];
  if (writer !== undefined && backpressure !== stream[_backpressure]) {
    if (backpressure === true) {
      writer[_readyPromise] = new Deferred();
    } else {
      assert(backpressure === false);
      writer[_readyPromise].resolve(undefined);
    }
  }
  stream[_backpressure] = backpressure;
}

/** @type {AsyncIterator<unknown, unknown>} */
const asyncIteratorPrototype = ObjectGetPrototypeOf(AsyncGeneratorPrototype);

const _iteratorNext = Symbol("[[iteratorNext]]");
const _iteratorFinished = Symbol("[[iteratorFinished]]");

/** @type {AsyncIterator<unknown>} */
const readableStreamAsyncIteratorPrototype = ObjectSetPrototypeOf({
  /** @returns {Promise<IteratorResult<unknown>>} */
  next() {
    /** @type {ReadableStreamDefaultReader} */
    const reader = this[_reader];
    function nextSteps() {
      if (reader[_iteratorFinished]) {
        return PromiseResolve({ value: undefined, done: true });
      }

      if (reader[_stream] === undefined) {
        return PromiseReject(
          new TypeError(
            "Cannot get the next iteration result once the reader has been released.",
          ),
        );
      }

      /** @type {Deferred<IteratorResult<any>>} */
      const promise = new Deferred();
      /** @type {ReadRequest} */
      const readRequest = {
        chunkSteps(chunk) {
          promise.resolve({ value: chunk, done: false });
        },
        closeSteps() {
          readableStreamDefaultReaderRelease(reader);
          promise.resolve({ value: undefined, done: true });
        },
        errorSteps(e) {
          readableStreamDefaultReaderRelease(reader);
          promise.reject(e);
        },
      };

      readableStreamDefaultReaderRead(reader, readRequest);
      return PromisePrototypeThen(promise.promise, (result) => {
        reader[_iteratorNext] = null;
        if (result.done === true) {
          reader[_iteratorFinished] = true;
          return { value: undefined, done: true };
        }
        return result;
      }, (reason) => {
        reader[_iteratorNext] = null;
        reader[_iteratorFinished] = true;
        throw reason;
      });
    }

    reader[_iteratorNext] = reader[_iteratorNext]
      ? PromisePrototypeThen(reader[_iteratorNext], nextSteps, nextSteps)
      : nextSteps();

    return reader[_iteratorNext];
  },
  /**
   * @param {unknown} arg
   * @returns {Promise<IteratorResult<unknown>>}
   */
  return(arg) {
    /** @type {ReadableStreamDefaultReader} */
    const reader = this[_reader];
    const returnSteps = () => {
      if (reader[_iteratorFinished]) {
        return PromiseResolve({ value: arg, done: true });
      }
      reader[_iteratorFinished] = true;

      if (reader[_stream] === undefined) {
        return PromiseResolve({ value: undefined, done: true });
      }
      assert(reader[_readRequests].length === 0);
      if (this[_preventCancel] === false) {
        const result = readableStreamReaderGenericCancel(reader, arg);
        readableStreamDefaultReaderRelease(reader);
        return result;
      }
      readableStreamDefaultReaderRelease(reader);
      return PromiseResolve({ value: undefined, done: true });
    };

    const returnPromise = reader[_iteratorNext]
      ? PromisePrototypeThen(reader[_iteratorNext], returnSteps, returnSteps)
      : returnSteps();
    return PromisePrototypeThen(
      returnPromise,
      () => ({ value: arg, done: true }),
    );
  },
}, asyncIteratorPrototype);

class ByteLengthQueuingStrategy {
  /** @param {{ highWaterMark: number }} init */
  constructor(init) {
    const prefix = "Failed to construct 'ByteLengthQueuingStrategy'";
    webidl.requiredArguments(arguments.length, 1, prefix);
    init = webidl.converters.QueuingStrategyInit(init, prefix, "Argument 1");
    this[webidl.brand] = webidl.brand;
    this[_globalObject] = globalThis;
    this[_highWaterMark] = init.highWaterMark;
  }

  /** @returns {number} */
  get highWaterMark() {
    webidl.assertBranded(this, ByteLengthQueuingStrategyPrototype);
    return this[_highWaterMark];
  }

  /** @returns {(chunk: ArrayBufferView) => number} */
  get size() {
    webidl.assertBranded(this, ByteLengthQueuingStrategyPrototype);
    initializeByteLengthSizeFunction(this[_globalObject]);
    return WeakMapPrototypeGet(byteSizeFunctionWeakMap, this[_globalObject]);
  }

  [SymbolFor("Deno.customInspect")](inspect) {
    return inspect(createFilteredInspectProxy({
      object: this,
      evaluate: ObjectPrototypeIsPrototypeOf(
        ByteLengthQueuingStrategyPrototype,
        this,
      ),
      keys: [
        "highWaterMark",
        "size",
      ],
    }));
  }
}

webidl.configurePrototype(ByteLengthQueuingStrategy);
const ByteLengthQueuingStrategyPrototype = ByteLengthQueuingStrategy.prototype;

/** @type {WeakMap<typeof globalThis, (chunk: ArrayBufferView) => number>} */
const byteSizeFunctionWeakMap = new SafeWeakMap();

function initializeByteLengthSizeFunction(globalObject) {
  if (WeakMapPrototypeHas(byteSizeFunctionWeakMap, globalObject)) {
    return;
  }
  // deno-lint-ignore prefer-primordials
  const size = (chunk) => chunk.byteLength;
  WeakMapPrototypeSet(byteSizeFunctionWeakMap, globalObject, size);
}

class CountQueuingStrategy {
  /** @param {{ highWaterMark: number }} init */
  constructor(init) {
    const prefix = "Failed to construct 'CountQueuingStrategy'";
    webidl.requiredArguments(arguments.length, 1, prefix);
    init = webidl.converters.QueuingStrategyInit(init, prefix, "Argument 1");
    this[webidl.brand] = webidl.brand;
    this[_globalObject] = globalThis;
    this[_highWaterMark] = init.highWaterMark;
  }

  /** @returns {number} */
  get highWaterMark() {
    webidl.assertBranded(this, CountQueuingStrategyPrototype);
    return this[_highWaterMark];
  }

  /** @returns {(chunk: any) => 1} */
  get size() {
    webidl.assertBranded(this, CountQueuingStrategyPrototype);
    initializeCountSizeFunction(this[_globalObject]);
    return WeakMapPrototypeGet(countSizeFunctionWeakMap, this[_globalObject]);
  }

  [SymbolFor("Deno.customInspect")](inspect) {
    return inspect(createFilteredInspectProxy({
      object: this,
      evaluate: ObjectPrototypeIsPrototypeOf(
        CountQueuingStrategyPrototype,
        this,
      ),
      keys: [
        "highWaterMark",
        "size",
      ],
    }));
  }
}

webidl.configurePrototype(CountQueuingStrategy);
const CountQueuingStrategyPrototype = CountQueuingStrategy.prototype;

/** @type {WeakMap<typeof globalThis, () => 1>} */
const countSizeFunctionWeakMap = new SafeWeakMap();

/** @param {typeof globalThis} globalObject */
function initializeCountSizeFunction(globalObject) {
  if (WeakMapPrototypeHas(countSizeFunctionWeakMap, globalObject)) {
    return;
  }
  const size = () => 1;
  WeakMapPrototypeSet(countSizeFunctionWeakMap, globalObject, size);
}

async function* createAsyncFromSyncIterator(syncIterator) {
  // deno-lint-ignore prefer-primordials
  yield* syncIterator;
}

// Ref: https://tc39.es/ecma262/#sec-getiterator
function getIterator(obj, async = false) {
  if (async) {
    if (obj[SymbolAsyncIterator] === undefined) {
      if (obj[SymbolIterator] === undefined) {
        throw new TypeError("No iterator found");
      }
      return createAsyncFromSyncIterator(obj[SymbolIterator]());
    } else {
      return obj[SymbolAsyncIterator]();
    }
  } else {
    if (obj[SymbolIterator] === undefined) {
      throw new TypeError("No iterator found");
    }
    return obj[SymbolIterator]();
  }
}

const _resourceBacking = Symbol("[[resourceBacking]]");
// This distinction exists to prevent unrefable streams being used in
// regular fast streams that are unaware of refability
const _resourceBackingUnrefable = Symbol("[[resourceBackingUnrefable]]");
/** @template R */
class ReadableStream {
  /** @type {ReadableStreamDefaultController | ReadableByteStreamController} */
  [_controller];
  /** @type {boolean} */
  [_detached];
  /** @type {boolean} */
  [_disturbed];
  /** @type {ReadableStreamDefaultReader | ReadableStreamBYOBReader} */
  [_reader];
  /** @type {"readable" | "closed" | "errored"} */
  [_state];
  /** @type {any} */
  [_storedError];
  /** @type {{ rid: number, autoClose: boolean } | null} */
  [_resourceBacking] = null;

  /**
   * @param {UnderlyingSource<R>=} underlyingSource
   * @param {QueuingStrategy<R>=} strategy
   */
  constructor(underlyingSource = undefined, strategy = undefined) {
    const prefix = "Failed to construct 'ReadableStream'";
    if (underlyingSource !== undefined) {
      underlyingSource = webidl.converters.object(
        underlyingSource,
        prefix,
        "Argument 1",
      );
    } else {
      underlyingSource = null;
    }
    if (strategy !== undefined) {
      strategy = webidl.converters.QueuingStrategy(
        strategy,
        prefix,
        "Argument 2",
      );
    } else {
      strategy = {};
    }
    this[webidl.brand] = webidl.brand;
    let underlyingSourceDict = {};
    if (underlyingSource !== undefined) {
      underlyingSourceDict = webidl.converters.UnderlyingSource(
        underlyingSource,
        prefix,
        "underlyingSource",
      );
    }
    initializeReadableStream(this);
    if (underlyingSourceDict.type === "bytes") {
      if (strategy.size !== undefined) {
        throw new RangeError(
          `${prefix}: When underlying source is "bytes", strategy.size must be undefined.`,
        );
      }
      const highWaterMark = extractHighWaterMark(strategy, 0);
      setUpReadableByteStreamControllerFromUnderlyingSource(
        // @ts-ignore cannot easily assert this is ReadableStream<ArrayBuffer>
        this,
        underlyingSource,
        underlyingSourceDict,
        highWaterMark,
      );
    } else {
      assert(!(ReflectHas(underlyingSourceDict, "type")));
      const sizeAlgorithm = extractSizeAlgorithm(strategy);
      const highWaterMark = extractHighWaterMark(strategy, 1);
      setUpReadableStreamDefaultControllerFromUnderlyingSource(
        this,
        underlyingSource,
        underlyingSourceDict,
        highWaterMark,
        sizeAlgorithm,
      );
    }
  }

  static from(asyncIterable) {
    webidl.requiredArguments(
      arguments.length,
      1,
      "Failed to call 'ReadableStream.from'",
    );
    asyncIterable = webidl.converters.any(asyncIterable);

    const iterator = getIterator(asyncIterable, true);

    const stream = createReadableStream(() => undefined, async () => {
      // deno-lint-ignore prefer-primordials
      const res = await iterator.next();
      if (typeof res !== "object") {
        throw new TypeError("iterator.next value is not an object");
      }
      if (res.done) {
        readableStreamDefaultControllerClose(stream[_controller]);
      } else {
        readableStreamDefaultControllerEnqueue(stream[_controller], res.value);
      }
    }, async (reason) => {
      if (typeof iterator.return === "undefined") {
        return undefined;
      } else {
        // deno-lint-ignore prefer-primordials
        const res = await iterator.return(reason);
        if (typeof res !== "object") {
          throw new TypeError("iterator.return value is not an object");
        } else {
          return undefined;
        }
      }
    }, 0);
    return stream;
  }

  /** @returns {boolean} */
  get locked() {
    webidl.assertBranded(this, ReadableStreamPrototype);
    return isReadableStreamLocked(this);
  }

  /**
   * @param {any=} reason
   * @returns {Promise<void>}
   */
  cancel(reason = undefined) {
    try {
      webidl.assertBranded(this, ReadableStreamPrototype);
      if (reason !== undefined) {
        reason = webidl.converters.any(reason);
      }
    } catch (err) {
      return PromiseReject(err);
    }
    if (isReadableStreamLocked(this)) {
      return PromiseReject(
        new TypeError("Cannot cancel a locked ReadableStream."),
      );
    }
    return readableStreamCancel(this, reason);
  }

  /**
   * @param {ReadableStreamGetReaderOptions=} options
   * @returns {ReadableStreamDefaultReader<R> | ReadableStreamBYOBReader}
   */
  getReader(options = undefined) {
    webidl.assertBranded(this, ReadableStreamPrototype);
    const prefix = "Failed to execute 'getReader' on 'ReadableStream'";
    if (options !== undefined) {
      options = webidl.converters.ReadableStreamGetReaderOptions(
        options,
        prefix,
        "Argument 1",
      );
    } else {
      options = {};
    }
    if (options.mode === undefined) {
      return acquireReadableStreamDefaultReader(this);
    } else {
      assert(options.mode === "byob");
      return acquireReadableStreamBYOBReader(this);
    }
  }

  /**
   * @template T
   * @param {{ readable: ReadableStream<T>, writable: WritableStream<R> }} transform
   * @param {PipeOptions=} options
   * @returns {ReadableStream<T>}
   */
  pipeThrough(transform, options = {}) {
    webidl.assertBranded(this, ReadableStreamPrototype);
    const prefix = "Failed to execute 'pipeThrough' on 'ReadableStream'";
    webidl.requiredArguments(arguments.length, 1, prefix);
    transform = webidl.converters.ReadableWritablePair(
      transform,
      prefix,
      "Argument 1",
    );
    options = webidl.converters.StreamPipeOptions(
      options,
      prefix,
      "Argument 2",
    );
    const { readable, writable } = transform;
    const { preventClose, preventAbort, preventCancel, signal } = options;
    if (isReadableStreamLocked(this)) {
      throw new TypeError("ReadableStream is already locked.");
    }
    if (isWritableStreamLocked(writable)) {
      throw new TypeError("Target WritableStream is already locked.");
    }
    const promise = readableStreamPipeTo(
      this,
      writable,
      preventClose,
      preventAbort,
      preventCancel,
      signal,
    );
    setPromiseIsHandledToTrue(promise);
    return readable;
  }

  /**
   * @param {WritableStream<R>} destination
   * @param {PipeOptions=} options
   * @returns {Promise<void>}
   */
  pipeTo(destination, options = {}) {
    try {
      webidl.assertBranded(this, ReadableStreamPrototype);
      const prefix = "Failed to execute 'pipeTo' on 'ReadableStream'";
      webidl.requiredArguments(arguments.length, 1, prefix);
      destination = webidl.converters.WritableStream(
        destination,
        prefix,
        "Argument 1",
      );
      options = webidl.converters.StreamPipeOptions(
        options,
        prefix,
        "Argument 2",
      );
    } catch (err) {
      return PromiseReject(err);
    }
    const { preventClose, preventAbort, preventCancel, signal } = options;
    if (isReadableStreamLocked(this)) {
      return PromiseReject(
        new TypeError("ReadableStream is already locked."),
      );
    }
    if (isWritableStreamLocked(destination)) {
      return PromiseReject(
        new TypeError("destination WritableStream is already locked."),
      );
    }
    return readableStreamPipeTo(
      this,
      destination,
      preventClose,
      preventAbort,
      preventCancel,
      signal,
    );
  }

  /** @returns {[ReadableStream<R>, ReadableStream<R>]} */
  tee() {
    webidl.assertBranded(this, ReadableStreamPrototype);
    return readableStreamTee(this, false);
  }

  // TODO(lucacasonato): should be moved to webidl crate
  /**
   * @param {ReadableStreamIteratorOptions=} options
   * @returns {AsyncIterableIterator<R>}
   */
  values(options = {}) {
    webidl.assertBranded(this, ReadableStreamPrototype);
    const prefix = "Failed to execute 'values' on 'ReadableStream'";
    options = webidl.converters.ReadableStreamIteratorOptions(
      options,
      prefix,
      "Argument 1",
    );
    /** @type {AsyncIterableIterator<R>} */
    const iterator = ObjectCreate(readableStreamAsyncIteratorPrototype);
    const reader = acquireReadableStreamDefaultReader(this);
    iterator[_reader] = reader;
    iterator[_preventCancel] = options.preventCancel;
    return iterator;
  }

  [SymbolFor("Deno.privateCustomInspect")](inspect) {
    return `${this.constructor.name} ${inspect({ locked: this.locked })}`;
  }
}

// TODO(lucacasonato): should be moved to webidl crate
ReadableStream.prototype[SymbolAsyncIterator] = ReadableStream.prototype.values;
ObjectDefineProperty(ReadableStream.prototype, SymbolAsyncIterator, {
  writable: true,
  enumerable: false,
  configurable: true,
});

webidl.configurePrototype(ReadableStream);
const ReadableStreamPrototype = ReadableStream.prototype;

function errorReadableStream(stream, e) {
  readableStreamDefaultControllerError(stream[_controller], e);
}

/** @template R */
class ReadableStreamDefaultReader {
  /** @type {Deferred<void>} */
  [_closedPromise];
  /** @type {ReadableStream<R> | undefined} */
  [_stream];
  /** @type {ReadRequest[]} */
  [_readRequests];

  /** @param {ReadableStream<R>} stream */
  constructor(stream) {
    const prefix = "Failed to construct 'ReadableStreamDefaultReader'";
    webidl.requiredArguments(arguments.length, 1, prefix);
    stream = webidl.converters.ReadableStream(stream, prefix, "Argument 1");
    this[webidl.brand] = webidl.brand;
    setUpReadableStreamDefaultReader(this, stream);
  }

  /** @returns {Promise<ReadableStreamReadResult<R>>} */
  read() {
    try {
      webidl.assertBranded(this, ReadableStreamDefaultReaderPrototype);
    } catch (err) {
      return PromiseReject(err);
    }
    if (this[_stream] === undefined) {
      return PromiseReject(
        new TypeError("Reader has no associated stream."),
      );
    }
    /** @type {Deferred<ReadableStreamReadResult<R>>} */
    const promise = new Deferred();
    /** @type {ReadRequest<R>} */
    const readRequest = {
      chunkSteps(chunk) {
        promise.resolve({ value: chunk, done: false });
      },
      closeSteps() {
        promise.resolve({ value: undefined, done: true });
      },
      errorSteps(e) {
        promise.reject(e);
      },
    };
    readableStreamDefaultReaderRead(this, readRequest);
    return promise.promise;
  }

  /** @returns {void} */
  releaseLock() {
    webidl.assertBranded(this, ReadableStreamDefaultReaderPrototype);
    if (this[_stream] === undefined) {
      return;
    }
    readableStreamDefaultReaderRelease(this);
  }

  get closed() {
    try {
      webidl.assertBranded(this, ReadableStreamDefaultReaderPrototype);
    } catch (err) {
      return PromiseReject(err);
    }
    return this[_closedPromise].promise;
  }

  /**
   * @param {any} reason
   * @returns {Promise<void>}
   */
  cancel(reason = undefined) {
    try {
      webidl.assertBranded(this, ReadableStreamDefaultReaderPrototype);
      if (reason !== undefined) {
        reason = webidl.converters.any(reason);
      }
    } catch (err) {
      return PromiseReject(err);
    }

    if (this[_stream] === undefined) {
      return PromiseReject(
        new TypeError("Reader has no associated stream."),
      );
    }
    return readableStreamReaderGenericCancel(this, reason);
  }

  [SymbolFor("Deno.privateCustomInspect")](inspect) {
    return `${this.constructor.name} ${inspect({ closed: this.closed })}`;
  }
}

webidl.configurePrototype(ReadableStreamDefaultReader);
const ReadableStreamDefaultReaderPrototype =
  ReadableStreamDefaultReader.prototype;

/** @template R */
class ReadableStreamBYOBReader {
  /** @type {Deferred<void>} */
  [_closedPromise];
  /** @type {ReadableStream<R> | undefined} */
  [_stream];
  /** @type {ReadIntoRequest[]} */
  [_readIntoRequests];

  /** @param {ReadableStream<R>} stream */
  constructor(stream) {
    const prefix = "Failed to construct 'ReadableStreamBYOBReader'";
    webidl.requiredArguments(arguments.length, 1, prefix);
    stream = webidl.converters.ReadableStream(stream, prefix, "Argument 1");
    this[webidl.brand] = webidl.brand;
    setUpReadableStreamBYOBReader(this, stream);
  }

  /**
   * @param {ArrayBufferView} view
   *  @returns {Promise<ReadableStreamBYOBReadResult>}
   */
  read(view) {
    try {
      webidl.assertBranded(this, ReadableStreamBYOBReaderPrototype);
      const prefix = "Failed to execute 'read' on 'ReadableStreamBYOBReader'";
      view = webidl.converters.ArrayBufferView(view, prefix, "Argument 1");
    } catch (err) {
      return PromiseReject(err);
    }

    let buffer, byteLength;
    if (TypedArrayPrototypeGetSymbolToStringTag(view) === undefined) {
      buffer = DataViewPrototypeGetBuffer(/** @type {DataView} */ (view));
      byteLength = DataViewPrototypeGetByteLength(
        /** @type {DataView} */ (view),
      );
    } else {
      buffer = TypedArrayPrototypeGetBuffer(/** @type {Uint8Array} */ (view));
      byteLength = TypedArrayPrototypeGetByteLength(
        /** @type {Uint8Array} */ (view),
      );
    }
    if (byteLength === 0) {
      return PromiseReject(
        new TypeError("view must have non-zero byteLength"),
      );
    }
    if (getArrayBufferByteLength(buffer) === 0) {
      return PromiseReject(
        new TypeError("view's buffer must have non-zero byteLength"),
      );
    }
    if (isDetachedBuffer(buffer)) {
      return PromiseReject(
        new TypeError("view's buffer has been detached"),
      );
    }
    if (this[_stream] === undefined) {
      return PromiseReject(
        new TypeError("Reader has no associated stream."),
      );
    }
    /** @type {Deferred<ReadableStreamBYOBReadResult>} */
    const promise = new Deferred();
    /** @type {ReadIntoRequest} */
    const readIntoRequest = {
      chunkSteps(chunk) {
        promise.resolve({ value: chunk, done: false });
      },
      closeSteps(chunk) {
        promise.resolve({ value: chunk, done: true });
      },
      errorSteps(e) {
        promise.reject(e);
      },
    };
    readableStreamBYOBReaderRead(this, view, readIntoRequest);
    return promise.promise;
  }

  /** @returns {void} */
  releaseLock() {
    webidl.assertBranded(this, ReadableStreamBYOBReaderPrototype);
    if (this[_stream] === undefined) {
      return;
    }
    readableStreamBYOBReaderRelease(this);
  }

  get closed() {
    try {
      webidl.assertBranded(this, ReadableStreamBYOBReaderPrototype);
    } catch (err) {
      return PromiseReject(err);
    }
    return this[_closedPromise].promise;
  }

  /**
   * @param {any} reason
   * @returns {Promise<void>}
   */
  cancel(reason = undefined) {
    try {
      webidl.assertBranded(this, ReadableStreamBYOBReaderPrototype);
      if (reason !== undefined) {
        reason = webidl.converters.any(reason);
      }
    } catch (err) {
      return PromiseReject(err);
    }

    if (this[_stream] === undefined) {
      return PromiseReject(
        new TypeError("Reader has no associated stream."),
      );
    }
    return readableStreamReaderGenericCancel(this, reason);
  }

  [SymbolFor("Deno.privateCustomInspect")](inspect) {
    return `${this.constructor.name} ${inspect({ closed: this.closed })}`;
  }
}

webidl.configurePrototype(ReadableStreamBYOBReader);
const ReadableStreamBYOBReaderPrototype = ReadableStreamBYOBReader.prototype;

class ReadableStreamBYOBRequest {
  /** @type {ReadableByteStreamController} */
  [_controller];
  /** @type {ArrayBufferView | null} */
  [_view];

  /** @returns {ArrayBufferView | null} */
  get view() {
    webidl.assertBranded(this, ReadableStreamBYOBRequestPrototype);
    return this[_view];
  }

  constructor() {
    webidl.illegalConstructor();
  }

  respond(bytesWritten) {
    webidl.assertBranded(this, ReadableStreamBYOBRequestPrototype);
    const prefix = "Failed to execute 'respond' on 'ReadableStreamBYOBRequest'";
    webidl.requiredArguments(arguments.length, 1, prefix);
    bytesWritten = webidl.converters["unsigned long long"](
      bytesWritten,
      prefix,
      "Argument 1",
      {
        enforceRange: true,
      },
    );

    if (this[_controller] === undefined) {
      throw new TypeError("This BYOB request has been invalidated");
    }

    let buffer, byteLength;
    if (TypedArrayPrototypeGetSymbolToStringTag(this[_view]) === undefined) {
      buffer = DataViewPrototypeGetBuffer(this[_view]);
      byteLength = DataViewPrototypeGetByteLength(this[_view]);
    } else {
      buffer = TypedArrayPrototypeGetBuffer(this[_view]);
      byteLength = TypedArrayPrototypeGetByteLength(this[_view]);
    }
    if (isDetachedBuffer(buffer)) {
      throw new TypeError(
        "The BYOB request's buffer has been detached and so cannot be used as a response",
      );
    }
    assert(byteLength > 0);
    assert(getArrayBufferByteLength(buffer) > 0);
    readableByteStreamControllerRespond(this[_controller], bytesWritten);
  }

  respondWithNewView(view) {
    webidl.assertBranded(this, ReadableStreamBYOBRequestPrototype);
    const prefix =
      "Failed to execute 'respondWithNewView' on 'ReadableStreamBYOBRequest'";
    webidl.requiredArguments(arguments.length, 1, prefix);
    view = webidl.converters.ArrayBufferView(view, prefix, "Argument 1");

    if (this[_controller] === undefined) {
      throw new TypeError("This BYOB request has been invalidated");
    }

    let buffer;
    if (TypedArrayPrototypeGetSymbolToStringTag(view) === undefined) {
      buffer = DataViewPrototypeGetBuffer(view);
    } else {
      buffer = TypedArrayPrototypeGetBuffer(view);
    }
    if (isDetachedBuffer(buffer)) {
      throw new TypeError(
        "The given view's buffer has been detached and so cannot be used as a response",
      );
    }
    readableByteStreamControllerRespondWithNewView(this[_controller], view);
  }
}

webidl.configurePrototype(ReadableStreamBYOBRequest);
const ReadableStreamBYOBRequestPrototype = ReadableStreamBYOBRequest.prototype;

class ReadableByteStreamController {
  /** @type {number | undefined} */
  [_autoAllocateChunkSize];
  /** @type {ReadableStreamBYOBRequest | null} */
  [_byobRequest];
  /** @type {(reason: any) => Promise<void>} */
  [_cancelAlgorithm];
  /** @type {boolean} */
  [_closeRequested];
  /** @type {boolean} */
  [_pullAgain];
  /** @type {(controller: this) => Promise<void>} */
  [_pullAlgorithm];
  /** @type {boolean} */
  [_pulling];
  /** @type {PullIntoDescriptor[]} */
  [_pendingPullIntos];
  /** @type {ReadableByteStreamQueueEntry[]} */
  [_queue];
  /** @type {number} */
  [_queueTotalSize];
  /** @type {boolean} */
  [_started];
  /** @type {number} */
  [_strategyHWM];
  /** @type {ReadableStream<ArrayBuffer>} */
  [_stream];

  constructor() {
    webidl.illegalConstructor();
  }

  /** @returns {ReadableStreamBYOBRequest | null} */
  get byobRequest() {
    webidl.assertBranded(this, ReadableByteStreamControllerPrototype);
    return readableByteStreamControllerGetBYOBRequest(this);
  }

  /** @returns {number | null} */
  get desiredSize() {
    webidl.assertBranded(this, ReadableByteStreamControllerPrototype);
    return readableByteStreamControllerGetDesiredSize(this);
  }

  /** @returns {void} */
  close() {
    webidl.assertBranded(this, ReadableByteStreamControllerPrototype);
    if (this[_closeRequested] === true) {
      throw new TypeError("Closed already requested.");
    }
    if (this[_stream][_state] !== "readable") {
      throw new TypeError(
        "ReadableByteStreamController's stream is not in a readable state.",
      );
    }
    readableByteStreamControllerClose(this);
  }

  /**
   * @param {ArrayBufferView} chunk
   * @returns {void}
   */
  enqueue(chunk) {
    webidl.assertBranded(this, ReadableByteStreamControllerPrototype);
    const prefix =
      "Failed to execute 'enqueue' on 'ReadableByteStreamController'";
    webidl.requiredArguments(arguments.length, 1, prefix);
    const arg1 = "Argument 1";
    chunk = webidl.converters.ArrayBufferView(chunk, prefix, arg1);
    let buffer, byteLength;
    if (TypedArrayPrototypeGetSymbolToStringTag(chunk) === undefined) {
      buffer = DataViewPrototypeGetBuffer(/** @type {DataView} */ (chunk));
      byteLength = DataViewPrototypeGetByteLength(
        /** @type {DataView} */ (chunk),
      );
    } else {
      buffer = TypedArrayPrototypeGetBuffer(/** @type {Uint8Array} */ (chunk));
      byteLength = TypedArrayPrototypeGetByteLength(
        /** @type {Uint8Array} */ (chunk),
      );
    }
    if (byteLength === 0) {
      throw webidl.makeException(
        TypeError,
        "length must be non-zero",
        prefix,
        arg1,
      );
    }
    if (getArrayBufferByteLength(buffer) === 0) {
      throw webidl.makeException(
        TypeError,
        "buffer length must be non-zero",
        prefix,
        arg1,
      );
    }
    if (this[_closeRequested] === true) {
      throw new TypeError(
        "Cannot enqueue chunk after a close has been requested.",
      );
    }
    if (this[_stream][_state] !== "readable") {
      throw new TypeError(
        "Cannot enqueue chunk when underlying stream is not readable.",
      );
    }
    return readableByteStreamControllerEnqueue(this, chunk);
  }

  /**
   * @param {any=} e
   * @returns {void}
   */
  error(e = undefined) {
    webidl.assertBranded(this, ReadableByteStreamControllerPrototype);
    if (e !== undefined) {
      e = webidl.converters.any(e);
    }
    readableByteStreamControllerError(this, e);
  }

  [SymbolFor("Deno.customInspect")](inspect) {
    return inspect(createFilteredInspectProxy({
      object: this,
      evaluate: ObjectPrototypeIsPrototypeOf(
        ReadableByteStreamControllerPrototype,
        this,
      ),
      keys: ["desiredSize"],
    }));
  }

  /**
   * @param {any} reason
   * @returns {Promise<void>}
   */
  [_cancelSteps](reason) {
    readableByteStreamControllerClearPendingPullIntos(this);
    resetQueue(this);
    const result = this[_cancelAlgorithm](reason);
    readableByteStreamControllerClearAlgorithms(this);
    return result;
  }

  /**
   * @param {ReadRequest<ArrayBuffer>} readRequest
   * @returns {void}
   */
  [_pullSteps](readRequest) {
    /** @type {ReadableStream<ArrayBuffer>} */
    const stream = this[_stream];
    assert(readableStreamHasDefaultReader(stream));
    if (this[_queueTotalSize] > 0) {
      assert(readableStreamGetNumReadRequests(stream) === 0);
      readableByteStreamControllerFillReadRequestFromQueue(this, readRequest);
      return;
    }
    const autoAllocateChunkSize = this[_autoAllocateChunkSize];
    if (autoAllocateChunkSize !== undefined) {
      let buffer;
      try {
        buffer = new ArrayBuffer(autoAllocateChunkSize);
      } catch (e) {
        readRequest.errorSteps(e);
        return;
      }
      /** @type {PullIntoDescriptor} */
      const pullIntoDescriptor = {
        buffer,
        bufferByteLength: autoAllocateChunkSize,
        byteOffset: 0,
        byteLength: autoAllocateChunkSize,
        bytesFilled: 0,
        elementSize: 1,
        viewConstructor: Uint8Array,
        readerType: "default",
      };
      ArrayPrototypePush(this[_pendingPullIntos], pullIntoDescriptor);
    }
    readableStreamAddReadRequest(stream, readRequest);
    readableByteStreamControllerCallPullIfNeeded(this);
  }

  [_releaseSteps]() {
    if (this[_pendingPullIntos].length !== 0) {
      /** @type {PullIntoDescriptor} */
      const firstPendingPullInto = this[_pendingPullIntos][0];
      firstPendingPullInto.readerType = "none";
      this[_pendingPullIntos] = [firstPendingPullInto];
    }
  }
}

webidl.configurePrototype(ReadableByteStreamController);
const ReadableByteStreamControllerPrototype =
  ReadableByteStreamController.prototype;

/** @template R */
class ReadableStreamDefaultController {
  /** @type {(reason: any) => Promise<void>} */
  [_cancelAlgorithm];
  /** @type {boolean} */
  [_closeRequested];
  /** @type {boolean} */
  [_pullAgain];
  /** @type {(controller: this) => Promise<void>} */
  [_pullAlgorithm];
  /** @type {boolean} */
  [_pulling];
  /** @type {Array<ValueWithSize<R>>} */
  [_queue];
  /** @type {number} */
  [_queueTotalSize];
  /** @type {boolean} */
  [_started];
  /** @type {number} */
  [_strategyHWM];
  /** @type {(chunk: R) => number} */
  [_strategySizeAlgorithm];
  /** @type {ReadableStream<R>} */
  [_stream];

  constructor() {
    webidl.illegalConstructor();
  }

  /** @returns {number | null} */
  get desiredSize() {
    webidl.assertBranded(this, ReadableStreamDefaultControllerPrototype);
    return readableStreamDefaultControllerGetDesiredSize(this);
  }

  /** @returns {void} */
  close() {
    webidl.assertBranded(this, ReadableStreamDefaultControllerPrototype);
    if (readableStreamDefaultControllerCanCloseOrEnqueue(this) === false) {
      throw new TypeError("The stream controller cannot close or enqueue.");
    }
    readableStreamDefaultControllerClose(this);
  }

  /**
   * @param {R} chunk
   * @returns {void}
   */
  enqueue(chunk = undefined) {
    webidl.assertBranded(this, ReadableStreamDefaultControllerPrototype);
    if (chunk !== undefined) {
      chunk = webidl.converters.any(chunk);
    }
    if (readableStreamDefaultControllerCanCloseOrEnqueue(this) === false) {
      throw new TypeError("The stream controller cannot close or enqueue.");
    }
    readableStreamDefaultControllerEnqueue(this, chunk);
  }

  /**
   * @param {any=} e
   * @returns {void}
   */
  error(e = undefined) {
    webidl.assertBranded(this, ReadableStreamDefaultControllerPrototype);
    if (e !== undefined) {
      e = webidl.converters.any(e);
    }
    readableStreamDefaultControllerError(this, e);
  }

  [SymbolFor("Deno.customInspect")](inspect) {
    return inspect(createFilteredInspectProxy({
      object: this,
      evaluate: ObjectPrototypeIsPrototypeOf(
        ReadableStreamDefaultController.prototype,
        this,
      ),
      keys: ["desiredSize"],
    }));
  }

  /**
   * @param {any} reason
   * @returns {Promise<void>}
   */
  [_cancelSteps](reason) {
    resetQueue(this);
    const result = this[_cancelAlgorithm](reason);
    readableStreamDefaultControllerClearAlgorithms(this);
    return result;
  }

  /**
   * @param {ReadRequest<R>} readRequest
   * @returns {void}
   */
  [_pullSteps](readRequest) {
    const stream = this[_stream];
    if (this[_queue].length) {
      const chunk = dequeueValue(this);
      if (this[_closeRequested] && this[_queue].length === 0) {
        readableStreamDefaultControllerClearAlgorithms(this);
        readableStreamClose(stream);
      } else {
        readableStreamDefaultControllerCallPullIfNeeded(this);
      }
      readRequest.chunkSteps(chunk);
    } else {
      readableStreamAddReadRequest(stream, readRequest);
      readableStreamDefaultControllerCallPullIfNeeded(this);
    }
  }

  [_releaseSteps]() {
    return;
  }
}

webidl.configurePrototype(ReadableStreamDefaultController);
const ReadableStreamDefaultControllerPrototype =
  ReadableStreamDefaultController.prototype;

/**
 * @template I
 * @template O
 */
class TransformStream {
  /** @type {boolean} */
  [_backpressure];
  /** @type {Deferred<void>} */
  [_backpressureChangePromise];
  /** @type {TransformStreamDefaultController<O>} */
  [_controller];
  /** @type {boolean} */
  [_detached];
  /** @type {ReadableStream<O>} */
  [_readable];
  /** @type {WritableStream<I>} */
  [_writable];

  /**
   * @param {Transformer<I, O>} transformer
   * @param {QueuingStrategy<I>} writableStrategy
   * @param {QueuingStrategy<O>} readableStrategy
   */
  constructor(
    transformer = undefined,
    writableStrategy = {},
    readableStrategy = {},
  ) {
    const prefix = "Failed to construct 'TransformStream'";
    if (transformer !== undefined) {
      transformer = webidl.converters.object(transformer, prefix, "Argument 1");
    }
    writableStrategy = webidl.converters.QueuingStrategy(
      writableStrategy,
      prefix,
      "Argument 2",
    );
    readableStrategy = webidl.converters.QueuingStrategy(
      readableStrategy,
      prefix,
      "Argument 3",
    );
    this[webidl.brand] = webidl.brand;
    if (transformer === undefined) {
      transformer = null;
    }
    const transformerDict = webidl.converters.Transformer(
      transformer,
      prefix,
      "transformer",
    );
    if (transformerDict.readableType !== undefined) {
      throw new RangeError(
        `${prefix}: readableType transformers not supported.`,
      );
    }
    if (transformerDict.writableType !== undefined) {
      throw new RangeError(
        `${prefix}: writableType transformers not supported.`,
      );
    }
    const readableHighWaterMark = extractHighWaterMark(readableStrategy, 0);
    const readableSizeAlgorithm = extractSizeAlgorithm(readableStrategy);
    const writableHighWaterMark = extractHighWaterMark(writableStrategy, 1);
    const writableSizeAlgorithm = extractSizeAlgorithm(writableStrategy);
    /** @type {Deferred<void>} */
    const startPromise = new Deferred();
    initializeTransformStream(
      this,
      startPromise,
      writableHighWaterMark,
      writableSizeAlgorithm,
      readableHighWaterMark,
      readableSizeAlgorithm,
    );
    setUpTransformStreamDefaultControllerFromTransformer(
      this,
      transformer,
      transformerDict,
    );
    if (transformerDict.start) {
      startPromise.resolve(
        webidl.invokeCallbackFunction(
          transformerDict.start,
          [this[_controller]],
          transformer,
          webidl.converters.any,
          "Failed to call 'start' on 'TransformStreamDefaultController'",
        ),
      );
    } else {
      startPromise.resolve(undefined);
    }
  }

  /** @returns {ReadableStream<O>} */
  get readable() {
    webidl.assertBranded(this, TransformStreamPrototype);
    return this[_readable];
  }

  /** @returns {WritableStream<I>} */
  get writable() {
    webidl.assertBranded(this, TransformStreamPrototype);
    return this[_writable];
  }

  [SymbolFor("Deno.privateCustomInspect")](inspect) {
    return `${this.constructor.name} ${
      inspect({ readable: this.readable, writable: this.writable })
    }`;
  }
}

webidl.configurePrototype(TransformStream);
const TransformStreamPrototype = TransformStream.prototype;

/** @template O */
class TransformStreamDefaultController {
  /** @type {(controller: this) => Promise<void>} */
  [_flushAlgorithm];
  /** @type {TransformStream<O>} */
  [_stream];
  /** @type {(chunk: O, controller: this) => Promise<void>} */
  [_transformAlgorithm];

  constructor() {
    webidl.illegalConstructor();
  }

  /** @returns {number | null} */
  get desiredSize() {
    webidl.assertBranded(this, TransformStreamDefaultController.prototype);
    const readableController = this[_stream][_readable][_controller];
    return readableStreamDefaultControllerGetDesiredSize(
      /** @type {ReadableStreamDefaultController<O>} */ readableController,
    );
  }

  /**
   * @param {O} chunk
   * @returns {void}
   */
  enqueue(chunk = undefined) {
    webidl.assertBranded(this, TransformStreamDefaultController.prototype);
    if (chunk !== undefined) {
      chunk = webidl.converters.any(chunk);
    }
    transformStreamDefaultControllerEnqueue(this, chunk);
  }

  /**
   * @param {any=} reason
   * @returns {void}
   */
  error(reason = undefined) {
    webidl.assertBranded(this, TransformStreamDefaultController.prototype);
    if (reason !== undefined) {
      reason = webidl.converters.any(reason);
    }
    transformStreamDefaultControllerError(this, reason);
  }

  /** @returns {void} */
  terminate() {
    webidl.assertBranded(this, TransformStreamDefaultControllerPrototype);
    transformStreamDefaultControllerTerminate(this);
  }

  [SymbolFor("Deno.customInspect")](inspect) {
    return inspect(createFilteredInspectProxy({
      object: this,
      evaluate: ObjectPrototypeIsPrototypeOf(
        TransformStreamDefaultController.prototype,
        this,
      ),
      keys: ["desiredSize"],
    }));
  }
}

webidl.configurePrototype(TransformStreamDefaultController);
const TransformStreamDefaultControllerPrototype =
  TransformStreamDefaultController.prototype;

/** @template W */
class WritableStream {
  /** @type {boolean} */
  [_backpressure];
  /** @type {Deferred<void> | undefined} */
  [_closeRequest];
  /** @type {WritableStreamDefaultController<W>} */
  [_controller];
  /** @type {boolean} */
  [_detached];
  /** @type {Deferred<void> | undefined} */
  [_inFlightWriteRequest];
  /** @type {Deferred<void> | undefined} */
  [_inFlightCloseRequest];
  /** @type {PendingAbortRequest | undefined} */
  [_pendingAbortRequest];
  /** @type {"writable" | "closed" | "erroring" | "errored"} */
  [_state];
  /** @type {any} */
  [_storedError];
  /** @type {WritableStreamDefaultWriter<W>} */
  [_writer];
  /** @type {Deferred<void>[]} */
  [_writeRequests];

  /**
   * @param {UnderlyingSink<W>=} underlyingSink
   * @param {QueuingStrategy<W>=} strategy
   */
  constructor(underlyingSink = undefined, strategy = {}) {
    const prefix = "Failed to construct 'WritableStream'";
    if (underlyingSink !== undefined) {
      underlyingSink = webidl.converters.object(
        underlyingSink,
        prefix,
        "Argument 1",
      );
    }
    strategy = webidl.converters.QueuingStrategy(
      strategy,
      prefix,
      "Argument 2",
    );
    this[webidl.brand] = webidl.brand;
    if (underlyingSink === undefined) {
      underlyingSink = null;
    }
    const underlyingSinkDict = webidl.converters.UnderlyingSink(
      underlyingSink,
      prefix,
      "underlyingSink",
    );
    if (underlyingSinkDict.type != null) {
      throw new RangeError(
        `${prefix}: WritableStream does not support 'type' in the underlying sink.`,
      );
    }
    initializeWritableStream(this);
    const sizeAlgorithm = extractSizeAlgorithm(strategy);
    const highWaterMark = extractHighWaterMark(strategy, 1);
    setUpWritableStreamDefaultControllerFromUnderlyingSink(
      this,
      underlyingSink,
      underlyingSinkDict,
      highWaterMark,
      sizeAlgorithm,
    );
  }

  /** @returns {boolean} */
  get locked() {
    webidl.assertBranded(this, WritableStreamPrototype);
    return isWritableStreamLocked(this);
  }

  /**
   * @param {any=} reason
   * @returns {Promise<void>}
   */
  abort(reason = undefined) {
    try {
      webidl.assertBranded(this, WritableStreamPrototype);
    } catch (err) {
      return PromiseReject(err);
    }
    if (reason !== undefined) {
      reason = webidl.converters.any(reason);
    }
    if (isWritableStreamLocked(this)) {
      return PromiseReject(
        new TypeError(
          "The writable stream is locked, therefore cannot be aborted.",
        ),
      );
    }
    return writableStreamAbort(this, reason);
  }

  /** @returns {Promise<void>} */
  close() {
    try {
      webidl.assertBranded(this, WritableStreamPrototype);
    } catch (err) {
      return PromiseReject(err);
    }
    if (isWritableStreamLocked(this)) {
      return PromiseReject(
        new TypeError(
          "The writable stream is locked, therefore cannot be closed.",
        ),
      );
    }
    if (writableStreamCloseQueuedOrInFlight(this) === true) {
      return PromiseReject(
        new TypeError("The writable stream is already closing."),
      );
    }
    return writableStreamClose(this);
  }

  /** @returns {WritableStreamDefaultWriter<W>} */
  getWriter() {
    webidl.assertBranded(this, WritableStreamPrototype);
    return acquireWritableStreamDefaultWriter(this);
  }

  [SymbolFor("Deno.privateCustomInspect")](inspect) {
    return `${this.constructor.name} ${inspect({ locked: this.locked })}`;
  }
}

webidl.configurePrototype(WritableStream);
const WritableStreamPrototype = WritableStream.prototype;

/** @template W */
class WritableStreamDefaultWriter {
  /** @type {Deferred<void>} */
  [_closedPromise];

  /** @type {Deferred<void>} */
  [_readyPromise];

  /** @type {WritableStream<W>} */
  [_stream];

  /**
   * @param {WritableStream<W>} stream
   */
  constructor(stream) {
    const prefix = "Failed to construct 'WritableStreamDefaultWriter'";
    webidl.requiredArguments(arguments.length, 1, prefix);
    stream = webidl.converters.WritableStream(stream, prefix, "Argument 1");
    this[webidl.brand] = webidl.brand;
    setUpWritableStreamDefaultWriter(this, stream);
  }

  /** @returns {Promise<void>} */
  get closed() {
    try {
      webidl.assertBranded(this, WritableStreamDefaultWriterPrototype);
    } catch (err) {
      return PromiseReject(err);
    }
    return this[_closedPromise].promise;
  }

  /** @returns {number} */
  get desiredSize() {
    webidl.assertBranded(this, WritableStreamDefaultWriterPrototype);
    if (this[_stream] === undefined) {
      throw new TypeError(
        "A writable stream is not associated with the writer.",
      );
    }
    return writableStreamDefaultWriterGetDesiredSize(this);
  }

  /** @returns {Promise<void>} */
  get ready() {
    try {
      webidl.assertBranded(this, WritableStreamDefaultWriterPrototype);
    } catch (err) {
      return PromiseReject(err);
    }
    return this[_readyPromise].promise;
  }

  /**
   * @param {any} reason
   * @returns {Promise<void>}
   */
  abort(reason = undefined) {
    try {
      webidl.assertBranded(this, WritableStreamDefaultWriterPrototype);
    } catch (err) {
      return PromiseReject(err);
    }
    if (reason !== undefined) {
      reason = webidl.converters.any(reason);
    }
    if (this[_stream] === undefined) {
      return PromiseReject(
        new TypeError("A writable stream is not associated with the writer."),
      );
    }
    return writableStreamDefaultWriterAbort(this, reason);
  }

  /** @returns {Promise<void>} */
  close() {
    try {
      webidl.assertBranded(this, WritableStreamDefaultWriterPrototype);
    } catch (err) {
      return PromiseReject(err);
    }
    const stream = this[_stream];
    if (stream === undefined) {
      return PromiseReject(
        new TypeError("A writable stream is not associated with the writer."),
      );
    }
    if (writableStreamCloseQueuedOrInFlight(stream) === true) {
      return PromiseReject(
        new TypeError("The associated stream is already closing."),
      );
    }
    return writableStreamDefaultWriterClose(this);
  }

  /** @returns {void} */
  releaseLock() {
    webidl.assertBranded(this, WritableStreamDefaultWriterPrototype);
    const stream = this[_stream];
    if (stream === undefined) {
      return;
    }
    assert(stream[_writer] !== undefined);
    writableStreamDefaultWriterRelease(this);
  }

  /**
   * @param {W} chunk
   * @returns {Promise<void>}
   */
  write(chunk = undefined) {
    try {
      webidl.assertBranded(this, WritableStreamDefaultWriterPrototype);
      if (chunk !== undefined) {
        chunk = webidl.converters.any(chunk);
      }
    } catch (err) {
      return PromiseReject(err);
    }
    if (this[_stream] === undefined) {
      return PromiseReject(
        new TypeError("A writable stream is not associate with the writer."),
      );
    }
    return writableStreamDefaultWriterWrite(this, chunk);
  }

  [SymbolFor("Deno.customInspect")](inspect) {
    return inspect(createFilteredInspectProxy({
      object: this,
      evaluate: ObjectPrototypeIsPrototypeOf(
        WritableStreamDefaultWriter.prototype,
        this,
      ),
      keys: [
        "closed",
        "desiredSize",
        "ready",
      ],
    }));
  }
}

webidl.configurePrototype(WritableStreamDefaultWriter);
const WritableStreamDefaultWriterPrototype =
  WritableStreamDefaultWriter.prototype;

/** @template W */
class WritableStreamDefaultController {
  /** @type {(reason?: any) => Promise<void>} */
  [_abortAlgorithm];
  /** @type {() => Promise<void>} */
  [_closeAlgorithm];
  /** @type {ValueWithSize<W | _close>[]} */
  [_queue];
  /** @type {number} */
  [_queueTotalSize];
  /** @type {boolean} */
  [_started];
  /** @type {number} */
  [_strategyHWM];
  /** @type {(chunk: W) => number} */
  [_strategySizeAlgorithm];
  /** @type {WritableStream<W>} */
  [_stream];
  /** @type {(chunk: W, controller: this) => Promise<void>} */
  [_writeAlgorithm];
  /** @type {AbortSignal} */
  [_signal];

  get signal() {
    webidl.assertBranded(this, WritableStreamDefaultControllerPrototype);
    return this[_signal];
  }

  constructor() {
    webidl.illegalConstructor();
  }

  /**
   * @param {any=} e
   * @returns {void}
   */
  error(e = undefined) {
    webidl.assertBranded(this, WritableStreamDefaultControllerPrototype);
    if (e !== undefined) {
      e = webidl.converters.any(e);
    }
    const state = this[_stream][_state];
    if (state !== "writable") {
      return;
    }
    writableStreamDefaultControllerError(this, e);
  }

  [SymbolFor("Deno.customInspect")](inspect) {
    return inspect(createFilteredInspectProxy({
      object: this,
      evaluate: ObjectPrototypeIsPrototypeOf(
        WritableStreamDefaultController.prototype,
        this,
      ),
      keys: [],
    }));
  }

  /**
   * @param {any=} reason
   * @returns {Promise<void>}
   */
  [_abortSteps](reason) {
    const result = this[_abortAlgorithm](reason);
    writableStreamDefaultControllerClearAlgorithms(this);
    return result;
  }

  [_errorSteps]() {
    resetQueue(this);
  }
}

webidl.configurePrototype(WritableStreamDefaultController);
const WritableStreamDefaultControllerPrototype =
  WritableStreamDefaultController.prototype;

/**
 * @param {ReadableStream} stream
 */
function createProxy(stream) {
  return stream.pipeThrough(new TransformStream());
}

webidl.converters.ReadableStream = webidl
  .createInterfaceConverter("ReadableStream", ReadableStream.prototype);
webidl.converters.WritableStream = webidl
  .createInterfaceConverter("WritableStream", WritableStream.prototype);

webidl.converters.ReadableStreamType = webidl.createEnumConverter(
  "ReadableStreamType",
  ["bytes"],
);

webidl.converters.UnderlyingSource = webidl
  .createDictionaryConverter("UnderlyingSource", [
    {
      key: "start",
      converter: webidl.converters.Function,
    },
    {
      key: "pull",
      converter: webidl.converters.Function,
    },
    {
      key: "cancel",
      converter: webidl.converters.Function,
    },
    {
      key: "type",
      converter: webidl.converters.ReadableStreamType,
    },
    {
      key: "autoAllocateChunkSize",
      converter: (V, prefix, context, opts) =>
        webidl.converters["unsigned long long"](V, prefix, context, {
          ...opts,
          enforceRange: true,
        }),
    },
  ]);
webidl.converters.UnderlyingSink = webidl
  .createDictionaryConverter("UnderlyingSink", [
    {
      key: "start",
      converter: webidl.converters.Function,
    },
    {
      key: "write",
      converter: webidl.converters.Function,
    },
    {
      key: "close",
      converter: webidl.converters.Function,
    },
    {
      key: "abort",
      converter: webidl.converters.Function,
    },
    {
      key: "type",
      converter: webidl.converters.any,
    },
  ]);
webidl.converters.Transformer = webidl
  .createDictionaryConverter("Transformer", [
    {
      key: "start",
      converter: webidl.converters.Function,
    },
    {
      key: "transform",
      converter: webidl.converters.Function,
    },
    {
      key: "flush",
      converter: webidl.converters.Function,
    },
    {
      key: "readableType",
      converter: webidl.converters.any,
    },
    {
      key: "writableType",
      converter: webidl.converters.any,
    },
  ]);
webidl.converters.QueuingStrategy = webidl
  .createDictionaryConverter("QueuingStrategy", [
    {
      key: "highWaterMark",
      converter: webidl.converters["unrestricted double"],
    },
    {
      key: "size",
      converter: webidl.converters.Function,
    },
  ]);
webidl.converters.QueuingStrategyInit = webidl
  .createDictionaryConverter("QueuingStrategyInit", [
    {
      key: "highWaterMark",
      converter: webidl.converters["unrestricted double"],
      required: true,
    },
  ]);

webidl.converters.ReadableStreamIteratorOptions = webidl
  .createDictionaryConverter("ReadableStreamIteratorOptions", [
    {
      key: "preventCancel",
      defaultValue: false,
      converter: webidl.converters.boolean,
    },
  ]);

webidl.converters.ReadableStreamReaderMode = webidl
  .createEnumConverter("ReadableStreamReaderMode", ["byob"]);
webidl.converters.ReadableStreamGetReaderOptions = webidl
  .createDictionaryConverter("ReadableStreamGetReaderOptions", [{
    key: "mode",
    converter: webidl.converters.ReadableStreamReaderMode,
  }]);

webidl.converters.ReadableWritablePair = webidl
  .createDictionaryConverter("ReadableWritablePair", [
    {
      key: "readable",
      converter: webidl.converters.ReadableStream,
      required: true,
    },
    {
      key: "writable",
      converter: webidl.converters.WritableStream,
      required: true,
    },
  ]);
webidl.converters.StreamPipeOptions = webidl
  .createDictionaryConverter("StreamPipeOptions", [
    {
      key: "preventClose",
      defaultValue: false,
      converter: webidl.converters.boolean,
    },
    {
      key: "preventAbort",
      defaultValue: false,
      converter: webidl.converters.boolean,
    },
    {
      key: "preventCancel",
      defaultValue: false,
      converter: webidl.converters.boolean,
    },
    { key: "signal", converter: webidl.converters.AbortSignal },
  ]);

internals.resourceForReadableStream = resourceForReadableStream;

export {
  // Non-Public
  _state,
  // Exposed in global runtime scope
  ByteLengthQueuingStrategy,
  CountQueuingStrategy,
  createProxy,
  Deferred,
  errorReadableStream,
  getReadableStreamResourceBacking,
  getWritableStreamResourceBacking,
  isReadableStreamDisturbed,
  ReadableByteStreamController,
  ReadableStream,
  ReadableStreamBYOBReader,
  ReadableStreamBYOBRequest,
  readableStreamClose,
  readableStreamCollectIntoUint8Array,
  ReadableStreamDefaultController,
  ReadableStreamDefaultReader,
  readableStreamDisturb,
  readableStreamForRid,
  readableStreamForRidUnrefable,
  readableStreamForRidUnrefableRef,
  readableStreamForRidUnrefableUnref,
  ReadableStreamPrototype,
  readableStreamTee,
  readableStreamThrowIfErrored,
  resourceForReadableStream,
  TransformStream,
  TransformStreamDefaultController,
  WritableStream,
  writableStreamClose,
  WritableStreamDefaultController,
  WritableStreamDefaultWriter,
  writableStreamForRid,
};

// Copyright 2018-2023 the Deno authors. All rights reserved. MIT license.
const core = globalThis.Deno.core;
const internals = globalThis.__bootstrap.internals;
const primordials = globalThis.__bootstrap.primordials;
import * as webidl from "ext:deno_webidl/00_webidl.js";
import {
  fromInnerResponse,
  newInnerResponse,
} from "ext:deno_fetch/23_response.js";
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
const {
  ArrayPrototypeIncludes,
  ArrayPrototypeMap,
  ArrayPrototypePush,
  StringPrototypeCharCodeAt,
  StringPrototypeToLowerCase,
  StringPrototypeSplit,
  Symbol,
  TypeError,
} = primordials;

const _ws = Symbol("[[associated_ws]]");

const spaceCharCode = StringPrototypeCharCodeAt(" ", 0);
const tabCharCode = StringPrototypeCharCodeAt("\t", 0);
const commaCharCode = StringPrototypeCharCodeAt(",", 0);

/** Builds a case function that can be used to find a case insensitive
 * value in some text that's separated by commas.
 *
 * This is done because it doesn't require any allocations.
 * @param checkText {string} - The text to find. (ex. "websocket")
 */
function buildCaseInsensitiveCommaValueFinder(checkText) {
  const charCodes = ArrayPrototypeMap(
    StringPrototypeSplit(
      StringPrototypeToLowerCase(checkText),
      "",
    ),
    (c) => [c.charCodeAt(0), c.toUpperCase().charCodeAt(0)],
  );
  /** @type {number} */
  let i;
  /** @type {number} */
  let char;

  /** @param value {string} */
  return function (value) {
    for (i = 0; i < value.length; i++) {
      char = value.charCodeAt(i);
      skipWhitespace(value);

      if (hasWord(value)) {
        skipWhitespace(value);
        if (i === value.length || char === commaCharCode) {
          return true;
        }
      } else {
        skipUntilComma(value);
      }
    }

    return false;
  };

  /** @param value {string} */
  function hasWord(value) {
    for (let j = 0; j < charCodes.length; ++j) {
      const { 0: cLower, 1: cUpper } = charCodes[j];
      if (cLower === char || cUpper === char) {
        char = StringPrototypeCharCodeAt(value, ++i);
      } else {
        return false;
      }
    }
    return true;
  }

  /** @param value {string} */
  function skipWhitespace(value) {
    while (char === spaceCharCode || char === tabCharCode) {
      char = StringPrototypeCharCodeAt(value, ++i);
    }
  }

  /** @param value {string} */
  function skipUntilComma(value) {
    while (char !== commaCharCode && i < value.length) {
      char = StringPrototypeCharCodeAt(value, ++i);
    }
  }
}

// Expose this function for unit tests
internals.buildCaseInsensitiveCommaValueFinder =
  buildCaseInsensitiveCommaValueFinder;

const websocketCvf = buildCaseInsensitiveCommaValueFinder("websocket");
const upgradeCvf = buildCaseInsensitiveCommaValueFinder("upgrade");

function upgradeWebSocket(request, options = {}) {
  const upgrade = request.headers.get("upgrade");
  const upgradeHasWebSocketOption = upgrade !== null &&
    websocketCvf(upgrade);
  if (!upgradeHasWebSocketOption) {
    throw new TypeError(
      "Invalid Header: 'upgrade' header must contain 'websocket'",
    );
  }

  const connection = request.headers.get("connection");
  const connectionHasUpgradeOption = connection !== null &&
    upgradeCvf(connection);
  if (!connectionHasUpgradeOption) {
    throw new TypeError(
      "Invalid Header: 'connection' header must contain 'Upgrade'",
    );
  }

  const websocketKey = request.headers.get("sec-websocket-key");
  if (websocketKey === null) {
    throw new TypeError(
      "Invalid Header: 'sec-websocket-key' header must be set",
    );
  }

  const accept = ops.op_http_websocket_accept_header(websocketKey);

  const r = newInnerResponse(101);
  r.headerList = [
    ["upgrade", "websocket"],
    ["connection", "Upgrade"],
    ["sec-websocket-accept", accept],
  ];

  const protocolsStr = request.headers.get("sec-websocket-protocol") || "";
  const protocols = StringPrototypeSplit(protocolsStr, ", ");
  if (protocols && options.protocol) {
    if (ArrayPrototypeIncludes(protocols, options.protocol)) {
      ArrayPrototypePush(r.headerList, [
        "sec-websocket-protocol",
        options.protocol,
      ]);
    } else {
      throw new TypeError(
        `Protocol '${options.protocol}' not in the request's protocol list (non negotiable)`,
      );
    }
  }

  const response = fromInnerResponse(r, "immutable");

  const socket = webidl.createBranded(WebSocket);
  setEventTargetData(socket);
  socket[_server] = true;
  response[_ws] = socket;
  socket[_idleTimeoutDuration] = options.idleTimeout ?? 120;
  socket[_idleTimeoutTimeout] = null;

  return { response, socket };
}

export { upgradeWebSocket };

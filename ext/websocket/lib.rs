// Copyright 2018-2023 the Deno authors. All rights reserved. MIT license.
use crate::stream::WebSocketStream;
use bytes::Bytes;
use deno_core::anyhow::bail;
use deno_core::error::invalid_hostname;
use deno_core::error::type_error;
use deno_core::error::AnyError;
use deno_core::futures::TryFutureExt;
use deno_core::op2;
use deno_core::unsync::spawn;
use deno_core::url;
use deno_core::AsyncMutFuture;
use deno_core::AsyncRefCell;
use deno_core::ByteString;
use deno_core::CancelHandle;
use deno_core::CancelTryFuture;
use deno_core::JsBuffer;
use deno_core::OpState;
use deno_core::RcRef;
use deno_core::Resource;
use deno_core::ResourceId;
use deno_core::ToJsBuffer;
use deno_net::raw::NetworkStream;
use deno_tls::create_client_config;
use deno_tls::rustls::ClientConfig;
use deno_tls::RootCertStoreProvider;
use deno_tls::SocketUse;
use http::header::CONNECTION;
use http::header::UPGRADE;
use http::HeaderName;
use http::HeaderValue;
use http::Method;
use http::Request;
use http::StatusCode;
use http::Uri;
use hyper::Body;
use once_cell::sync::Lazy;
use rustls_tokio_stream::rustls::RootCertStore;
use rustls_tokio_stream::rustls::ServerName;
use rustls_tokio_stream::TlsStream;
use serde::Serialize;
use std::borrow::Cow;
use std::cell::Cell;
use std::cell::RefCell;
use std::convert::TryFrom;
use std::fmt;
use std::future::Future;
use std::num::NonZeroUsize;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;
use tokio::io::AsyncRead;
use tokio::io::AsyncWrite;
use tokio::io::ReadHalf;
use tokio::io::WriteHalf;
use tokio::net::TcpStream;

use fastwebsockets::CloseCode;
use fastwebsockets::FragmentCollectorRead;
use fastwebsockets::Frame;
use fastwebsockets::OpCode;
use fastwebsockets::Role;
use fastwebsockets::WebSocket;
use fastwebsockets::WebSocketWrite;

mod stream;

static USE_WRITEV: Lazy<bool> = Lazy::new(|| {
  let enable = std::env::var("DENO_USE_WRITEV").ok();

  if let Some(val) = enable {
    return !val.is_empty();
  }

  false
});

#[derive(Clone)]
pub struct WsRootStoreProvider(Option<Arc<dyn RootCertStoreProvider>>);

impl WsRootStoreProvider {
  pub fn get_or_try_init(&self) -> Result<Option<RootCertStore>, AnyError> {
    Ok(match &self.0 {
      Some(provider) => Some(provider.get_or_try_init()?.clone()),
      None => None,
    })
  }
}

#[derive(Clone)]
pub struct WsUserAgent(pub String);

pub trait WebSocketPermissions {
  fn check_net_url(
    &mut self,
    _url: &url::Url,
    _api_name: &str,
  ) -> Result<(), AnyError>;
}

/// `UnsafelyIgnoreCertificateErrors` is a wrapper struct so it can be placed inside `GothamState`;
/// using type alias for a `Option<Vec<String>>` could work, but there's a high chance
/// that there might be another type alias pointing to a `Option<Vec<String>>`, which
/// would override previously used alias.
pub struct UnsafelyIgnoreCertificateErrors(Option<Vec<String>>);

pub struct WsCancelResource(Rc<CancelHandle>);

impl Resource for WsCancelResource {
  fn name(&self) -> Cow<str> {
    "webSocketCancel".into()
  }

  fn close(self: Rc<Self>) {
    self.0.cancel()
  }
}

// This op is needed because creating a WS instance in JavaScript is a sync
// operation and should throw error when permissions are not fulfilled,
// but actual op that connects WS is async.
#[op2]
#[smi]
pub fn op_ws_check_permission_and_cancel_handle<WP>(
  state: &mut OpState,
  #[string] api_name: String,
  #[string] url: String,
  cancel_handle: bool,
) -> Result<Option<ResourceId>, AnyError>
where
  WP: WebSocketPermissions + 'static,
{
  state
    .borrow_mut::<WP>()
    .check_net_url(&url::Url::parse(&url)?, &api_name)?;

  if cancel_handle {
    let rid = state
      .resource_table
      .add(WsCancelResource(CancelHandle::new_rc()));
    Ok(Some(rid))
  } else {
    Ok(None)
  }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateResponse {
  rid: ResourceId,
  protocol: String,
  extensions: String,
}

async fn handshake_websocket(
  state: &Rc<RefCell<OpState>>,
  uri: &Uri,
  protocols: &str,
  headers: Option<Vec<(ByteString, ByteString)>>,
) -> Result<(WebSocket<WebSocketStream>, http::HeaderMap), AnyError> {
  let mut request = Request::builder().method(Method::GET).uri(
    uri
      .path_and_query()
      .ok_or(type_error("Missing path in url".to_string()))?
      .as_str(),
  );

  let authority = uri.authority().unwrap().as_str();
  let host = authority
    .find('@')
    .map(|idx| authority.split_at(idx + 1).1)
    .unwrap_or_else(|| authority);
  request = request
    .header("Host", host)
    .header(UPGRADE, "websocket")
    .header(CONNECTION, "Upgrade")
    .header(
      "Sec-WebSocket-Key",
      fastwebsockets::handshake::generate_key(),
    );

  let user_agent = state.borrow().borrow::<WsUserAgent>().0.clone();
  request = populate_common_request_headers(
    request,
    &user_agent,
    protocols,
    &headers,
  )?;

  let request = request.body(Body::empty())?;
  let domain = &uri.host().unwrap().to_string();
  let port = &uri.port_u16().unwrap_or(match uri.scheme_str() {
    Some("wss") => 443,
    Some("ws") => 80,
    _ => unreachable!(),
  });
  let addr = format!("{domain}:{port}");

  let res = match uri.scheme_str() {
    Some("ws") => handshake_http1_ws(request, &addr).await?,
    Some("wss") => {
      match handshake_http1_wss(state, request, domain, &addr).await {
        Ok(res) => res,
        Err(_) => {
          handshake_http2_wss(
            state,
            uri,
            authority,
            &user_agent,
            protocols,
            domain,
            &headers,
            &addr,
          )
          .await?
        }
      }
    }
    _ => unreachable!(),
  };
  Ok(res)
}

async fn handshake_http1_ws(
  request: Request<Body>,
  addr: &String,
) -> Result<(WebSocket<WebSocketStream>, http::HeaderMap), AnyError> {
  let tcp_socket = TcpStream::connect(addr).await?;
  handshake_connection(request, tcp_socket).await
}

async fn handshake_http1_wss(
  state: &Rc<RefCell<OpState>>,
  request: Request<Body>,
  domain: &str,
  addr: &str,
) -> Result<(WebSocket<WebSocketStream>, http::HeaderMap), AnyError> {
  let tcp_socket = TcpStream::connect(addr).await?;
  let tls_config = create_ws_client_config(state, SocketUse::Http1Only)?;
  let dnsname =
    ServerName::try_from(domain).map_err(|_| invalid_hostname(domain))?;
  let tls_connector = TlsStream::new_client_side(
    tcp_socket,
    tls_config.into(),
    dnsname,
    NonZeroUsize::new(65536),
  );
  handshake_connection(request, tls_connector).await
}

#[allow(clippy::too_many_arguments)]
async fn handshake_http2_wss(
  state: &Rc<RefCell<OpState>>,
  uri: &Uri,
  authority: &str,
  user_agent: &str,
  protocols: &str,
  domain: &str,
  headers: &Option<Vec<(ByteString, ByteString)>>,
  addr: &str,
) -> Result<(WebSocket<WebSocketStream>, http::HeaderMap), AnyError> {
  let tcp_socket = TcpStream::connect(addr).await?;
  let tls_config = create_ws_client_config(state, SocketUse::Http2Only)?;
  let dnsname =
    ServerName::try_from(domain).map_err(|_| invalid_hostname(domain))?;
  // We need to better expose the underlying errors here
  let mut tls_connector = TlsStream::new_client_side(
    tcp_socket,
    tls_config.into(),
    dnsname,
    None,
  );
  let res = tls_connector.handshake().await;
  _ = res?;
  let h2 = h2::client::Builder::new();
  let (mut send, conn) = h2.handshake::<_, Bytes>(tls_connector).await?;
  spawn(conn);
  let mut request = Request::builder();
  request = request.method(Method::CONNECT);
  let uri = Uri::builder()
    .authority(authority)
    .path_and_query(uri.path_and_query().unwrap().as_str())
    .scheme("https")
    .build()?;
  request = request.uri(uri);
  request = populate_common_request_headers(
    request,
    user_agent,
    protocols,
    headers,
  )?;
  request = request.extension(h2::ext::Protocol::from("websocket"));
  let (resp, send) = send.send_request(request.body(())?, false)?;
  let resp = resp.await?;
  if resp.status() != StatusCode::OK {
    bail!("Invalid status code: {}", resp.status());
  }
  let (http::response::Parts { headers, .. }, recv) = resp.into_parts();
  let mut stream = WebSocket::after_handshake(
    WebSocketStream::new(stream::WsStreamKind::H2(send, recv), None),
    Role::Client,
  );
  // We currently don't support vectored writes in the H2 streams
  stream.set_writev(false);
  // We don't need to mask on H2
  stream.set_auto_apply_mask(false);
  Ok((stream, headers))
}

async fn handshake_connection<
  S: AsyncRead + AsyncWrite + Send + Unpin + 'static,
>(
  request: Request<Body>,
  socket: S,
) -> Result<(WebSocket<WebSocketStream>, http::HeaderMap), AnyError> {
  let (upgraded, response) =
    fastwebsockets::handshake::client(&LocalExecutor, request, socket).await?;

  let upgraded = upgraded.into_inner();
  let stream =
    WebSocketStream::new(stream::WsStreamKind::Upgraded(upgraded), None);
  let stream = WebSocket::after_handshake(stream, Role::Client);

  Ok((stream, response.into_parts().0.headers))
}

pub fn create_ws_client_config(
  state: &Rc<RefCell<OpState>>,
  socket_use: SocketUse,
) -> Result<ClientConfig, AnyError> {
  let unsafely_ignore_certificate_errors: Option<Vec<String>> = state
    .borrow()
    .try_borrow::<UnsafelyIgnoreCertificateErrors>()
    .and_then(|it| it.0.clone());
  let root_cert_store = state
    .borrow()
    .borrow::<WsRootStoreProvider>()
    .get_or_try_init()?;

  create_client_config(
    root_cert_store,
    vec![],
    unsafely_ignore_certificate_errors,
    None,
    socket_use,
  )
}

/// Headers common to both http/1.1 and h2 requests.
fn populate_common_request_headers(
  mut request: http::request::Builder,
  user_agent: &str,
  protocols: &str,
  headers: &Option<Vec<(ByteString, ByteString)>>,
) -> Result<http::request::Builder, AnyError> {
  request = request
    .header("User-Agent", user_agent)
    .header("Sec-WebSocket-Version", "13");

  if !protocols.is_empty() {
    request = request.header("Sec-WebSocket-Protocol", protocols);
  }

  if let Some(headers) = headers {
    for (key, value) in headers {
      let name = HeaderName::from_bytes(key)
        .map_err(|err| type_error(err.to_string()))?;
      let v = HeaderValue::from_bytes(value)
        .map_err(|err| type_error(err.to_string()))?;

      let is_disallowed_header = matches!(
        name,
        http::header::HOST
          | http::header::SEC_WEBSOCKET_ACCEPT
          | http::header::SEC_WEBSOCKET_EXTENSIONS
          | http::header::SEC_WEBSOCKET_KEY
          | http::header::SEC_WEBSOCKET_PROTOCOL
          | http::header::SEC_WEBSOCKET_VERSION
          | http::header::UPGRADE
          | http::header::CONNECTION
      );
      if !is_disallowed_header {
        request = request.header(name, v);
      }
    }
  }
  Ok(request)
}

#[op2(async)]
#[serde]
pub async fn op_ws_create<WP>(
  state: Rc<RefCell<OpState>>,
  #[string] api_name: String,
  #[string] url: String,
  #[string] protocols: String,
  #[smi] cancel_handle: Option<ResourceId>,
  #[serde] headers: Option<Vec<(ByteString, ByteString)>>,
) -> Result<CreateResponse, AnyError>
where
  WP: WebSocketPermissions + 'static,
{
  {
    let mut s = state.borrow_mut();
    s.borrow_mut::<WP>()
      .check_net_url(&url::Url::parse(&url)?, &api_name)
      .expect(
        "Permission check should have been done in op_ws_check_permission",
      );
  }

  let cancel_resource = if let Some(cancel_rid) = cancel_handle {
    let r = state
      .borrow_mut()
      .resource_table
      .get::<WsCancelResource>(cancel_rid)?;
    Some(r.0.clone())
  } else {
    None
  };

  let uri: Uri = url.parse()?;

  let handshake = handshake_websocket(&state, &uri, &protocols, headers)
    .map_err(|err| {
      AnyError::from(DomExceptionNetworkError::new(&format!(
        "failed to connect to WebSocket: {err}"
      )))
    });
  let (stream, response) = match cancel_resource {
    Some(rc) => handshake.try_or_cancel(rc).await,
    None => handshake.await,
  }?;

  if let Some(cancel_rid) = cancel_handle {
    if let Ok(res) = state.borrow_mut().resource_table.take_any(cancel_rid) {
      res.close();
    }
  }

  let mut state = state.borrow_mut();
  let rid = state.resource_table.add(ServerWebSocket::new(stream));

  let protocol = match response.get("Sec-WebSocket-Protocol") {
    Some(header) => header.to_str().unwrap(),
    None => "",
  };
  let extensions = response
    .get_all("Sec-WebSocket-Extensions")
    .iter()
    .map(|header| header.to_str().unwrap())
    .collect::<String>();
  Ok(CreateResponse {
    rid,
    protocol: protocol.to_string(),
    extensions,
  })
}

#[repr(u16)]
pub enum MessageKind {
  Text = 0,
  Binary = 1,
  Pong = 2,
  Error = 3,
  ClosedDefault = 1005,
}

/// To avoid locks, we keep as much as we can inside of [`Cell`]s.
pub struct ServerWebSocket {
  buffered: Cell<usize>,
  error: Cell<Option<String>>,
  errored: Cell<bool>,
  closed: Cell<bool>,
  buffer: Cell<Option<Vec<u8>>>,
  string: Cell<Option<String>>,
  ws_read: AsyncRefCell<FragmentCollectorRead<ReadHalf<WebSocketStream>>>,
  ws_write: AsyncRefCell<WebSocketWrite<WriteHalf<WebSocketStream>>>,
}

impl ServerWebSocket {
  fn new(ws: WebSocket<WebSocketStream>) -> Self {
    let (ws_read, ws_write) = ws.split(tokio::io::split);
    Self {
      buffered: Cell::new(0),
      error: Cell::new(None),
      errored: Cell::new(false),
      closed: Cell::new(false),
      buffer: Cell::new(None),
      string: Cell::new(None),
      ws_read: AsyncRefCell::new(FragmentCollectorRead::new(ws_read)),
      ws_write: AsyncRefCell::new(ws_write),
    }
  }

  fn set_error(&self, error: Option<String>) {
    if let Some(error) = error {
      self.error.set(Some(error));
      self.errored.set(true);
    } else {
      self.error.set(None);
      self.errored.set(false);
    }
  }

  /// Reserve a lock, but don't wait on it. This gets us our place in line.
  fn reserve_lock(
    self: &Rc<Self>,
  ) -> AsyncMutFuture<WebSocketWrite<WriteHalf<WebSocketStream>>> {
    RcRef::map(self, |r| &r.ws_write).borrow_mut()
  }

  #[inline]
  async fn write_frame(
    self: &Rc<Self>,
    lock: AsyncMutFuture<WebSocketWrite<WriteHalf<WebSocketStream>>>,
    frame: Frame<'_>,
  ) -> Result<(), AnyError> {
    let mut ws = lock.await;
    if ws.is_closed() {
      return Ok(());
    }
    ws.write_frame(frame)
      .await
      .map_err(|err| type_error(err.to_string()))?;
    Ok(())
  }
}

impl Resource for ServerWebSocket {
  fn name(&self) -> Cow<str> {
    "serverWebSocket".into()
  }
}

pub fn ws_create_server_stream(
  state: &mut OpState,
  transport: NetworkStream,
  read_buf: Bytes,
) -> Result<ResourceId, AnyError> {
  let mut ws = WebSocket::after_handshake(
    WebSocketStream::new(
      stream::WsStreamKind::Network(transport),
      Some(read_buf),
    ),
    Role::Server,
  );
  ws.set_writev(*USE_WRITEV);
  ws.set_auto_close(true);
  ws.set_auto_pong(true);

  let rid = state.resource_table.add(ServerWebSocket::new(ws));
  Ok(rid)
}

fn send_binary(state: &mut OpState, rid: ResourceId, data: &[u8]) {
  let resource = state.resource_table.get::<ServerWebSocket>(rid).unwrap();
  let data = data.to_vec();
  let len = data.len();
  resource.buffered.set(resource.buffered.get() + len);
  let lock = resource.reserve_lock();
  deno_core::unsync::spawn(async move {
    if let Err(err) = resource
      .write_frame(lock, Frame::new(true, OpCode::Binary, None, data.into()))
      .await
    {
      resource.set_error(Some(err.to_string()));
    } else {
      resource.buffered.set(resource.buffered.get() - len);
    }
  });
}

#[op2(fast)]
pub fn op_ws_send_binary(
  state: &mut OpState,
  #[smi] rid: ResourceId,
  #[anybuffer] data: &[u8],
) {
  send_binary(state, rid, data)
}

#[op2(fast)]
pub fn op_ws_send_binary_ab(
  state: &mut OpState,
  #[smi] rid: ResourceId,
  #[arraybuffer] data: &[u8],
) {
  send_binary(state, rid, data)
}

#[op2(fast)]
pub fn op_ws_send_text(
  state: &mut OpState,
  #[smi] rid: ResourceId,
  #[string] data: String,
) {
  let resource = state.resource_table.get::<ServerWebSocket>(rid).unwrap();
  let len = data.len();
  resource.buffered.set(resource.buffered.get() + len);
  let lock = resource.reserve_lock();
  deno_core::unsync::spawn(async move {
    if let Err(err) = resource
      .write_frame(
        lock,
        Frame::new(true, OpCode::Text, None, data.into_bytes().into()),
      )
      .await
    {
      resource.set_error(Some(err.to_string()));
    } else {
      resource.buffered.set(resource.buffered.get() - len);
    }
  });
}

/// Async version of send. Does not update buffered amount as we rely on the socket itself for backpressure.
#[op2(async)]
pub async fn op_ws_send_binary_async(
  state: Rc<RefCell<OpState>>,
  #[smi] rid: ResourceId,
  #[buffer] data: JsBuffer,
) -> Result<(), AnyError> {
  let resource = state
    .borrow_mut()
    .resource_table
    .get::<ServerWebSocket>(rid)?;
  let data = data.to_vec();
  let lock = resource.reserve_lock();
  resource
    .write_frame(lock, Frame::new(true, OpCode::Binary, None, data.into()))
    .await
}

/// Async version of send. Does not update buffered amount as we rely on the socket itself for backpressure.
#[op2(async)]
pub async fn op_ws_send_text_async(
  state: Rc<RefCell<OpState>>,
  #[smi] rid: ResourceId,
  #[string] data: String,
) -> Result<(), AnyError> {
  let resource = state
    .borrow_mut()
    .resource_table
    .get::<ServerWebSocket>(rid)?;
  let lock = resource.reserve_lock();
  resource
    .write_frame(
      lock,
      Frame::new(true, OpCode::Text, None, data.into_bytes().into()),
    )
    .await
}

const EMPTY_PAYLOAD: &[u8] = &[];

#[op2(fast)]
#[smi]
pub fn op_ws_get_buffered_amount(
  state: &mut OpState,
  #[smi] rid: ResourceId,
) -> u32 {
  state
    .resource_table
    .get::<ServerWebSocket>(rid)
    .unwrap()
    .buffered
    .get() as u32
}

#[op2(async)]
pub async fn op_ws_send_pong(
  state: Rc<RefCell<OpState>>,
  #[smi] rid: ResourceId,
) -> Result<(), AnyError> {
  let resource = state
    .borrow_mut()
    .resource_table
    .get::<ServerWebSocket>(rid)?;
  let lock = resource.reserve_lock();
  resource
    .write_frame(lock, Frame::pong(EMPTY_PAYLOAD.into()))
    .await
}

#[op2(async)]
pub async fn op_ws_send_ping(
  state: Rc<RefCell<OpState>>,
  #[smi] rid: ResourceId,
) -> Result<(), AnyError> {
  let resource = state
    .borrow_mut()
    .resource_table
    .get::<ServerWebSocket>(rid)?;
  let lock = resource.reserve_lock();
  resource
    .write_frame(
      lock,
      Frame::new(true, OpCode::Ping, None, EMPTY_PAYLOAD.into()),
    )
    .await
}

#[op2(async(lazy))]
pub async fn op_ws_close(
  state: Rc<RefCell<OpState>>,
  #[smi] rid: ResourceId,
  #[smi] code: Option<u16>,
  #[string] reason: Option<String>,
) -> Result<(), AnyError> {
  let resource = state
    .borrow_mut()
    .resource_table
    .get::<ServerWebSocket>(rid)?;
  let frame = reason
    .map(|reason| Frame::close(code.unwrap_or(1005), reason.as_bytes()))
    .unwrap_or_else(|| Frame::close_raw(vec![].into()));

  resource.closed.set(true);
  let lock = resource.reserve_lock();
  resource.write_frame(lock, frame).await?;
  Ok(())
}

#[op2]
#[serde]
pub fn op_ws_get_buffer(
  state: &mut OpState,
  #[smi] rid: ResourceId,
) -> ToJsBuffer {
  let resource = state.resource_table.get::<ServerWebSocket>(rid).unwrap();
  resource.buffer.take().unwrap().into()
}

#[op2]
#[string]
pub fn op_ws_get_buffer_as_string(
  state: &mut OpState,
  #[smi] rid: ResourceId,
) -> String {
  let resource = state.resource_table.get::<ServerWebSocket>(rid).unwrap();
  resource.string.take().unwrap()
}

#[op2]
#[string]
pub fn op_ws_get_error(state: &mut OpState, #[smi] rid: ResourceId) -> String {
  let Ok(resource) = state.resource_table.get::<ServerWebSocket>(rid) else {
    return "Bad resource".into();
  };
  resource.errored.set(false);
  resource.error.take().unwrap_or_default()
}

#[op2(async)]
pub async fn op_ws_next_event(
  state: Rc<RefCell<OpState>>,
  #[smi] rid: ResourceId,
) -> u16 {
  let Ok(resource) = state
    .borrow_mut()
    .resource_table
    .get::<ServerWebSocket>(rid)
  else {
    // op_ws_get_error will correctly handle a bad resource
    return MessageKind::Error as u16;
  };

  // If there's a pending error, this always returns error
  if resource.errored.get() {
    return MessageKind::Error as u16;
  }

  let mut ws = RcRef::map(&resource, |r| &r.ws_read).borrow_mut().await;
  let writer = RcRef::map(&resource, |r| &r.ws_write);
  let mut sender = move |frame| {
    let writer = writer.clone();
    async move { writer.borrow_mut().await.write_frame(frame).await }
  };
  loop {
    let res = ws.read_frame(&mut sender).await;
    let val = match res {
      Ok(val) => val,
      Err(err) => {
        // No message was received, socket closed while we waited.
        // Report closed status to JavaScript.
        if resource.closed.get() {
          return MessageKind::ClosedDefault as u16;
        }

        resource.set_error(Some(err.to_string()));
        return MessageKind::Error as u16;
      }
    };

    break match val.opcode {
      OpCode::Text => match String::from_utf8(val.payload.to_vec()) {
        Ok(s) => {
          resource.string.set(Some(s));
          MessageKind::Text as u16
        }
        Err(_) => {
          resource.set_error(Some("Invalid string data".into()));
          MessageKind::Error as u16
        }
      },
      OpCode::Binary => {
        resource.buffer.set(Some(val.payload.to_vec()));
        MessageKind::Binary as u16
      }
      OpCode::Close => {
        // Close reason is returned through error
        if val.payload.len() < 2 {
          resource.set_error(None);
          MessageKind::ClosedDefault as u16
        } else {
          let close_code = CloseCode::from(u16::from_be_bytes([
            val.payload[0],
            val.payload[1],
          ]));
          let reason = String::from_utf8(val.payload[2..].to_vec()).ok();
          resource.set_error(reason);
          close_code.into()
        }
      }
      OpCode::Pong => MessageKind::Pong as u16,
      OpCode::Continuation | OpCode::Ping => {
        continue;
      }
    };
  }
}

deno_core::extension!(deno_websocket,
  deps = [ deno_url, deno_webidl ],
  parameters = [P: WebSocketPermissions],
  ops = [
    op_ws_check_permission_and_cancel_handle<P>,
    op_ws_create<P>,
    op_ws_close,
    op_ws_next_event,
    op_ws_get_buffer,
    op_ws_get_buffer_as_string,
    op_ws_get_error,
    op_ws_send_binary,
    op_ws_send_binary_ab,
    op_ws_send_text,
    op_ws_send_binary_async,
    op_ws_send_text_async,
    op_ws_send_ping,
    op_ws_send_pong,
    op_ws_get_buffered_amount,
  ],
  esm = [ "01_websocket.js", "02_websocketstream.js" ],
  options = {
    user_agent: String,
    root_cert_store_provider: Option<Arc<dyn RootCertStoreProvider>>,
    unsafely_ignore_certificate_errors: Option<Vec<String>>
  },
  state = |state, options| {
    state.put::<WsUserAgent>(WsUserAgent(options.user_agent));
    state.put(UnsafelyIgnoreCertificateErrors(
      options.unsafely_ignore_certificate_errors,
    ));
    state.put::<WsRootStoreProvider>(WsRootStoreProvider(options.root_cert_store_provider));
  },
);

pub fn get_declaration() -> PathBuf {
  PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("lib.deno_websocket.d.ts")
}

#[derive(Debug)]
pub struct DomExceptionNetworkError {
  pub msg: String,
}

impl DomExceptionNetworkError {
  pub fn new(msg: &str) -> Self {
    DomExceptionNetworkError {
      msg: msg.to_string(),
    }
  }
}

impl fmt::Display for DomExceptionNetworkError {
  fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
    f.pad(&self.msg)
  }
}

impl std::error::Error for DomExceptionNetworkError {}

pub fn get_network_error_class_name(e: &AnyError) -> Option<&'static str> {
  e.downcast_ref::<DomExceptionNetworkError>()
    .map(|_| "DOMExceptionNetworkError")
}

// Needed so hyper can use non Send futures
#[derive(Clone)]
struct LocalExecutor;

impl<Fut> hyper::rt::Executor<Fut> for LocalExecutor
where
  Fut: Future + 'static,
  Fut::Output: 'static,
{
  fn execute(&self, fut: Fut) {
    deno_core::unsync::spawn(fut);
  }
}

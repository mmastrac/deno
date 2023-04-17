//! The HTTP implementation requires a synchronous call into v8 for maximum performance in the simple-file-serving
//! case. The callback may be synchronous or asynchronous, however, and we determine this by looking at the return
//! value -- it is either a promise or not.

use std::borrow::Cow;
use std::cell::RefCell;
use std::future::Future;
use std::io;
use std::ops::DerefMut;
use std::pin::Pin;
use std::rc::Rc;

use bytes::Bytes;
use deno_core::CancelHandle;
use deno_core::WriteOutcome;
use deno_core::error::bad_resource;
use deno_core::error::AnyError;
use deno_core::futures::TryFutureExt;
use deno_core::futures::stream::Peekable;
use deno_core::futures::FutureExt;
use deno_core::futures::Stream;
use deno_core::futures::StreamExt;
use deno_core::op;
use deno_core::serde_v8::Value;
use deno_core::v8;
use deno_core::AsyncResult;
use deno_core::BufView;
use deno_core::ByteString;
use deno_core::OpState;
use deno_core::Resource;
use deno_core::ResourceId;
use deno_core::ZeroCopyBuf;
use deno_core::CancelTryFuture;
use deno_net::raw::put_network_stream_resource;
use deno_net::raw::take_network_stream_listener_resource;
use deno_net::raw::take_network_stream_resource;
use deno_net::raw::NetworkStream;
use deno_net::raw::NetworkStreamListenAddress;
use deno_net::raw::NetworkStreamType;
use hyper1::body::Body;
use hyper1::body::Frame;
use hyper1::body::Incoming;
use hyper1::body::SizeHint;
use hyper1::header::HOST;
use hyper1::http::HeaderName;
use hyper1::http::HeaderValue;
use hyper1::server::conn::http1;
use hyper1::service::service_fn;
use hyper1::StatusCode;
use slab::Slab;
use tokio::task::spawn_local;
use tokio::task::JoinHandle;

type Request = hyper1::Request<Incoming>;
type Response = hyper1::Response<ResponseBytes>;

#[derive(Default)]
enum PromiseState {
  #[default]
  None,
  Waiting(tokio::sync::oneshot::Sender<()>),
  Resolved,
}

pub struct HttpPair {
  request: Request,
  // The response may get taken before we tear this down
  response: Option<Response>,
  body: Option<Rc<HttpRequestBody>>,
  promise: PromiseState,
  tracker: Option<tokio::sync::oneshot::Sender<Result<bool, AnyError>>>,
}

thread_local! {
  pub static SLAB: RefCell<Slab<HttpPair>> = RefCell::new(Slab::with_capacity(1024));
}

macro_rules! with {
  ($ref:ident, $mut:ident, $type:ty, $http:ident, $expr:expr) => {
    #[inline(always)]
    #[allow(dead_code)]
    fn $mut<T>(key: usize, f: impl FnOnce(&mut $type) -> T) -> T {
      SLAB.with(|slab| {
        let mut borrow = slab.borrow_mut();
        #[allow(unused_mut)] // TODO(mmastrac): compiler issue?
        let mut $http = borrow.get_mut(key).unwrap();
        f(&mut $expr)
      })
    }

    #[inline(always)]
    #[allow(dead_code)]
    fn $ref<T>(key: usize, f: impl FnOnce(&$type) -> T) -> T {
      SLAB.with(|slab| {
        let borrow = slab.borrow();
        let $http = borrow.get(key).unwrap();
        f(&$expr)
      })
    }
  };
}

with!(with_req, with_req_mut, Request, http, http.request);
with!(with_resp, with_resp_mut, Option<Response>, http, http.response);
with!(with_body, with_body_mut, Option<Rc<HttpRequestBody>>, http, http.body);
with!(
  with_promise,
  with_promise_mut,
  PromiseState,
  http,
  http.promise
);
with!(with_http, with_http_mut, HttpPair, http, http);
with!(with_tracker, with_tracker_mut, Option<tokio::sync::oneshot::Sender<Result<bool, AnyError>>>, http, http.tracker);

fn slab_insert(request: Request) -> usize {
  SLAB.with(|slab| {
    slab.borrow_mut().insert(HttpPair {
      request,
      response: Some(Response::new(Default::default())),
      body: None,
      promise: PromiseState::default(),
      tracker: None,
    })
  })
}

#[derive(Default)]
enum ResponseBytesInner {
  /// A completed stream.
  #[default]
  Done,
  /// A static buffer of bytes, sent it one fell swoop.
  Bytes(usize, BufView),
  /// A resource stream, piped in fast mode.
  Resource(usize, bool, Rc<dyn Resource>, AsyncResult<BufView>),
  /// A JS-backed stream, written in JS and transported via pipe.
  V8Stream(usize, tokio::sync::mpsc::Receiver<BufView>),
}

#[derive(Default)]
struct ResponseBytes(ResponseBytesInner);

impl ResponseBytesInner {
  pub fn len(&self) -> Option<usize> {
    match self {
      Self::Done => Some(0),
      Self::Bytes(_, bytes) => Some(bytes.len()),
      Self::Resource(..) => None,
      Self::V8Stream(..) => None,
    }
  }

  pub fn finalize(&mut self, success: bool) -> ResponseBytesInner {
    println!("finalize");
    let current = std::mem::take(self);
    let index = match current {
      Self::Done => None,
      Self::Bytes(index, _) => {
        Some(index)
      },
      Self::Resource(index, ..) => {
        Some(index)
      },
      Self::V8Stream(index, ..) => {
        Some(index)
      }
    };
    if let Some(index) = index {
      println!("wakeup");
      with_tracker_mut(index, |tracker| tracker.take().map(|t| t.send(Ok(success)).unwrap()));
      SLAB.with(|slab| slab.borrow_mut().remove(index));
      println!("wokeup");
    }
    current
  }
}

impl Body for ResponseBytes {
  type Data = BufView;
  type Error = AnyError;

  fn poll_frame(
    mut self: Pin<&mut Self>,
    cx: &mut std::task::Context<'_>,
  ) -> std::task::Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
    match &mut self.0 {
      ResponseBytesInner::Done => std::task::Poll::Ready(None),
      ResponseBytesInner::Bytes(..) => {
        if let ResponseBytesInner::Bytes(_, data) = self.0.finalize(true) {
          std::task::Poll::Ready(Some(Ok(Frame::data(data))))
        } else {
          unreachable!()
        }
      },
      ResponseBytesInner::Resource(index, auto_close, stm, ref mut future) => {
        match future.poll_unpin(cx) {
          std::task::Poll::Pending => return std::task::Poll::Pending,
          std::task::Poll::Ready(Err(err)) => {
            return std::task::Poll::Ready(Some(Err(err)));
          }
          std::task::Poll::Ready(Ok(buf)) => {
            if buf.is_empty() {
              if *auto_close {
                stm.clone().close();
              }
              return std::task::Poll::Ready(None);
            }
            // Re-arm the future
            *future = stm.clone().read(64 * 1024);
            std::task::Poll::Ready(Some(Ok(Frame::data(buf))))
          }
        }
      }
      ResponseBytesInner::V8Stream(index, stm) => {
        println!("stream");
        match stm.poll_recv(cx) {
          std::task::Poll::Pending => std::task::Poll::Pending,
          std::task::Poll::Ready(Some(buf)) => {
            println!("ready");
            std::task::Poll::Ready(Some(Ok(Frame::data(BufView::from(buf)))))
          },
          std::task::Poll::Ready(None) => {
            self.0.finalize(true);
            return std::task::Poll::Ready(None);
          }
        }
      }
    }
  }

  fn is_end_stream(&self) -> bool {
    matches!(self.0, ResponseBytesInner::Done)
  }

  fn size_hint(&self) -> SizeHint {
    if let Some(size) = self.0.len() {
      SizeHint::with_exact(size as u64)
    } else {
      SizeHint::default()
    }
  }
}

impl Drop for ResponseBytes {
  fn drop(&mut self) {
    self.0.finalize(false);
  }
}

#[derive(Clone)]
struct HttpCallback {
  pub op_state: Rc<RefCell<OpState>>,
}

unsafe impl Send for HttpCallback {}
unsafe impl Sync for HttpCallback {}

struct SafeFutureForSingleThread<F: Future<Output = O> + Unpin, O> (F);

impl <F: Future<Output = O> + Unpin, O> Future for SafeFutureForSingleThread<F, O> {
  type Output = O;
  fn poll(mut self: Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<Self::Output> {
    self.0.poll_unpin(cx)      
  }
}

unsafe impl <F: Future<Output = O> + Unpin, O> Send for SafeFutureForSingleThread<F, O> {}

enum CallbackResult {
  Ready,
  PendingPromise(tokio::sync::oneshot::Receiver<()>),
}

/// The HTTP callback into v8 may require resolution of a promise.
enum HttpCallbackFuture {
  /// The callback has completed
  Ready(usize),
  /// We are waiting for a promise.
  PromisePending(usize, tokio::sync::oneshot::Receiver<()>),
  /// The future is completed and will return pending forever.
  Completed,
}

impl Future for HttpCallbackFuture {
  type Output = Result<Response, AnyError>;

  fn poll(
    mut self: Pin<&mut Self>,
    cx: &mut std::task::Context<'_>,
  ) -> std::task::Poll<Self::Output> {
    let res = match self.deref_mut() {
      Self::Ready(index) => {
        let index = *index;
        *self.get_mut() = Self::Completed;
        std::task::Poll::Ready(index)
      }
      Self::PromisePending(index, ref mut rx) => {
        let index = *index;
        rx.poll_unpin(cx).map(|_| index)
      }
      Self::Completed => {
        return std::task::Poll::Pending;
      }
    };
    match res {
      std::task::Poll::Pending => std::task::Poll::Pending,
      std::task::Poll::Ready(index) => std::task::Poll::Ready(Ok(
        with_http_mut(index, |http| http.response.take().unwrap()),
      )),
    }
  }
}

impl HttpCallback {
  pub fn process_request(&self, index: usize) -> HttpCallbackFuture {
    println!("process {}", index);
    let rx = with_promise_mut(index, |promise| {
      let (tx, rx) = tokio::sync::oneshot::channel();
      *promise = PromiseState::Waiting(tx);
      rx
    });
    HttpCallbackFuture::PromisePending(index, rx)
  }
}

#[op]
pub fn op_upgrade_raw(index: usize) {}

#[op]
pub async fn op_upgrade(
  state: Rc<RefCell<OpState>>,
  index: usize,
  headers: Vec<(ByteString, ByteString)>,
) -> Result<ResourceId, AnyError> {
  let upgrade = with_http_mut(index, |http| {
    let upgrade = hyper1::upgrade::on(&mut http.request);
    let response = http.response.as_mut().unwrap();
    *response.status_mut() = StatusCode::SWITCHING_PROTOCOLS;
    // TODO(mmastrac): headers
    for (name, value) in headers {
      response.headers_mut().append(
        HeaderName::from_bytes(&name).unwrap(),
        HeaderValue::from_bytes(&value).unwrap(),
      );
    }
    let promise = std::mem::replace(&mut http.promise, PromiseState::Resolved);
    match promise {
      PromiseState::None => {}
      PromiseState::Waiting(tx) => {
        tx.send(()).unwrap();
      }
      PromiseState::Resolved => {
        return Err(bad_resource("connection already completed"));
      }
    }
    Ok(upgrade)
  })?;
  let upgraded = upgrade.await?;
  let upgraded = match upgraded.downcast::<tokio::net::TcpStream>() {
    Ok(hyper1::upgrade::Parts { io: conn, .. }) => {
      return put_network_stream_resource(
        &mut state.borrow_mut().resource_table,
        NetworkStream::Tcp(conn),
      );
    }
    Err(x) => x,
  };
  let upgraded = match upgraded.downcast::<tokio::net::UnixStream>() {
    Ok(hyper1::upgrade::Parts { io: conn, .. }) => {
      return put_network_stream_resource(
        &mut state.borrow_mut().resource_table,
        NetworkStream::Unix(conn),
      );
    }
    Err(x) => x,
  };
  let _upgraded = match upgraded.downcast::<deno_net::ops_tls::TlsStream>() {
    Ok(hyper1::upgrade::Parts { io: conn, .. }) => {
      return put_network_stream_resource(
        &mut state.borrow_mut().resource_table,
        NetworkStream::Tls(conn),
      );
    }
    Err(x) => x,
  };
  Err(bad_resource("Impossible to upgrade this connection"))
}

#[op]
pub fn op_set_promise_complete(index: usize) {
  println!("promise...");
  with_promise_mut(index, |promise| {
    let promise_state = std::mem::replace(promise, PromiseState::Resolved);
    match promise_state {
      PromiseState::None => {}
      PromiseState::Waiting(tx) => {
        println!("promise send!");
        // TODO(mmastrac): Don't unwrap
        tx.send(()).unwrap();
      }
      PromiseState::Resolved => {}
    }
  });
  println!("promise!");
}

/// Compute the fallback address from the [`NetworkStreamListenAddress`]. If the request has no authority/host in
/// its URI, and there is no [`HeaderName::HOST`] header, we fall back to this.
fn req_host_from_addr(
  stream_type: NetworkStreamType,
  addr: &NetworkStreamListenAddress,
) -> String {
  match addr {
    NetworkStreamListenAddress::Ip(addr) => {
      if stream_type == NetworkStreamType::Tls && addr.port() == 443 {
        addr.ip().to_string()
      } else if stream_type == NetworkStreamType::Tcp && addr.port() == 80 {
        addr.ip().to_string()
      } else {
        addr.to_string()
      }
    }
    // There is no standard way for unix domain socket URLs
    // nginx and nodejs request use http://unix:[socket_path]:/ but it is not a valid URL
    // httpie uses http+unix://[percent_encoding_of_path]/ which we follow
    #[cfg(unix)]
    NetworkStreamListenAddress::Unix(unix) => percent_encoding::percent_encode(
      unix
        .as_pathname()
        .and_then(|x| x.to_str())
        .unwrap_or_default()
        .as_bytes(),
      percent_encoding::NON_ALPHANUMERIC,
    )
    .to_string(),
  }
}

fn req_scheme_from_stream_type(stream_type: NetworkStreamType) -> &'static str {
  match stream_type {
    NetworkStreamType::Tcp => "http://",
    NetworkStreamType::Tls => "https://",
    NetworkStreamType::Unix => "http+unix://",
  }
}

fn req_fallback_url(
  stream_type: NetworkStreamType,
  addr: &NetworkStreamListenAddress,
) -> String {
  format!(
    "{}{}",
    req_scheme_from_stream_type(stream_type),
    req_host_from_addr(stream_type, addr)
  )
}

fn req_host<'a>(
  req: &'a Request,
  addr: &NetworkStream,
) -> Option<Cow<'a, str>> {
  // Unix sockets always use the socket address
  if let NetworkStream::Unix(_) = addr {
    return None;
  }

  if let Some(auth) = req.uri().authority() {
    match addr {
      NetworkStream::Tcp(tcp) => {
        if tcp.local_addr().unwrap().port() == 80 {
          return Some(Cow::Borrowed(auth.host()));
        }
      }
      NetworkStream::Tls(tls) => {
        if tls.local_addr().unwrap().port() == 443 {
          return Some(Cow::Borrowed(auth.host()));
        }
      }
      _ => {}
    }
    return Some(Cow::Borrowed(auth.as_str()));
  }

  if let Some(host) = req.uri().host() {
    return Some(Cow::Borrowed(host));
  }

  // Most requests will use this path
  if let Some(host) = req.headers().get(HOST) {
    return Some(match host.to_str() {
      Ok(host) => Cow::Borrowed(host),
      Err(_) => Cow::Owned(
        host
          .as_bytes()
          .iter()
          .cloned()
          .map(char::from)
          .collect::<String>(),
      ),
    });
  }

  None
}

#[op]
pub fn op_get_request_method_and_url(
  index: usize,
) -> (String, Option<String>, String) {
  with_http(index, |http| {
    let value = http.request.uri();
    // TODO(mmastrac): HOST
    // TODO(mmastrac): Method can be optimized
    (
      http.request.method().as_str().to_owned(),
      None,
      value.to_string(),
    )
  })
}

#[op]
pub fn op_get_request_header(index: usize, name: String) -> Option<ByteString> {
  with_http(index, |http| {
    let value = http.request.headers().get(name);
    if let Some(value) = value {
      Some(value.as_bytes().into())
    } else {
      None
    }
  })
}

#[op]
pub fn op_get_request_headers(index: usize) -> Vec<(ByteString, ByteString)> {
  with_http(index, |http| {
    let headers = http.request.headers();
    let mut vec = Vec::with_capacity(headers.len());
    for (name, value) in headers {
      let name: &[u8] = name.as_ref();
      vec.push((name.into(), value.as_bytes().into()))
    }
    vec
  })
}

struct ReadFuture(usize);

impl Stream for ReadFuture {
  type Item = Result<Bytes, AnyError>;

  fn poll_next(
    self: Pin<&mut Self>,
    cx: &mut std::task::Context<'_>,
  ) -> std::task::Poll<Option<Self::Item>> {
    with_req_mut(self.0, |req| {
      println!("frame?");
      let res = Pin::new(req).poll_frame(cx);
      println!("frame {:?}", res);
      match res {
        std::task::Poll::Ready(Some(Ok(frame))) => {
          println!("frame");
          if let Ok(data) = frame.into_data() {
            // Ensure that we never yield an empty frame
            if !data.is_empty() {
              return std::task::Poll::Ready(Some(Ok(data)));
            }
          }
        }
        std::task::Poll::Ready(None) => return std::task::Poll::Ready(None),
        _ => {}
      }
      std::task::Poll::Pending
    })
  }
}

struct HttpRequestBody(RefCell<Peekable<ReadFuture>>);

impl HttpRequestBody {
  async fn read(self: Rc<Self>, limit: usize) -> Result<BufView, AnyError> {
    let mut peekable = self.0.borrow_mut();
    println!("peek");
    let res = Pin::new(&mut *peekable).peek_mut().await;
    println!("peek {:?}", res);
    match res {
      None => return Ok(BufView::empty()),
      Some(Err(_)) => {
        return Err(peekable.next().await.unwrap().err().unwrap())
      }
      Some(Ok(bytes)) => {
        println!("bytes");
        if bytes.len() <= limit {
          println!("bytes!");
          // We can safely take the next item since we peeked it
          return Ok(BufView::from(peekable.next().await.unwrap()?));
        }

        println!("bytes split");
        let ret = bytes.split_to(limit);
        return Ok(BufView::from(ret));
      }
    }
  }
}

impl Resource for HttpRequestBody {
  fn name(&self) -> Cow<str> {
    "requestBody".into()
  }

  fn read(self: Rc<Self>, limit: usize) -> AsyncResult<BufView> {
    Box::pin(HttpRequestBody::read(self, limit))
  }
}

struct HttpResponseBody(RefCell<Option<tokio::sync::mpsc::Sender<BufView>>>);

impl Resource for HttpResponseBody {
  fn name(&self) -> Cow<str> {
    return "responseBody".into();
  }

  fn write(self: Rc<Self>, buf: BufView) -> AsyncResult<deno_core::WriteOutcome> {
    let clone = self.clone();
    Box::pin(async move {
      println!("write");
      let nwritten = buf.len();
      let res = clone.0.borrow().as_ref().unwrap().send(buf).await;
      println!("write! {:?}", res.is_ok());
      res.map_err(|_| bad_resource("failed to write"))?;
      println!("write!");
      Ok(WriteOutcome::Full { nwritten })
    })
  }

  fn close(self: Rc<Self>) {
    println!("close");
    self.0.borrow_mut().take();
  }
}

#[op]
pub fn op_read_request_body(state: &mut OpState, index: usize) -> ResourceId {
  println!("body");
  let body_resource = Rc::new(HttpRequestBody(RefCell::new(ReadFuture(index).peekable())));
  let res = state.resource_table.add_rc(body_resource.clone());
  with_body_mut(index, |body| {
    *body = Some(body_resource);
  });
  res
}

#[op]
pub fn op_set_response_header(
  index: usize,
  name: String,
  value: String,
) {
  with_resp_mut(index, |resp| {
    let resp_headers = resp.as_mut().unwrap().headers_mut();
    resp_headers.append(
      HeaderName::from_bytes(&name.as_bytes()).unwrap(),
      HeaderValue::from_bytes(&value.as_bytes()).unwrap(),
    );
  })
}

#[op]
pub fn op_set_response_headers(
  index: usize,
  headers: Vec<(String, String)>,
) {
  with_resp_mut(index, |resp| {
    let resp_headers = resp.as_mut().unwrap().headers_mut();
    resp_headers.reserve(headers.len());
    for (name, value) in headers {
      resp_headers.append(
        HeaderName::from_bytes(&name.as_bytes()).unwrap(),
        HeaderValue::from_bytes(&value.as_bytes()).unwrap(),
      );
    }
  })
}

#[op]
pub fn op_set_response_body_resource(
  state: &mut OpState,
  index: usize,
  stream_rid: ResourceId,
  auto_close: bool,
) -> Result<(), AnyError> {
  let resource = state.resource_table.get_any(stream_rid)?;

  with_resp_mut(index, move |response| {
    let future = resource.clone().read(64 * 1024);
    *response.as_mut().unwrap().body_mut() = ResponseBytes(ResponseBytesInner::Resource(index, auto_close, resource, future));
  });

  Ok(())
}

#[op]
pub fn op_set_response_body_stream(
  state: &mut OpState,
  index: usize,
) -> Result<ResourceId, AnyError> {
  // TODO(mmastrac): what should this channel size be?
  let (tx, rx) = tokio::sync::mpsc::channel(1);
  with_resp_mut(index, move |response| {
    *response.as_mut().unwrap().body_mut() = ResponseBytes(ResponseBytesInner::V8Stream(index, rx));
  });

  Ok(state.resource_table.add(HttpResponseBody(RefCell::new(Some(tx)))))
}

#[op]
pub fn op_set_response_body_text(index: usize, text: String) {
  println!("body text");
  with_resp_mut(index, move |response| {
    *response.as_mut().unwrap().body_mut() =
      ResponseBytes(ResponseBytesInner::Bytes(index, BufView::from(text.into_bytes())))
  });
  println!("body text done");
}

#[op]
pub fn op_set_response_body_bytes(index: usize, buffer: ZeroCopyBuf) {
  with_resp_mut(index, |response| {
    *response.as_mut().unwrap().body_mut() = ResponseBytes(ResponseBytesInner::Bytes(index, BufView::from(buffer)))
  });
}

#[op]
pub async fn op_http_track(state: Rc<RefCell<OpState>>, index: usize, server_rid: ResourceId) -> Result<(), AnyError> {
  let (tx, rx) = tokio::sync::oneshot::channel();

  println!("track write");

  with_tracker_mut(index, |tracker| {
    *tracker = Some(tx);
  });

  let cancel_handle = state
    .borrow_mut()
    .resource_table
    .get::<HttpJoinHandle>(server_rid)?.1.clone();

    println!("track");

  let res = rx.map(|e| match e {
    Err(e) => Err(AnyError::from(e)),
    Ok(Err(e)) => Err(AnyError::from(e)),
    Ok(Ok(true)) => Ok(()),
    Ok(Ok(false)) => Err(AnyError::msg("failed to write entire stream"))
  }).try_or_cancel(cancel_handle).await;

  println!("tracked {:?}", res);

  res
}

fn serve_http(
  io: impl tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
  http_callback: HttpCallback,
  cancel: Rc<CancelHandle>,
  tx: tokio::sync::mpsc::Sender<usize>,
) -> JoinHandle<Result<(), AnyError>> {
  // TODO(mmastrac): This is faster if we can use tokio::spawn but then the send bounds get us
  let safe_future = SafeFutureForSingleThread(Box::pin(async {
    let res = http1::Builder::new()
      .keep_alive(true)
      .serve_connection(
        io,
        service_fn(move |req| {
          let index = slab_insert(req);
          let tx = tx.clone();
          async move {
            let rx = with_promise_mut(index, |promise| {
              let (tx, rx) = tokio::sync::oneshot::channel();
              *promise = PromiseState::Waiting(tx);
              rx
            });
            tx.send(index).await.unwrap();
            HttpCallbackFuture::PromisePending(index, rx).await
          }
        }),
      )
      .with_upgrades()
      .map_err(|e| AnyError::from(e))
      .try_or_cancel(cancel)
      .await;

    res
  }));
  spawn_local(safe_future)
}

fn serve_http_on(
  network_stream: NetworkStream,
  http_callback: HttpCallback,
  cancel: Rc<CancelHandle>,
  tx: tokio::sync::mpsc::Sender<usize>,
) -> JoinHandle<Result<(), AnyError>> {
  match network_stream {
    NetworkStream::Tcp(conn) => serve_http(conn, http_callback, cancel, tx),
    NetworkStream::Tls(conn) => serve_http(conn, http_callback, cancel, tx),
    NetworkStream::Unix(conn) => serve_http(conn, http_callback, cancel, tx),
  }
}

struct HttpJoinHandle(RefCell<Option<JoinHandle<Result<(), AnyError>>>>, Rc<CancelHandle>, RefCell<tokio::sync::mpsc::Receiver<usize>>);

impl Resource for HttpJoinHandle {
  fn name(&self) -> Cow<str> {
    "http".into()
  }

  fn close(self: Rc<Self>) {
    println!("close");
    self.1.cancel()
  }
}

#[op(v8)]
pub fn op_serve_http<'scope>(
  scope: &mut v8::HandleScope<'scope>,
  state: Rc<RefCell<OpState>>,
  listener_rid: ResourceId,
  init_cb: Value<'scope>,
) -> Result<ResourceId, AnyError> {
  let listener = take_network_stream_listener_resource(
    &mut state.borrow_mut().resource_table,
    listener_rid,
  )?;

  let fallback_base_url =
    req_fallback_url(listener.stream(), &listener.listen_address()?);
  let init_callback = v8::Local::<v8::Function>::try_from(init_cb.v8_value)?;
  let recv = v8::undefined(scope);
  let url = v8::String::new(scope, fallback_base_url.as_str()).unwrap();
  init_callback.call(scope, recv.into(), &[url.into()]);

  let http_callback = HttpCallback {
    op_state: state.clone(),
  };

  let cancel = Rc::new(CancelHandle::new());
  let (tx, rx) = tokio::sync::mpsc::channel(10);
  // TODO(mmastrac): Cancel handle makes this !send
  let cancel_clone = cancel.clone();
  let handle = spawn_local(SafeFutureForSingleThread(Box::pin(async move {
    loop {
      serve_http_on(listener.accept().await?, http_callback.clone(), cancel_clone.clone(), tx.clone());
    }
    // TODO(mmastrac): We need to listen for the abort signal
    #[allow(unreachable_code)]
    Ok::<_, AnyError>(())
  })));

  Ok(
    state
      .borrow_mut()
      .resource_table
      .add(HttpJoinHandle(RefCell::new(Some(handle)), cancel, RefCell::new(rx))),
  )
}

#[op(v8)]
pub fn op_serve_http_on<'scope>(
  scope: &mut v8::HandleScope<'scope>,
  state: Rc<RefCell<OpState>>,
  conn: ResourceId,
  init_cb: Value<'scope>,
) -> Result<ResourceId, AnyError> {
  let network_stream = take_network_stream_resource(
    &mut (&mut *state.borrow_mut()).resource_table,
    conn,
  )?;

  let fallback_base_url =
    req_fallback_url(network_stream.stream(), &network_stream.local_address()?);
  let init_callback = v8::Local::<v8::Function>::try_from(init_cb.v8_value)?;
  let recv = v8::undefined(scope);
  let url = v8::String::new(scope, fallback_base_url.as_str()).unwrap();
  init_callback.call(scope, recv.into(), &[url.into()]);

  let http_callback = HttpCallback {
    op_state: state.clone(),
  };

  let cancel = Rc::new(CancelHandle::new());
  let (tx, rx) = tokio::sync::mpsc::channel(10);
  let handle = serve_http_on(network_stream, http_callback, cancel.clone(), tx);
  Ok(
    state
      .borrow_mut()
      .resource_table
      .add(HttpJoinHandle(RefCell::new(Some(handle)), cancel, RefCell::new(rx))),
  )
}

#[op]
pub async fn op_http_wait(
  state: Rc<RefCell<OpState>>,
  rid: ResourceId,
) -> Result<u32, AnyError> {
  let handle = state
    .borrow_mut()
    .resource_table
    .get::<HttpJoinHandle>(rid)?;

  println!("wait");
  let mut recv = handle.2.borrow_mut();
  match recv.recv().await {
    None => {
      let res = handle.0.borrow_mut().take().unwrap().await?;

      // Drop the cancel and join handles
      state.borrow_mut().resource_table.take::<HttpJoinHandle>(rid)?;

      // Filter out shutdown errors
      if let Err(err) = res {
        if let Some(err) = err.source() {
          if let Some(err) = err.downcast_ref::<io::Error>() {
            if err.kind() == io::ErrorKind::NotConnected {
              return Ok(u32::MAX);
            }
          }
        }
        return Err(err);
      }
      return Ok(u32::MAX);
    }
    Some(req) => {
      return Ok(req as u32);
    }
  }

  // let res = handle.0.borrow_mut().take().unwrap().await?;

  // // Drop the cancel and join handles
  // state.borrow_mut().resource_table.take::<HttpJoinHandle>(rid)?;

  // // Filter out shutdown errors
  // if let Err(ref err) = res {
  //   if let Some(err) = err.source() {
  //     if let Some(err) = err.downcast_ref::<io::Error>() {
  //       if err.kind() == io::ErrorKind::NotConnected {
  //         return Ok(());
  //       }
  //     }
  //   }
  // }

  // res
}

#[cfg(test)]
mod tests {
  #[tokio::test]
  async fn http_runtime_sync() {}
}

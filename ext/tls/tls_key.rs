use crate::load_certs;
use crate::load_private_keys;
use crate::Certificate;
use crate::PrivateKey;
use deno_core::anyhow::anyhow;
use deno_core::error::AnyError;
use deno_core::futures::future::Either;
use deno_core::futures::FutureExt;
use deno_core::unsync::spawn;
use rustls::ServerConfig;
use rustls_tokio_stream::ServerConfigProvider;
use std::cell::RefCell;
use std::collections::HashMap;
use std::fmt::Debug;
use std::future::ready;
use std::future::Future;
use std::io::BufReader;
use std::io::ErrorKind;
use std::rc::Rc;
use std::sync::Arc;
use tokio::sync::oneshot;

type ErrorType = Rc<AnyError>;

/// A TLS certificate/private key pair.
#[derive(Clone, Debug)]
pub struct TlsKey(pub Vec<Certificate>, pub PrivateKey);

#[derive(Clone, Debug, Default)]
pub enum TlsKeys {
  // TODO(mmastrac): We need Option<&T> for cppgc -- this is a workaround
  #[default]
  Null,
  Static(TlsKey),
  Resolver(TlsKeyResolver),
}

impl TryInto<Option<TlsKey>> for TlsKeys {
  type Error = Self;
  fn try_into(self) -> Result<Option<TlsKey>, Self::Error> {
    match self {
      Self::Null => Ok(None),
      Self::Static(key) => Ok(Some(key)),
      Self::Resolver(_) => Err(self),
    }
  }
}

impl From<Option<TlsKey>> for TlsKeys {
  fn from(value: Option<TlsKey>) -> Self {
    match value {
      None => TlsKeys::Null,
      Some(key) => TlsKeys::Static(key),
    }
  }
}

enum TlsKeyState {
  Resolving(
    tokio::sync::broadcast::Receiver<Result<(String, String), ErrorType>>,
  ),
  Resolved(Result<(String, String), ErrorType>),
}

struct TlsKeyResolverInner {
  resolution_tx: tokio::sync::mpsc::UnboundedSender<(
    String,
    tokio::sync::broadcast::Sender<Result<(String, String), ErrorType>>,
  )>,
  cache: RefCell<HashMap<String, TlsKeyState>>,
}

#[derive(Clone)]
pub struct TlsKeyResolver {
  inner: Rc<TlsKeyResolverInner>,
}

static_assertions::assert_impl_all!((Arc<ServerConfig>, std::io::Error): Send, Sync);

impl TlsKeyResolver {
  async fn resolve_internal(
    &self,
    sni: String,
    alpn: Vec<Vec<u8>>,
  ) -> Result<Arc<ServerConfig>, AnyError> {
    let (cert, key) = self.resolve(sni).await?;
    let cert = load_certs(&mut BufReader::new(cert.as_bytes()))?;
    let key = load_private_keys(key.as_bytes())?
      .into_iter()
      .next()
      .unwrap();

    let mut tls_config = ServerConfig::builder()
      .with_safe_defaults()
      .with_no_client_auth()
      .with_single_cert(cert, key)?;
    tls_config.alpn_protocols = alpn;
    Ok(tls_config.into())
  }

  pub fn into_server_config_provider(
    self,
    alpn: Vec<Vec<u8>>,
  ) -> ServerConfigProvider {
    let (tx, mut rx) =
      tokio::sync::mpsc::unbounded_channel::<(_, oneshot::Sender<_>)>();

    // We don't want to make the resolver multi-threaded, but the `ServerConfigProvider` is
    // required to be wrapped in an Arc. To fix this, we spawn a task in our current runtime
    // to respond to the requests.
    spawn(async move {
      while let Some((sni, txr)) = rx.recv().await {
        _ = txr.send(self.resolve_internal(sni, alpn.clone()).await);
      }
    });

    Arc::new(move |hello| {
      // Take ownership of the SNI information
      let sni = hello.server_name().unwrap_or_default().to_owned();
      let (txr, rxr) = tokio::sync::oneshot::channel::<_>();
      _ = tx.send((sni, txr));
      rxr
        .map(|res| match res {
          Err(e) => Err(std::io::Error::new(ErrorKind::InvalidData, e)),
          Ok(Err(e)) => Err(std::io::Error::new(ErrorKind::InvalidData, e)),
          Ok(Ok(res)) => Ok(res),
        })
        .boxed()
    })
  }
}

impl Debug for TlsKeyResolver {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.debug_struct("TlsKeyResolver").finish()
  }
}

pub fn new_resolver() -> (TlsKeyResolver, TlsKeyLookup) {
  let (resolution_tx, resolution_rx) = tokio::sync::mpsc::unbounded_channel();
  (
    TlsKeyResolver {
      inner: Rc::new(TlsKeyResolverInner {
        resolution_tx,
        cache: Default::default(),
      }),
    },
    TlsKeyLookup {
      resolution_rx: RefCell::new(resolution_rx),
      pending: Default::default(),
    },
  )
}

impl TlsKeyResolver {
  /// Resolve the certificate and key for a given host. This immediately spawns a task in the
  /// background and is therefore cancellation-safe.
  pub fn resolve(
    &self,
    sni: String,
  ) -> impl Future<Output = Result<(String, String), AnyError>> {
    let mut cache = self.inner.cache.borrow_mut();
    let mut recv = match cache.get(&sni) {
      None => {
        eprintln!("send");
        let (tx, rx) = tokio::sync::broadcast::channel(1);
        cache.insert(sni.clone(), TlsKeyState::Resolving(rx.resubscribe()));
        _ = self.inner.resolution_tx.send((sni.clone(), tx));
        rx
      }
      Some(TlsKeyState::Resolving(recv)) => recv.resubscribe(),
      Some(TlsKeyState::Resolved(res)) => {
        return Either::Left(ready(res.clone().map_err(|_| anyhow!("Failed"))));
      }
    };
    drop(cache);

    // Make this cancellation safe
    let inner = self.inner.clone();
    let handle = spawn(async move {
      let res = recv.recv().await?;
      let mut cache = inner.cache.borrow_mut();
      match cache.get(&sni) {
        None | Some(TlsKeyState::Resolving(..)) => {
          cache.insert(sni, TlsKeyState::Resolved(res.clone()));
        }
        Some(TlsKeyState::Resolved(..)) => {
          // Someone beat us to it
        }
      }
      Ok(res.map_err(|_| anyhow!("Failed"))?)
    });
    Either::Right(async move {
      let res = handle.await?;
      res
    })
  }
}

pub struct TlsKeyLookup {
  resolution_rx: RefCell<
    tokio::sync::mpsc::UnboundedReceiver<(
      String,
      tokio::sync::broadcast::Sender<Result<(String, String), ErrorType>>,
    )>,
  >,
  pending: RefCell<
    HashMap<
      String,
      tokio::sync::broadcast::Sender<Result<(String, String), ErrorType>>,
    >,
  >,
}

impl TlsKeyLookup {
  /// Only one poll call may be active at any time. This method holds a `RefCell` lock.
  pub async fn poll(&self) -> Option<String> {
    eprintln!("poll");
    if let Some((sni, sender)) = self.resolution_rx.borrow_mut().recv().await {
      eprintln!("got {sni}");
      self.pending.borrow_mut().insert(sni.clone(), sender);
      Some(sni)
    } else {
      None
    }
  }

  /// Resolve a previously polled item.
  pub fn resolve(&self, sni: String, res: Result<(String, String), AnyError>) {
    _ = self
      .pending
      .borrow_mut()
      .remove(&sni)
      .unwrap()
      .send(res.map_err(|e| Rc::new(e)));
  }
}

#[cfg(test)]
pub mod tests {
  use super::*;
  use deno_core::unsync::spawn;

  #[tokio::test]
  async fn test_resolve_once() {
    let (resolver, lookup) = new_resolver();
    let task = spawn(async move {
      while let Some(sni) = lookup.poll().await {
        lookup.resolve(
          sni.clone(),
          Ok((format!("{sni}-cert"), format!("{sni}-key"))),
        );
      }
    });

    let (cert, key) = resolver.resolve("example.com".to_owned()).await.unwrap();
    assert_eq!("example.com-cert", cert);
    assert_eq!("example.com-key", key);
    drop(resolver);

    task.await.unwrap();
  }

  #[tokio::test]
  async fn test_resolve_concurrent() {
    let (resolver, lookup) = new_resolver();
    let task = spawn(async move {
      while let Some(sni) = lookup.poll().await {
        lookup.resolve(
          sni.clone(),
          Ok((format!("{sni}-cert"), format!("{sni}-key"))),
        );
      }
    });

    let f1 = resolver.resolve("example.com".to_owned());
    let f2 = resolver.resolve("example.com".to_owned());

    let (cert, key) = f1.await.unwrap();
    assert_eq!("example.com-cert", cert);
    assert_eq!("example.com-key", key);
    let (cert, key) = f2.await.unwrap();
    assert_eq!("example.com-cert", cert);
    assert_eq!("example.com-key", key);
    drop(resolver);

    task.await.unwrap();
  }

  #[tokio::test]
  async fn test_resolve_multiple_concurrent() {
    let (resolver, lookup) = new_resolver();
    let task = spawn(async move {
      while let Some(sni) = lookup.poll().await {
        lookup.resolve(
          sni.clone(),
          Ok((format!("{sni}-cert"), format!("{sni}-key"))),
        );
      }
    });

    let f1 = resolver.resolve("example1.com".to_owned());
    let f2 = resolver.resolve("example2.com".to_owned());

    let (cert, key) = f1.await.unwrap();
    assert_eq!("example1.com-cert", cert);
    assert_eq!("example1.com-key", key);
    let (cert, key) = f2.await.unwrap();
    assert_eq!("example2.com-cert", cert);
    assert_eq!("example2.com-key", key);
    drop(resolver);

    task.await.unwrap();
  }
}

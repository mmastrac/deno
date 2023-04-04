// Copyright 2018-2023 the Deno authors. All rights reserved. MIT license.

use crate::io::TcpStreamResource;
use crate::io::UnixStreamResource;
use crate::ops::TcpListenerResource;
use crate::ops_tls::TlsListenerResource;
use crate::ops_tls::TlsStream;
use crate::ops_tls::TlsStreamResource;
use crate::ops_unix::UnixListenerResource;
use deno_core::error::bad_resource;
use deno_core::error::bad_resource_id;
use deno_core::error::AnyError;
use deno_core::ResourceTable;

use deno_core::ResourceId;
use deno_tls::rustls::ServerConfig;

use std::rc::Rc;
use std::sync::Arc;
use tokio::net::TcpStream;
use tokio::net::UnixStream;

/// A raw stream of one of the types handled by this extension.
pub enum NetworkStream {
  Tcp(TcpStream),
  Tls(TlsStream),
  #[cfg(unix)]
  Unix(UnixStream),
}

/// A raw stream of one of the types handled by this extension.
#[derive(Copy, Clone, PartialEq, Eq)]
pub enum NetworkStreamType {
  Tcp,
  Tls,
  #[cfg(unix)]
  Unix,
}

impl NetworkStream {
  pub fn local_address(
    &self,
  ) -> Result<NetworkStreamListenAddress, std::io::Error> {
    match self {
      Self::Tcp(tcp) => Ok(NetworkStreamListenAddress::Ip(tcp.local_addr()?)),
      Self::Tls(tls) => Ok(NetworkStreamListenAddress::Ip(tls.local_addr()?)),
      #[cfg(unix)]
      Self::Unix(unix) => {
        Ok(NetworkStreamListenAddress::Unix(unix.local_addr()?))
      }
    }
  }

  pub fn stream(&self) -> NetworkStreamType {
    match self {
      Self::Tcp(_) => NetworkStreamType::Tcp,
      Self::Tls(_) => NetworkStreamType::Tls,
      Self::Unix(_) => NetworkStreamType::Unix,
    }
  }
}

/// A raw stream listener of one of the types handled by this extension.
pub enum NetworkStreamListener {
  Tcp(tokio::net::TcpListener),
  Tls(tokio::net::TcpListener, Arc<ServerConfig>),
  #[cfg(unix)]
  Unix(tokio::net::UnixListener),
}

pub enum NetworkStreamListenAddress {
  Ip(std::net::SocketAddr),
  #[cfg(unix)]
  Unix(tokio::net::unix::SocketAddr),
}

impl NetworkStreamListener {
  /// Accepts a connection on this listener.
  pub async fn accept(&self) -> Result<NetworkStream, AnyError> {
    Ok(match self {
      Self::Tcp(tcp) => {
        let (stream, _addr) = tcp.accept().await?;
        NetworkStream::Tcp(stream)
      }
      Self::Tls(tcp, config) => {
        let (stream, _addr) = tcp.accept().await?;
        NetworkStream::Tls(TlsStream::new_server_side(stream, config.clone()))
      }
      #[cfg(unix)]
      Self::Unix(unix) => {
        let (stream, _addr) = unix.accept().await?;
        NetworkStream::Unix(stream)
      }
    })
  }

  pub fn listen_address(
    &self,
  ) -> Result<NetworkStreamListenAddress, std::io::Error> {
    match self {
      Self::Tcp(tcp) => Ok(NetworkStreamListenAddress::Ip(tcp.local_addr()?)),
      Self::Tls(tcp, _) => {
        Ok(NetworkStreamListenAddress::Ip(tcp.local_addr()?))
      }
      #[cfg(unix)]
      Self::Unix(unix) => {
        Ok(NetworkStreamListenAddress::Unix(unix.local_addr()?))
      }
    }
  }

  pub fn stream(&self) -> NetworkStreamType {
    match self {
      Self::Tcp(..) => NetworkStreamType::Tcp,
      Self::Tls(..) => NetworkStreamType::Tls,
      Self::Unix(..) => NetworkStreamType::Unix,
    }
  }
}

/// In some cases it may be more efficient to extract the resource from the resource table and use it directly (for example, an HTTP server).
/// This method will extract a stream from the resource table and return it, unwrapped.
pub fn take_network_stream_resource(
  resource_table: &mut ResourceTable,
  stream_rid: ResourceId,
) -> Result<NetworkStream, AnyError> {
  // The stream we're attempting to unwrap may be in use somewhere else. If that's the case, we cannot proceed
  // with the process of unwrapping this connection, so we just return a bad resource error.
  // See also: https://github.com/denoland/deno/pull/16242

  if let Ok(resource_rc) = resource_table.take::<TcpStreamResource>(stream_rid)
  {
    // This TCP connection might be used somewhere else.
    let resource = Rc::try_unwrap(resource_rc)
      .map_err(|_| bad_resource("TCP stream is currently in use"))?;
    let (read_half, write_half) = resource.into_inner();
    let tcp_stream = read_half.reunite(write_half)?;
    return Ok(NetworkStream::Tcp(tcp_stream));
  }

  if let Ok(resource_rc) = resource_table.take::<TlsStreamResource>(stream_rid)
  {
    // This TLS connection might be used somewhere else.
    let resource = Rc::try_unwrap(resource_rc)
      .map_err(|_| bad_resource("TLS stream is currently in use"))?;
    let (read_half, write_half) = resource.into_inner();
    let tls_stream = read_half.reunite(write_half);
    return Ok(NetworkStream::Tls(tls_stream));
  }

  #[cfg(unix)]
  if let Ok(resource_rc) = resource_table.take::<UnixStreamResource>(stream_rid)
  {
    // This UNIX socket might be used somewhere else.
    let resource = Rc::try_unwrap(resource_rc)
      .map_err(|_| bad_resource("UNIX stream is currently in use"))?;
    let (read_half, write_half) = resource.into_inner();
    let unix_stream = read_half.reunite(write_half)?;
    return Ok(NetworkStream::Unix(unix_stream));
  }

  Err(bad_resource_id())
}

/// Inserts a raw stream (back?) into the resource table and returns a resource ID. This can then be used to create raw connection
/// objects on the JS side.
pub fn put_network_stream_resource(
  resource_table: &mut ResourceTable,
  stream: NetworkStream,
) -> Result<ResourceId, AnyError> {
  let res = match stream {
    NetworkStream::Tcp(conn) => {
      let (r, w) = conn.into_split();
      resource_table.add(TcpStreamResource::new((r, w)))
    }
    NetworkStream::Tls(conn) => {
      let (r, w) = conn.into_split();
      resource_table.add(TlsStreamResource::new((r, w)))
    }
    #[cfg(unix)]
    NetworkStream::Unix(conn) => {
      let (r, w) = conn.into_split();
      resource_table.add(UnixStreamResource::new((r, w)))
    }
  };

  Ok(res)
}

/// In some cases it may be more efficient to extract the resource from the resource table and use it directly (for example, an HTTP server).
/// This method will extract a stream from the resource table and return it, unwrapped.
pub fn take_network_stream_listener_resource(
  resource_table: &mut ResourceTable,
  stream_rid: ResourceId,
) -> Result<NetworkStreamListener, AnyError> {
  if let Ok(resource_rc) =
    resource_table.take::<TcpListenerResource>(stream_rid)
  {
    let resource = Rc::try_unwrap(resource_rc)
      .map_err(|_| bad_resource("TCP socket listener is currently in use"))?;
    return Ok(NetworkStreamListener::Tcp(resource.listener.into_inner()));
  }

  if let Ok(resource_rc) =
    resource_table.take::<TlsListenerResource>(stream_rid)
  {
    let resource = Rc::try_unwrap(resource_rc)
      .map_err(|_| bad_resource("TLS socket listener is currently in use"))?;
    return Ok(NetworkStreamListener::Tls(
      resource.tcp_listener.into_inner(),
      resource.tls_config,
    ));
  }

  #[cfg(unix)]
  if let Ok(resource_rc) =
    resource_table.take::<UnixListenerResource>(stream_rid)
  {
    let resource = Rc::try_unwrap(resource_rc)
      .map_err(|_| bad_resource("UNIX socket listener is currently in use"))?;
    return Ok(NetworkStreamListener::Unix(resource.listener.into_inner()));
  }

  Err(bad_resource_id())
}

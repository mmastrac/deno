// Copyright 2018-2023 the Deno authors. All rights reserved. MIT license.

use bytes::Bytes;
use deno_core::futures::future::poll_fn;
use deno_core::futures::ready;
use std::io;
use std::mem::MaybeUninit;
use std::pin::Pin;
use std::task::Poll;
use tokio::io::AsyncRead;
use tokio::io::AsyncWrite;
use tokio::io::ReadBuf;

const MAX_PREFIX_SIZE: usize = 256;

pub struct NetworkStreamPrefixCheck<S: AsyncRead + Unpin> {
  io: S,
  prefix: &'static [u8],
  buffer: [MaybeUninit<u8>; MAX_PREFIX_SIZE * 2],
}

impl<S: AsyncRead + Unpin> NetworkStreamPrefixCheck<S> {
  pub fn new(io: S, prefix: &'static [u8]) -> Self {
    debug_assert!(prefix.len() < MAX_PREFIX_SIZE);
    Self {
      io,
      prefix,
      buffer: [MaybeUninit::<u8>::uninit(); MAX_PREFIX_SIZE * 2],
    }
  }

  // Returns a [`NetworkBufferedStream`], rewound with the bytes we read to determine what
  // type of stream this is.
  pub async fn match_prefix(
    self,
  ) -> io::Result<(bool, NetworkBufferedStream<S>)> {
    let mut buffer = self.buffer;
    let mut readbuf = ReadBuf::uninit(&mut buffer);
    let mut io = self.io;
    let prefix = self.prefix;
    loop {
      enum State {
        Unknown,
        Matched,
        NotMatched,
      }

      let state = poll_fn(|cx| {
        let filled_len = readbuf.filled().len();
        let res = ready!(Pin::new(&mut io).poll_read(cx, &mut readbuf));
        if let Err(e) = res {
          return Poll::Ready(Err(e));
        }
        let filled = readbuf.filled();
        let new_len = filled.len();
        if new_len == filled_len {
          // Empty read, no match
          return Poll::Ready(Ok(State::NotMatched));
        } else if new_len < prefix.len() {
          // Read less than prefix, make sure we're still matching the prefix (early exit)
          if !prefix.starts_with(filled) {
            return Poll::Ready(Ok(State::NotMatched));
          }
        } else if new_len >= prefix.len() {
          // We have enough to determine
          if filled.starts_with(prefix) {
            return Poll::Ready(Ok(State::Matched));
          } else {
            return Poll::Ready(Ok(State::NotMatched));
          }
        }

        Poll::Ready(Ok(State::Unknown))
      })
      .await?;

      match state {
        State::Unknown => continue,
        State::Matched => {
          let initialized_len = readbuf.filled().len();
          return Ok((
            true,
            NetworkBufferedStream::new(io, buffer, initialized_len),
          ));
        }
        State::NotMatched => {
          let initialized_len = readbuf.filled().len();
          return Ok((
            false,
            NetworkBufferedStream::new(io, buffer, initialized_len),
          ));
        }
      }
    }
  }
}

pub struct NetworkBufferedStream<S: AsyncRead + Unpin> {
  io: S,
  initialized_len: usize,
  prefix_offset: usize,
  prefix: [MaybeUninit<u8>; MAX_PREFIX_SIZE * 2],
  prefix_read: bool,
}

impl<S: AsyncRead + Unpin> NetworkBufferedStream<S> {
  fn new(
    io: S,
    prefix: [MaybeUninit<u8>; MAX_PREFIX_SIZE * 2],
    initialized_len: usize,
  ) -> Self {
    Self {
      io,
      initialized_len,
      prefix_offset: 0,
      prefix,
      prefix_read: false,
    }
  }

  fn current_slice(&self) -> &[u8] {
    // We trust that these bytes are initialized properly
    let slice = &self.prefix[self.prefix_offset..self.initialized_len];

    // This guarantee comes from slice_assume_init_ref (we can't use that until it's stable)

    // SAFETY: casting `slice` to a `*const [T]` is safe since the caller guarantees that
    // `slice` is initialized, and `MaybeUninit` is guaranteed to have the same layout as `T`.
    // The pointer obtained is valid since it refers to memory owned by `slice` which is a
    // reference and thus guaranteed to be valid for reads.

    unsafe { &*(slice as *const [_] as *const [u8]) as _ }
  }

  pub fn into_inner(self) -> (S, Bytes) {
    let bytes = Bytes::copy_from_slice(self.current_slice());
    (self.io, bytes)
  }
}

impl<S: AsyncRead + Unpin> AsyncRead for NetworkBufferedStream<S> {
  // From hyper's Rewind (https://github.com/hyperium/hyper), MIT License, Copyright (c) Sean McArthur
  fn poll_read(
    mut self: Pin<&mut Self>,
    cx: &mut std::task::Context<'_>,
    buf: &mut ReadBuf<'_>,
  ) -> Poll<std::io::Result<()>> {
    if !self.prefix_read {
      let prefix = self.current_slice();

      // If there are no remaining bytes, let the bytes get dropped.
      if !prefix.is_empty() {
        let copy_len = std::cmp::min(prefix.len(), buf.remaining());
        buf.put_slice(&prefix[..copy_len]);
        self.prefix_offset += copy_len;

        return Poll::Ready(Ok(()));
      } else {
        self.prefix_read = true;
      }
    }
    Pin::new(&mut self.io).poll_read(cx, buf)
  }
}

impl<S: AsyncRead + AsyncWrite + Unpin> AsyncWrite
  for NetworkBufferedStream<S>
{
  fn poll_write(
    mut self: Pin<&mut Self>,
    cx: &mut std::task::Context<'_>,
    buf: &[u8],
  ) -> std::task::Poll<Result<usize, std::io::Error>> {
    Pin::new(&mut self.io).poll_write(cx, buf)
  }

  fn poll_flush(
    mut self: Pin<&mut Self>,
    cx: &mut std::task::Context<'_>,
  ) -> std::task::Poll<Result<(), std::io::Error>> {
    Pin::new(&mut self.io).poll_flush(cx)
  }

  fn poll_shutdown(
    mut self: Pin<&mut Self>,
    cx: &mut std::task::Context<'_>,
  ) -> std::task::Poll<Result<(), std::io::Error>> {
    Pin::new(&mut self.io).poll_shutdown(cx)
  }

  fn is_write_vectored(&self) -> bool {
    self.io.is_write_vectored()
  }

  fn poll_write_vectored(
    mut self: Pin<&mut Self>,
    cx: &mut std::task::Context<'_>,
    bufs: &[std::io::IoSlice<'_>],
  ) -> std::task::Poll<Result<usize, std::io::Error>> {
    Pin::new(&mut self.io).poll_write_vectored(cx, bufs)
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use tokio::io::AsyncReadExt;

  struct YieldsOneByteAtATime(&'static [u8]);

  impl AsyncRead for YieldsOneByteAtATime {
    fn poll_read(
      mut self: Pin<&mut Self>,
      _cx: &mut std::task::Context<'_>,
      buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
      if let Some((head, tail)) = self.as_mut().0.split_first() {
        self.as_mut().0 = tail;
        let dest = buf.initialize_unfilled_to(1);
        dest[0] = *head;
        buf.advance(1);
      }
      Poll::Ready(Ok(()))
    }
  }

  async fn test(
    io: impl AsyncRead + Unpin,
    prefix: &'static [u8],
    expect_match: bool,
    expect_string: &'static str,
  ) -> io::Result<()> {
    let (matches, mut io) = NetworkStreamPrefixCheck::new(io, prefix)
      .match_prefix()
      .await?;
    assert_eq!(matches, expect_match);
    let mut s = String::new();
    Pin::new(&mut io).read_to_string(&mut s).await?;
    assert_eq!(s, expect_string);
    Ok(())
  }

  #[tokio::test]
  async fn matches_prefix_simple() -> io::Result<()> {
    let buf = b"prefix match".as_slice();
    test(buf, b"prefix", true, "prefix match").await
  }

  #[tokio::test]
  async fn matches_prefix_exact() -> io::Result<()> {
    let buf = b"prefix".as_slice();
    test(buf, b"prefix", true, "prefix").await
  }

  #[tokio::test]
  async fn not_matches_prefix_simple() -> io::Result<()> {
    let buf = b"prefill match".as_slice();
    test(buf, b"prefix", false, "prefill match").await
  }

  #[tokio::test]
  async fn not_matches_prefix_short() -> io::Result<()> {
    let buf = b"nope".as_slice();
    test(buf, b"prefix", false, "nope").await
  }

  #[tokio::test]
  async fn not_matches_prefix_empty() -> io::Result<()> {
    let buf = b"".as_slice();
    test(buf, b"prefix", false, "").await
  }

  #[tokio::test]
  async fn matches_one_byte_at_a_time() -> io::Result<()> {
    let buf = YieldsOneByteAtATime(b"prefix");
    test(buf, b"prefix", true, "prefix").await
  }

  #[tokio::test]
  async fn not_matches_one_byte_at_a_time() -> io::Result<()> {
    let buf = YieldsOneByteAtATime(b"prefill");
    test(buf, b"prefix", false, "prefill").await
  }
}

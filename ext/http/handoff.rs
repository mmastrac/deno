use std::cell::RefCell;
use std::future::Future;
use std::rc::Rc;
use std::task::Waker;
use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum HandoffError {
  #[error("Channel closed")]
  Closed,
}

/// Acts like a one-element MPSC channel, but requires no locking.
struct AsyncHandoff<T: Unpin> {
  value: Option<T>,
  recv_alive: bool,
  recv_waker: Option<Waker>,
  send_alive: bool,
  send_waker: Option<Waker>,
}

pub fn new<T: Unpin>() -> (AsyncHandoffSender<T>, AsyncHandoffReceiver<T>) {
  let handoff = Rc::new(RefCell::new(AsyncHandoff {
    value: None,
    recv_alive: true,
    recv_waker: None,
    send_alive: true,
    send_waker: None,
  }));
  (AsyncHandoffSender{ handoff: handoff.clone() }, AsyncHandoffReceiver{ handoff })
}

pub struct AsyncHandoffSender<T: Unpin> {
  handoff: Rc<RefCell<AsyncHandoff<T>>>
}

pub struct AsyncHandoffSenderFuture<'a, T: Unpin>(&'a AsyncHandoffSender<T>, Option<T>);

impl <'a, T: Unpin> Future for AsyncHandoffSenderFuture<'a, T> {
  type Output = Result<(), HandoffError>;

  fn poll(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<Self::Output> {
    let mut handoff = self.0.handoff.borrow_mut();
    if !handoff.recv_alive {
      return std::task::Poll::Ready(Err(HandoffError::Closed));
    }

    debug_assert!(handoff.send_waker.is_none());

    if handoff.value.is_some() {
      // Can't send, value not picked up
      handoff.send_waker = Some(cx.waker().clone());
      return std::task::Poll::Pending;
    }

    // Value was free, so we can send
    debug_assert!(handoff.value.is_none());
    debug_assert!(self.1.is_some());
    handoff.value = self.get_mut().1.take();
    if let Some(recv_waker) = handoff.recv_waker.take() {
      drop(handoff);
      recv_waker.wake();
    }

    std::task::Poll::Ready(Ok(()))
  }
}

pub struct AsyncHandoffReceiverFuture<'a, T: Unpin>(&'a AsyncHandoffReceiver<T>);

impl <'a, T: Unpin> Future for AsyncHandoffReceiverFuture<'a, T> {
  type Output = Result<T, HandoffError>;

  fn poll(self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<Self::Output> {
    let mut handoff = self.0.handoff.borrow_mut();
    debug_assert!(handoff.recv_waker.is_none());

    if let Some(value) = handoff.value.take() {
      // There's a value
      if let Some(send_waker) = handoff.send_waker.take() {
        drop(handoff);
        send_waker.wake();
      }
      return std::task::Poll::Ready(Ok(value));
    }

    // Check for close after we receive
    if !handoff.send_alive {
      return std::task::Poll::Ready(Err(HandoffError::Closed));
    }

    handoff.recv_waker = Some(cx.waker().clone());
    std::task::Poll::Pending
  }
}

pub struct AsyncHandoffReceiver<T: Unpin> {
  handoff: Rc<RefCell<AsyncHandoff<T>>>
}

impl <T: Unpin> AsyncHandoffSender<T> {
  pub fn send(&self, t: T) -> AsyncHandoffSenderFuture<T> {
    AsyncHandoffSenderFuture(self, Some(t))
  }
}

impl <T: Unpin> Drop for AsyncHandoffSender<T> {
  fn drop(&mut self) {
    self.handoff.borrow_mut().send_alive = false;
  }
}

impl <T: Unpin> AsyncHandoffReceiver<T> {
  pub fn recv(&self) -> AsyncHandoffReceiverFuture<T> {
    AsyncHandoffReceiverFuture(self)
  }
}

impl <T: Unpin> Drop for AsyncHandoffReceiver<T> {
  fn drop(&mut self) {
    self.handoff.borrow_mut().recv_alive = false;
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use tokio::task::{spawn_local, LocalSet};
  
  #[tokio::test]
  async fn test_send() {
    let local = LocalSet::new();
    local.run_until(async {
      let (tx, rx) = new::<u32>();
      let handle = spawn_local(async move {
        rx.recv().await
      });

      tx.send(1).await.unwrap();
      assert_eq!(handle.await.unwrap(), Ok(1));
    }).await;
  }

  #[tokio::test]
  async fn test_drop() {
    let local = LocalSet::new();
    local.run_until(async {
      let (tx, rx) = new::<u32>();
      drop(tx);
      let handle = spawn_local(async move {
        rx.recv().await
      });

      assert_eq!(handle.await.unwrap(), Err(HandoffError::Closed));
    }).await;
  }

  #[tokio::test]
  async fn test_send_twice() {
    let local = LocalSet::new();
    local.run_until(async {
      let (tx, rx) = new::<u32>();
      let handle = spawn_local(async move {
        rx.recv().await.unwrap() + rx.recv().await.unwrap()
      });

      tx.send(1).await.unwrap();
      tx.send(2).await.unwrap();
      assert_eq!(handle.await.unwrap(), 3);
    }).await;
  }  

  #[tokio::test]
  async fn test_send_then_drop() {
    let local = LocalSet::new();
    local.run_until(async {
      let (tx, rx) = new::<u32>();
      let handle = spawn_local(async move {
        assert_eq!(rx.recv().await.unwrap(), 1);
        assert_eq!(rx.recv().await, Err(HandoffError::Closed));
      });

      tx.send(1).await.unwrap();
      drop(tx);
      assert!(handle.await.is_ok())
    }).await;
  }  
}

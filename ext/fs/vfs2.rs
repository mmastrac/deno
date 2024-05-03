use std::{future::Future, io::ErrorKind, marker::PhantomData, path::Path};

use deno_core::{anyhow::bail, error::AnyError};

enum VfsOpType {
  MayBlock,
  WontBlock,
  Async,
}

pub struct VfsOpSync<'a, F: FnOnce() -> VfsResult<R>+ 'a, R > (F, PhantomData<&'a ()>);
pub struct VfsOpAsync<'a, F: Future<Output = VfsResult<R>>+ 'a, R>  (F, PhantomData<&'a ()>);

pub fn sync<'a, F: FnOnce() -> VfsResult<R> + 'a, R>(f: F) -> VfsOpSync<'a, F, R> {
  VfsOpSync(f, PhantomData)
}

pub type VfsResult<T> = Result<T, AnyError>;

pub trait VfsOp<'a, R> {
  const TYPE: VfsOpType;
}

impl <'a, F: Future<Output = VfsResult<R>>, R> VfsOp<'a, F::Output> for VfsOpAsync<'a, F, R> {
  const TYPE: VfsOpType = VfsOpType::Async;
}

impl <'a, F: FnOnce() -> VfsResult<R>, R> VfsOp<'a, R> for VfsOpSync<'a, F, R> {
  const TYPE: VfsOpType = VfsOpType::MayBlock;
}

impl <'a, R> VfsOp<'a, R> for VfsResult<R> {
  const TYPE: VfsOpType = VfsOpType::WontBlock;
}

impl <'a, R> VfsOp<'a, R> for () {
  const TYPE: VfsOpType = VfsOpType::WontBlock;
}

pub struct VfsHandle<'a>(PhantomData<&'a ()>);

impl <'a> VfsHandle<'a> {
  pub fn from_path(path: &'a Path) -> Self {
    unimplemented!()
  }

  pub fn posix(&self) -> (i32, *const i8) {
    unimplemented!()
  }
  
  fn from_dirfd(dirfd: i32, filename: Option<&std::ffi::OsStr>) -> Self {
        todo!()
    }
}

pub trait Vfs {
  fn resolve<'a>(&self, path: &'a Path) -> impl VfsOp<'a, VfsHandle<'a>>;
  fn rename<'a>(&self, from: VfsHandle<'a>, to: VfsHandle<'a>) -> impl VfsOp<'a, ()> { bail!("Unsupported VFS operation"); }
  fn link(&self, from: VfsHandle, to: VfsHandle) -> impl VfsOp<()> { bail!("Unsupported VFS operation"); }
  fn unlink<'a>(&self, file: VfsHandle<'a>) -> impl VfsOp<'a, ()> { bail!("Unsupported VFS operation"); }
  fn cp(&self, from: VfsHandle, to: VfsHandle) -> impl VfsOp<()> { bail!("Unsupported VFS operation"); }
  fn stat(&self, file: VfsHandle) -> impl VfsOp<()> { bail!("Unsupported VFS operation"); }
  fn open(&self, file: VfsHandle) -> impl VfsOp<VfsFile>;
}

#[derive(Default)]
struct VfsDriver {}

impl VfsDriver {
  pub fn sync<'a, R>(&self, op: impl VfsOp<'a, R>) -> VfsResult<R> {
    unimplemented!()
  }
}

pub trait VfsFile {
  fn poll_read();
  fn poll_write();
  fn start_seek();
  fn poll_seek();
}

struct WindowsVfs {}

struct PosixVfs {
}

#[inline(always)]
unsafe fn with_errno(f: impl FnOnce() -> libc::c_int) -> Result<libc::c_int, libc::c_int> {
  let r = f();
  if r != -1 {
    Ok(r)
  } else {
    Err(*libc::__error())
  }
}

impl Vfs for PosixVfs {
  fn resolve<'a>(&self, path: &'a Path) -> impl VfsOp<'a, VfsHandle<'a>> {
    sync(move || unsafe {
      let dirfd = if let Some(parent) = path.parent() {
        with_errno(|| libc::open(parent.as_os_str().as_encoded_bytes().as_ptr() as _, libc::O_DIRECTORY)).map_err(std::io::Error::from_raw_os_error)?
      } else {
        libc::AT_FDCWD
      };
      let filename = path.file_name();
      Ok(VfsHandle::from_dirfd(dirfd, filename))
    })
  }

  fn unlink<'a>(&self, file: VfsHandle<'a>) -> impl VfsOp<'a, ()> {
    sync(move || unsafe { 
      let (dirfd, pathname) = file.posix();
      let Err(e) = with_errno(|| libc::unlinkat(dirfd, pathname, 0)) else {
        return Ok(());
      };
      if e != libc::EISDIR {
        return Err(std::io::Error::from_raw_os_error(e).into());
      }
      with_errno(|| libc::unlinkat(dirfd, pathname, libc::AT_REMOVEDIR)).map_err(std::io::Error::from_raw_os_error)?;
      Ok(())
    })
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[derive(Default)]
  struct MemoryVfs;

  impl Vfs for MemoryVfs {
    fn resolve<'a>(&self, path: &'a Path) -> impl VfsOp<'a, VfsHandle<'a>> {
      Ok(VfsHandle::from_path(path))
    }
    fn rename<'a>(&self, from: VfsHandle<'a>, to: VfsHandle<'a>) -> impl VfsOp<'a, ()> {
      sync(move || { drop(from); Ok(()) })
    }
  }

  #[test]
  fn test_memory_vfs() {
    let vfs = MemoryVfs::default();
    let driver = VfsDriver::default();
    let from = driver.sync(vfs.resolve("/a".as_ref())).unwrap();
    let to = driver.sync(vfs.resolve("/b".as_ref())).unwrap();
    driver.sync(vfs.rename(from, to)).unwrap();
  }
}

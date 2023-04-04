use std::ptr::NonNull;

use deno_core::v8;

/// An aggressively interrupting callback-caller. This will call the given callback function
/// right away.
pub(crate) struct JsCallback {
  callback: NonNull<v8::Function>,
  context: NonNull<v8::Context>,
  isolate: *mut v8::Isolate,
}

impl JsCallback {
  /// Create a wrapper for a V8 function to make callbacks earlier. This constructor is unsafe
  /// as the [`JsCallback`] must never outlive its isolate.
  pub unsafe fn new(
    scope: &mut v8::HandleScope,
    context: v8::Local<v8::Context>,
    callback: v8::Local<v8::Function>,
  ) -> Self {
    // SAFETY: Transmute the HandleScope to an isolate
    let isolate: *mut v8::Isolate = &mut *scope as &mut v8::Isolate;

    let callback = v8::Global::new(scope, callback).into_raw();
    let context = v8::Global::new(scope, context).into_raw();
    Self {
      callback,
      context,
      isolate,
    }
  }

  /// This will make an interrupting call to the given callback function.
  #[inline(always)]
  pub fn call<T>(
    &self,
    f: impl FnOnce(&mut v8::HandleScope, &v8::Function) -> T,
  ) -> T {
    let isolate: *mut v8::Isolate = self.isolate;
    // SAFETY: JsCallback is !Send, so we can only have one &mut handle in here.
    // TODO: Does this isolate have &mut handles elsewhere?
    let isolate = unsafe { &mut *isolate };

    // SAFETY: We know this pointer came from into_raw()
    let callback = unsafe { v8::Global::from_raw(isolate, self.callback) };

    let context: NonNull<v8::Context> = self.context;
    // SAFETY: NonNull<Context> has the same layout as the Global<Context> from earlier. Bootstrapping
    // a CallbackScope is hard.
    let mut cb_scope = unsafe {
      let local_context = std::mem::transmute::<
        NonNull<v8::Context>,
        v8::Local<v8::Context>,
      >(context);
      v8::CallbackScope::new(local_context)
    };

    let scope = &mut v8::HandleScope::new(&mut cb_scope);
    let func = callback.open(scope);

    let res = f(scope, func);

    // We aren't going to clean up our globals yet
    std::mem::forget(callback);
    res
  }
}

impl Drop for JsCallback {
  fn drop(&mut self) {
    let isolate: *mut v8::Isolate = self.isolate;
    let isolate = unsafe { &mut *isolate };

    // Drop the context
    let context: NonNull<v8::Context> = self.context;
    _ = unsafe { v8::Global::from_raw(isolate, context) };

    // Drop the callback
    let function: NonNull<v8::Function> = self.callback;
    _ = unsafe { v8::Global::from_raw(isolate, function) };
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use deno_core::JsRuntime;

  #[test]
  fn callback_test() {
    let mut runtime = JsRuntime::new(Default::default());
    runtime
      .execute_script_static(
        "<script>",
        "function callback(a) { return a + '!'; }",
      )
      .unwrap();

    let realm = runtime.global_realm();
    let scope = &mut realm.handle_scope(runtime.v8_isolate());
    let context = realm.context();
    let context_local = v8::Local::new(scope, context);
    let global = context_local.global(scope);
    let key = v8::String::new_external_onebyte_static(scope, b"callback")
      .unwrap()
      .into();
    let callback =
      v8::Local::<v8::Function>::try_from(global.get(scope, key).unwrap())
        .unwrap();

    let callback = unsafe { JsCallback::new(scope, context_local, callback) };
    let output = callback.call(|scope, func| {
      let recv = v8::undefined(scope).into();
      let input =
        v8::String::new_external_onebyte_static(scope, b"hello").unwrap();
      let result = func.call(scope, recv, &[input.into()]).unwrap();
      result.to_rust_string_lossy(scope)
    });
    assert_eq!("hello!", output);
  }
}

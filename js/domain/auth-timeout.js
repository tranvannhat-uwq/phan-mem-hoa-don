export const AUTH_TIMEOUT_MS = 12000;

// Bound Auth SDK locks as well as network requests. A late response cannot
// continue the caller's login/recovery flow after its deadline has expired.
export function withAuthTimeout(task, timeoutMs = AUTH_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error('Kết nối đăng nhập quá thời gian chờ. Vui lòng thử lại.');
      error.code = 'AUTH_TIMEOUT';
      error.loginCode = 'NETWORK';
      reject(error);
    }, timeoutMs);
    Promise.resolve(task).then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); }
    );
  });
}

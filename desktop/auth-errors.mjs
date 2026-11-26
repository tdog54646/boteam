// Unified account authentication expiration detection across Codex, Claude Code, and Antigravity CLI.

const AUTH_EXPIRED_PATTERNS = [
  /(?:登录|授权|凭据|访问令牌|令牌)(?:已)?(?:失效|过期)/,
  /刷新订阅凭据/,
  /此账号需要重新授权/,
  /请先授权隔离的/,
  /无法核验.*独立配置，请重新授权/,
  /无法确认\s*Codex\s*订阅身份，请用\s*ChatGPT\s*重新授权/,
  /authentication required|not signed in|not authenticated|token expired|invalid_grant/i,
]

export function markAuthExpired(error) {
  if (error && typeof error === 'object') {
    error.authExpired = true
  }
  return error
}

export function authExpiredError(message, code = 'AUTH_EXPIRED') {
  const err = new Error(message)
  err.code = code
  err.authExpired = true
  return err
}

export function isAuthExpiredError(error) {
  if (!error) return false
  if (typeof error === 'object') {
    if (error.authExpired === true || error.code === 'AGY_AUTH_REQUIRED' || error.code === 'AUTH_EXPIRED') {
      return true
    }
  }
  const message = typeof error === 'string' ? error : error?.message || ''
  return AUTH_EXPIRED_PATTERNS.some(pattern => pattern.test(message))
}

export function shouldOfferAccountReauth(task, account) {
  if (!task || task.status !== 'failed' || !account) return false
  if (account.status === 'login' || account.loginState === 'signed-out') return true
  if (task.authExpired === true) return true
  return isAuthExpiredError(task.error)
}

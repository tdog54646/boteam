export const antigravityLocationReason = 'User location is not supported for the API use.'
const locationWarning = '⚠ FAILED_PRECONDITION (code 400): ' + antigravityLocationReason
export const antigravityLocationMessage =
  'Google 拒绝了当前地区的 Antigravity 请求（400 FAILED_PRECONDITION）。请在服务支持的地区使用，或选择其他可用的 Bot。'

function normalizeWarning(text) {
  return text.trim().replace(/^⚠️/u, '⚠')
}

export function isAntigravityLocationWarning(text) {
  return typeof text === 'string' && normalizeWarning(text) === locationWarning
}

// agy can deliver this diagnostic as ordinary text in one or more ACP chunks.
export function couldBeAntigravityLocationWarning(text) {
  return text.length <= locationWarning.length + 16 && locationWarning.startsWith(normalizeWarning(text))
}

export function isAntigravityLocationRpcError(error) {
  return [error?.message, error?.data, error?.data?.message, error?.data?.error?.message].some(
    message => typeof message === 'string' && message.includes(antigravityLocationReason),
  )
}

export function antigravityLocationError() {
  return Object.assign(new Error(antigravityLocationMessage), { code: 'AGY_UNSUPPORTED_LOCATION' })
}

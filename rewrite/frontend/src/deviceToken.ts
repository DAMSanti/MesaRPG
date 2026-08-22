const STORAGE_KEY = 'mesa_device_token'

/**
 * Per-device secret, generated once and kept in localStorage — proves to
 * the backend "this device submitted this pending/rejected sheet" (see
 * app/main.py's _require_owner) without any login. No password: this
 * matches the app's existing LAN/home-table trust model, it only closes
 * the gap where a player could edit someone else's pending ficha.
 */
export function getDeviceToken(): string {
  let token = localStorage.getItem(STORAGE_KEY)
  if (!token) {
    token = crypto.randomUUID()
    localStorage.setItem(STORAGE_KEY, token)
  }
  return token
}

// Desktop notifications that nudge the user back when Inroad finishes work in
// the background: research drafted, research failed, or questions waiting about
// the event. Opt-in — App keeps `syncDesktopNotify` in step with the saved
// setting — and nothing fires while the window is focused, where the in-app
// toasts already reach the user.

let enabled = false

export function syncDesktopNotify(on: boolean) {
  enabled = on
}

// Notification copy is short; long errors and subjects get clipped.
const clip = (s: string, max = 140) => (s.length > max ? `${s.slice(0, max - 1)}…` : s)

// Fires only when the setting is on, permission is granted and the Inroad
// window isn't focused. Clicking one pulls the window to the front.
export function notifyDesktop(title: string, body: string) {
  if (!enabled || document.hasFocus()) return
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
    const n = new Notification(clip(title), { body: clip(body) })
    n.onclick = () => {
      window.focus()
      n.close()
    }
  } catch {
    // Some platforms throw when notifications aren't available; a missed nudge is fine.
  }
}

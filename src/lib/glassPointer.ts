/**
 * Liquid-glass pointer response: while the mouse is over a `.glass-interactive` surface or a board card, publish its
 * position inside that element as `--mx` / `--my` so the CSS (styles/glass.css) can draw the specular highlight there.
 *
 * One passive listener on the document, one rAF per frame, nothing for touch or coarse pointers (no hover to follow),
 * nothing React has to render — the variables are written straight onto the element and React never touches them.
 */
const SURFACE = '.glass-interactive, .ticket-card'

export function installGlassPointer(doc: Document = document): () => void {
  const win = doc.defaultView
  if (!win || typeof win.matchMedia !== 'function' || !win.matchMedia('(hover: hover) and (pointer: fine)').matches) return () => {}
  let frame = 0
  let last: PointerEvent | null = null

  const paint = () => {
    frame = 0
    const e = last
    const el = e && e.target instanceof Element ? (e.target.closest(SURFACE) as HTMLElement | null) : null
    if (!e || !el) return
    const r = el.getBoundingClientRect()
    el.style.setProperty('--mx', `${Math.round(e.clientX - r.left)}px`)
    el.style.setProperty('--my', `${Math.round(e.clientY - r.top)}px`)
  }
  const onMove = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return
    last = e
    if (!frame) frame = win.requestAnimationFrame(paint)
  }

  doc.addEventListener('pointermove', onMove, { passive: true })
  return () => {
    doc.removeEventListener('pointermove', onMove)
    if (frame) win.cancelAnimationFrame(frame)
  }
}

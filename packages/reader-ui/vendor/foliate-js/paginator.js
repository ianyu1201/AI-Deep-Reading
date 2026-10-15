const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

const debounce = (f, wait, immediate) => {
    let timeout
    return (...args) => {
        const later = () => {
            timeout = null
            if (!immediate) f(...args)
        }
        const callNow = immediate && !timeout
        if (timeout) clearTimeout(timeout)
        timeout = setTimeout(later, wait)
        if (callNow) f(...args)
    }
}

const lerp = (min, max, x) => x * (max - min) + min
const easeOutQuad = x => 1 - (1 - x) * (1 - x)
const animate = (a, b, duration, ease, render) => new Promise(resolve => {
    let start
    const step = now => {
        if (document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches) {
            render(lerp(a, b, 1))
            return resolve()
        }
        start ??= now
        const fraction = Math.min(1, (now - start) / duration)
        render(lerp(a, b, ease(fraction)))
        if (fraction < 1) requestAnimationFrame(step)
        else resolve()
    }
    if (document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches) {
        render(lerp(a, b, 1))
        return resolve()
    }
    requestAnimationFrame(step)
})

// collapsed range doesn't return client rects sometimes (or always?)
// try make get a non-collapsed range or element
const uncollapse = range => {
    if (!range?.collapsed) return range
    const { endOffset, endContainer } = range
    if (endContainer.nodeType === 1) {
        const node = endContainer.childNodes[endOffset]
        if (node?.nodeType === 1) return node
        return endContainer
    }
    if (endOffset + 1 < endContainer.length) range.setEnd(endContainer, endOffset + 1)
    else if (endOffset > 1) range.setStart(endContainer, endOffset - 1)
    else return endContainer.parentNode
    return range
}

const makeRange = (doc, node, start, end = start) => {
    const range = doc.createRange()
    range.setStart(node, start)
    range.setEnd(node, end)
    return range
}

// use binary search to find an offset value in a text node
const bisectNode = (doc, node, cb, start = 0, end = node.nodeValue.length) => {
    if (end - start === 1) {
        const result = cb(makeRange(doc, node, start), makeRange(doc, node, end))
        return result < 0 ? start : end
    }
    const mid = Math.floor(start + (end - start) / 2)
    const result = cb(makeRange(doc, node, start, mid), makeRange(doc, node, mid, end))
    return result < 0 ? bisectNode(doc, node, cb, start, mid)
        : result > 0 ? bisectNode(doc, node, cb, mid, end) : mid
}

const { SHOW_ELEMENT, SHOW_TEXT, SHOW_CDATA_SECTION,
    FILTER_ACCEPT, FILTER_REJECT, FILTER_SKIP } = NodeFilter

const filter = SHOW_ELEMENT | SHOW_TEXT | SHOW_CDATA_SECTION

// needed cause there seems to be a bug in `getBoundingClientRect()` in Firefox
// where it fails to include rects that have zero width and non-zero height
// (CSSOM spec says "rectangles [...] of which the height or width is not zero")
// which makes the visible range include an extra space at column boundaries
const getBoundingClientRect = target => {
    let top = Infinity, right = -Infinity, left = Infinity, bottom = -Infinity
    for (const rect of target.getClientRects()) {
        left = Math.min(left, rect.left)
        top = Math.min(top, rect.top)
        right = Math.max(right, rect.right)
        bottom = Math.max(bottom, rect.bottom)
    }
    return new DOMRect(left, top, right - left, bottom - top)
}

const getVisibleRange = (doc, start, end, mapRect) => {
    // first get all visible nodes
    const acceptNode = node => {
        const name = node.localName?.toLowerCase()
        // ignore all scripts, styles, and their children
        if (name === 'script' || name === 'style') return FILTER_REJECT
        if (node.nodeType === 1) {
            const { left, right } = mapRect(node.getBoundingClientRect())
            // no need to check child nodes if it's completely out of view
            if (right < start || left > end) return FILTER_REJECT
            if (['img','svg','video'].includes(name)) return FILTER_ACCEPT
            // elements must be completely in view to be considered visible
            // because you can't specify offsets for elements
            if (left >= start && right <= end) return FILTER_ACCEPT
            // TODO: it should probably allow elements that do not contain text
            // because they can exceed the whole viewport in both directions
            // especially in scrolled mode
        } else {
            // ignore empty text nodes
            if (!node.nodeValue?.trim()) return FILTER_SKIP
            // create range to get rect
            const range = doc.createRange()
            range.selectNodeContents(node)
            const { left, right } = mapRect(range.getBoundingClientRect())
            // it's visible if any part of it is in view
            if (right >= start && left <= end) return FILTER_ACCEPT
        }
        return FILTER_SKIP
    }
    const walker = doc.createTreeWalker(doc.body, filter, { acceptNode })
    const nodes = []
    for (let node = walker.nextNode(); node; node = walker.nextNode())
        nodes.push(node)

    // we're only interested in the first and last visible nodes
    const from = nodes[0] ?? doc.body
    const to = nodes[nodes.length - 1] ?? from

    // find the offset at which visibility changes
    const startOffset = from.nodeType === 1 ? 0
        : bisectNode(doc, from, (a, b) => {
            const p = mapRect(getBoundingClientRect(a))
            const q = mapRect(getBoundingClientRect(b))
            if (p.right < start && q.left > start) return 0
            return q.left > start ? -1 : 1
        })
    const endOffset = to.nodeType === 1 ? 0
        : bisectNode(doc, to, (a, b) => {
            const p = mapRect(getBoundingClientRect(a))
            const q = mapRect(getBoundingClientRect(b))
            if (p.right < end && q.left > end) return 0
            return q.left > end ? -1 : 1
        })

    const range = doc.createRange()
    if(from.nodeType===1 && ['img','svg','video'].includes(from.localName?.toLowerCase()))range.setStartBefore(from)
    else range.setStart(from, startOffset)
    if(to.nodeType===1 && ['img','svg','video'].includes(to.localName?.toLowerCase()))range.setEndAfter(to)
    else range.setEnd(to, endOffset)
    return range
}

const selectionIsBackward = sel => {
    const range = document.createRange()
    range.setStart(sel.anchorNode, sel.anchorOffset)
    range.setEnd(sel.focusNode, sel.focusOffset)
    return range.collapsed
}

const setSelectionTo = (target, collapse) => {
    let range
    if (target.startContainer) range = target.cloneRange()
    else if (target.nodeType) {
        range = document.createRange()
        range.selectNode(target)
    }
    if (range) {
        const sel = range.startContainer.ownerDocument.defaultView.getSelection()
        if (sel) {
            sel.removeAllRanges()
            if (collapse === -1) range.collapse(true)
            else if (collapse === 1) range.collapse()
            sel.addRange(range)
        }
    }
}

const getDirection = doc => {
    const { defaultView } = doc
    const { writingMode, direction } = defaultView.getComputedStyle(doc.body)
    const vertical = writingMode === 'vertical-rl'
        || writingMode === 'vertical-lr'
    const rtl = doc.body.dir === 'rtl'
        || direction === 'rtl'
        || doc.documentElement.dir === 'rtl'
    return { vertical, rtl }
}

const getBackground = doc => {
    const bodyStyle = doc.defaultView.getComputedStyle(doc.body)
    return bodyStyle.backgroundColor === 'rgba(0, 0, 0, 0)'
        && bodyStyle.backgroundImage === 'none'
        ? doc.defaultView.getComputedStyle(doc.documentElement).background
        : bodyStyle.background
}

const makeMarginals = (length, part) => Array.from({ length }, () => {
    const div = document.createElement('div')
    const child = document.createElement('div')
    div.append(child)
    child.setAttribute('part', part)
    return div
})

const setStylesImportant = (el, styles) => {
    const { style } = el
    for (const [k, v] of Object.entries(styles)) style.setProperty(k, v, 'important')
}

class View {
    #observer = new ResizeObserver(() => this.expand())
    #element = document.createElement('div')
    #iframe = document.createElement('iframe')
    #contentRange = document.createRange()
    #overlayer
    #vertical = false
    #rtl = false
    #column = true
    #size
    #layout = {}
    #mediaSizes = new WeakMap()
    #destroyed = false
    #loadReject
    columns = 1
    contentColumns = 0
    renderCount = 0
    expandCount = 0
    constructor({ container, onExpand }) {
        this.container = container
        this.onExpand = onExpand
        this.#iframe.setAttribute('part', 'filter')
        this.#element.append(this.#iframe)
        Object.assign(this.#element.style, {
            boxSizing: 'content-box',
            position: 'relative',
            overflow: 'hidden',
            flex: '0 0 auto',
            width: '100%', height: '100%',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
        })
        Object.assign(this.#iframe.style, {
            overflow: 'hidden',
            border: '0',
            display: 'none',
            width: '100%', height: '100%',
        })
        // Desktop Chromium: EPUB content scripts are disabled.
        // Parent reader code still handles selection and navigation events.
        this.#iframe.setAttribute('sandbox', 'allow-same-origin')
        this.#iframe.setAttribute('scrolling', 'no')
    }
    get element() {
        return this.#element
    }
    get document() {
        return this.#iframe.contentDocument
    }
    async load(src, afterLoad, beforeRender) {
        if (typeof src !== 'string') throw new Error(`${src} is not string`)
        return new Promise((resolve, reject) => {
            this.#loadReject = reject
            this.#iframe.addEventListener('load', () => {
                if(this.#destroyed)return reject(new DOMException('View destroyed','AbortError'))
                try {
                const doc = this.document
                afterLoad?.(doc)

                // it needs to be visible for Firefox to get computed style
                this.#iframe.style.display = 'block'
                const { vertical, rtl } = getDirection(doc)
                const background = getBackground(doc)
                this.#iframe.style.display = 'none'

                this.#vertical = vertical
                this.#rtl = rtl

                this.#contentRange.selectNodeContents(doc.body)
                const layout = beforeRender?.({ vertical, rtl, background })
                this.#iframe.style.display = 'block'
                this.render(layout)
                this.#observer.observe(doc.body)

                // the resize observer above doesn't work in Firefox
                // (see https://bugzilla.mozilla.org/show_bug.cgi?id=1832939)
                // until the bug is fixed we can at least account for font load
                doc.fonts.ready.then(() => { if (!this.#destroyed) { this.setImageSize(); this.expand() } })
                for (const media of doc.images) media.addEventListener('load', () => { if (!this.#destroyed) { this.setImageSize(); this.expand() } }, { once: true })

                this.#loadReject = null
                resolve()
                } catch(error) { reject(error) }
            }, { once: true })
            this.#iframe.src = src
        })
    }
    render(layout) {
        if (!layout || this.#destroyed || !this.document?.body) return
        this.renderCount++
        this.#column = layout.flow !== 'scrolled'
        this.#layout = layout
        if (this.#column) this.columnize(layout)
        else this.scrolled(layout)
    }
    scrolled({ gap, columnWidth }) {
        const vertical = this.#vertical
        const doc = this.document
        setStylesImportant(doc.documentElement, {
            'box-sizing': 'border-box',
            'padding': vertical ? `${gap}px 0` : `0 ${gap}px`,
            'column-width': 'auto',
            'height': 'auto',
            'width': 'auto',
        })
        setStylesImportant(doc.body, {
            [vertical ? 'max-height' : 'max-width']: `${columnWidth}px`,
            'margin': 'auto',
        })
        this.setImageSize()
        this.expand()
    }
    columnize({ width, height, gap, columnWidth }) {
        const vertical = this.#vertical
        this.#size = vertical ? height : width
        this.columns = Math.max(1, Math.round(this.#size / (columnWidth + gap)))

        const doc = this.document
        setStylesImportant(doc.documentElement, {
            'box-sizing': 'border-box',
            'column-width': `${Math.trunc(columnWidth)}px`,
            'column-gap': `${gap}px`,
            'column-fill': 'auto',
            ...(vertical
                ? { 'width': `${width}px` }
                : { 'height': `${height}px` }),
            'padding': vertical ? `${gap / 2}px 0` : `0 ${gap / 2}px`,
            'overflow': 'hidden',
            // force wrap long words
            'overflow-wrap': 'break-word',
            // reset some potentially problematic props
            'position': 'static', 'border': '0', 'margin': '0',
            'max-height': 'none', 'max-width': 'none',
            'min-height': 'none', 'min-width': 'none',
            // fix glyph clipping in WebKit
            '-webkit-line-box-contain': 'block glyphs replaced',
        })
        setStylesImportant(doc.body, {
            'max-height': 'none',
            'max-width': 'none',
            'margin': '0',
        })
        this.setImageSize()
        this.expand()
    }
    setImageSize() {
        const { width, height, columnWidth, margin = 0 } = this.#layout
        const doc = this.document
        // The iframe spans every column; 100% therefore is not a page width.
        // Clamp replaced elements to the *single* content column, identically
        // for primary and adjacent views. Author text and source nodes stay intact.
        const maxWidth = Math.max(1, columnWidth || width || this.#iframe.clientWidth)
        const maxHeight = this.#column ? Math.max(1, height - margin * 2) : Infinity
        for(const figure of doc.body.querySelectorAll('figure'))setStylesImportant(figure,{'max-width':`${maxWidth}px`,'height':'auto','min-height':'0','break-inside':'avoid'})
        for (const el of doc.body.querySelectorAll('img, svg, video')) {
            const style = doc.defaultView.getComputedStyle(el)
            const naturalWidth = el.naturalWidth || el.videoWidth || el.viewBox?.baseVal?.width || parseFloat(style.width)
            const naturalHeight = el.naturalHeight || el.videoHeight || el.viewBox?.baseVal?.height || parseFloat(style.height)
            if (!this.#mediaSizes.has(el)) this.#mediaSizes.set(el, {width:parseFloat(style.width), height:parseFloat(style.height)})
            const {width:authorWidth, height:authorHeight} = this.#mediaSizes.get(el)
            const ratio = naturalWidth > 0 && naturalHeight > 0 ? naturalWidth / naturalHeight : authorWidth / authorHeight
            const intendedWidth = Number.isFinite(authorWidth) && authorWidth > 0 ? authorWidth : naturalWidth
            const fitsWidth = Math.min(intendedWidth || maxWidth, maxWidth)
            const fittedWidth = Number.isFinite(ratio) && ratio > 0 ? Math.min(fitsWidth, maxHeight * ratio) : fitsWidth
            setStylesImportant(el, {
                'max-width': `${maxWidth}px`,
                'max-height': Number.isFinite(maxHeight) ? `${maxHeight}px` : 'none',
                'object-fit': 'contain', 'break-inside': 'avoid',
                'page-break-inside': 'avoid', 'box-sizing': 'border-box',
                ...(Number.isFinite(ratio) && ratio > 0 ? {'width': `${fittedWidth}px`, 'height': `${fittedWidth / ratio}px`} : {}),
            })
            // Image-only fixed-size wrappers must not fragment the image box.
            // Do not reformat mixed prose, inline icons, or source text offsets.
            let parent = el.parentElement
            for (let depth = 0; depth < 2 && parent && parent !== doc.body; depth++, parent = parent.parentElement) {
                if (parent.textContent.trim() || parent.querySelectorAll('img,svg,video').length !== 1) break
                setStylesImportant(parent, {'max-width': `${maxWidth}px`, 'height': 'auto', 'min-height': '0', 'break-inside': 'avoid'})
            }
        }
    }
    expand() {
        if (this.#destroyed || !this.document?.documentElement) return
        this.expandCount++
        const { documentElement } = this.document
        if (this.#column) {
            const side = this.#vertical ? 'height' : 'width'
            const otherSide = this.#vertical ? 'width' : 'height'
            const contentRect = this.#contentRange.getBoundingClientRect()
            const rootRect = documentElement.getBoundingClientRect()
            // offset caused by column break at the start of the page
            // which seem to be supported only by WebKit and only for horizontal writing
            const contentStart = this.#vertical ? 0
                : this.#rtl ? rootRect.right - contentRect.right : contentRect.left - rootRect.left
            const contentSize = contentStart + contentRect[side]
            this.contentColumns = Math.max(1, Math.ceil((contentSize - 1) / (this.#size / this.columns)))
            const pageCount = Math.ceil(contentSize / this.#size)
            const expandedSize = pageCount * this.#size
            this.#element.style.padding = '0'
            this.#iframe.style[side] = `${expandedSize}px`
            this.#element.style[side] = `${expandedSize + this.#size * 2}px`
            this.#iframe.style[otherSide] = '100%'
            this.#element.style[otherSide] = '100%'
            documentElement.style[side] = `${this.#size}px`
            if (this.#overlayer) {
                this.#overlayer.element.style.margin = '0'
                this.#overlayer.element.style.left = this.#vertical ? '0' : `${this.#size}px`
                this.#overlayer.element.style.top = this.#vertical ? `${this.#size}px` : '0'
                this.#overlayer.element.style[side] = `${expandedSize}px`
                this.#overlayer.redraw()
            }
        } else {
            const side = this.#vertical ? 'width' : 'height'
            const otherSide = this.#vertical ? 'height' : 'width'
            const contentSize = documentElement.getBoundingClientRect()[side]
            const expandedSize = contentSize
            const { margin } = this.#layout
            const padding = this.#vertical ? `0 ${margin}px` : `${margin}px 0`
            this.#element.style.padding = padding
            this.#iframe.style[side] = `${expandedSize}px`
            this.#element.style[side] = `${expandedSize}px`
            this.#iframe.style[otherSide] = '100%'
            this.#element.style[otherSide] = '100%'
            if (this.#overlayer) {
                this.#overlayer.element.style.margin = padding
                this.#overlayer.element.style.left = '0'
                this.#overlayer.element.style.top = '0'
                this.#overlayer.element.style[side] = `${expandedSize}px`
                this.#overlayer.redraw()
            }
        }
        this.onExpand()
    }
    set overlayer(overlayer) {
        this.#overlayer = overlayer
        this.#element.append(overlayer.element)
    }
    get overlayer() {
        return this.#overlayer
    }
    destroy() {
        this.#destroyed = true
        this.#loadReject?.(new DOMException('View destroyed','AbortError'))
        this.#loadReject = null
        if (this.document?.body) this.#observer.unobserve(this.document.body)
    }
}

// NOTE: everything here assumes the so-called "negative scroll type" for RTL
export class Paginator extends HTMLElement {
    static observedAttributes = [
        'flow', 'gap', 'margin',
        'max-inline-size', 'max-block-size', 'max-column-count',
    ]
    #root = this.attachShadow({ mode: 'closed' })
    #observer = new ResizeObserver(() => this.render())
    #top
    #background
    #container
    #header
    #footer
    #view
    #vertical = false
    #rtl = false
    #margin = 0
    #index = -1
    #anchor = 0 // anchor view to a fraction (0-1), Range, or Element
    #justAnchored = false
    #locked = false // while true, prevent any further navigation
    #styles
    #styleMap = new WeakMap()
    #mediaQuery = matchMedia('(prefers-color-scheme: dark)')
    #mediaQueryListener
    #scrollBounds
    #touchState
    #touchScrolled
    #lastVisibleRange
    // Separate documents retain their own CFI/annotation identity. A clipped
    // adjacent View fills an otherwise unused right page; no source DOM merge.
    #companion
    #pendingCompanions = new Set()
    #companionEpoch = 0
    #companionReady = Promise.resolve()
    #entryOffsets = new Map()
    #previousSections = new Map()
    #entryOffset = 0
    #layoutSignature = ''
    #destroyed = false
    #navigationEpoch = 0
    #navigationTarget = null
    constructor() {
        super()
        this.#root.innerHTML = `<style>
        :host {
            display: block;
            container-type: size;
        }
        :host, #top {
            box-sizing: border-box;
            position: relative;
            overflow: hidden;
            width: 100%;
            height: 100%;
        }
        #top {
            --_gap: 7%;
            --_margin: 48px;
            --_max-inline-size: 720px;
            --_max-block-size: 1440px;
            --_max-column-count: 2;
            --_max-column-count-portrait: 1;
            --_max-column-count-spread: var(--_max-column-count);
            --_half-gap: calc(var(--_gap) / 2);
            --_max-width: calc(var(--_max-inline-size) * var(--_max-column-count-spread));
            --_max-height: var(--_max-block-size);
            display: grid;
            grid-template-columns:
                minmax(var(--_half-gap), 1fr)
                var(--_half-gap)
                minmax(0, calc(var(--_max-width) - var(--_gap)))
                var(--_half-gap)
                minmax(var(--_half-gap), 1fr);
            grid-template-rows:
                minmax(var(--_margin), 1fr)
                minmax(0, var(--_max-height))
                minmax(var(--_margin), 1fr);
            &.vertical {
                --_max-column-count-spread: var(--_max-column-count-portrait);
                --_max-width: var(--_max-block-size);
                --_max-height: calc(var(--_max-inline-size) * var(--_max-column-count-spread));
            }
            @container (orientation: portrait) {
                & {
                    --_max-column-count-spread: var(--_max-column-count-portrait);
                }
                &.vertical {
                    --_max-column-count-spread: var(--_max-column-count);
                }
            }
        }
        #background {
            grid-column: 1 / -1;
            grid-row: 1 / -1;
        }
        #container {
            grid-column: 2 / 5;
            grid-row: 2;
            overflow: hidden;
        }
        :host([flow="scrolled"]) #container {
            grid-column: 1 / -1;
            grid-row: 1 / -1;
            overflow: auto;
            overflow-anchor: none;
            scrollbar-width: thin;
            scrollbar-color: var(--ui-muted, #757575) transparent;
        }
        :host([flow="scrolled"]) #container::-webkit-scrollbar { width: 10px; height: 10px; }
        :host([flow="scrolled"]) #container::-webkit-scrollbar-track { background: transparent; }
        :host([flow="scrolled"]) #container::-webkit-scrollbar-thumb { background: #8888; border: 3px solid transparent; background-clip: padding-box; border-radius: 8px; }
        :host([flow="scrolled"]) #container:hover::-webkit-scrollbar-thumb { background-color: #888c; }
        @media (forced-colors: active), (prefers-contrast: more) {
            :host([flow="scrolled"]) #container { scrollbar-width: auto; scrollbar-color: auto; }
        }
        #header {
            grid-column: 3 / 4;
            grid-row: 1;
        }
        #footer {
            grid-column: 3 / 4;
            grid-row: 3;
            align-self: end;
        }
        #header, #footer {
            display: grid;
            height: var(--_margin);
        }
        :is(#header, #footer) > * {
            display: flex;
            align-items: center;
            min-width: 0;
        }
        :is(#header, #footer) > * > * {
            width: 100%;
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
            text-align: center;
            font-size: .75em;
            opacity: .6;
        }
        </style>
        <div id="top">
            <div id="background" part="filter"></div>
            <div id="header"></div>
            <div id="container"></div>
            <div id="footer"></div>
        </div>
        `

        this.#top = this.#root.getElementById('top')
        this.#background = this.#root.getElementById('background')
        this.#container = this.#root.getElementById('container')
        this.#header = this.#root.getElementById('header')
        this.#footer = this.#root.getElementById('footer')

        this.#observer.observe(this.#container)
        this.#container.addEventListener('scroll', () => { this.#updateScrollWindow(); this.dispatchEvent(new Event('scroll')) })
        this.#container.addEventListener('scroll', debounce(() => {
            if (this.scrolled) {
                if (this.#justAnchored) this.#justAnchored = false
                else this.#afterScroll('scroll')
            }
        }, 250))

        const opts = { passive: false }
        this.addEventListener('touchstart', this.#onTouchStart.bind(this), opts)
        this.addEventListener('touchmove', this.#onTouchMove.bind(this), opts)
        this.addEventListener('touchend', this.#onTouchEnd.bind(this))
        this.addEventListener('load', ({ detail: { doc } }) => {
            doc.addEventListener('touchstart', this.#onTouchStart.bind(this), opts)
            doc.addEventListener('touchmove', this.#onTouchMove.bind(this), opts)
            doc.addEventListener('touchend', this.#onTouchEnd.bind(this))
        })

        this.addEventListener('relocate', ({ detail }) => {
            if (detail.reason === 'selection') setSelectionTo(this.#anchor, 0)
            else if (detail.reason === 'navigation') {
                if (this.#anchor === 1) setSelectionTo(detail.range, 1)
                else if (typeof this.#anchor === 'number')
                    setSelectionTo(detail.range, -1)
                else setSelectionTo(this.#anchor, -1)
            }
        })
        const checkPointerSelection = debounce((range, sel) => {
            if (!sel.rangeCount) return
            const selRange = sel.getRangeAt(0)
            const backward = selectionIsBackward(sel)
            if (backward && selRange.compareBoundaryPoints(Range.START_TO_START, range) < 0)
                this.prev()
            else if (!backward && selRange.compareBoundaryPoints(Range.END_TO_END, range) > 0)
                this.next()
        }, 700)
        this.addEventListener('load', ({ detail: { doc } }) => {
            let isPointerSelecting = false
            doc.addEventListener('pointerdown', () => isPointerSelecting = true)
            doc.addEventListener('pointerup', () => isPointerSelecting = false)
            let isKeyboardSelecting = false
            doc.addEventListener('keydown', () => isKeyboardSelecting = true)
            doc.addEventListener('keyup', () => isKeyboardSelecting = false)
            doc.addEventListener('selectionchange', () => {
                if (this.scrolled) return
                if (doc !== this.#view?.document) return
                const range = this.#lastVisibleRange
                if (!range) return
                const sel = doc.getSelection()
                if (!sel.rangeCount) return
                if (isPointerSelecting && sel.type === 'Range')
                    checkPointerSelection(range, sel)
                else if (isKeyboardSelecting) {
                    const selRange = sel.getRangeAt(0).cloneRange()
                    const backward = selectionIsBackward(sel)
                    if (!backward) selRange.collapse()
                    this.#scrollToAnchor(selRange)
                }
            })
            doc.addEventListener('focusin', e => this.scrolled ? null :
                // NOTE: `requestAnimationFrame` is needed in WebKit
                requestAnimationFrame(() => { if (doc === this.#view?.document) this.#scrollToAnchor(e.target) }))
        })

        this.#mediaQueryListener = () => {
            if (!this.#view) return
            this.#background.style.background = getBackground(this.#view.document)
        }
        this.#mediaQuery.addEventListener('change', this.#mediaQueryListener)
    }
    attributeChangedCallback(name, _, value) {
        switch (name) {
            case 'flow':
                this.#clearScrollWindow(this.#view)
                this.render()
                break
            case 'gap':
            case 'margin':
            case 'max-block-size':
            case 'max-column-count':
                this.#top.style.setProperty('--_' + name, value)
                break
            case 'max-inline-size':
                // needs explicit `render()` as it doesn't necessarily resize
                this.#top.style.setProperty('--_' + name, value)
                this.render()
                break
        }
    }
    open(book) {
        this.bookDir = book.dir
        this.sections = book.sections
        book.transformTarget?.addEventListener('data', ({ detail }) => {
            if (detail.type !== 'text/css') return
            const w = innerWidth
            const h = innerHeight
            detail.data = Promise.resolve(detail.data).then(data => data
                // unprefix as most of the props are (only) supported unprefixed
                .replace(/(?<=[{\s;])-epub-/gi, '')
                // replace vw and vh as they cause problems with layout
                .replace(/(\d*\.?\d+)vw/gi, (_, d) => parseFloat(d) * w / 100 + 'px')
                .replace(/(\d*\.?\d+)vh/gi, (_, d) => parseFloat(d) * h / 100 + 'px')
                // `page-break-*` unsupported in columns; replace with `column-break-*`
                .replace(/page-break-(after|before|inside)\s*:/gi, (_, x) =>
                    `-webkit-column-break-${x}:`)
                .replace(/break-(after|before|inside)\s*:\s*(avoid-)?page/gi, (_, x, y) =>
                    `break-${x}: ${y ?? ''}column`))
        })
    }
    #createView() {
        this.#clearScrollWindow(this.#view)
        this.#scrollViews.clear()
        this.#clearCompanion()
        if (this.#view) {
            this.#view.destroy()
            this.#container.removeChild(this.#view.element)
        }
        this.#view = new View({
            container: this,
            onExpand: () => this.continuousScroll && this.#scrollViews.size ? this.#windowExpanded() : this.#scrollToAnchor(this.#anchor),
        })
        this.#container.append(this.#view.element)
        return this.#view
    }
    #beforeRender({ vertical, rtl, background }) {
        this.#vertical = vertical
        this.#rtl = rtl
        this.#top.classList.toggle('vertical', vertical)

        // set background to `doc` background
        // this is needed because the iframe does not fill the whole element
        this.#background.style.background = background

        const { width, height } = this.#container.getBoundingClientRect()
        const size = vertical ? height : width

        const style = getComputedStyle(this.#top)
        const maxInlineSize = parseFloat(style.getPropertyValue('--_max-inline-size'))
        const maxColumnCount = parseInt(style.getPropertyValue('--_max-column-count-spread'))
        const margin = parseFloat(style.getPropertyValue('--_margin'))
        this.#margin = margin

        const g = parseFloat(style.getPropertyValue('--_gap')) / 100
        // The gap will be a percentage of the #container, not the whole view.
        // This means the outer padding will be bigger than the column gap. Let
        // `a` be the gap percentage. The actual percentage for the column gap
        // will be (1 - a) * a. Let us call this `b`.
        //
        // To make them the same, we start by shrinking the outer padding
        // setting to `b`, but keep the column gap setting the same at `a`. Then
        // the actual size for the column gap will be (1 - b) * a. Repeating the
        // process again and again, we get the sequence
        //     x₁ = (1 - b) * a
        //     x₂ = (1 - x₁) * a
        //     ...
        // which converges to x = (1 - x) * a. Solving for x, x = a / (1 + a).
        // So to make the spacing even, we must shrink the outer padding with
        //     f(x) = x / (1 + x).
        // But we want to keep the outer padding, and make the inner gap bigger.
        // So we apply the inverse, f⁻¹ = -x / (x - 1) to the column gap.
        const gap = -g / (g - 1) * size

        const flow = this.getAttribute('flow')
        this.#container.style.display=flow==='scrolled'&&!vertical&&!rtl?'flex':''
        this.#container.style.flexDirection='column'
        if (flow === 'scrolled') {
            // FIXME: vertical-rl only, not -lr
            this.setAttribute('dir', vertical ? 'rtl' : 'ltr')
            this.#top.style.padding = '0'
            const columnWidth = maxInlineSize

            this.heads = null
            this.feet = null
            this.#header.replaceChildren()
            this.#footer.replaceChildren()

            return { flow, margin, gap, columnWidth: Math.min(columnWidth, width - gap * 2), width, height }
        }

        const divisor = Math.min(maxColumnCount, Math.ceil(size / maxInlineSize))
        const columnWidth = (size / divisor) - gap
        this.setAttribute('dir', rtl ? 'rtl' : 'ltr')

        const marginalDivisor = vertical
            ? Math.min(2, Math.ceil(width / maxInlineSize))
            : divisor
        const marginalStyle = {
            gridTemplateColumns: `repeat(${marginalDivisor}, 1fr)`,
            gap: `${gap}px`,
            direction: this.bookDir === 'rtl' ? 'rtl' : 'ltr',
        }
        Object.assign(this.#header.style, marginalStyle)
        Object.assign(this.#footer.style, marginalStyle)
        const heads = makeMarginals(marginalDivisor, 'head')
        const feet = makeMarginals(marginalDivisor, 'foot')
        this.heads = heads.map(el => el.children[0])
        this.feet = feet.map(el => el.children[0])
        this.#header.replaceChildren(...heads)
        this.#footer.replaceChildren(...feet)

        return { height, width, margin, gap, columnWidth }
    }
    render() {
        if (!this.#view?.document?.body) return
        const signature = `${this.clientWidth}:${this.clientHeight}:${this.getAttribute('flow')}:${this.getAttribute('max-column-count')}`
        if (signature !== this.#layoutSignature) {
            this.#layoutSignature = signature
            this.#entryOffsets.clear()
            this.#previousSections.clear()
            this.#entryOffset = 0
        }
        this.#clearCompanion()
        const layout = this.#beforeRender({
            vertical: this.#vertical,
            rtl: this.#rtl,
        })
        for (const view of new Set([this.#view,...this.#scrollViews.values()])) view.render(layout)
        if(this.continuousScroll && this.#windowTextAnchor)this.#windowExpanded()
        else this.#scrollToAnchor(this.#anchor)
        if(this.continuousScroll){this.#scrollViews.set(this.#index,this.#view);void this.#ensureScrollWindow()}
    }
    get scrolled() {
        return this.getAttribute('flow') === 'scrolled'
    }
    get scrollProp() {
        const { scrolled } = this
        return this.#vertical ? (scrolled ? 'scrollLeft' : 'scrollTop')
            : scrolled ? 'scrollTop' : 'scrollLeft'
    }
    get sideProp() {
        const { scrolled } = this
        return this.#vertical ? (scrolled ? 'width' : 'height')
            : scrolled ? 'height' : 'width'
    }
    get size() {
        return this.#container.getBoundingClientRect()[this.sideProp]
    }
    get viewSize() {
        return this.#view.element.getBoundingClientRect()[this.sideProp]
    }
    get start() {
        return Math.abs(this.#container[this.scrollProp])
    }
    get end() {
        return this.start + this.size
    }
    get page() {
        return this.#continuousSpread ? Math.round(this.start / this.size * 2) / 2
            : Math.floor(((this.start + this.end) / 2) / this.size)
    }
    get pages() {
        return Math.round(this.viewSize / this.size)
    }
    scrollBy(dx, dy) {
        const delta = this.#vertical ? dy : dx
        const element = this.#container
        const { scrollProp } = this
        const [offset, a, b] = this.#scrollBounds
        const rtl = this.#rtl
        const min = rtl ? offset - b : offset - a
        const max = rtl ? offset + a : offset + b
        element[scrollProp] = Math.max(min, Math.min(max,
            element[scrollProp] + delta))
    }
    snap(vx, vy) {
        const velocity = this.#vertical ? vy : vx
        const [offset, a, b] = this.#scrollBounds
        const { start, end, pages, size } = this
        const min = Math.abs(offset) - a
        const max = Math.abs(offset) + b
        const d = velocity * (this.#rtl ? -size : size)
        const page = Math.floor(
            Math.max(min, Math.min(max, (start + end) / 2
                + (isNaN(d) ? 0 : d))) / size)

        this.#scrollToPage(page, 'snap').then(() => {
            const dir = page <= 0 ? -1 : page >= pages - 1 ? 1 : null
            if (dir) return this.#goTo({
                index: this.#adjacentIndex(dir),
                anchor: dir < 0 ? () => 1 : () => 0,
            })
        })
    }
    #onTouchStart(e) {
        const touch = e.changedTouches[0]
        this.#touchState = {
            x: touch?.screenX, y: touch?.screenY,
            t: e.timeStamp,
            vx: 0, xy: 0,
        }
    }
    #onTouchMove(e) {
        const state = this.#touchState
        if (state.pinched) return
        state.pinched = globalThis.visualViewport.scale > 1
        if (this.scrolled || state.pinched) return
        if (e.touches.length > 1) {
            if (this.#touchScrolled) e.preventDefault()
            return
        }
        e.preventDefault()
        const touch = e.changedTouches[0]
        const x = touch.screenX, y = touch.screenY
        const dx = state.x - x, dy = state.y - y
        const dt = e.timeStamp - state.t
        state.x = x
        state.y = y
        state.t = e.timeStamp
        state.vx = dx / dt
        state.vy = dy / dt
        this.#touchScrolled = true
        this.scrollBy(dx, dy)
    }
    #onTouchEnd() {
        this.#touchScrolled = false
        if (this.scrolled) return

        // XXX: Firefox seems to report scale as 1... sometimes...?
        // at this point I'm basically throwing `requestAnimationFrame` at
        // anything that doesn't work
        requestAnimationFrame(() => {
            if (globalThis.visualViewport.scale === 1)
                this.snap(this.#touchState.vx, this.#touchState.vy)
        })
    }
    // allows one to process rects as if they were LTR and horizontal
    #getRectMapper() {
        if (this.scrolled) {
            const size = this.viewSize
            const margin = this.#margin
            return this.#vertical
                ? ({ left, right }) =>
                    ({ left: size - right - margin, right: size - left - margin })
                : ({ top, bottom }) => ({ left: top + margin, right: bottom + margin })
        }
        const pxSize = this.pages * this.size
        return this.#rtl
            ? ({ left, right }) =>
                ({ left: pxSize - right, right: pxSize - left })
            : this.#vertical
                ? ({ top, bottom }) => ({ left: top, right: bottom })
                : f => f
    }
    async #scrollToRect(rect, reason) {
        if (this.scrolled) {
            const offset = this.#getRectMapper()(rect).left - this.#margin + (this.continuousScroll ? this.#scrollOffset() : 0)
            return this.#scrollTo(offset, reason)
        }
        const offset = this.#getRectMapper()(rect).left
        return this.#scrollToPage(this.#continuousSpread
            ? Math.max(1 + this.#entryOffset, Math.floor(offset / this.size - this.#entryOffset) + 1 + this.#entryOffset)
            : Math.floor(offset / this.size) + (this.#rtl ? -1 : 1), reason)
    }
    async #scrollTo(offset, reason, smooth) {
        this.#clearCompanion()
        const element = this.#container
        const { scrollProp, size } = this
        if (element[scrollProp] === offset) {
            this.#scrollBounds = [offset, this.atStart ? 0 : size, this.atEnd ? 0 : size]
            this.#afterScroll(reason)
            return
        }
        // FIXME: vertical-rl only, not -lr
        if (this.scrolled && this.#vertical) offset = -offset
        if ((reason === 'snap' || smooth) && this.hasAttribute('animated')) return animate(
            element[scrollProp], offset, parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--motion-page')) || 300, easeOutQuad,
            x => element[scrollProp] = x,
        ).then(() => {
            this.#scrollBounds = [offset, this.atStart ? 0 : size, this.atEnd ? 0 : size]
            this.#afterScroll(reason)
        })
        else {
            element[scrollProp] = offset
            this.#scrollBounds = [offset, this.atStart ? 0 : size, this.atEnd ? 0 : size]
            this.#afterScroll(reason)
        }
    }
    async #scrollToPage(page, reason, smooth) {
        const offset = this.size * (this.#rtl ? -page : page)
        return this.#scrollTo(offset, reason, smooth)
    }
    async scrollToAnchor(anchor, select) {
        return this.#scrollToAnchor(anchor, select ? 'selection' : 'navigation')
    }
    async #scrollToAnchor(anchor, reason = 'anchor') {
        this.#anchor = anchor
        const rects = uncollapse(anchor)?.getClientRects?.()
        // if anchor is an element or a range
        if (rects) {
            // when the start of the range is immediately after a hyphen in the
            // previous column, there is an extra zero width rect in that column
            const rect = Array.from(rects)
                .find(r => r.width > 0 && r.height > 0) || rects[0]
            if (!rect) return
            await this.#scrollToRect(rect, reason)
            return
        }
        // if anchor is a fraction
        if (this.scrolled) {
            await this.#scrollTo(anchor * this.viewSize + (this.continuousScroll ? this.#scrollOffset() : 0), reason)
            return
        }
        const { pages } = this
        if (!pages) return
        const textPages = pages - 2
        const newPage = this.#continuousSpread
            ? Math.max(0, Math.ceil((this.#view.contentColumns - this.#entryOffset * 2) / 2) - 1)
            : textPages - 1
        await this.#scrollToPage(Math.round(anchor * newPage) + 1 + this.#entryOffset, reason)
    }
    #getVisibleRange() {
        if (this.scrolled) return getVisibleRange(this.#view.document,
            this.start + this.#margin - (this.continuousScroll ? this.#scrollOffset() : 0), this.end - this.#margin - (this.continuousScroll ? this.#scrollOffset() : 0), this.#getRectMapper())
        const size = this.#rtl ? -this.size : this.size
        return getVisibleRange(this.#view.document,
            this.start - size, this.end - size, this.#getRectMapper())
    }
    #afterScroll(reason) {
        if(!this.#view?.document?.body)return
        const range = this.#getVisibleRange()
        this.#lastVisibleRange = range
        if(this.continuousScroll){
            const anchor=range.cloneRange();anchor.collapse(true)
            const target=uncollapse(anchor)
            const rect=target?.getClientRects?.()[0]
            if(rect)this.#windowTextAnchor={range:anchor,target,y:this.#scrollOffset()+this.#margin+rect.top-this.#container.scrollTop}
        }
        // don't set new anchor if relocation was to scroll to anchor
        if (reason !== 'selection' && reason !== 'navigation' && reason !== 'anchor')
            this.#anchor = range
        else this.#justAnchored = true

        const index = this.#index
        const detail = { reason, range, index }
        if (this.scrolled) detail.fraction = Math.max(0, (this.start - (this.continuousScroll ? this.#scrollOffset() : 0)) / this.viewSize)
        else if (this.pages > 0) {
            const { page, pages } = this
            this.#header.style.visibility = page > 1 ? 'visible' : 'hidden'
            detail.fraction = (page - 1) / (pages - 2)
            detail.size = 1 / (pages - 2)
        }
        this.dispatchEvent(new CustomEvent('relocate', { detail }))
        this.#companionReady = this.#refreshCompanion().catch(error => { if (error.name !== 'AbortError') console.warn('Adjacent page unavailable', error) })
    }
    async #display(promise, epoch = this.#navigationEpoch) {
        const { index, src, anchor, onLoad, select } = await promise
        if(this.#destroyed || epoch!==this.#navigationEpoch)throw new DOMException('Navigation superseded','AbortError')
        this.#index = index
        const hasFocus = this.#view?.document?.hasFocus()
        if (src) {
            const view = this.#createView()
            view.sourceIndex=index
            view.element.style.order=String(index)
            const afterLoad = doc => {
                if (doc.head) {
                    const $styleBefore = doc.createElement('style')
                    doc.head.prepend($styleBefore)
                    const $style = doc.createElement('style')
                    doc.head.append($style)
                    this.#styleMap.set(doc, [$styleBefore, $style])
                }
                onLoad?.({ doc, index })
            }
            const beforeRender = this.#beforeRender.bind(this)
            await view.load(src, afterLoad, beforeRender)
            if(this.#destroyed || epoch!==this.#navigationEpoch || this.#view!==view)throw new DOMException('Navigation superseded','AbortError')
            this.dispatchEvent(new CustomEvent('create-overlayer', {
                detail: {
                    doc: view.document, index,
                    attach: overlayer => view.overlayer = overlayer,
                },
            }))
            this.#view = view
        }
        this.#syncScrollPadding()
        await this.scrollToAnchor((typeof anchor === 'function'
            ? anchor(this.#view.document) : anchor) ?? 0, select)
        if(this.continuousScroll){this.#scrollViews.set(index,this.#view);this.#windowAnchorTop=this.#scrollOffset();await this.#ensureScrollWindow()}
        if (hasFocus) this.focusView()
    }
    #canGoToIndex(index) {
        return index >= 0 && index <= this.sections.length - 1
    }
    async #goTo(args) {
        if(!this.#canGoToIndex(args.index))return
        const target={index:args.index};this.#navigationTarget=target
        try {
            await this.#goToImpl(args)
            if(this.continuousScroll && this.#navigationTarget===target && this.#index===args.index && this.#view?.document?.body){
                const anchor=typeof args.anchor==='function'?args.anchor(this.#view.document):args.anchor
                await this.scrollToAnchor(anchor??0,args.select)
            }
        } finally {if(this.#navigationTarget===target)this.#navigationTarget=null}
    }
    async #goToImpl({ index, anchor, select, entryOffset = 0}) {
        if (!this.#canGoToIndex(index)) return
        if(this.continuousScroll && this.#scrollViews.has(index)){
            this.#index=index;this.#view=this.#scrollViews.get(index);this.#windowAnchorTop=this.#scrollOffset();
            await this.scrollToAnchor((typeof anchor==='function'?anchor(this.#view.document):anchor)??0,select);
            await this.#ensureScrollWindow();return
        }
        if (index === this.#index) {
            this.#entryOffset = entryOffset
            this.#entryOffsets.set(index, entryOffset)
            await this.#display({ index, anchor, select })
        }
        else {
            const oldIndex = this.#index
            const onLoad = detail => {
                this.#releaseSection(oldIndex)
                this.setStyles(this.#styles)
                this.dispatchEvent(new CustomEvent('load', { detail }))
            }
            this.#pinSection(index)
            try { await this.#display(this.#loadSection(index)
                .then(src => {this.#entryOffset=entryOffset;this.#entryOffsets.set(index,entryOffset);return { index, src, anchor, onLoad, select }})
                .catch(e => {
                    console.warn(e)
                    console.warn(new Error(`Failed to load section ${index}`))
                    throw e
                })) } finally {this.#unpinSection(index);this.#drainSectionReleases()}
        }
    }
    async goTo(target) {
        if (this.#locked || this.#destroyed) return
        const epoch=++this.#navigationEpoch
        const resolved = await target
        if(epoch!==this.#navigationEpoch || this.#destroyed)return
        if (this.#canGoToIndex(resolved.index)) {this.#previousSections.clear(); return this.#goTo(resolved)}
    }
    #scrollPrev(distance) {
        if (!this.#view) return true
        if (this.scrolled) {
            if (this.start > 0) return this.#scrollTo(
                Math.max(0, this.start - (distance ?? this.size)), null, true)
            return true
        }
        if (this.atStart) return
        const page = this.page - 1
        return this.#scrollToPage(page, 'page', true).then(() => page <= 0)
    }
    #scrollNext(distance) {
        if (!this.#view) return true
        if (this.scrolled) {
            if (this.viewSize - this.end > 2) return this.#scrollTo(
                Math.min(this.viewSize, distance ? this.start + distance : this.end), null, true)
            return true
        }
        if (this.atEnd) return
        const page = this.page + 1
        const pages = this.pages
        return this.#scrollToPage(page, 'page', true).then(() => page >= pages - 1)
    }
    get atStart() {
        return this.#adjacentIndex(-1) == null && this.page <= 1
    }
    get atEnd() {
        if (this.#continuousSpread) {
            const exhausted = Math.round((this.page - 1) * 2) + 2 >= this.#view.contentColumns
            if (!exhausted) return false
            if (this.#adjacentIndex(1) == null) return true
            const adjacent=this.#companion
            return !!adjacent && adjacent.view.contentColumns<=1 &&
                !this.sections.slice(adjacent.index+1).some(s=>s?.linear!=='no')
        }
        return this.#adjacentIndex(1) == null && this.page >= this.pages - 2
    }
    #adjacentIndex(dir) {
        for (let index = this.#index + dir; this.#canGoToIndex(index); index += dir)
            if (this.sections[index]?.linear !== 'no') return index
    }
    async #turnPage(dir, distance) {
        if(this.continuousScroll){this.scrollContinuous(dir*(distance??this.size));await this.ready();return}
        if (this.#locked) return
        this.#locked = true
        const previousIndex = this.#index
        const previousAnchor = this.#lastVisibleRange?.cloneRange() ?? this.#anchor
        try {
            await this.#companionReady
            const prev = dir === -1
            let shouldGo
            if (this.#continuousSpread) {
                const first = 1 + this.#entryOffset
                const column = Math.round((this.page - 1) * 2)
                if (prev && this.page <= first) {
                    const index = this.#previousSections.get(this.#index) ?? this.#adjacentIndex(-1)
                    if (index != null) await this.#goTo({ index, anchor: 1, entryOffset: this.#entryOffsets.get(index) ?? 0 })
                    shouldGo = index != null
                } else if (!prev && column + 2 >= this.#view.contentColumns) {
                    const consumed = this.#companion?.index
                    let index = this.#adjacentIndex(1)
                    let offset = this.#companion && index != null && consumed === index ? .5 : 0
                    if (offset && this.#companion.view.contentColumns <= 1) {
                        index++
                        while (this.#canGoToIndex(index) && this.sections[index]?.linear === 'no') index++
                        offset = 0
                    }
                    if (this.#canGoToIndex(index)) {
                        this.#previousSections.set(index,this.#index)
                        await this.#goTo({ index, anchor: 0, entryOffset: offset })
                    }
                    shouldGo = this.#canGoToIndex(index)
                } else await this.#scrollToPage(this.page + dir, 'page', true)
            } else {
                shouldGo = await (prev ? this.#scrollPrev(distance) : this.#scrollNext(distance))
                if (shouldGo) await this.#goTo({
                    index: this.#adjacentIndex(dir), anchor: prev ? () => 1 : () => 0,
                })
            }
            await this.#companionReady
            if (shouldGo || !this.hasAttribute('animated')) await wait(100)
        } catch (error) {
            // A failed adjacent section must not leave the old page beyond its
            // visible range. Only restore the still-current section/document.
            if (this.#index === previousIndex && this.#view?.document
                && previousAnchor?.startContainer?.ownerDocument === this.#view.document) {
                try { await this.scrollToAnchor(previousAnchor) } catch {}
            }
            throw error
        } finally {
            this.#locked = false
        }
    }
    prev(distance) {
        return this.#turnPage(-1, distance)
    }
    next(distance) {
        return this.#turnPage(1, distance)
    }
    prevSection() {
        return this.goTo({ index: this.#adjacentIndex(-1) })
    }
    nextSection() {
        return this.goTo({ index: this.#adjacentIndex(1) })
    }
    firstSection() {
        const index = this.sections.findIndex(section => section.linear !== 'no')
        return this.goTo({ index })
    }
    lastSection() {
        const index = this.sections.findLastIndex(section => section.linear !== 'no')
        return this.goTo({ index })
    }
    get layoutDiagnostics() {
        const views=new Set([this.#view,...this.#scrollViews.values(),...this.#pendingScrollViews,this.#companion?.view].filter(Boolean))
        return {navigationTarget:this.#navigationTarget?.index??null,navigationEpoch:this.#navigationEpoch,liveDocuments:views.size,indices:this.getContents().map(x=>x.index),views:[...views].map(v=>({columns:v.columns,contentColumns:v.contentColumns,renders:v.renderCount,expansions:v.expandCount})),pending:this.#pendingScrollViews.size,failures:[...this.#sectionFailures]}
    }
    get continuousScroll() { return this.scrolled && !this.#vertical && !this.#rtl }
    #scrollViews = new Map()
    #windowEpoch = 0
    #windowTask = null
    #windowAnchorTop = 0
    #windowTextAnchor = null
    #pendingScrollViews = new Set()
    #windowAbort = new AbortController()
    #sectionFailures = new Set()
    #deferredReleases = new Set()
    #sectionLoads = new Map()
    #pendingSources = new Map()
    #pinSection(index){this.#pendingSources.set(index,(this.#pendingSources.get(index)??0)+1)}
    #unpinSection(index){const count=(this.#pendingSources.get(index)??1)-1;if(count)this.#pendingSources.set(index,count);else this.#pendingSources.delete(index)}
    #sectionInUse(index) {
        return this.#view?.sourceIndex===index || this.#scrollViews.has(index) || this.#companion?.index===index || this.#pendingSources.has(index)
            || [...this.#pendingScrollViews].some(view=>view.sourceIndex===index)
            || [...this.#pendingCompanions].some(pending=>pending.index===index)
    }
    #loadSection(index) {
        this.#deferredReleases.delete(index)
        if(!this.#sectionLoads.has(index)){
            const promise=Promise.resolve().then(()=>this.sections[index].load())
            this.#sectionLoads.set(index,promise)
            promise.catch(()=>{if(this.#sectionLoads.get(index)===promise)this.#sectionLoads.delete(index)})
        }
        return this.#sectionLoads.get(index)
    }
    #releaseSection(index) {
        if(index==null || index<0 || !this.#sectionLoads.has(index))return
        this.#deferredReleases.add(index)
        const promise=this.#sectionLoads.get(index)
        promise.then(()=>{
            if(this.#sectionLoads.get(index)!==promise || !this.#deferredReleases.has(index) || this.#sectionInUse(index))return
            this.#sectionLoads.delete(index);this.#deferredReleases.delete(index);this.sections[index]?.unload?.()
        },()=>this.#deferredReleases.delete(index))
    }
    #drainSectionReleases() { for(const index of this.#deferredReleases)this.#releaseSection(index) }
    #scrollOffset(view = this.#view) {
        return view ? view.element.getBoundingClientRect().top - this.#container.getBoundingClientRect().top + this.#container.scrollTop : 0
    }
    #clearScrollWindow(keep = null) {
        this.#windowEpoch++
        this.#windowAbort.abort()
        this.#windowAbort = new AbortController()
        this.#sectionFailures.clear()
        this.#windowTask = null
        this.#windowTextAnchor = null
        this.#container.style.paddingBottom=''
        for(const view of this.#pendingScrollViews){view.destroy();view.element.remove()}
        this.#pendingScrollViews.clear()
        for (const [index, view] of this.#scrollViews) if (view !== keep) {
            view.destroy(); view.element.remove(); this.#scrollViews.delete(index); this.#releaseSection(index)
        }
        this.#scrollViews.clear()
        if (keep) this.#scrollViews.set(this.#index, keep)
        this.#windowAnchorTop = keep ? this.#scrollOffset(keep) : 0
    }
    #syncScrollPadding() {
        const last=[...this.#scrollViews].sort((a,b)=>a[0]-b[0]).at(-1)?.[1]??this.#view
        this.#container.style.paddingBottom=this.continuousScroll ? `${Math.max(0,this.size-(last?.element.getBoundingClientRect().height??0))}px` : ''
    }
    #windowExpanded() {
        if (!this.continuousScroll || !this.#view) return
        this.#syncScrollPadding()
        const saved=this.#windowTextAnchor
        if(saved?.range?.startContainer?.ownerDocument===this.#view.document){
            const rect=saved.target.getClientRects()[0]
            if(rect){
                this.#container.scrollTop+=this.#scrollOffset()+this.#margin+rect.top-this.#container.scrollTop-saved.y
                this.#windowAnchorTop=this.#scrollOffset()
                return
            }
        }
        const top = this.#scrollOffset()
        this.#container.scrollTop += top - this.#windowAnchorTop
        this.#windowAnchorTop = top
    }
    #updateScrollWindow() {
        if (!this.continuousScroll || !this.#scrollViews.size || this.#navigationTarget) return
        const y = this.#container.scrollTop + Math.min(this.#margin, 32)
        const entries = [...this.#scrollViews].sort((a,b)=>a[0]-b[0])
        const current = entries.find(([,view]) => {
            const top=this.#scrollOffset(view),bottom=top+view.element.getBoundingClientRect().height
            if(bottom<y || top>this.#container.scrollTop+this.size || !view.document?.body)return false
            const range=getVisibleRange(view.document,this.#container.scrollTop-top+this.#margin,this.#container.scrollTop-top+this.size-this.#margin,
                ({top,bottom})=>({left:top+this.#margin,right:bottom+this.#margin}))
            // A blank trailing margin is not a stable source position. Move
            // relocation ownership to the next actual visible source content.
            if(range.collapsed && range.startContainer===view.document.body)return false
            const frame=view.document.defaultView.frameElement.getBoundingClientRect(),clip=this.#container.getBoundingClientRect(),element=view.element.getBoundingClientRect()
            const visibleTop=Math.max(clip.top,frame.top,element.top),visibleBottom=Math.min(clip.bottom,frame.bottom,element.bottom)
            if(visibleBottom-visibleTop<1)return false
            const rects=range.toString().trim() ? [...range.getClientRects()] : [...view.document.querySelectorAll('img,svg,video')].flatMap(el=>[...el.getClientRects()])
            return rects.some(rect=>rect.width>0&&rect.height>0&&Math.min(rect.bottom+frame.top,visibleBottom)-Math.max(rect.top+frame.top,visibleTop)>1)
        }) ?? entries.find(([,view])=>this.#scrollOffset(view)>y) ?? entries.at(-1)
        if (current && current[1] !== this.#view) {
            [this.#index, this.#view] = current
            this.#anchor = 0
            this.#lastVisibleRange = null
        }
        this.#windowAnchorTop = this.#scrollOffset()
        this.#afterScroll('scroll')
        void this.#ensureScrollWindow()
    }
    async #ensureScrollWindow() {
        if (!this.continuousScroll || !this.#view) return
        if (this.#windowTask) return this.#windowTask
        const epoch = this.#windowEpoch
        const signal = this.#windowAbort.signal
        let rejectAbort
        const onAbort=()=>rejectAbort(new DOMException('Scroll window cancelled','AbortError'))
        const aborted=new Promise((_,reject)=>rejectAbort=reject)
        signal.addEventListener('abort',onAbort,{once:true})
        const run = async () => {
            // At most seven source documents. Long chapters need only neighbours;
            // short chapters fill up to two screens ahead without whole-book DOM.
            const candidates = []
            const linear = this.sections.map((s,i)=>s.linear !== 'no' ? i : -1).filter(i=>i>=0)
            const active = linear.indexOf(this.#index)
            for (let n=1;n<=3;n++) for (const direction of [1,-1]) {
                const index=linear[active+n*direction]
                if (index != null) candidates.push(index)
            }
            const keep = new Set([this.#index,...candidates])
            const oldTop = this.#scrollOffset()
            for (const [index,view] of this.#scrollViews) if (!keep.has(index)) {
                view.destroy();view.element.remove();this.#scrollViews.delete(index);this.#releaseSection(index)
            }
            this.#container.scrollTop += this.#scrollOffset() - oldTop
            this.#windowAnchorTop = this.#scrollOffset()
            for (const index of candidates) {
                if(epoch!==this.#windowEpoch || !this.continuousScroll)return
                if(this.#scrollViews.has(index)||this.#sectionFailures.has(index))continue
                const distance=Math.abs(linear.indexOf(index)-active)
                const ahead=index>this.#index
                const extent=ahead ? this.#container.scrollHeight-this.#container.scrollTop-this.size : this.#container.scrollTop
                if(distance>1 && (extent>this.size*2 || !this.#scrollViews.has(linear[linear.indexOf(index)-(ahead?1:-1)])))continue
                let view, timer, loaded=false, retained=false, expired=false
                const primary=this.#view
                this.#pinSection(index)
                try {
                    this.dispatchEvent(new CustomEvent('section-load-state',{detail:{index,state:'loading'}}))
                    const timeout=new Promise((_,reject)=>timer=setTimeout(()=>{expired=true;reject(Error('Section layout timed out'))},10000))
                    const loading=this.#loadSection(index).then(src=>{if(expired||epoch!==this.#windowEpoch){this.#releaseSection(index)}else loaded=true;return src})
                    const src=await Promise.race([loading,timeout,aborted])
                    if(epoch!==this.#windowEpoch || !this.continuousScroll)return
                    view=new View({container:this,onExpand:()=>this.#windowExpanded()})
                    view.sourceIndex=index
                    view.element.style.order=String(index)
                    this.#pendingScrollViews.add(view)
                    Object.assign(view.element.style,{position:'absolute',visibility:'hidden',top:'0'})
                    this.#container.append(view.element)
                    await Promise.race([view.load(src,doc=>{
                        const before=doc.createElement('style'),after=doc.createElement('style');doc.head.prepend(before);doc.head.append(after)
                        this.#styleMap.set(doc,[before,after]);this.#applyStyles(doc)
                    },({vertical,rtl})=>{
                        if(vertical||rtl)throw Error('Adjacent section uses a different writing direction')
                        return this.#beforeRender({vertical:false,rtl:false,background:getBackground(primary.document)})
                    }),timeout,aborted])
                    if(epoch!==this.#windowEpoch || !this.continuousScroll){view.destroy();view.element.remove();return}
                    const before=this.#scrollOffset()
                    Object.assign(view.element.style,{position:'relative',visibility:'visible',top:''})
                    // Reparenting/moving an iframe reloads its Document in Chromium.
                    // CSS order keeps source sequence without losing styles/CFI/listeners.
                    this.#scrollViews.set(index,view)
                    retained=true
                    this.#syncScrollPadding()
                    this.#container.scrollTop+=this.#scrollOffset()-before
                    this.#windowAnchorTop=this.#scrollOffset()
                    this.dispatchEvent(new CustomEvent('create-overlayer',{detail:{doc:view.document,index,attach:o=>view.overlayer=o}}))
                    this.dispatchEvent(new CustomEvent('load',{detail:{doc:view.document,index,continuous:true}}))
                    this.dispatchEvent(new CustomEvent('section-load-state',{detail:{index,state:'ready',liveDocuments:this.#scrollViews.size}}))
                }catch(error){view?.destroy();view?.element.remove();if(epoch===this.#windowEpoch){this.#sectionFailures.add(index);this.dispatchEvent(new CustomEvent('section-load-state',{detail:{index,state:'error',message:String(error.message)}}))}break}
                finally{clearTimeout(timer);this.#pendingScrollViews.delete(view);this.#unpinSection(index);if(loaded&&!retained)this.#releaseSection(index);this.#drainSectionReleases()}
            }
        }
        const task=run();this.#windowTask=task
        try{await task}finally{signal.removeEventListener('abort',onAbort);if(this.#windowTask===task)this.#windowTask=null}
    }
    #applyStyles(doc) {
        const pair=this.#styleMap.get(doc);if(!pair)return
        if(Array.isArray(this.#styles)){pair[0].textContent=this.#styles[0];pair[1].textContent=this.#styles[1]}
        else pair[1].textContent=this.#styles??''
    }
    scrollContinuous(delta) {
        if(!this.continuousScroll)return false
        this.#navigationTarget=null
        this.#container.scrollTop += delta
        this.#updateScrollWindow()
        this.#afterScroll('scroll')
        return true
    }
    async ready() { await this.#windowTask; await this.#companionReady }
    retrySections() { this.#sectionFailures.clear(); return this.#ensureScrollWindow() }
    get sectionStart() { return this.continuousScroll ? this.start - this.#scrollOffset() : this.start }

    get #continuousSpread() {
        return !this.scrolled && !this.#vertical && !this.#rtl && this.#view?.columns === 2
    }
    #clearCompanion() {
        this.#companionEpoch++
        for (const pending of this.#pendingCompanions) {
            pending.cancel()
            pending.view.destroy()
            pending.clip.remove()
        }
        const cancelledIndices=[...this.#pendingCompanions].map(p=>p.index)
        this.#pendingCompanions.clear()
        for(const index of cancelledIndices)this.#releaseSection(index)
        if (!this.#companion) return
        const index=this.#companion.index
        this.#companion.view.destroy()
        this.#companion.clip.remove()
        // Shared section loader owns URL lifetime; do not revoke a URL which
        // can simultaneously become the primary document during a page turn.
        this.#companion = null
        this.#releaseSection(index)
        this.#drainSectionReleases()
    }
    async #refreshCompanion() {
        if (!this.#continuousSpread) return
        const column = Math.round((this.page - 1) * 2)
        if (this.#view.contentColumns - column !== 1) return
        const index = this.#adjacentIndex(1)
        if (index == null || ['left', 'center'].includes(this.sections[index].pageSpread)) return
        this.#pinSection(index)
        try {
        const token = ++this.#companionEpoch
        const primary = this.#view
        const src = await this.#loadSection(index)
        if (token !== this.#companionEpoch || primary !== this.#view) {this.#releaseSection(index);return}
        const clip = document.createElement('div')
        const box = this.#container.getBoundingClientRect(), host = this.#top.getBoundingClientRect()
        Object.assign(clip.style, {position:'absolute', overflow:'hidden', zIndex:'1',
            left:`${box.left-host.left+box.width/2}px`, top:`${box.top-host.top}px`,
            width:`${box.width/2}px`, height:`${box.height}px`, background:getBackground(primary.document)})
        const holder = document.createElement('div')
        Object.assign(holder.style, {width:`${box.width}px`, height:'100%', position:'relative', left:`${-box.width}px`})
        clip.append(holder)
        // Attached for real layout, but never display unready adjacent content.
        clip.style.visibility = 'hidden'
        this.#top.append(clip)
        let unsupported = false
        const view = new View({container:this, onExpand:()=>{}})
        holder.append(view.element)
        let cancel, timer
        const cancelled = new Promise((_,reject)=>cancel=()=>reject(new DOMException('Adjacent view cancelled','AbortError')))
        const pending={view,clip,cancel,index}
        this.#pendingCompanions.add(pending)
        try {
            await Promise.race([view.load(src, doc => {
                const before = doc.createElement('style'), after = doc.createElement('style')
                doc.head.prepend(before); doc.head.append(after)
                this.#styleMap.set(doc,[before,after])
                const styles = this.#styles
                if (Array.isArray(styles)) {before.textContent=styles[0];after.textContent=styles[1]}
                else after.textContent=styles ?? ''
            }, ({vertical,rtl}) => {
                unsupported = vertical || rtl
                const style=getComputedStyle(this.#top), g=parseFloat(style.getPropertyValue('--_gap'))/100
                const gap=-g/(g-1)*box.width
                return {width:box.width,height:box.height,margin:this.#margin,gap,columnWidth:box.width/2-gap}
            }), cancelled])
            await Promise.race([view.document.fonts.ready, cancelled,
                new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Adjacent font layout timed out')),5000))])
            view.expand()
            if (unsupported || token !== this.#companionEpoch || primary !== this.#view) {view.destroy();clip.remove();return}
            // Explicit recto/left starts and a forced blank page are retained.
            const first=view.document.body.firstElementChild
            const before=first && view.document.defaultView.getComputedStyle(first).breakBefore
            const after=primary.document.body.lastElementChild && primary.document.defaultView.getComputedStyle(primary.document.body.lastElementChild).breakAfter
            if (['left','recto','verso'].includes(before) || ['left','right','recto','verso'].includes(after)) {view.destroy();clip.remove();return}
            this.#companion = {view,index,clip}
            this.dispatchEvent(new CustomEvent('create-overlayer',{detail:{doc:view.document,index,attach:overlayer=>view.overlayer=overlayer}}))
            this.dispatchEvent(new CustomEvent('load',{detail:{doc:view.document,index,companion:true}}))
            clip.style.visibility='visible'
            this.dispatchEvent(new CustomEvent('spread-ready',{detail:{indices:[this.#index,index]}}))
        } catch (error) {view.destroy();clip.remove();throw error}
        finally {clearTimeout(timer);this.#pendingCompanions.delete(pending);if(this.#companion?.view!==view)this.#releaseSection(index)}
        } finally {this.#unpinSection(index);this.#drainSectionReleases()}
    }
    getContents() {
        if(this.continuousScroll && this.#scrollViews.size)return [...this.#scrollViews].sort(([a],[b])=>a===this.#index?-1:b===this.#index?1:a-b).map(([index,view])=>({index,doc:view.document,overlayer:view.overlayer}))
        if (this.#view) return [{
            index: this.#index,
            overlayer: this.#view.overlayer,
            doc: this.#view.document,
        }, ...(this.#companion ? [{index:this.#companion.index,doc:this.#companion.view.document,overlayer:this.#companion.view.overlayer}] : [])]
        return []
    }
    setStyles(styles) {
        this.#styles = styles
        for(const view of this.#scrollViews.values())this.#applyStyles(view.document)
        const $$styles = this.#styleMap.get(this.#view?.document)
        if (!$$styles) return
        const [$beforeStyle, $style] = $$styles
        if (Array.isArray(styles)) {
            const [beforeStyle, style] = styles
            $beforeStyle.textContent = beforeStyle
            $style.textContent = style
        } else $style.textContent = styles

        // NOTE: needs `requestAnimationFrame` in Chromium
        const styledView=this.#view
        requestAnimationFrame(() => {if(this.#view===styledView && styledView?.document?.body)this.#background.style.background = getBackground(styledView.document)})

        // needed because the resize observer doesn't work in Firefox
        styledView?.document?.fonts?.ready?.then(() => {if(this.#view===styledView)styledView.expand()})
    }
    focusView() {
        this.#view.document.defaultView.focus()
    }
    destroy() {
        this.#destroyed=true
        this.#navigationEpoch++
        this.#clearScrollWindow(this.#view)
        this.#scrollViews.clear()
        this.#clearCompanion()
        this.#observer.unobserve(this)
        this.#view.destroy()
        this.#view = null
        this.#releaseSection(this.#index)
        this.#drainSectionReleases()
        this.#mediaQuery.removeEventListener('change', this.#mediaQueryListener)
    }
}

customElements.define('foliate-paginator', Paginator)
